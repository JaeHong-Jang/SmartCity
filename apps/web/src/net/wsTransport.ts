// WebSocket transport: hello on open, exponential-backoff reconnect (reset by welcome), keepalive ping.
// Every attempt has a deadline for its welcome: a socket that hangs (never opens, or opens and stays
// silent) is dropped and retried like a closed one. Events of dropped sockets are ignored. The
// deadline doubles after each attempt that ran out of time (a server that is slow every time still
// gets through) and restarts whenever the socket delivers a message.

import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@smartcity/shared';
import { Emitter, type Transport, type TransportStatus } from './transport';

const PING_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;
/** Time the first attempt gets from `new WebSocket` to its welcome; doubled per timed-out attempt up to the max. */
export const WELCOME_DEADLINE_MS = 10_000;
export const MAX_WELCOME_DEADLINE_MS = 60_000;
/** A timer this late means the page was busy (first shader compile), not that the server is slow. */
const LATE_MS = 250;

/** A refusal of the hello's protocol version (this server; servers before v2 only sent the text). */
const protocolRefused = (m: Extract<ServerMessage, { t: 'error' }>): boolean => m.code === 'protocol' || /^unsupported protocol/.test(m.error);

export class WsTransport implements Transport {
  private ws: WebSocket | null = null;
  private messages = new Emitter<ServerMessage>();
  private statuses = new Emitter<TransportStatus>();
  private backoff = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** Generation of the current socket; bumped whenever a socket is dropped, so its late events are ignored. */
  private gen = 0;
  /** Attempts in a row that ran out of time before their welcome (reset by welcome). */
  private timeouts = 0;
  private closed = false;
  /** Connection attempts since the last welcome (the first attempt is 1). */
  attempts = 0;
  /** Epoch ms of the next automatic attempt while waiting for it, else null. */
  retryAt: number | null = null;
  /**
   * The server refused this app's protocol version: retrying cannot help, so the transport stops and
   * the connect overlay asks for a reload instead.
   */
  outdated = false;
  /**
   * The server refused the invite password (missing, wrong, or too many wrong ones): retrying with the
   * same one cannot help, so the transport waits until `connect()` is called with a new one.
   */
  authRefused = false;

  constructor(
    private readonly url: string,
    private readonly room: string,
    private readonly name: () => string,
    /** Invite password sent with `hello` (null = none). */
    private readonly invite: () => string | null = () => null,
  ) {}

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  connect(): void {
    this.closed = false;
    this.authRefused = false;
    this.open();
  }

  private open(): void {
    this.attempts++;
    this.retryAt = null;
    this.statuses.emit('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    const g = ++this.gen;
    this.ws = ws;
    const deadline = Math.min(MAX_WELCOME_DEADLINE_MS, WELCOME_DEADLINE_MS * 2 ** this.timeouts);
    this.armDeadline(g, deadline);
    ws.onopen = () => {
      if (g !== this.gen) return;
      const invite = this.invite();
      ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, room: this.room, name: this.name(), ...(invite === null ? {} : { invite }) } satisfies ClientMessage));
      this.statuses.emit('open');
      this.pingTimer = setInterval(() => this.send({ t: 'ping', at: Date.now() }), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (g !== this.gen || typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      // Only a welcome proves the room is served: a server that opens and then refuses keeps backing off.
      if (msg.t === 'error' && protocolRefused(msg)) {
        this.outdated = true;
        this.closed = true;
        this.retryAt = null;
      }
      if (msg.t === 'error' && msg.code === 'auth') {
        this.authRefused = true;
        this.closed = true;
        this.retryAt = null;
      }
      if (msg.t === 'welcome') {
        this.backoff = 500;
        this.attempts = 0;
        this.timeouts = 0;
        this.clearDeadline();
      } else if (this.deadlineTimer) {
        // The server is answering: give the welcome a fresh window.
        this.clearDeadline();
        this.armDeadline(g, deadline);
      }
      this.messages.emit(msg);
    };
    ws.onclose = () => {
      if (g === this.gen) this.lost();
    };
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
  }

  /** The current socket is gone: retry with backoff and tell listeners. */
  private lost(): void {
    this.cleanup();
    // Scheduled first so listeners of 'closed' already see `retryAt`.
    if (!this.closed) this.scheduleRetry();
    this.statuses.emit('closed');
  }

  private armDeadline(g: number, ms: number): void {
    const due = Date.now() + ms;
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      if (g !== this.gen) return;
      if (Date.now() - due > LATE_MS) {
        this.armDeadline(g, ms);
        return;
      }
      const ws = this.ws;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      this.timeouts++;
      this.lost();
    }, ms);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearDeadline();
    this.ws = null;
    this.gen++;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
    this.retryAt = Date.now() + wait;
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

  /** Skip the backoff wait (or drop the current attempt) and try again now. */
  retryNow(): void {
    if (this.closed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.reconnect();
  }

  close(): void {
    this.closed = true;
    this.retryAt = null;
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
