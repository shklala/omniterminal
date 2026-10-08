import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { DaemonClient, connectOrSpawn, type SpawnSpec } from '../client/daemonClient';
import type { AppPaths } from '../shared/paths';

export type BridgeStatus = { connected: boolean; pid: number | null; message: string };

/**
 * Keeps the GUI connected to the session manager: starts it if needed and reconnects
 * (re-spawning it if it crashed) until the app quits.
 */
export class DaemonBridge extends EventEmitter {
  private client: DaemonClient | null = null;
  private quitting = false;
  private connecting: Promise<DaemonClient> | null = null;
  status: BridgeStatus = { connected: false, pid: null, message: 'Starting session manager…' };

  constructor(private readonly paths: AppPaths, private readonly spawnSpec: SpawnSpec) {
    super();
  }

  /** The session manager runs as this same executable in Node mode (no window, no Chromium). */
  static spawnSpecFor(execPath: string, appDir: string): SpawnSpec {
    const daemonScript = path.join(appDir, 'dist', 'daemon.js');
    return {
      execPath,
      // A small young generation keeps this long-running background process lean
      // (V8's default semi-space is sized for throughput, not footprint).
      args: ['--max-semi-space-size=2', daemonScript],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OMNITERMINAL_DAEMON: '1' },
    };
  }

  private setStatus(s: BridgeStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  async connect(): Promise<DaemonClient> {
    if (this.client?.connected) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let delay = 300;
      for (;;) {
        try {
          const { client } = await connectOrSpawn(this.paths, this.spawnSpec, 'gui');
          this.client = client;
          client.on('event', (ev: string, data: unknown) => this.emit('event', ev, data));
          client.on('close', () => {
            this.client = null;
            if (this.quitting) return;
            this.setStatus({ connected: false, pid: null, message: 'Session manager disconnected — reconnecting…' });
            setTimeout(() => void this.connect(), 500);
          });
          this.setStatus({ connected: true, pid: client.hello?.pid ?? null, message: 'Connected' });
          this.emit('connected');
          return client;
        } catch (e) {
          if (this.quitting) throw e;
          this.setStatus({ connected: false, pid: null, message: `Cannot reach session manager: ${(e as Error).message}` });
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 5000);
        }
      }
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const c = await this.connect();
    return c.call<T>(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.client?.notify(method, params);
  }

  /** GUI is closing normally: sessions keep running (except those marked non-persistent). */
  async goodbye(): Promise<void> {
    this.quitting = true;
    await this.client?.goodbye();
  }

  /** "Exit completely": stops every session and the session manager itself. */
  async shutdownDaemon(): Promise<void> {
    this.quitting = true;
    try {
      const c = this.client ?? (await this.connect());
      await Promise.race([c.call('daemon.shutdown'), new Promise((r) => setTimeout(r, 5000))]);
    } catch {
      /* already gone */
    }
    this.client?.close();
  }
}
