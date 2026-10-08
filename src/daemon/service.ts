import * as fs from 'node:fs';
import { APP_VERSION, DEFAULT_APP_SETTINGS } from '../shared/defaults';
import type { AppPaths } from '../shared/paths';
import { LIMITATIONS, TOOL_REGISTRY } from '../shared/tools';
import { THEME_COLOR_KEYS, type AppSettings, type AppState, type CustomTheme, type DaemonInfo, type ProfileInput } from '../shared/types';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { ValidationError } from '../shared/validation';
import { SecretStore, dpapiCrypto, type SecretCrypto } from './credentials/secretStore';
import type { Logger } from './log';
import { Db } from './persistence/db';
import { ProfileManager, type ProfileUpdate } from './profiles/profileManager';
import { detectShells } from './pty/shells';
import { SessionManager, type SessionEvents } from './sessions/sessionManager';
import { elevatedShellCommand, getElevationStatus } from './windows/elevation';
import { baseProfileId } from '../shared/sessionKey';

export interface ServiceOptions {
  paths: AppPaths;
  log: Logger;
  events: SessionEvents;
  crypto?: SecretCrypto;
  skipRegistryEnv?: boolean;
}

type Size = { cols: number; rows: number } | undefined;

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
  private shutdownHandler: (() => void) | null = null;

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
    });
    this.sessions.setShells(await detectShells());
    await this.sessions.recoverOrphans({ restore: this.getSettings().restoreAfterRestart });
    this.sessions.snapshotsEnabled = () => this.getSettings().restoreAfterRestart;
    this.sessions.suggestionsEnabled = () => this.getSettings().suggestions;
    this.sessions.startSnapshots(Number(process.env.OMNITERMINAL_SNAPSHOT_MS) || 30_000);
    this.db.flush();
  }

  onShutdownRequested(handler: () => void): void {
    this.shutdownHandler = handler;
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
      if (key === 'language' && !['en', 'ar'].includes(String(patch[key]))) throw new ValidationError('Unsupported language');
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
        setTimeout(() => this.shutdownHandler?.(), 10);
        return true;
      default:
        throw new ValidationError(`Unknown method: ${method}`);
    }
  }

  async shutdown(): Promise<void> {
    await this.sessions.stopAll();
    this.db.close();
  }
}
