import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEnvironment } from '../src/daemon/env/environmentManager';
import { Db } from '../src/daemon/persistence/db';
import { nullLogger } from '../src/daemon/log';
import { makeService, type TestContext } from './helpers';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await makeService();
});
afterEach(async () => {
  await ctx.cleanup();
});

const pm = () => ctx.service.profiles;

describe('creating profiles', () => {
  it('creates the isolated directory structure and persists to SQLite', async () => {
    const p = await pm().create({ name: 'Terminal 01', cwd: 'C:\\', shellId: 'cmd' });
    expect(p.slug).toBe('terminal-01');
    expect(p.dir).toBe(path.join(ctx.paths.profiles, 'terminal-01'));
    for (const sub of ['config', 'credentials', 'history', 'logs', 'cache', 'environment']) {
      expect(fs.statSync(path.join(p.dir, sub)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(path.join(p.dir, 'metadata.json'))).toBe(true);
    // Tool config dirs are materialized on creation.
    expect(fs.statSync(path.join(p.dir, 'config', 'claude')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(p.dir, 'config', 'gcloud')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(p.dir, 'config', 'github')).isDirectory()).toBe(true);
    const gitconfig = fs.readFileSync(path.join(p.dir, 'config', 'git', '.gitconfig'), 'utf8');
    expect(gitconfig).toContain('namespace = omniterminal-terminal-01');

    ctx.service.db.flush();
    const reopened = await Db.open(ctx.paths.db, nullLogger);
    expect(reopened.all('SELECT name FROM profiles').map((r) => r.name)).toEqual(['Terminal 01']);
    reopened.close();
  });

  it('supports many profiles with no artificial limit', async () => {
    for (let i = 1; i <= 40; i++) await pm().create({ name: `Terminal ${String(i).padStart(2, '0')}` });
    expect(pm().list()).toHaveLength(40);
    expect(new Set(pm().list().map((p) => p.dir)).size).toBe(40);
  });

  it('rejects invalid and duplicate names', async () => {
    await expect(pm().create({ name: '' })).rejects.toThrow(/empty/);
    await expect(pm().create({ name: 'x'.repeat(100) })).rejects.toThrow(/exceed/);
    await expect(pm().create({ name: 'a\u0007b' })).rejects.toThrow(/control/);
    await pm().create({ name: 'Company A' });
    await expect(pm().create({ name: 'company a' })).rejects.toThrow(/already exists/);
  });

  it('keeps traversal-looking names inside the profiles root', async () => {
    const p = await pm().create({ name: '..\\..\\..\\Windows' });
    expect(p.dir.startsWith(ctx.paths.profiles + path.sep)).toBe(true);
    expect(p.slug).toBe('windows');
  });

  it('gives colliding slugs unique directories', async () => {
    const a = await pm().create({ name: 'Client X' });
    const b = await pm().create({ name: 'Client-X' });
    expect(a.slug).toBe('client-x');
    expect(b.slug).toBe('client-x-2');
  });

  it('rejects custom mappings that escape the profile directory', async () => {
    await expect(
      pm().create({ name: 'Bad', customMappings: [{ envVar: 'MY_CFG', path: '..\\..\\escape', kind: 'dir' }] }),
    ).rejects.toThrow(/traversal|escapes/);
    await expect(
      pm().create({ name: 'Bad2', customMappings: [{ envVar: 'CLAUDE_CONFIG_DIR', path: 'x', kind: 'dir' }] }),
    ).rejects.toThrow(/built-in/);
    const ok = await pm().create({ name: 'Good', customMappings: [{ envVar: 'MY_CFG', path: 'config/mytool', kind: 'dir' }] });
    expect(ok.customMappings).toEqual([{ envVar: 'MY_CFG', path: 'config/mytool', kind: 'dir' }]);
  });
});

describe('renaming and deleting', () => {
  it('renames without moving the directory', async () => {
    const p = await pm().create({ name: 'Old Name' });
    const r = await pm().rename(p.id, 'New Name');
    expect(r.name).toBe('New Name');
    expect(r.dir).toBe(p.dir);
    const meta = JSON.parse(fs.readFileSync(path.join(p.dir, 'metadata.json'), 'utf8'));
    expect(meta.profile.name).toBe('New Name');
    await expect(pm().rename(p.id, '   ')).rejects.toThrow();
  });

  it('deletes the profile and its private directory', async () => {
    const p = await pm().create({ name: 'Doomed' });
    fs.writeFileSync(path.join(p.dir, 'config', 'claude', '.credentials.json'), '{"token":"x"}');
    await ctx.service.handle('profiles.delete', { id: p.id }, 'test');
    expect(pm().find(p.id)).toBeNull();
    expect(fs.existsSync(p.dir)).toBe(false);
    // Other profiles' directories are untouched.
    expect(fs.existsSync(ctx.paths.profiles)).toBe(true);
  });
});

describe('secrets', () => {
  it('never stores secret values in SQLite or metadata, and never returns them', async () => {
    const p = await pm().create({
      name: 'Secretive',
      env: [
        { name: 'API_ENV', value: 'clientA', secret: false },
        { name: 'API_KEY', value: 'super-secret-value-123', secret: true },
      ],
    });
    expect(p.env.find((v) => v.name === 'API_KEY')).toEqual({ name: 'API_KEY', value: '', secret: true, hasValue: true });
    ctx.service.db.flush();
    expect(fs.readFileSync(ctx.paths.db).includes(Buffer.from('super-secret-value-123'))).toBe(false);
    expect(fs.readFileSync(path.join(p.dir, 'metadata.json'), 'utf8')).not.toContain('super-secret-value-123');
    const store = fs.readFileSync(path.join(p.dir, 'credentials', 'secrets.dpapi.json'), 'utf8');
    expect(store).not.toContain('super-secret-value-123');
    expect(JSON.stringify(ctx.service.state())).not.toContain('super-secret-value-123');
  });

  it('keeps an existing secret when the GUI sends an empty value, and deletes removed secrets', async () => {
    const p = await pm().create({ name: 'S', env: [{ name: 'TOKEN', value: 'abcd1234', secret: true }] });
    await pm().update(p.id, { env: [{ name: 'TOKEN', value: '', secret: true }] });
    const built = buildEnvironment({
      profile: pm().get(p.id),
      sessionId: 's',
      secrets: await (ctx.service.sessions as any).secrets.getAll(p.dir, p.id, ['TOKEN']),
      baseEnv: {},
      registry: null,
    });
    expect(built.env.TOKEN).toBe('abcd1234');
    await pm().update(p.id, { env: [] });
    const store = JSON.parse(fs.readFileSync(path.join(p.dir, 'credentials', 'secrets.dpapi.json'), 'utf8'));
    expect(Object.keys(store.entries)).toEqual([]);
  });
});

describe('duplicate', () => {
  it('copies configuration but never credentials, secrets or history', async () => {
    const src = await pm().create({
      name: 'Claude-01',
      cwd: 'C:\\Projects',
      shellId: 'cmd',
      startupCommand: 'claude',
      env: [
        { name: 'PROJECT', value: 'alpha', secret: false },
        { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-secret-should-not-copy', secret: true },
      ],
      appearance: { fontSize: 16 } as never,
    });
    // Simulate logged-in tools and history in the source terminal.
    fs.writeFileSync(path.join(src.dir, 'config', 'claude', '.credentials.json'), '{"claudeAiOauth":"tok"}');
    fs.writeFileSync(path.join(src.dir, 'config', 'gcloud', 'credentials.db'), 'gcloud-creds');
    fs.writeFileSync(path.join(src.dir, 'config', 'github', 'hosts.yml'), 'oauth_token: gho_x');
    fs.appendFileSync(path.join(src.dir, 'config', 'git', '.gitconfig'), '\n[user]\n\tname = Src\n');
    fs.writeFileSync(path.join(src.dir, 'history', 'powershell_history.txt'), 'secret command');

    const dup = await pm().duplicate(src.id);
    expect(dup.name).toBe('Claude-01 copy');
    expect(dup.id).not.toBe(src.id);
    expect(dup.dir).not.toBe(src.dir);
    expect(dup.cwd).toBe('C:\\Projects');
    expect(dup.startupCommand).toBe('claude');
    expect(dup.appearance.fontSize).toBe(16);
    expect(dup.env).toEqual([
      { name: 'PROJECT', value: 'alpha', secret: false },
      { name: 'ANTHROPIC_API_KEY', value: '', secret: true, hasValue: false },
    ]);

    expect(fs.existsSync(path.join(dup.dir, 'config', 'claude', '.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.join(dup.dir, 'config', 'gcloud', 'credentials.db'))).toBe(false);
    expect(fs.existsSync(path.join(dup.dir, 'config', 'github', 'hosts.yml'))).toBe(false);
    expect(fs.existsSync(path.join(dup.dir, 'history', 'powershell_history.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dup.dir, 'credentials', 'secrets.dpapi.json'))).toBe(false);
    const dupGit = fs.readFileSync(path.join(dup.dir, 'config', 'git', '.gitconfig'), 'utf8');
    expect(dupGit).not.toContain('name = Src');
    expect(dupGit).toContain(`namespace = omniterminal-${dup.slug}`);
  });
});

describe('import / export', () => {
  it('exports configuration only and never secrets', async () => {
    await pm().create({
      name: 'Exp',
      env: [
        { name: 'A', value: '1', secret: false },
        { name: 'SECRET_TOKEN', value: 'do-not-export-me', secret: true },
      ],
    });
    const json = (await ctx.service.handle('profiles.export', {}, 'test')) as string;
    expect(json).not.toContain('do-not-export-me');
    const bundle = JSON.parse(json);
    expect(bundle.format).toBe('omniterminal-export');
    expect(bundle.profiles[0].env).toEqual([
      { name: 'A', value: '1', secret: false },
      { name: 'SECRET_TOKEN', value: null, secret: true },
    ]);
  });

  it('imports as new profiles with unique names and ignores smuggled secret values', async () => {
    await pm().create({ name: 'Exp' });
    const bundle = {
      format: 'omniterminal-export',
      version: 1,
      exportedAt: '',
      note: '',
      profiles: [{ ...pm().exportProfiles().profiles[0], env: [{ name: 'K', value: 'smuggled', secret: true }] }],
    };
    const created = await pm().importProfiles(JSON.stringify(bundle));
    expect(created[0].name).toBe('Exp 2');
    expect(created[0].env[0]).toEqual({ name: 'K', value: '', secret: true, hasValue: false });
    await expect(pm().importProfiles('{"format":"nope"}')).rejects.toThrow(/Not an OmniTerminal/);
    await expect(pm().importProfiles('not json')).rejects.toThrow(/valid JSON/);
  });
});

describe('environment and config isolation', () => {
  it('gives every terminal different tool config locations and its own variables', async () => {
    const a = await pm().create({ name: 'Terminal A', env: [{ name: 'API_ENV', value: 'clientA', secret: false }, { name: 'PROJECT', value: 'projectA', secret: false }] });
    const b = await pm().create({ name: 'Terminal B', env: [{ name: 'API_ENV', value: 'clientB', secret: false }, { name: 'PROJECT', value: 'projectB', secret: false }] });
    const base = { Path: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: 'C:\\global\\.claude', USERPROFILE: 'C:\\Users\\me' };
    const ea = buildEnvironment({ profile: a, sessionId: '1', secrets: {}, baseEnv: base, registry: null }).env;
    const eb = buildEnvironment({ profile: b, sessionId: '2', secrets: {}, baseEnv: base, registry: null }).env;

    for (const v of ['CLAUDE_CONFIG_DIR', 'CLOUDSDK_CONFIG', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'GCM_NAMESPACE', 'AZURE_CONFIG_DIR', 'HISTFILE']) {
      expect(ea[v], v).toBeTruthy();
      expect(ea[v], v).not.toBe(eb[v]);
    }
    expect(ea.CLAUDE_CONFIG_DIR).toBe(path.join(a.dir, 'config', 'claude'));
    expect(ea.CLOUDSDK_CONFIG).toBe(path.join(a.dir, 'config', 'gcloud'));
    expect(ea.GH_CONFIG_DIR).toBe(path.join(a.dir, 'config', 'github'));
    expect(ea.GIT_CONFIG_GLOBAL).toBe(path.join(a.dir, 'config', 'git', '.gitconfig'));
    expect(ea.API_ENV).toBe('clientA');
    expect(eb.API_ENV).toBe('clientB');
    expect(eb.PROJECT).toBe('projectB');
    // Session-manager internals never leak into terminals.
    expect(ea.ELECTRON_RUN_AS_NODE).toBeUndefined();
    // Full access: inherited user environment is preserved (no sandbox).
    expect(ea.Path).toBe('C:\\Windows');
    expect(ea.USERPROFILE).toBe('C:\\Users\\me');
  });

  it('respects tool toggles and forwards variables into WSL', async () => {
    const p = await pm().create({ name: 'W', tools: { claude: false }, env: [{ name: 'X1', value: 'y', secret: false }] });
    const e = buildEnvironment({ profile: p, sessionId: '1', secrets: {}, baseEnv: {}, registry: null, isWsl: true }).env;
    expect(e.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(e.WSLENV.split(':')).toEqual(expect.arrayContaining(['HISTFILE/p', 'X1']));
  });
});

describe('crash recovery', () => {
  it('rebuilds the profile registry from metadata.json when the database is lost', async () => {
    const p = await pm().create({ name: 'Survivor', cwd: 'C:\\x' });
    await ctx.service.shutdown();
    fs.writeFileSync(ctx.paths.db, 'this is not a sqlite database');
    fs.rmSync(ctx.paths.db + '.bak', { force: true });
    const home = ctx.paths.home;
    const ctx2 = await makeService(home);
    const restored = ctx2.service.profiles.find(p.id);
    expect(restored?.name).toBe('Survivor');
    expect(restored?.cwd).toBe('C:\\x');
    ctx = ctx2;
  });
});
