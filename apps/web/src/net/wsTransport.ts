// WebSocket transport: hello on open, exponential-backoff reconnect, keepalive ping.

import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@smartcity/shared';
import { Emitter, type Transport, type TransportStatus } from './transport';

const PING_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;

export class WsTransport implements Transport {
  private ws: WebSocket | null = null;
  private messages = new Emitter<ServerMessage>();
  private statuses = new Emitter<TransportStatus>();
  private backoff = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly room: string,
    private readonly name: () => string,
  ) {}

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    this.statuses.emit('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, room: this.room, name: this.name() } satisfies ClientMessage));
      this.statuses.emit('open');
      this.pingTimer = setInterval(() => this.send({ t: 'ping', at: Date.now() }), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.messages.emit(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.cleanup();
      this.statuses.emit('closed');
      if (!this.closed) this.scheduleRetry();
    };
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.open();
    }, wait);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(cb: (msg: ServerMessage) => void): () => void {
    return this.messages.on(cb);
  }

  onStatus(cb: (status: TransportStatus) => void): () => void {
    return this.statuses.on(cb);
  }

  reconnect(): void {
    const ws = this.ws;
    this.cleanup();
    if (ws) {
      ws.onclose = null;
      ws.close();
      this.statuses.emit('closed');
    }
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.cleanup();
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
}
