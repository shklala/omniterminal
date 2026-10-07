import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Profile, SessionInfo, ShellInfo } from '../../shared/types';
import { ValidationError } from '../../shared/validation';
import type { SecretStore } from '../credentials/secretStore';
import { buildEnvironment } from '../env/environmentManager';
import type { Logger } from '../log';
import type { Db } from '../persistence/db';
import type { ProfileManager } from '../profiles/profileManager';
import { PtySession } from '../pty/ptySession';
import { buildLaunchSpec } from '../pty/shells';
import { cleanupOrphans, getProcessStartTime, getTreeStats, killTree, type TreeStats } from '../windows/processes';
import { readRegistryEnvironment } from '../windows/registryEnv';

export interface SessionEvents {
  onData(profileId: string, sessionId: string, data: string, subscriberId: string): void;
  onExit(profileId: string, sessionId: string, exitCode: number | null): void;
  onChange(reason: string): void;
}

export interface SessionManagerOptions {
  /** Skip the registry environment refresh (tests). */
  skipRegistryEnv?: boolean;
}

/**
 * Owns every PTY. One live session per terminal profile ("one terminal = one environment").
 * GUI clients attach/detach; sessions outlive clients.
 */
export class SessionManager {
  private readonly sessions = new Map<string, PtySession>(); // by profileId
  private readonly starting = new Map<string, Promise<PtySession>>();
  private readonly resizeTimers = new Map<string, NodeJS.Timeout>();
  private shells: ShellInfo[] = [];

  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileManager,
    private readonly secrets: SecretStore,
    private readonly log: Logger,
    private readonly events: SessionEvents,
    private readonly opts: SessionManagerOptions = {},
  ) {}

  setShells(shells: ShellInfo[]): void {
    this.shells = shells;
  }

  getShells(): ShellInfo[] {
    return this.shells;
  }

  /**
   * Called at startup: any session recorded as running by a previous (crashed) manager
   * no longer has a PTY owner. Clean up its processes safely and mark it ended.
   */
  async recoverOrphans(): Promise<number> {
    const rows = this.db.all("SELECT * FROM sessions WHERE status = 'running' AND daemon_pid != ?", [process.pid]);
    if (rows.length === 0) return 0;
    const killed = await cleanupOrphans(
      rows.filter((r) => r.pid != null).map((r) => ({ pid: Number(r.pid), startTime: r.pid_start == null ? null : String(r.pid_start) })),
    );
    for (const r of rows) {
      this.db.run("UPDATE sessions SET status = 'orphaned', ended_at = ? WHERE id = ?", [Date.now(), String(r.id)]);
    }
    this.log.warn(`Recovered ${rows.length} orphaned session record(s); terminated ${killed.length} leftover process(es)`);
    return rows.length;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s));
  }

  get(profileId: string): PtySession | undefined {
    return this.sessions.get(profileId);
  }

  private info(s: PtySession): SessionInfo {
    const profile = this.profiles.find(s.profileId);
    return {
      sessionId: s.sessionId,
      profileId: s.profileId,
      pid: s.pid,
      state: s.alive ? 'running' : 'exited',
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      cols: s.cols,
      rows: s.rows,
      attachedClients: s.attachedCount,
      shellId: profile?.shellId ?? '',
      title: s.title,
    };
  }

  /** Starts the session for a profile if it is not already running. Idempotent. */
  async start(profileId: string, size?: { cols: number; rows: number }): Promise<SessionInfo> {
    const existing = this.sessions.get(profileId);
    if (existing?.alive) return this.info(existing);
    const inflight = this.starting.get(profileId);
    if (inflight) return this.info(await inflight);

    const p = this.launch(profileId, size).finally(() => this.starting.delete(profileId));
    this.starting.set(profileId, p);
    return this.info(await p);
  }

  private async launch(profileId: string, size?: { cols: number; rows: number }): Promise<PtySession> {
    const profile = this.profiles.get(profileId);
    const old = this.sessions.get(profileId);
    if (old) {
      old.dispose();
      this.sessions.delete(profileId);
    }

    const sessionId = crypto.randomUUID();
    const cols = size?.cols ?? profile.lastCols;
    const rows = size?.rows ?? profile.lastRows;
    const cwd = this.resolveCwd(profile);
    const spec = buildLaunchSpec(profile, this.shells, path.join(profile.dir, 'history'));
    const secretNames = profile.env.filter((v) => v.secret).map((v) => v.name);
    const secretValues = secretNames.length ? await this.secrets.getAll(profile.dir, profile.id, secretNames) : {};
    Object.values(secretValues).forEach((v) => this.log.registerSecret(v));
    const registry = this.opts.skipRegistryEnv || !profile.advanced.refreshEnvironment ? null : await readRegistryEnvironment();
    const shell = this.shells.find((s) => s.id === profile.shellId);
    const built = buildEnvironment({
      profile,
      sessionId,
      secrets: secretValues,
      baseEnv: process.env,
      registry,
      extraEnv: spec.extraEnv,
      isWsl: shell?.kind === 'wsl',
    });

    const transcriptFile = profile.advanced.transcript
      ? path.join(profile.dir, 'logs', `transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
      : null;

    let session: PtySession;
    try {
      session = new PtySession({
        sessionId,
        profileId,
        file: spec.file,
        args: spec.args,
        cwd,
        env: built.env,
        cols,
        rows,
        scrollback: profile.advanced.scrollback,
        useConptyDll: profile.advanced.useBundledConpty,
        typeOnReady: spec.typeOnReady,
        transcriptFile,
        knownSecrets: Object.values(secretValues),
      });
    } catch (e) {
      this.profileLog(profile, `failed to start: ${(e as Error).message}`);
      throw new ValidationError(`Could not start shell "${spec.file}": ${(e as Error).message}`);
    }

    this.sessions.set(profileId, session);
    this.db.run(
      "INSERT INTO sessions (id, profile_id, pid, pid_start, daemon_pid, started_at, status) VALUES (?, ?, ?, NULL, ?, ?, 'running')",
      [sessionId, profileId, session.pid, process.pid, session.startedAt],
    );
    this.profiles.touch(profileId);
    this.profileLog(profile, `session ${sessionId} started pid=${session.pid} shell=${profile.shellId} cwd=${cwd}`);
    this.log.info(`Session ${sessionId} started for ${profileId} (pid ${session.pid})`);

    // Record the process start time so a future manager can safely identify orphans.
    void getProcessStartTime(session.pid).then((t) => {
      if (t) this.db.run('UPDATE sessions SET pid_start = ? WHERE id = ?', [t, sessionId]);
    });

    session.onExit((code) => {
      this.db.run("UPDATE sessions SET status = 'exited', ended_at = ?, exit_code = ? WHERE id = ?", [Date.now(), code, sessionId]);
      this.profileLog(profile, `session ${sessionId} exited code=${code}`);
      this.log.info(`Session ${sessionId} exited (${code})`);
      Object.values(secretValues).forEach((v) => this.log.forgetSecret(v));
      this.events.onExit(profileId, sessionId, code);
      this.events.onChange('session.exit');
    });

    this.events.onChange('session.start');
    return session;
  }

  private resolveCwd(profile: Profile): string {
    const candidates = [profile.cwd, process.env.USERPROFILE, process.cwd()];
    for (const c of candidates) {
      if (!c) continue;
      try {
        if (fs.statSync(c).isDirectory()) return c;
      } catch {
        /* try next */
      }
    }
    return process.cwd();
  }

  private profileLog(profile: Profile, msg: string): void {
    try {
      fs.mkdirSync(path.join(profile.dir, 'logs'), { recursive: true });
      fs.appendFileSync(path.join(profile.dir, 'logs', 'session.log'), `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* best effort */
    }
  }

  /** Attaches a client; starts the session first when `autoStart` is set and it is not running. */
  async attach(
    profileId: string,
    subscriberId: string,
    size: { cols: number; rows: number } | undefined,
    autoStart: boolean,
  ): Promise<{ session: SessionInfo; snapshot: string }> {
    let s = this.sessions.get(profileId);
    if ((!s || !s.alive) && autoStart) {
      await this.start(profileId, size);
      s = this.sessions.get(profileId);
    }
    if (!s) throw new ValidationError('Terminal is not running.');
    if (size && s.alive) s.resize(size.cols, size.rows);
    const sessionId = s.sessionId;
    const snapshot = await s.attach(subscriberId, (data) => this.events.onData(profileId, sessionId, data, subscriberId));
    this.events.onChange('session.attach');
    return { session: this.info(s), snapshot };
  }

  detach(profileId: string, subscriberId: string): void {
    this.sessions.get(profileId)?.detach(subscriberId);
    this.events.onChange('session.detach');
  }

  /** Detaches a client from all sessions; stops non-persistent sessions on a graceful close. */
  detachClient(subscriberId: string, graceful: boolean): void {
    for (const s of this.sessions.values()) {
      if (s.attachedCount === 0) continue;
      s.detach(subscriberId);
      if (graceful && s.alive && s.attachedCount === 0) {
        const profile = this.profiles.find(s.profileId);
        if (profile && !profile.advanced.persistSession) {
          this.log.info(`Stopping non-persistent session ${s.sessionId} after GUI closed`);
          void this.stop(s.profileId);
        }
      }
    }
    this.events.onChange('client.detach');
  }

  write(profileId: string, data: string): void {
    this.sessions.get(profileId)?.write(data);
  }

  resize(profileId: string, cols: number, rows: number): void {
    const s = this.sessions.get(profileId);
    if (!s) return;
    s.resize(cols, rows);
    // Persist "last known dimensions" without writing to disk on every resize event.
    clearTimeout(this.resizeTimers.get(profileId));
    this.resizeTimers.set(
      profileId,
      setTimeout(() => {
        this.resizeTimers.delete(profileId);
        if (this.profiles.find(profileId)) {
          void this.profiles.update(profileId, { lastCols: s.cols, lastRows: s.rows }).catch(() => undefined);
        }
      }, 1000),
    );
  }

  async stop(profileId: string): Promise<void> {
    const s = this.sessions.get(profileId);
    if (!s) return;
    if (s.alive) {
      const exited = new Promise<void>((r) => s.onExit(() => r()));
      s.kill();
      const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000));
      if ((await Promise.race([exited, timeout])) === 'timeout') {
        this.log.warn(`Session ${s.sessionId} did not exit; killing process tree`);
        await killTree(s.pid);
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      }
    }
    s.dispose();
    this.sessions.delete(profileId);
    this.events.onChange('session.stop');
  }

  async restart(profileId: string, size?: { cols: number; rows: number }): Promise<SessionInfo> {
    await this.stop(profileId);
    return this.start(profileId, size);
  }

  /** Removes exited sessions from the live table (their history stays in SQLite). */
  dismiss(profileId: string): void {
    const s = this.sessions.get(profileId);
    if (s && !s.alive) {
      s.dispose();
      this.sessions.delete(profileId);
      this.events.onChange('session.dismiss');
    }
  }

  get runningCount(): number {
    return [...this.sessions.values()].filter((s) => s.alive).length;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  private statsCache: { at: number; value: Promise<Record<string, TreeStats>> } | null = null;

  /** Resource usage per running terminal (keyed by profile id), cached for 2 s. */
  stats(): Promise<Record<string, TreeStats>> {
    if (this.statsCache && Date.now() - this.statsCache.at < 2000) return this.statsCache.value;
    const live = [...this.sessions.values()].filter((s) => s.alive);
    const value = getTreeStats(live.map((s) => s.pid)).then((byPid) => {
      const out: Record<string, TreeStats> = {};
      for (const s of live) if (byPid[s.pid]) out[s.profileId] = byPid[s.pid];
      return out;
    });
    this.statsCache = { at: Date.now(), value };
    return value;
  }

  async textContent(profileId: string): Promise<string> {
    const s = this.sessions.get(profileId);
    if (!s) throw new ValidationError('Terminal is not running.');
    return s.textContent();
  }
}
