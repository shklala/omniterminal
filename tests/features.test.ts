import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { iniValue } from '../src/daemon/profiles/accounts';
import { sshEnvironment } from '../src/daemon/env/ssh';
import { installPsReadLine, isPsReadLineInstalled } from '../src/daemon/windows/psreadline';
import { makeService, tempHome, waitFor, type TestContext } from './helpers';

let ctx: TestContext | null = null;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
});

const call = (method: string, params: unknown = {}) => ctx!.service.handle(method, params, 'test');

describe('Who am I (accounts read from a terminal\'s own files)', () => {
  it('reads accounts per tool and reports tokens without their values', async () => {
    ctx = await makeService();
    const p = await ctx.service.profiles.create({ name: 'Acct', env: [{ name: 'GH_TOKEN', value: 'ghp_secretvalue123', secret: true }] });
    await ctx.service.sessions.environmentFor(p.id); // creates the config folders
    const cfg = (...x: string[]) => path.join(p.dir, 'config', ...x);
    fs.writeFileSync(cfg('claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Acme' } }));
    fs.writeFileSync(cfg('github', 'hosts.yml'), 'github.com:\n    git_protocol: https\n    user: octo-me\n');
    fs.appendFileSync(cfg('git', '.gitconfig'), '\n[user]\n\tname = Omar Test\n\temail = omar@test.dev\n');
    fs.mkdirSync(cfg('gcloud', 'configurations'), { recursive: true });
    fs.writeFileSync(cfg('gcloud', 'active_config'), 'work');
    fs.writeFileSync(cfg('gcloud', 'configurations', 'config_work'), '[core]\naccount = dev@corp.com\nproject = proj-1\n');
    fs.writeFileSync(cfg('azure', 'azureProfile.json'), '\uFEFF' + JSON.stringify({ subscriptions: [{ isDefault: true, name: 'Pay-As-You-Go', user: { name: 'az@corp.com' } }] }));
    fs.writeFileSync(cfg('kube', 'config'), 'apiVersion: v1\ncurrent-context: prod-cluster\n');
    fs.writeFileSync(cfg('npm', '.npmrc'), '//registry.npmjs.org/:_authToken=npm_secret\n');

    const list = (await call('profiles.accounts', { id: p.id })) as { toolId: string; account: string | null; tokens: string[] }[];
    const by = (id: string) => list.find((a) => a.toolId === id);
    expect(by('claude')?.account).toBe('me@example.com (Acme)');
    expect(by('gh')?.account).toBe('octo-me');
    expect(by('gh')?.tokens).toEqual(['GitHub token']);
    expect(by('git')?.account).toBe('Omar Test <omar@test.dev>');
    expect(by('gcloud')?.account).toBe('dev@corp.com (project proj-1)');
    expect(by('azure')?.account).toBe('az@corp.com (Pay-As-You-Go)');
    expect(by('kube')?.account).toBe('context prod-cluster');
    expect(by('npm')?.account).toBe('Signed in to registry.npmjs.org');
    // Token values never leave the session manager.
    expect(JSON.stringify(list)).not.toMatch(/ghp_secretvalue123|npm_secret/);
  });

  it('parses INI sections case-insensitively and ignores comments', () => {
    expect(iniValue('# [user]\n[User]\n  Email = "a@b.c"\n[core]\nemail = x', 'user', 'email')).toBe('a@b.c');
    expect(iniValue('[user]\n# email = no', 'user', 'email')).toBeNull();
  });

  it('runs a tool\'s own account command and explains a missing tool', async () => {
    ctx = await makeService();
    const p = await ctx.service.profiles.create({ name: 'Who' });
    const out = (await call('profiles.whoami', { id: p.id, toolId: 'railway' })) as string;
    // railway is not installed on test machines.
    expect(out).toMatch(/railway is not installed|railway/i);
    await expect(call('profiles.whoami', { id: p.id, toolId: 'git' })).rejects.toThrow(/no account command/);
  }, 30000);
});

