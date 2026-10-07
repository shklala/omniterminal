import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { PROTOCOL_VERSION } from '../shared/defaults';
import { FrameDecoder, encodeFrame, type Frame } from '../shared/protocol';
import { ValidationError } from '../shared/validation';
import type { Logger } from './log';
import type { OmniService } from './service';

interface Client {
  id: string;
  name: string;
  socket: net.Socket;
  authed: boolean;
  /** Output batched per session and flushed on the next tick to reduce frame count. */
  outBuf: Map<string, { sessionId: string; chunks: string[] }>;
  flushScheduled: boolean;
}

/**
 * Named-pipe RPC server. Every connection must first present the per-run token stored in
 * %LOCALAPPDATA%\OmniTerminal\run\daemon.json (a user-private location).
 */
export class PipeServer {
  private server: net.Server | null = null;
  private readonly clients = new Map<string, Client>();
  private changeTimer: NodeJS.Timeout | null = null;
  private pendingReasons = new Set<string>();
  onClientCountChange: (count: number) => void = () => undefined;

  constructor(
    private readonly pipe: string,
    private readonly token: string,
    private readonly log: Logger,
    private service: OmniService | null = null,
  ) {}

  setService(service: OmniService): void {
    this.service = service;
  }

  get clientCount(): number {
    return [...this.clients.values()].filter((c) => c.authed).length;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.once('error', reject);
      server.listen(this.pipe, () => {
        server.removeListener('error', reject);
        server.on('error', (e) => this.log.error('Pipe server error', e));
        this.server = server;
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    const client: Client = {
      id: crypto.randomUUID(),
      name: 'unknown',
      socket,
      authed: false,
      outBuf: new Map(),
      flushScheduled: false,
    };
    this.clients.set(client.id, client);
    socket.setEncoding('utf8');
    const authTimer = setTimeout(() => {
      if (!client.authed) socket.destroy();
    }, 5000);

    const decoder = new FrameDecoder((f) => void this.onFrame(client, f));
    socket.on('data', (chunk: string) => {
      try {
        decoder.push(chunk);
      } catch (e) {
        this.log.warn('Dropping client: bad frame', e);
        socket.destroy();
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(client.id);
      if (client.authed) {
        this.log.info(`Client ${client.name} (${client.id}) disconnected`);
        // Ungraceful disconnect (GUI crash/kill): detach only, never stop sessions.
        this.service?.sessions.detachClient(client.id, false);
        this.onClientCountChange(this.clientCount);
      }
    });
  }

  private send(client: Client, frame: Frame): void {
    if (!client.socket.destroyed) client.socket.write(encodeFrame(frame));
  }

  private async onFrame(client: Client, f: Frame): Promise<void> {
    if (!client.authed) {
      if (f.t !== 'hello' || typeof f.token !== 'string') return void client.socket.destroy();
      const a = Buffer.from(f.token);
      const b = Buffer.from(this.token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        this.log.warn('Rejected client with invalid token');
        return void client.socket.destroy();
      }
      client.authed = true;
      client.name = String(f.client || 'gui').slice(0, 40);
      this.log.info(`Client ${client.name} (${client.id}) connected`);
      this.send(client, { t: 'res', id: 0, ok: true, result: { ...this.service?.info(), protocol: PROTOCOL_VERSION, clientId: client.id } });
      this.onClientCountChange(this.clientCount);
      return;
    }
    if (!this.service) return;
    if (f.t === 'ntf') {
      try {
        await this.service.handle(f.method, f.params, client.id);
      } catch {
        /* notifications have no response channel */
      }
      return;
    }
    if (f.t !== 'req') return;
    try {
      const result = await this.service.handle(f.method, f.params, client.id);
      this.send(client, { t: 'res', id: f.id, ok: true, result: result ?? null });
    } catch (e) {
      const err = e as Error;
      const known = err instanceof ValidationError;
      if (!known) this.log.error(`RPC ${f.method} failed`, err);
      this.send(client, { t: 'res', id: f.id, ok: false, error: known ? err.message : `Internal error: ${err.message}`, code: known ? 'validation' : 'internal' });
    }
  }

  /** Queues terminal output for the subscribed client only. */
  sendData(clientId: string, profileId: string, sessionId: string, data: string): void {
    const client = this.clients.get(clientId);
    if (!client?.authed) return;
    const entry = client.outBuf.get(profileId);
    if (entry && entry.sessionId === sessionId) entry.chunks.push(data);
    else client.outBuf.set(profileId, { sessionId, chunks: [data] });
    if (!client.flushScheduled) {
      client.flushScheduled = true;
      setImmediate(() => this.flush(client));
    }
  }

  private flush(client: Client): void {
    client.flushScheduled = false;
    for (const [profileId, { sessionId, chunks }] of client.outBuf) {
      this.send(client, { t: 'evt', event: 'session.data', data: { profileId, sessionId, data: chunks.join('') } });
    }
    client.outBuf.clear();
  }

  broadcast(event: string, data: unknown): void {
    for (const c of this.clients.values()) {
      if (!c.authed) continue;
      if (event === 'session.exit') this.flush(c);
      this.send(c, { t: 'evt', event, data });
    }
  }

  /** Coalesces state-change notifications so the GUI refreshes at most every 50 ms. */
  notifyChanged(reason: string): void {
    this.pendingReasons.add(reason);
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const reasons = [...this.pendingReasons];
      this.pendingReasons.clear();
      this.broadcast('state.changed', { reason: reasons.join(',') });
    }, 50);
  }

  close(): Promise<void> {
    for (const c of this.clients.values()) c.socket.destroy();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
