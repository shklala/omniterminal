// Must run before node-pty creates terminals: caps its per-terminal worker's memory.
import './workerLimits';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { redact } from '../../shared/redact';
import { sanitizeSnapshot } from './snapshot';

export interface PtySessionOptions {
  sessionId: string;
  profileId: string;
  file: string;
  args: string[] | string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  scrollback: number;
  useConptyDll: boolean;
  typeOnReady: string | null;
  transcriptFile: string | null;
  elevated?: boolean;
  /** Output restored from before a restart, shown above the new session. */
  preamble?: string;
  knownSecrets: string[];
}

type DataListener = (data: string) => void;

interface Subscriber {
  id: string;
  onData: DataListener;
  /** Buffers output while the snapshot is being produced. */
  pending: string[] | null;
}

/**
 * One live terminal: a ConPTY process plus a headless xterm that mirrors the screen.
 * The mirror lets any GUI re-attach at any time and receive an exact serialized snapshot
 * (including alternate-screen apps like vim or claude) followed by the live stream.
 */
export class PtySession {
  readonly sessionId: string;
  readonly profileId: string;
  readonly elevated: boolean;
  readonly startedAt = Date.now();
  readonly pid: number;
  exitCode: number | null = null;
  endedAt: number | null = null;
  title = '';
  cols: number;
  rows: number;

  private readonly proc: pty.IPty;
  private readonly mirror: HeadlessTerminal;
  private readonly serializer: SerializeAddon;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly exitListeners: ((code: number | null) => void)[] = [];
  private transcript: fs.WriteStream | null = null;
  private readonly knownSecrets: string[];
  private typedStartup = false;
  /** Output arrived since the last screen snapshot was saved. */
  dirty = false;

  constructor(opts: PtySessionOptions) {
    this.sessionId = opts.sessionId;
    this.profileId = opts.profileId;
    this.elevated = !!opts.elevated;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.knownSecrets = opts.knownSecrets;

    this.mirror = new HeadlessTerminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer as never);
    this.mirror.onTitleChange((t) => (this.title = t));
    if (opts.preamble) {
      // Push the restored output into scrollback so the new shell's first screen does not overwrite it.
      this.mirror.write(opts.preamble + '\r\n'.repeat(opts.rows));
    }

    this.proc = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
      useConptyDll: opts.useConptyDll,
    });
    this.pid = this.proc.pid;

    // When no GUI is attached, the mirror answers terminal queries (DA, DSR, ...) so
    // programs that probe the terminal do not hang. When a GUI is attached, its xterm answers.
    this.mirror.onData((reply) => {
      if (this.subscribers.size === 0 && this.exitCode === null) this.safeWrite(reply);
    });

    if (opts.transcriptFile) {
      fs.mkdirSync(path.dirname(opts.transcriptFile), { recursive: true });
      this.transcript = fs.createWriteStream(opts.transcriptFile, { flags: 'a' });
    }

    this.proc.onData((data) => {
      this.dirty = true;
      this.mirror.write(data);
      for (const sub of this.subscribers.values()) {
        if (sub.pending) sub.pending.push(data);
        else sub.onData(data);
      }
      // Transcripts are redacted: known secret values and common token formats are removed.
      this.transcript?.write(redact(data, this.knownSecrets));
      if (opts.typeOnReady && !this.typedStartup) {
        this.typedStartup = true;
        const cmd = opts.typeOnReady;
        setTimeout(() => this.write(cmd + '\r'), 400);
      }
    });

    this.proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode ?? 0;
      this.endedAt = Date.now();
      this.transcript?.end();
      this.transcript = null;
      for (const l of this.exitListeners) l(this.exitCode);
    });
  }

  get alive(): boolean {
    return this.exitCode === null;
  }

  get attachedCount(): number {
    return this.subscribers.size;
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }

  private safeWrite(data: string): void {
    try {
      this.proc.write(data);
    } catch {
      /* process is gone */
    }
  }

  write(data: string): void {
    if (this.alive) this.safeWrite(data);
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(2, Math.min(1000, Math.floor(cols)));
    rows = Math.max(1, Math.min(500, Math.floor(rows)));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.mirror.resize(cols, rows);
    if (this.alive) {
      try {
        this.proc.resize(cols, rows);
      } catch {
        /* exited between check and resize */
      }
    }
  }

  /**
   * Attaches a client. Resolves with a snapshot of the current screen; the listener then
   * receives every byte produced after the snapshot, with nothing lost or duplicated.
   */
  attach(subscriberId: string, onData: DataListener): Promise<string> {
    const sub: Subscriber = { id: subscriberId, onData, pending: [] };
    this.subscribers.set(subscriberId, sub);
    return new Promise((resolve) => {
      // write('') callback fires after all previously queued output has been parsed.
      this.mirror.write('', () => {
        const snapshot = this.serializer.serialize({ scrollback: this.mirror.options.scrollback ?? 5000 });
        const pending = sub.pending ?? [];
        sub.pending = null;
        resolve(snapshot + pending.join(''));
      });
    });
  }

  detach(subscriberId: string): void {
    this.subscribers.delete(subscriberId);
  }

  /** Plain-text dump of the buffer (used by tests and diagnostics). */
  /**
   * Saves the screen and recent scrollback (with ANSI colours), redacted, so the terminal can show
   * it again after Windows restarts. Written atomically to the profile's private cache folder.
   */
  async saveSnapshot(file: string, maxLines = 1000): Promise<void> {
    this.dirty = false;
    await new Promise<void>((r) => this.mirror.write('', r));
    // Saved for a NEW shell after a restart: plain history, no modes (see sanitizeSnapshot).
    const text = redact(sanitizeSnapshot(this.serializer.serialize({ scrollback: maxLines, excludeModes: true })), this.knownSecrets);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  async textContent(): Promise<string> {
    await new Promise<void>((r) => this.mirror.write('', r));
    const buf = this.mirror.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  kill(): void {
    if (!this.alive) return;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }

  dispose(): void {
    this.subscribers.clear();
    this.transcript?.end();
    this.transcript = null;
    this.mirror.dispose();
  }
}
