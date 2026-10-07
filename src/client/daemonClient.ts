import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { PROTOCOL_VERSION } from '../shared/defaults';
import { FrameDecoder, encodeFrame, type Frame } from '../shared/protocol';
import type { AppPaths } from '../shared/paths';

export interface DaemonInfoFile {
  pid: number;
  pipe: string;
  token: string;
  version: string;
  startedAt: number;
}

export interface SpawnSpec {
  execPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export class RpcError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * Connection to the session manager. Emits 'event' (name, data) and 'close'.
 */
export class DaemonClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  hello: { version: string; pid: number; clientId: string } | null = null;

  static readInfo(paths: AppPaths): DaemonInfoFile | null {
    try {
      return JSON.parse(fs.readFileSync(paths.daemonInfo, 'utf8')) as DaemonInfoFile;
    } catch {
      return null;
    }
  }

  async connect(info: DaemonInfoFile, clientName: string, timeoutMs = 4000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(info.pipe);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Timed out connecting to session manager'));
      }, timeoutMs);
      socket.setEncoding('utf8');
      const decoder = new FrameDecoder((f) => this.onFrame(f));
      socket.on('data', (c: string) => decoder.push(c));
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('Session manager disconnected'));
        this.pending.clear();
        if (this.socket === socket) {
          this.socket = null;
          this.emit('close');
        }
      });
      socket.once('connect', () => {
        this.socket = socket;
        this.pending.set(0, {
          resolve: (v) => {
            clearTimeout(timer);
            this.hello = v as DaemonClient['hello'];
            resolve();
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        socket.write(encodeFrame({ t: 'hello', token: info.token, client: clientName, protocol: PROTOCOL_VERSION }));
      });
    });
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  private onFrame(f: Frame): void {
    if (f.t === 'res') {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      if (f.ok) p.resolve(f.result);
      else p.reject(new RpcError(f.error, f.code));
    } else if (f.t === 'evt') {
      this.emit('event', f.event, f.data);
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.socket) return Promise.reject(new Error('Not connected to session manager'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket!.write(encodeFrame({ t: 'req', id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.socket?.write(encodeFrame({ t: 'ntf', method, params }));
  }

  /** Graceful close: tells the manager the GUI is leaving on purpose. */
  async goodbye(): Promise<void> {
    if (!this.socket) return;
    try {
      await Promise.race([this.call('client.goodbye'), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      /* ignore */
    }
    this.close();
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Starts the session manager fully detached from the GUI.
 * A plain detached spawn would inherit the GUI's inheritable handles (e.g. stdout/stderr pipes of
 * whatever launched the GUI), keeping them open for the manager's lifetime. Start-Process creates
 * the process without handle inheritance; the short-lived PowerShell only passes the environment on.
 * (The launcher must NOT be DETACHED_PROCESS: console-less powershell.exe silently does nothing.
 * Its child breaks away from the GUI's job object, so the manager outlives the GUI.)
 */
export function spawnDaemon(spec: SpawnSpec): void {
  const argList = spec.args.map((a) => psQuote(`"${a}"`)).join(',');
  const script = `Start-Process -FilePath ${psQuote(spec.execPath)} -ArgumentList @(${argList}) -WindowStyle Hidden`;
  const ps = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const launcher = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: 'ignore',
    windowsHide: true,
    env: spec.env,
  });
  launcher.on('error', () => {
    // PowerShell unavailable: fall back to a plain detached spawn.
    const child = spawn(spec.execPath, spec.args, { detached: true, stdio: 'ignore', windowsHide: true, env: spec.env });
    child.on('error', () => undefined);
    child.unref();
  });
  launcher.unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects to the running session manager, starting it if necessary.
 * Returns a connected client.
 */
export async function connectOrSpawn(
  paths: AppPaths,
  spawnSpec: SpawnSpec,
  clientName: string,
  timeoutMs = 20000,
): Promise<{ client: DaemonClient; spawned: boolean }> {
  const tryConnect = async (): Promise<DaemonClient | null> => {
    const info = DaemonClient.readInfo(paths);
    if (!info) return null;
    const client = new DaemonClient();
    try {
      await client.connect(info, clientName, 3000);
      return client;
    } catch {
      client.close();
      return null;
    }
  };

  const existing = await tryConnect();
  if (existing) return { client: existing, spawned: false };

  const before = DaemonClient.readInfo(paths);
  spawnDaemon(spawnSpec);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    const info = DaemonClient.readInfo(paths);
    if (!info || (before && info.token === before.token)) continue;
    const c = await tryConnect();
    if (c) return { client: c, spawned: true };
  }
  // A concurrently started manager may have won the race; one last attempt.
  const last = await tryConnect();
  if (last) return { client: last, spawned: false };
  throw new Error('Could not start the OmniTerminal session manager. See logs\\session-manager.log.');
}
