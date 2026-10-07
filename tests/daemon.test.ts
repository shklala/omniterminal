import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient, connectOrSpawn, type SpawnSpec } from '../src/client/daemonClient';
import { encodeFrame } from '../src/shared/protocol';
import { getAppPaths } from '../src/shared/paths';
import type { AppState, Profile, SessionInfo } from '../src/shared/types';
import { tempHome, waitFor } from './helpers';

const root = path.resolve(__dirname, '..');
const daemonJs = path.join(root, 'dist-test', 'daemon.js');
const home = tempHome();
const paths = getAppPaths({ ...process.env, OMNITERMINAL_HOME: home });
const spec: SpawnSpec = {
  execPath: process.execPath,
  args: [daemonJs],
  env: { ...process.env, OMNITERMINAL_HOME: home, OMNITERMINAL_IDLE_EXIT_MS: '600000' },
};
const clients: DaemonClient[] = [];

async function gui(name = 'test-gui') {
  const { client, spawned } = await connectOrSpawn(paths, spec, name);
  clients.push(client);
  return { client, spawned };
}

async function screenText(client: DaemonClient, profileId: string) {
  return client.call<string>('sessions.text', { profileId });
}

beforeAll(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'daemon', 'main.ts')],
    outfile: daemonJs,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['node-pty', 'sql.js', '@xterm/headless', '@xterm/addon-serialize'],
    logLevel: 'silent',
  });
});

