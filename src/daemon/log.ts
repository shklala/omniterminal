import * as fs from 'node:fs';
import * as path from 'node:path';
import { redact } from '../shared/redact';

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Redacting file logger. Every line passes through redact() together with the set of
 * currently known secret values, so secrets never reach disk or the console.
 */
export class Logger {
  private stream: fs.WriteStream | null = null;
  private readonly secrets = new Set<string>();

  constructor(file: string | null, private readonly echo = false) {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotate(file, 2 * 1024 * 1024);
      this.stream = fs.createWriteStream(file, { flags: 'a' });
    }
  }

  registerSecret(value: string): void {
    if (value && value.length >= 4) this.secrets.add(value);
  }

  forgetSecret(value: string): void {
    this.secrets.delete(value);
  }

  debug(msg: string, meta?: unknown): void { this.write('debug', msg, meta); }
  info(msg: string, meta?: unknown): void { this.write('info', msg, meta); }
  warn(msg: string, meta?: unknown): void { this.write('warn', msg, meta); }
  error(msg: string, meta?: unknown): void { this.write('error', msg, meta); }

  private write(level: Level, msg: string, meta?: unknown): void {
    let line = `${new Date().toISOString()} [${level}] ${msg}`;
    if (meta !== undefined) {
      const m = meta instanceof Error ? `${meta.name}: ${meta.message}` : safeJson(meta);
      line += ` ${m}`;
    }
    line = redact(line, this.secrets);
    this.stream?.write(line + '\n');
    if (this.echo) process.stderr.write(line + '\n');
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream = null;
    });
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function rotate(file: string, maxBytes: number): void {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) fs.renameSync(file, file + '.1');
  } catch {
    /* no file yet */
  }
}

export const nullLogger = new Logger(null);
