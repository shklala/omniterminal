import * as fs from 'node:fs';
import { APP_VERSION, DEFAULT_APP_SETTINGS } from '../shared/defaults';
import type { AppPaths } from '../shared/paths';
import { LIMITATIONS, TOOL_REGISTRY } from '../shared/tools';
import { THEME_COLOR_KEYS, type AppSettings, type AppState, type CustomTheme, type DaemonInfo, type ProfileInput, type Snippet, type Workspace } from '../shared/types';
import { execFile } from 'node:child_process';
import { getTool } from '../shared/tools';
import { redact } from '../shared/redact';
import { readAccounts } from './profiles/accounts';
import { createSshKey, sshStatus } from './env/ssh';
import { PSREADLINE_VERSION, installPsReadLine, isPsReadLineInstalled } from './windows/psreadline';
import { checkInstalledTools } from './windows/toolCheck';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { ValidationError } from '../shared/validation';
import { SecretStore, dpapiCrypto, type SecretCrypto } from './credentials/secretStore';
import type { Logger } from './log';
import { Db } from './persistence/db';
import { ProfileManager, type ProfileUpdate } from './profiles/profileManager';
import { detectShells } from './pty/shells';
import { SessionManager, type SessionEvents } from './sessions/sessionManager';
import { elevatedShellCommand, getElevationStatus, type ElevationStatus } from './windows/elevation';
import { baseProfileId } from '../shared/sessionKey';

export interface ServiceOptions {
  paths: AppPaths;
  log: Logger;
  events: SessionEvents;
  crypto?: SecretCrypto;
  skipRegistryEnv?: boolean;
  /** Replaces the administrator support check (tests). */
  elevation?: () => Promise<ElevationStatus>;
}

type Size = { cols: number; rows: number } | undefined;

export const SUPPORTED_LANGUAGES = ['en', 'ar', 'es', 'fr', 'de', 'zh'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cleanName(v: unknown, what: string): string {
  const name = String(v ?? '').trim();
  if (/[\u0000-\u001f]/.test(name)) throw new ValidationError(`${what} cannot contain control characters.`);
  if (!name || name.length > 60) throw new ValidationError(`${what} must be 1 to 60 characters.`);
  return name;
}

/** Keybindings from the settings page: known-looking action ids and short key strings only. */
function validKeybindings(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('Invalid keyboard shortcuts');
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z][a-zA-Z0-9.-]{0,40}$/.test(k) || typeof val !== 'string' || val.length > 40) throw new ValidationError('Invalid keyboard shortcut');
    out[k] = val;
  }
  return out;
}

function size(p: Record<string, unknown>): Size {
  const cols = Number(p.cols);
  const rows = Number(p.rows);
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0 ? { cols, rows } : undefined;
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !v) throw new ValidationError(`Missing parameter: ${key}`);
  return v;
}

/**
 * The session manager's application service: owns persistence, profiles, secrets and PTYs,
 * and exposes them as RPC methods. Transport-agnostic (used by the pipe server and by tests).
 */
export class OmniService {
  readonly startedAt = Date.now();
  db!: Db;
  profiles!: ProfileManager;
  sessions!: SessionManager;
  private shutdownHandler: ((handoff: boolean) => void) | null = null;

  constructor(private readonly opts: ServiceOptions) {}

  async init(): Promise<void> {
    const { paths, log } = this.opts;
    fs.mkdirSync(paths.home, { recursive: true });
    this.db = await Db.open(paths.db, log);
    const secrets = new SecretStore(this.opts.crypto ?? dpapiCrypto);
    this.profiles = new ProfileManager(this.db, paths.profiles, secrets, log);
    // Rebuild the registry from per-profile metadata.json if the DB was lost or corrupted.
    this.profiles.recoverFromMetadata();
    this.sessions = new SessionManager(this.db, this.profiles, secrets, log, this.opts.events, {
      skipRegistryEnv: this.opts.skipRegistryEnv,
      elevation: this.opts.elevation,
      modulesDir: this.modulesDir,
    });
    this.sessions.setShells(await detectShells());
    await this.sessions.recoverOrphans({ restore: this.getSettings().restoreAfterRestart });
    this.sessions.snapshotsEnabled = () => this.getSettings().restoreAfterRestart;
    this.sessions.suggestionsEnabled = () => this.getSettings().suggestions;
    this.sessions.resumeClaudeEnabled = () => this.getSettings().resumeClaude;
    this.sessions.startSnapshots(Number(process.env.OMNITERMINAL_SNAPSHOT_MS) || 15_000);
    this.db.flush();
  }

