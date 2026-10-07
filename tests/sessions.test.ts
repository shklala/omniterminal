import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dpapiCrypto } from '../src/daemon/credentials/secretStore';
import { makeService, waitFor, type TestContext } from './helpers';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});

const text = (profileId: string) => ctx.service.sessions.textContent(profileId);

async function runAndWait(profileId: string, command: string, expected: string | RegExp, timeoutMs = 20000) {
  ctx.service.sessions.write(profileId, command + '\r');
  await waitFor(async () => {
    const t = await text(profileId);
    return typeof expected === 'string' ? t.includes(expected) : expected.test(t);
  }, timeoutMs);
}

describe('PTY sessions (cmd)', () => {
  beforeEach(async () => {
    ctx = await makeService();
  });

  it('launches a real ConPTY session and runs commands', async () => {
    const p = await ctx.service.profiles.create({ name: 'Cmd', shellId: 'cmd', cwd: process.env.USERPROFILE });
    const info = await ctx.service.sessions.start(p.id, { cols: 100, rows: 30 });
    expect(info.state).toBe('running');
    expect(info.pid).toBeGreaterThan(0);
    await runAndWait(p.id, 'echo OMNI_%OMNITERMINAL_PROFILE%_OK', 'OMNI_Cmd_OK');
    // Starting is idempotent: same session id.
    expect((await ctx.service.sessions.start(p.id)).sessionId).toBe(info.sessionId);
  });

  it('isolates environment and config dirs between simultaneous sessions', async () => {
    const profiles = [];
    for (let i = 1; i <= 5; i++) {
      profiles.push(
        await ctx.service.profiles.create({
          name: `Terminal 0${i}`,
          shellId: 'cmd',
          env: [{ name: 'API_ENV', value: `client${i}`, secret: false }],
        }),
      );
    }
    await Promise.all(profiles.map((p) => ctx.service.sessions.start(p.id)));
    expect(ctx.service.sessions.runningCount).toBe(5);
    const pids = new Set(ctx.service.sessions.list().map((s) => s.pid));
    expect(pids.size).toBe(5);

    await Promise.all(
      profiles.map((p, i) => runAndWait(p.id, 'echo [%API_ENV%] [%CLAUDE_CONFIG_DIR%]', `[client${i + 1}] [${path.join(p.dir, 'config', 'claude')}]`)),
    );
    // Starting Terminal 02 never changed Terminal 01: check 01 again after all others started.
    await runAndWait(profiles[0].id, 'echo AGAIN=%API_ENV%=%GH_CONFIG_DIR%', `AGAIN=client1=${path.join(profiles[0].dir, 'config', 'github')}`);

    await ctx.service.sessions.stop(profiles[1].id);
    expect(ctx.service.sessions.get(profiles[1].id)).toBeUndefined();
    expect(ctx.service.sessions.get(profiles[0].id)?.alive).toBe(true);
  });

  it('reconnects: a new attach receives a snapshot of everything printed before', async () => {
    const p = await ctx.service.profiles.create({ name: 'Recon', shellId: 'cmd' });
    const first = await ctx.service.sessions.attach(p.id, 'client-1', { cols: 90, rows: 25 }, true);
    expect(first.session.attachedClients).toBe(1);
    await runAndWait(p.id, 'echo BEFORE_DISCONNECT_MARKER', /BEFORE_DISCONNECT_MARKER[\s\S]*BEFORE_DISCONNECT_MARKER/);

    // GUI crashes (ungraceful): session must survive.
    ctx.service.sessions.detachClient('client-1', false);
    const s = ctx.service.sessions.get(p.id)!;
    expect(s.alive).toBe(true);
    expect(s.attachedCount).toBe(0);

    // Output produced while nobody is attached is still captured.
    ctx.service.sessions.write(p.id, 'echo WHILE_DETACHED_MARKER\r');
    await waitFor(async () => (await text(p.id)).includes('WHILE_DETACHED_MARKER\r') || /WHILE_DETACHED_MARKER[\s\S]*WHILE_DETACHED_MARKER/.test(await text(p.id)));

    const second = await ctx.service.sessions.attach(p.id, 'client-2', { cols: 90, rows: 25 }, false);
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(second.snapshot).toContain('BEFORE_DISCONNECT_MARKER');
    expect(second.snapshot).toContain('WHILE_DETACHED_MARKER');
  });

  it('stops non-persistent sessions only on graceful GUI close', async () => {
    const p = await ctx.service.profiles.create({ name: 'Ephemeral', shellId: 'cmd', advanced: { persistSession: false } as never });
    await ctx.service.sessions.attach(p.id, 'gui', undefined, true);
    ctx.service.sessions.detachClient('gui', false); // crash
    expect(ctx.service.sessions.get(p.id)?.alive).toBe(true);
    await ctx.service.sessions.attach(p.id, 'gui2', undefined, false);
    ctx.service.sessions.detachClient('gui2', true); // graceful close
    await waitFor(() => !ctx.service.sessions.get(p.id));
  });

  it('records exit codes and restarts with a new session id', async () => {
    const p = await ctx.service.profiles.create({ name: 'Exiter', shellId: 'cmd' });
    const a = await ctx.service.sessions.start(p.id);
    ctx.service.sessions.write(p.id, 'exit 3\r');
    await waitFor(() => ctx.events.exits.some((e) => e.profileId === p.id));
    expect(ctx.events.exits.find((e) => e.profileId === p.id)?.exitCode).toBe(3);
    expect(ctx.service.sessions.list()[0].state).toBe('exited');
    const b = await ctx.service.sessions.restart(p.id);
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.state).toBe('running');
    const rows = ctx.service.db.all('SELECT status, exit_code FROM sessions WHERE id = ?', [a.sessionId]);
    expect(rows[0]).toMatchObject({ status: 'exited', exit_code: 3 });
  });

  it('reports per-terminal resource usage of the process tree', async () => {
    const p = await ctx.service.profiles.create({ name: 'Stats', shellId: 'cmd' });
    await ctx.service.sessions.start(p.id);
    ctx.service.sessions.write(p.id, 'ping -n 30 127.0.0.1 >nul\r');
    await waitFor(async () => {
      const st = await ctx.service.handle('sessions.stats', {}, 't') as Record<string, { memory: number; processes: number; children: string[] }>;
      return !!st[p.id] && st[p.id].children.includes('PING');
    }, 20000, 2100);
    const st = (await ctx.service.handle('sessions.stats', {}, 't')) as Record<string, { memory: number; processes: number }>;
    expect(st[p.id].memory).toBeGreaterThan(1024 * 1024);
    expect(st[p.id].processes).toBeGreaterThanOrEqual(2);
  });

  it('runs a startup command', async () => {
    const p = await ctx.service.profiles.create({ name: 'Startup', shellId: 'cmd', startupCommand: 'echo STARTUP_RAN_%OMNITERMINAL%' });
    await ctx.service.sessions.start(p.id);
    await waitFor(async () => (await text(p.id)).includes('STARTUP_RAN_1'));
  });
});

