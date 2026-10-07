// Wire protocol between the GUI (Electron main) and the session manager daemon.
// Transport: Windows named pipe, newline-delimited JSON frames.

export type Frame =
  | { t: 'hello'; token: string; client: string; protocol: number }
  | { t: 'req'; id: number; method: string; params?: unknown }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: string; code?: string }
  | { t: 'evt'; event: string; data: unknown }
  /** Fire-and-forget request (no response), used for high-frequency terminal input. */
  | { t: 'ntf'; method: string; params?: unknown };

export type DaemonEvent =
  | { event: 'session.data'; data: { profileId: string; sessionId: string; data: string } }
  | { event: 'session.exit'; data: { profileId: string; sessionId: string; exitCode: number | null } }
  | { event: 'state.changed'; data: { reason: string } };

/** Splits a byte stream into newline-delimited JSON frames. */
export class FrameDecoder {
  private buf = '';
  constructor(private readonly onFrame: (f: Frame) => void, private readonly maxFrame = 64 * 1024 * 1024) {}

  push(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        continue;
      }
      this.onFrame(frame);
    }
    if (this.buf.length > this.maxFrame) throw new Error('Frame too large');
  }
}

export function encodeFrame(f: Frame): string {
  // JSON.stringify escapes \n inside strings, so newline framing is safe.
  return JSON.stringify(f) + '\n';
}