afterAll(async () => {
  for (const c of clients) c.close();
  try {
    const { client } = await gui('cleanup');
    await client.call('daemon.shutdown');
    client.close();
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe('session manager process (named pipe)', () => {
  let profile: Profile;
  let firstPid: number;

  it('spawns a detached session manager on first GUI connect', async () => {
    const { client, spawned } = await gui();
    expect(spawned).toBe(true);
    expect(client.hello?.pid).toBeGreaterThan(0);
    firstPid = client.hello!.pid;
    const state = await client.call<AppState>('app.getState');
    expect(state.shells.some((s) => s.id === 'cmd')).toBe(true);
    expect(state.tools.some((t) => t.id === 'claude')).toBe(true);
  });

  it('rejects connections without the right token', async () => {
    const sock = net.connect(paths.pipe);
    await new Promise((r) => sock.once('connect', r));
    const closed = new Promise<boolean>((r) => sock.once('close', () => r(true)));
    sock.write(encodeFrame({ t: 'hello', token: 'wrong', client: 'evil', protocol: 1 }));
    expect(await closed).toBe(true);
    const sock2 = net.connect(paths.pipe);
    await new Promise((r) => sock2.once('connect', r));
    const closed2 = new Promise<boolean>((r) => sock2.once('close', () => r(true)));
    sock2.write(encodeFrame({ t: 'req', id: 1, method: 'app.getState' }));
    expect(await closed2).toBe(true);
  });

  it('creates a terminal, launches it and streams output', async () => {
    const { client } = await gui();
    profile = await client.call<Profile>('profiles.create', { profile: { name: 'Claude-01', shellId: 'cmd' } });
    const received: string[] = [];
    client.on('event', (ev: string, data: { profileId: string; data: string }) => {
      if (ev === 'session.data' && data.profileId === profile.id) received.push(data.data);
    });
    const att = await client.call<{ session: SessionInfo; snapshot: string }>('sessions.attach', { profileId: profile.id, cols: 100, rows: 30 });
    expect(att.session.state).toBe('running');
    client.notify('sessions.write', { profileId: profile.id, data: 'echo PERSIST_ME_%OMNITERMINAL_PROFILE%\r' });
    await waitFor(() => received.join('').includes('PERSIST_ME_Claude-01'));
  });

  it('GUI closes → session keeps running; GUI reopens → reconnects to the same session', async () => {
    // Simulate the GUI process dying: drop every connection without goodbye.
    for (const c of clients.splice(0)) c.close();
    await new Promise((r) => setTimeout(r, 500));

    const { client, spawned } = await gui('reopened-gui');
    expect(spawned).toBe(false);
    expect(client.hello?.pid).toBe(firstPid);
    const state = await client.call<AppState>('app.getState');
    const s = state.sessions.find((x) => x.profileId === profile.id);
    expect(s?.state).toBe('running');
    expect(s?.attachedClients).toBe(0); // shown as "Disconnected" in the GUI

    const att = await client.call<{ session: SessionInfo; snapshot: string }>('sessions.attach', { profileId: profile.id, cols: 100, rows: 30, autoStart: false });
    expect(att.session.sessionId).toBe(s?.sessionId);
    expect(att.snapshot).toContain('PERSIST_ME_Claude-01');

    client.notify('sessions.write', { profileId: profile.id, data: 'echo STILL_ALIVE\r' });
    await waitFor(async () => (await screenText(client, profile.id)).includes('STILL_ALIVE\r') || /STILL_ALIVE[\s\S]*STILL_ALIVE/.test(await screenText(client, profile.id)));
  });

  it('two GUIs can watch the same terminal; profiles remain independent', async () => {
    const { client: a } = await gui('gui-a');
    const { client: b } = await gui('gui-b');
    const other = await a.call<Profile>('profiles.create', { profile: { name: 'Terminal 02', shellId: 'cmd', env: [{ name: 'WHO', value: 'two', secret: false }] } });
    await a.call('sessions.attach', { profileId: other.id });
    await b.call('sessions.attach', { profileId: other.id });
    const gotB: string[] = [];
    b.on('event', (ev: string, d: { profileId: string; data: string }) => ev === 'session.data' && d.profileId === other.id && gotB.push(d.data));
    a.notify('sessions.write', { profileId: other.id, data: 'echo WHO=%WHO%\r' });
    await waitFor(() => gotB.join('').includes('WHO=two'));
    const t1 = await screenText(a, profile.id);
    expect(t1).not.toContain('WHO=two');
  });

  it('validation errors come back as RPC errors', async () => {
    const { client } = await gui();
    await expect(client.call('profiles.create', { profile: { name: '' } })).rejects.toThrow(/empty/);
    await expect(client.call('nope.method')).rejects.toThrow(/Unknown method/);
  });

  it('"Exit completely" stops all sessions and the manager', async () => {
    const { client } = await gui();
    const pids = (await client.call<AppState>('app.getState')).sessions.map((s) => s.pid);
    expect(pids.length).toBeGreaterThan(0);
    const closed = new Promise((r) => client.once('close', r));
    await client.call('daemon.shutdown');
    await closed;
    await waitFor(() => {
      try {
        process.kill(firstPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 15000);
    for (const pid of pids) {
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 10000);
    }
    expect(fs.existsSync(paths.daemonInfo)).toBe(false);
  });

  it('after a session-manager crash, orphan records are cleaned up and profiles survive', async () => {
    const { client, spawned } = await gui();
    expect(spawned).toBe(true);
    const p = await client.call<Profile>('profiles.create', { profile: { name: 'Crashy', shellId: 'cmd' } });
    const info = await client.call<SessionInfo>('sessions.start', { profileId: p.id });
    await new Promise((r) => setTimeout(r, 2500)); // let pid start time be recorded
    const daemonPid = client.hello!.pid;
    process.kill(daemonPid); // hard kill: simulates a crash
    await waitFor(() => !client.connected, 10000);
    await waitFor(() => {
      try {
        process.kill(info.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 15000).catch(() => undefined); // ConPTY normally takes the shell down with its owner

    const { client: c2, spawned: respawned } = await gui('after-crash');
    expect(respawned).toBe(true);
    const state = await c2.call<AppState>('app.getState');
    expect(state.profiles.map((x) => x.name)).toEqual(expect.arrayContaining(['Claude-01', 'Terminal 02', 'Crashy']));
    expect(state.sessions).toHaveLength(0);
    let alive = true;
    try {
      process.kill(info.pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