describe('Snippets and workspaces', () => {
  it('saves, validates and deletes snippets', async () => {
    ctx = await makeService();
    const p = await ctx.service.profiles.create({ name: 'Snip' });
    const s = (await call('snippets.save', { snippet: { name: 'Tests', command: 'npm test', profileId: p.id } })) as { id: string; run: boolean };
    expect(s.run).toBe(true);
    await call('snippets.save', { snippet: { id: s.id, name: 'Tests (watch)', command: 'npm test -- --watch', profileId: null, run: false } });
    const st = (await call('app.getState')) as { snippets: { name: string; profileId: string | null; run: boolean }[] };
    expect(st.snippets).toEqual([expect.objectContaining({ name: 'Tests (watch)', profileId: null, run: false })]);
    await expect(call('snippets.save', { snippet: { name: 'Bad\nname', command: 'x' } })).rejects.toThrow(/control characters/);
    await expect(call('snippets.save', { snippet: { name: 'Empty', command: '   ' } })).rejects.toThrow(/1 to 4000/);
    await expect(call('snippets.save', { snippet: { name: 'Gone', command: 'x', profileId: 'nope' } })).rejects.toThrow(/no longer exists/);
    await call('snippets.delete', { id: s.id });
    expect(((await call('app.getState')) as { snippets: unknown[] }).snippets).toEqual([]);
  });

  it('saves workspaces of split tabs and rejects unknown terminals', async () => {
    ctx = await makeService();
    const a = await ctx.service.profiles.create({ name: 'Api' });
    const b = await ctx.service.profiles.create({ name: 'Web' });
    const ws = (await call('workspaces.save', {
      workspace: { name: 'Client A', tabs: [{ direction: 'row', panes: [{ profileId: a.id, another: false }, { profileId: b.id, another: false }] }, { direction: 'sideways', panes: [{ profileId: a.id, another: true }] }] },
    })) as { id: string; tabs: { direction: string }[] };
    expect(ws.tabs.map((t) => t.direction)).toEqual(['row', 'row']);
    await expect(call('workspaces.save', { workspace: { name: 'X', tabs: [{ panes: [{ profileId: 'missing' }] }] } })).rejects.toThrow(/no longer exists/);
    await expect(call('workspaces.save', { workspace: { name: 'X', tabs: [{ panes: Array(5).fill({ profileId: a.id }) }] } })).rejects.toThrow(/1 to 4/);
    await call('workspaces.delete', { id: ws.id });
    expect(((await call('app.getState')) as { workspaces: unknown[] }).workspaces).toEqual([]);
  });

  it('validates the new settings', async () => {
    ctx = await makeService();
    const s = (await call('settings.set', { settings: { keybindings: { 'app.palette': 'Ctrl+K', 'pane.splitRight': '' }, notifyAfterSeconds: 30, language: 'de' } })) as Record<string, unknown>;
    expect(s.keybindings).toEqual({ 'app.palette': 'Ctrl+K', 'pane.splitRight': '' });
    expect(s.notifyAfterSeconds).toBe(30);
    await expect(call('settings.set', { settings: { keybindings: ['x'] } })).rejects.toThrow();
    await expect(call('settings.set', { settings: { keybindings: { 'bad key!': 'x' } } })).rejects.toThrow();
    await expect(call('settings.set', { settings: { notifyAfterSeconds: -1 } })).rejects.toThrow();
    await expect(call('settings.set', { settings: { language: 'xx' } })).rejects.toThrow(/language/);
  });
});

describe('SSH key per terminal', () => {
  it('changes nothing until a key exists, then points Git and ssh at the terminal\'s own key', async () => {
    ctx = await makeService();
    const p = await ctx.service.profiles.create({ name: 'Ssh', tools: { 'ssh-key': true } });
    expect(sshEnvironment(p)).toEqual({});
    const st = (await call('ssh.createKey', { id: p.id })) as { hasKey: boolean; publicKey: string };
    expect(st.hasKey).toBe(true);
    expect(st.publicKey).toMatch(/^ssh-ed25519 \S+ ssh@omniterminal$/);
    const env = sshEnvironment(p);
    expect(env.GIT_SSH_COMMAND).toMatch(/^ssh -F ".*\/config\/ssh\/config"$/);
    // Windows OpenSSH resolves the terminal's key and known_hosts from that config.
    const ssh = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    const resolved = execFileSync(ssh, ['-G', '-F', env.OMNITERMINAL_SSH_CONFIG, 'github.com'], { encoding: 'utf8' });
    expect(resolved.toLowerCase()).toContain(`identityfile ${path.join(p.dir, 'config', 'ssh', 'id_ed25519').replace(/\\/g, '/').toLowerCase()}`);
    expect(resolved).toMatch(/identitiesonly yes/);
    await expect(call('ssh.createKey', { id: p.id })).rejects.toThrow(/already has/);
    // A terminal without the tool switched on gets nothing.
    const q = await ctx.service.profiles.create({ name: 'NoSsh' });
    expect(sshEnvironment(q)).toEqual({});
  }, 30000);
});