describe('secrets (real Windows DPAPI)', () => {
  beforeEach(async () => {
    ctx = await makeService(undefined, dpapiCrypto);
  });

  it('encrypts at rest and injects only into its own terminal', async () => {
    const a = await ctx.service.profiles.create({ name: 'SecA', shellId: 'cmd', env: [{ name: 'MY_TOKEN', value: 'tokA-9f8e7d', secret: true }] });
    const b = await ctx.service.profiles.create({ name: 'SecB', shellId: 'cmd' });
    const store = fs.readFileSync(path.join(a.dir, 'credentials', 'secrets.dpapi.json'), 'utf8');
    expect(store).not.toContain('tokA-9f8e7d');
    expect(JSON.parse(store).algorithm).toBe('dpapi-currentuser');

    await ctx.service.sessions.start(a.id);
    await ctx.service.sessions.start(b.id);
    await runAndWait(a.id, 'echo VAL=[%MY_TOKEN%]', 'VAL=[tokA-9f8e7d]');
    await runAndWait(b.id, 'echo VAL=[%MY_TOKEN%]', 'VAL=[%MY_TOKEN%]');

    // Session manager log never contains the secret.
    ctx.service.db.flush();
    const logText = fs.readFileSync(path.join(ctx.paths.logs, 'test.log'), 'utf8');
    expect(logText).not.toContain('tokA-9f8e7d');
  });

  it('cannot decrypt a blob moved to another terminal (per-profile entropy)', async () => {
    const a = await ctx.service.profiles.create({ name: 'E1', env: [{ name: 'K', value: 'value-1234', secret: true }] });
    const b = await ctx.service.profiles.create({ name: 'E2', env: [{ name: 'K', value: '', secret: true }] });
    fs.copyFileSync(path.join(a.dir, 'credentials', 'secrets.dpapi.json'), path.join(b.dir, 'credentials', 'secrets.dpapi.json'));
    await expect(dpapiCrypto.unprotect([JSON.parse(fs.readFileSync(path.join(b.dir, 'credentials', 'secrets.dpapi.json'), 'utf8')).entries.K], `OmniTerminal/v1/${b.id}`)).rejects.toThrow();
  });
});

describe('PowerShell per-terminal history', () => {
  beforeEach(async () => {
    ctx = await makeService();
  });

  it('writes PSReadLine history to each terminal\'s own file', async () => {
    const a = await ctx.service.profiles.create({ name: 'PsA', shellId: 'powershell' });
    const b = await ctx.service.profiles.create({ name: 'PsB', shellId: 'powershell' });
    await ctx.service.sessions.start(a.id);
    await ctx.service.sessions.start(b.id);
    await waitFor(async () => /PS .*>/.test(await text(a.id)) && /PS .*>/.test(await text(b.id)), 40000);
    await runAndWait(a.id, 'echo "only-in-A-$($env:OMNITERMINAL_PROFILE)"', 'only-in-A-PsA', 30000);
    await runAndWait(b.id, 'echo "only-in-B-$($env:OMNITERMINAL_PROFILE)"', 'only-in-B-PsB', 30000);
    const ha = path.join(a.dir, 'history', 'powershell_history.txt');
    const hb = path.join(b.dir, 'history', 'powershell_history.txt');
    await waitFor(() => fs.existsSync(ha) && fs.existsSync(hb), 10000);
    expect(fs.readFileSync(ha, 'utf8')).toContain('only-in-A');
    expect(fs.readFileSync(ha, 'utf8')).not.toContain('only-in-B');
    expect(fs.readFileSync(hb, 'utf8')).toContain('only-in-B');
    expect(fs.readFileSync(hb, 'utf8')).not.toContain('only-in-A');
  }, 90000);
});