  onShutdownRequested(handler: (handoff: boolean) => void): void {
    this.shutdownHandler = handler;
  }

  get modulesDir(): string {
    return path.join(this.opts.paths.home, 'modules');
  }

  info(): DaemonInfo {
    return { version: APP_VERSION, pid: process.pid, startedAt: this.startedAt, home: this.opts.paths.home };
  }

  getSettings(): AppSettings {
    const rows = this.db.all('SELECT key, value FROM settings');
    const s: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS };
    for (const r of rows) {
      try {
        s[String(r.key)] = JSON.parse(String(r.value));
      } catch {
        /* ignore */
      }
    }
    return s as unknown as AppSettings;
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const allowed = Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[];
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      const expected = typeof DEFAULT_APP_SETTINGS[key];
      if (typeof patch[key] !== expected) throw new ValidationError(`Invalid value for setting ${key}`);
      if (key === 'uiTheme' && !['system', 'dark', 'light', 'midnight', 'nord'].includes(String(patch[key]))) throw new ValidationError('Invalid theme');
      if (key === 'language' && !SUPPORTED_LANGUAGES.includes(String(patch[key]))) throw new ValidationError('Unsupported language');
      if (key === 'notifyAfterSeconds' && !(Number.isInteger(patch[key]) && Number(patch[key]) >= 0 && Number(patch[key]) <= 86_400)) throw new ValidationError('Invalid notification delay');
      if (key === 'globalHotkey' && String(patch[key]).length > 40) throw new ValidationError('Invalid shortcut');
      if (key === 'keybindings') patch.keybindings = validKeybindings(patch.keybindings);
      this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(patch[key])]);
    }
    // Turning restore off also removes the saved copies of terminal output.
    if (patch.restoreAfterRestart === false) this.sessions?.clearAllSnapshots();
    return this.getSettings();
  }

  getUiPrefs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.all('SELECT key, value FROM ui_prefs')) {
      try {
        out[String(r.key)] = JSON.parse(String(r.value));
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  // ---------- snippets and workspaces (small JSON lists in the settings table) ----------
  private getList<T>(key: string): T[] {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', [key]);
    try {
      const list = row ? JSON.parse(String(row.value)) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private setList(key: string, list: unknown[]): void {
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(list)]);
  }

  getSnippets(): Snippet[] {
    return this.getList<Snippet>('snippets');
  }

  saveSnippet(input: Partial<Snippet>): Snippet {
    const name = cleanName(input.name, 'Snippet name');
    const command = String(input.command ?? '');
    if (!command.trim() || command.length > 4000) throw new ValidationError('The command must be 1 to 4000 characters.');
    const profileId = typeof input.profileId === 'string' && input.profileId ? input.profileId : null;
    if (profileId && !this.profiles.find(profileId)) throw new ValidationError('That terminal no longer exists.');
    const list = this.getSnippets();
    const id = typeof input.id === 'string' && UUID_RE.test(input.id) ? input.id : crypto.randomUUID();
    const snippet: Snippet = { id, name, command, profileId, run: input.run !== false };
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = snippet;
    else list.push(snippet);
    if (list.length > 500) throw new ValidationError('Too many snippets.');
    this.setList('snippets', list);
    return snippet;
  }

  deleteSnippet(id: string): void {
    this.setList('snippets', this.getSnippets().filter((x) => x.id !== id));
  }

  getWorkspaces(): Workspace[] {
    return this.getList<Workspace>('workspaces');
  }

  saveWorkspace(input: Partial<Workspace>): Workspace {
    const name = cleanName(input.name, 'Workspace name');
    const tabs = Array.isArray(input.tabs) ? input.tabs : [];
    if (tabs.length === 0 || tabs.length > 30) throw new ValidationError('A workspace needs 1 to 30 tabs.');
    const clean = tabs.map((t) => {
      const panes = Array.isArray(t?.panes) ? t.panes : [];
      if (panes.length === 0 || panes.length > 4) throw new ValidationError('Each workspace tab has 1 to 4 terminals.');
      return {
        direction: t.direction === 'column' ? ('column' as const) : ('row' as const),
        panes: panes.map((p) => {
          const id = String(p?.profileId ?? '');
          if (!this.profiles.find(id)) throw new ValidationError('A terminal in this workspace no longer exists.');
          return { profileId: id, another: p.another === true };
        }),
      };
    });
    const list = this.getWorkspaces();
    const id = typeof input.id === 'string' && UUID_RE.test(input.id) ? input.id : crypto.randomUUID();
    const ws: Workspace = { id, name, tabs: clean };
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = ws;
    else list.push(ws);
    this.setList('workspaces', list);
    return ws;
  }

  deleteWorkspace(id: string): void {
    this.setList('workspaces', this.getWorkspaces().filter((x) => x.id !== id));
  }

  /** Runs a tool's own "who am I" command in the terminal's environment (output redacted, 20 s limit). */
  async runWhoami(profileId: string, toolId: string): Promise<string> {
    const tool = getTool(toolId);
    if (!tool?.whoami) throw new ValidationError('This tool has no account command.');
    const { env, secrets, cwd } = await this.sessions.environmentFor(profileId);
    const comspec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return new Promise((resolve) => {
      execFile(comspec, ['/d', '/s', '/c', tool.whoami!], { env, cwd, windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        let text = `${stdout ?? ''}${stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
        if (!text && err) text = (err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || err.killed ? 'The command took too long.' : err.message;
        if (/is not recognized as an internal or external command/i.test(text)) text = `${tool.whoami!.split(' ')[0]} is not installed (or not on PATH).`;
        resolve(redact(text.slice(0, 4000), secrets));
      });
    });
  }

  // ---------- custom terminal themes ----------
  getCustomThemes(): CustomTheme[] {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', ['customThemes']);
    try {
      const list = row ? (JSON.parse(String(row.value)) as CustomTheme[]) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private saveCustomThemes(list: CustomTheme[]): void {
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['customThemes', JSON.stringify(list)]);
  }

  /** Validates and stores a theme from the editor. Returns the saved theme. */
  saveCustomTheme(input: Partial<CustomTheme>): CustomTheme {
    const name = String(input.name ?? '').trim().replace(/[\u0000-\u001f]/g, '');
    if (!name || name.length > 40) throw new ValidationError('Theme name must be 1 to 40 characters.');
    const colors = {} as CustomTheme['colors'];
    for (const k of THEME_COLOR_KEYS) {
      const v = String(input.colors?.[k] ?? '');
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new ValidationError(`Colour "${k}" must look like #12ab9f.`);
      colors[k] = v.toLowerCase();
    }
    const image = String(input.backgroundImage ?? '');
    if (image && !/^[a-z0-9-]{8,64}\.(png|jpe?g|webp|gif)$/i.test(image)) throw new ValidationError('Invalid background image.');
    const opacity = Math.max(0, Math.min(1, Number(input.imageOpacity ?? 0.35)));
    const fit = input.imageFit === 'contain' || input.imageFit === 'tile' ? input.imageFit : 'cover';
    const list = this.getCustomThemes();
    const id = typeof input.id === 'string' && /^custom:[0-9a-f-]{36}$/.test(input.id) ? input.id : `custom:${crypto.randomUUID()}`;
    const theme: CustomTheme = { id, name, colors, backgroundImage: image, imageOpacity: Number.isFinite(opacity) ? opacity : 0.35, imageFit: fit };
    const old = list.find((t) => t.id === id);
    if (old?.backgroundImage && old.backgroundImage !== image) this.removeThemeImage(old.backgroundImage);
    this.saveCustomThemes([...list.filter((t) => t.id !== id), theme]);
    return theme;
  }

  deleteCustomTheme(id: string): void {
    const list = this.getCustomThemes();
    const theme = list.find((t) => t.id === id);
    if (!theme) return;
    if (theme.backgroundImage) this.removeThemeImage(theme.backgroundImage);
    this.saveCustomThemes(list.filter((t) => t.id !== id));
  }

  private removeThemeImage(name: string): void {
    if (!/^[a-z0-9-]{8,64}\.(png|jpe?g|webp|gif)$/i.test(name)) return;
    fs.rmSync(path.join(this.opts.paths.home, 'themes', name), { force: true });
  }

  state(): AppState {
    return {
      daemon: this.info(),
      profiles: this.profiles.list(),
      sessions: this.sessions.list(),
      shells: this.sessions.getShells(),
      tools: TOOL_REGISTRY,
      limitations: LIMITATIONS,
      settings: this.getSettings(),
      customThemes: this.getCustomThemes(),
      snippets: this.getSnippets(),
      workspaces: this.getWorkspaces(),
    };
  }

  /** RPC dispatch. `clientId` identifies the connected GUI for attach/detach bookkeeping. */
  async handle(method: string, params: unknown, clientId: string): Promise<unknown> {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const changed = (reason: string) => this.opts.events.onChange(reason);
    switch (method) {
      case 'ping':
        return 'pong';
      case 'app.getState':
        return this.state();
      case 'shells.refresh':
        this.sessions.setShells(await detectShells());
        return this.sessions.getShells();

      case 'profiles.list':
        return this.profiles.list();
      case 'profiles.create': {
        const profile = await this.profiles.create(p.profile as ProfileInput);
        changed('profile.create');
        return profile;
      }
      case 'profiles.update': {
        const profile = await this.profiles.update(str(p, 'id'), (p.patch ?? {}) as ProfileUpdate);
        changed('profile.update');
        return profile;
      }
      case 'profiles.rename': {
        const profile = await this.profiles.rename(str(p, 'id'), str(p, 'name'));
        changed('profile.rename');
        return profile;
      }
      case 'profiles.delete': {
        const id = str(p, 'id');
        await this.sessions.stopProfile(id);
        this.profiles.delete(id, p.deleteFiles !== false);
        changed('profile.delete');
        return true;
      }
      case 'profiles.duplicate': {
        const profile = await this.profiles.duplicate(str(p, 'id'), typeof p.name === 'string' ? p.name : undefined);
        changed('profile.duplicate');
        return profile;
      }
      case 'profiles.reorder':
        this.profiles.reorder(Array.isArray(p.ids) ? p.ids.map(String) : []);
        changed('profile.reorder');
        return true;
      case 'profiles.export':
        return JSON.stringify(this.profiles.exportProfiles(Array.isArray(p.ids) ? p.ids.map(String) : undefined), null, 2);
      case 'profiles.import': {
        const created = await this.profiles.importProfiles(str(p, 'json'));
        changed('profile.import');
        return created;
      }

      case 'sessions.newInstance':
        return this.sessions.newInstance(str(p, 'profileId'), size(p));
      case 'sessions.list':
        return this.sessions.list();
      case 'sessions.start': {
        const info = await this.sessions.start(str(p, 'profileId'), size(p));
        return info;
      }
      case 'sessions.attach':
        return this.sessions.attach(str(p, 'profileId'), clientId, size(p), p.autoStart !== false);
      case 'sessions.detach':
        this.sessions.detach(str(p, 'profileId'), clientId);
        return true;
      case 'sessions.write':
        this.sessions.write(str(p, 'profileId'), String(p.data ?? ''));
        return true;
      case 'sessions.resize':
        this.sessions.resize(str(p, 'profileId'), Number(p.cols), Number(p.rows));
        return true;
      case 'sessions.stop':
        await this.sessions.stop(str(p, 'profileId'));
        return true;
      case 'sessions.restart':
        return this.sessions.restart(str(p, 'profileId'), size(p), p.elevated === true);
      case 'sessions.dismiss':
        this.sessions.dismiss(str(p, 'profileId'));
        return true;
      case 'system.elevation':
        return getElevationStatus();
      case 'sessions.elevate': {
        // Continue this terminal as administrator, in place, via Windows sudo (inline mode).
        const id = str(p, 'profileId');
        const profile = this.profiles.get(baseProfileId(id));
        const shell = this.sessions.getShells().find((s) => s.id === profile.shellId);
        const status = await getElevationStatus();
        if (status.managerElevated) throw new ValidationError('This terminal already runs as administrator.');
        if (status.sudo !== 'inline') throw new ValidationError('Windows sudo is not enabled in inline mode.');
        const cmd = shell ? elevatedShellCommand(shell.kind, shell.path) : null;
        if (!cmd) throw new ValidationError('Continue as Administrator is available for PowerShell, Command Prompt and Git Bash terminals.');
        if (!this.sessions.get(id)?.alive) throw new ValidationError('Terminal is not running.');
        // Clear any half-typed input first (Esc for PowerShell/cmd, Ctrl+U for bash).
        this.sessions.write(id, (shell!.kind === 'gitbash' ? '\x15' : '\x1b') + cmd + '\r');
        return true;
      }
      case 'sessions.saveNow':
        await this.sessions.saveSnapshots(true);
        return true;
      case 'sessions.stats':
        return this.sessions.stats();
      case 'sessions.text':
        return this.sessions.textContent(str(p, 'profileId'));

      case 'themes.save': {
        const theme = this.saveCustomTheme((p.theme ?? {}) as Partial<CustomTheme>);
        changed('themes');
        return theme;
      }
      case 'themes.delete':
        this.deleteCustomTheme(str(p, 'id'));
        changed('themes');
        return true;
      case 'snippets.save': {
        const s = this.saveSnippet((p.snippet ?? {}) as Partial<Snippet>);
        changed('snippets');
        return s;
      }
      case 'snippets.delete':
        this.deleteSnippet(str(p, 'id'));
        changed('snippets');
        return true;
      case 'workspaces.save': {
        const w = this.saveWorkspace((p.workspace ?? {}) as Partial<Workspace>);
        changed('workspaces');
        return w;
      }
      case 'workspaces.delete':
        this.deleteWorkspace(str(p, 'id'));
        changed('workspaces');
        return true;

      case 'profiles.accounts': {
        const profile = this.profiles.get(baseProfileId(str(p, 'id')));
        return readAccounts(profile, new Set(profile.env.filter((v) => v.secret && v.hasValue).map((v) => v.name)));
      }
      case 'profiles.whoami':
        return this.runWhoami(baseProfileId(str(p, 'id')), str(p, 'toolId'));

      case 'ssh.status':
        return sshStatus(this.profiles.get(baseProfileId(str(p, 'id'))));
      case 'ssh.createKey': {
        const status = await createSshKey(this.profiles.get(baseProfileId(str(p, 'id'))));
        changed('ssh');
        return status;
      }

      case 'system.tools':
        return checkInstalledTools(p.force === true);
      case 'system.suggestions':
        return { installed: isPsReadLineInstalled(this.modulesDir), version: PSREADLINE_VERSION };
      case 'system.installSuggestions':
        await installPsReadLine(this.modulesDir);
        return { installed: isPsReadLineInstalled(this.modulesDir), version: PSREADLINE_VERSION };

      case 'settings.get':
        return this.getSettings();
      case 'settings.set': {
        const s = this.setSettings((p.settings ?? {}) as Partial<AppSettings>);
        changed('settings');
        return s;
      }
      case 'uiPrefs.get':
        return this.getUiPrefs();
      case 'uiPrefs.set':
        this.db.run('INSERT OR REPLACE INTO ui_prefs (key, value) VALUES (?, ?)', [str(p, 'key'), JSON.stringify(p.value ?? null)]);
        return true;

      case 'client.goodbye':
        this.sessions.detachClient(clientId, true);
        return true;
      case 'daemon.memory': {
        // Diagnostics: where the session manager's memory goes.
        const m = process.memoryUsage();
        const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
        return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers), sessions: this.sessions.list().length };
      }
      case 'daemon.shutdown':
        setTimeout(() => this.shutdownHandler?.(false), 10);
        return true;
      case 'daemon.handoff':
        // Before installing an update: save every screen, then exit leaving terminals marked running
        // so the new version's manager restores them.
        setTimeout(() => this.shutdownHandler?.(true), 10);
        return true;
      default:
        throw new ValidationError(`Unknown method: ${method}`);
    }
  }

  async shutdown(): Promise<void> {
    await this.sessions.stopAll();
    this.db.close();
  }

  /** Update hand-off: screens are saved and session records stay "running" (see recoverOrphans). */
  async handoff(): Promise<void> {
    await this.sessions.saveSnapshots(true);
    this.sessions.stopSnapshots();
    this.db.close();
  }
}