describe('Turn on suggestions (PSReadLine download)', () => {
  it('installs a verified package and refuses one with the wrong checksum', async () => {
    const work = tempHome();
    const src = path.join(work, 'pkg');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'PSReadLine.psd1'), "@{ ModuleVersion = '2.3.6' }");
    fs.mkdirSync(path.join(src, '_rels'));
    fs.writeFileSync(path.join(src, '_rels', '.rels'), 'x');
    const zip = path.join(work, 'pkg.zip');
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', src, '.']);
    const body = fs.readFileSync(zip);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const server = http.createServer((_req, res) => res.end(body));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/p`;
    try {
      const modules = path.join(work, 'modules');
      await expect(installPsReadLine(modules, { url, sha256: '0'.repeat(64) })).rejects.toThrow(/checksum/);
      expect(isPsReadLineInstalled(modules)).toBe(false);
      await installPsReadLine(modules, { url, sha256: sha });
      expect(isPsReadLineInstalled(modules)).toBe(true);
      expect(fs.existsSync(path.join(modules, 'PSReadLine', '2.3.6', '_rels'))).toBe(false);
    } finally {
      server.close();
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('Restore and update hand-off', () => {
  it('says so when a terminal that ran as administrator comes back without it', async () => {
    ctx = await makeService();
    const p = await ctx.service.profiles.create({ name: 'WasAdmin', shellId: 'cmd' });
    ctx.service.db.run(
      "INSERT INTO sessions (id, profile_id, pid, pid_start, daemon_pid, started_at, status, elevated) VALUES (?, ?, NULL, NULL, 1, ?, 'running', 1)",
      [crypto.randomUUID(), p.id, Date.now()],
    );
    await ctx.service.sessions.recoverOrphans({ restore: true });
    await waitFor(async () => (await ctx!.service.sessions.textContent(p.id)).includes('WITHOUT administrator rights'), 15000);
  }, 30000);

  it("restores a full-screen program's screen as plain history, without its mouse mode or alternate screen", async () => {
    ctx = await makeService();
    const p = await ctx.service.profiles.create({ name: 'Tui', shellId: 'cmd' });
    const ESC = '\x1b';
    // A screen saved by 1.3.0 while Claude Code was open: mouse tracking, bracketed paste, alternate screen.
    const old = `C:\\> claude\r\n${ESC}[?1049h${ESC}[H${ESC}[1mCHAT_LINE_ONE${ESC}[0m\r\n> my question\r\n  CHAT_ANSWER${ESC}[?2004h${ESC}[?1000h${ESC}[?1006h`;
    fs.mkdirSync(path.join(p.dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(p.dir, 'cache', 'last-screen.ans'), old);
    ctx.service.db.run(
      "INSERT INTO sessions (id, profile_id, pid, pid_start, daemon_pid, started_at, status) VALUES (?, ?, NULL, NULL, 1, ?, 'running')",
      [crypto.randomUUID(), p.id, Date.now()],
    );
    await ctx.service.sessions.recoverOrphans({ restore: true });
    await waitFor(async () => (await ctx!.service.sessions.textContent(p.id)).includes('CHAT_ANSWER'), 15000);
    const { snapshot } = await ctx.service.sessions.attach(p.id, 'gui', undefined, false);
    expect(snapshot).toContain('CHAT_LINE_ONE');
    expect(snapshot).not.toMatch(/\x1b\[\?(1000|1002|1003|1006|1049|2004)h/);
    // The chat stays in scrollback, above the new shell's banner.
    await waitFor(async () => (await ctx!.service.sessions.textContent(p.id)).includes('Microsoft Windows'), 15000);
    const t = await ctx.service.sessions.textContent(p.id);
    expect(t.indexOf('CHAT_ANSWER')).toBeLessThan(t.lastIndexOf('Microsoft Windows'));

    // New snapshots are saved without modes in the first place.
    await ctx.service.sessions.saveSnapshots(true);
    const saved = fs.readFileSync(path.join(p.dir, 'cache', 'last-screen.ans'), 'utf8');
    expect(saved).toContain('CHAT_ANSWER');
    expect(saved).not.toMatch(/\x1b\[\?[0-9;]*[hl]/);
  }, 30000);

  it('hands running terminals to the next session manager with their screens', async () => {
    const home = tempHome();
    const first = await makeService(home);
    const p = await first.service.profiles.create({ name: 'Handoff', shellId: 'cmd', startupCommand: 'echo FIRST_START', restoreCommand: 'echo RESUMED_%OMNITERMINAL_PROFILE%' });
    const info = await first.service.sessions.start(p.id);
    first.service.sessions.write(p.id, 'echo BEFORE_UPDATE_%OMNITERMINAL_PROFILE%\r');
    await waitFor(async () => (await first.service.sessions.textContent(p.id)).includes('BEFORE_UPDATE_Handoff'), 15000);
    await waitFor(() => first.service.db.get('SELECT pid_start FROM sessions WHERE id = ?', [info.sessionId])?.pid_start != null, 15000);
    // In the app the new manager is another process; here both share one, so mark the record as foreign.
    first.service.db.run('UPDATE sessions SET daemon_pid = 1 WHERE id = ?', [info.sessionId]);
    await first.service.handoff();
    expect(fs.readFileSync(path.join(p.dir, 'cache', 'last-screen.ans'), 'utf8')).toContain('BEFORE_UPDATE_Handoff');

    ctx = await makeService(home); // the "new version": restores in init()
    await waitFor(async () => {
      const t = await ctx!.service.sessions.textContent(p.id).catch(() => '');
      return t.includes('BEFORE_UPDATE_Handoff') && t.includes('Restored after restart') && t.includes('RESUMED_Handoff');
    }, 20000);
    expect(ctx.service.sessions.get(p.id)?.sessionId).not.toBe(info.sessionId);
    // The old process was cleaned up by PID + start time.
    await waitFor(() => {
      try {
        process.kill(info.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 15000);
  }, 60000);
});

void os;
