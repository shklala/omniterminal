import * as fs from 'node:fs';
import { APP_VERSION, DEFAULT_APP_SETTINGS } from '../shared/defaults';
import type { AppPaths } from '../shared/paths';
import { LIMITATIONS, TOOL_REGISTRY } from '../shared/tools';
import type { AppSettings, AppState, DaemonInfo, ProfileInput } from '../shared/types';
import { ValidationError } from '../shared/validation';
import { SecretStore, dpapiCrypto, type SecretCrypto } from './credentials/secretStore';
import type { Logger } from './log';
import { Db } from './persistence/db';
import { ProfileManager, type ProfileUpdate } from './profiles/profileManager';
import { detectShells } from './pty/shells';
import { SessionManager, type SessionEvents } from './sessions/sessionManager';

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
    await this.sessions.recoverOrphans();
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
      this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(patch[key])]);
    }
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

  state(): AppState {
    return {
      daemon: this.info(),
      profiles: this.profiles.list(),
      sessions: this.sessions.list(),
      shells: this.sessions.getShells(),
      tools: TOOL_REGISTRY,
      limitations: LIMITATIONS,
      settings: this.getSettings(),
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
        await this.sessions.stop(id);
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
        return this.sessions.restart(str(p, 'profileId'), size(p));
      case 'sessions.dismiss':
        this.sessions.dismiss(str(p, 'profileId'));
        return true;
      case 'sessions.stats':
        return this.sessions.stats();
      case 'sessions.text':
        return this.sessions.textContent(str(p, 'profileId'));

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
