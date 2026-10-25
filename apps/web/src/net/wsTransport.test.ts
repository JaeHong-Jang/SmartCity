import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportStatus } from './transport';
import { MAX_WELCOME_DEADLINE_MS, WELCOME_DEADLINE_MS, WsTransport } from './wsTransport';

/** Minimal stand-in for the browser WebSocket: tests open, message and close it by hand. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const last = () => FakeSocket.all.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WsTransport retry info (connect overlay)', () => {
  it('counts attempts, exposes the next retry before "closed", caps the wait at 10 s and resets only on welcome', () => {
    const t = new WsTransport('ws://x/ws', 'main', () => 'me');
    const seen: { st: TransportStatus; attempts: number; retryAt: number | null }[] = [];
    t.onStatus((st) => seen.push({ st, attempts: t.attempts, retryAt: t.retryAt }));
    t.connect();
    expect(t.attempts).toBe(1);
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      last().drop();
      const closed = seen.at(-1)!;
      expect(closed.st).toBe('closed');
      expect(closed.retryAt).not.toBeNull();
      waits.push(closed.retryAt! - Date.now());
      vi.advanceTimersByTime(waits.at(-1)!);
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(t.attempts).toBe(8);
    expect(t.retryAt).toBeNull();

    // A socket that opens and is refused keeps backing off; a welcome resets.
    last().open();
    last().drop();
    expect(t.retryAt! - Date.now()).toBe(10_000);
    vi.advanceTimersByTime(10_000);
    last().open();
    last().onmessage?.({ data: JSON.stringify({ t: 'welcome' }) });
    expect(t.attempts).toBe(0);
    last().drop();
    expect(t.retryAt! - Date.now()).toBe(500);
    t.close();
  });

  it('retryNow skips the wait', () => {
    const t = new WsTransport('ws://x/ws', 'main', () => 'me');
    t.connect();
    last().drop();
    expect(FakeSocket.all).toHaveLength(1);
    t.retryNow();
    expect(FakeSocket.all).toHaveLength(2);
    expect(t.attempts).toBe(2);
    expect(t.retryAt).toBeNull();
    vi.advanceTimersByTime(WELCOME_DEADLINE_MS - 1);
    expect(FakeSocket.all).toHaveLength(2); // the cancelled timer does not open another
    t.close();
  });

  it('drops a socket that opens but never sends welcome and keeps retrying (Sol review #4)', () => {
    const t = new WsTransport('ws://x/ws', 'main', () => 'me');
    const welcomes: unknown[] = [];
    t.onMessage((m) => welcomes.push(m));
    const statuses: TransportStatus[] = [];
    t.onStatus((st) => statuses.push(st));
    t.connect();
    last().open(); // ...and then silence
    vi.advanceTimersByTime(60_000);
    // Sol saw `sockets:1, attempts:1, retryAt:null` here. Deadlines 10 s then 20 s (backoff 0.5, 1 s):
    // dropped at 10 s and 30.5 s, the third attempt (40 s window) is running.
    expect(t.attempts).toBe(3);
    expect(FakeSocket.all).toHaveLength(3);
    expect(FakeSocket.all.slice(0, 2).every((s) => s.readyState === 3)).toBe(true);
    expect(statuses.filter((s) => s === 'closed')).toHaveLength(2);
    expect(t.retryAt).toBeNull();

    // A dropped socket that answers late is ignored: no welcome, no status, no backoff reset.
    const stale = FakeSocket.all[0]!;
    const before = statuses.length;
    stale.onmessage?.({ data: JSON.stringify({ t: 'welcome' }) });
    stale.onopen?.();
    stale.onclose?.();
    expect(welcomes).toHaveLength(0);
    expect(statuses).toHaveLength(before);
    expect(t.attempts).toBe(FakeSocket.all.length);

    // The server recovers: the current attempt joins and its deadline no longer fires.
    vi.advanceTimersByTime(t.retryAt === null ? 0 : t.retryAt - Date.now());
    const sockets = FakeSocket.all.length;
    last().open();
    last().onmessage?.({ data: JSON.stringify({ t: 'welcome' }) });
    expect(welcomes).toHaveLength(1);
    vi.advanceTimersByTime(5 * WELCOME_DEADLINE_MS);
    expect(FakeSocket.all).toHaveLength(sockets);
    expect(last().readyState).toBe(1);
    t.close();
  });

  it('a deadline that fires late (busy page) is re-armed instead of dropping the socket', () => {
    const t = new WsTransport('ws://x/ws', 'main', () => 'me');
    t.connect();
    last().open();
    vi.advanceTimersByTime(WELCOME_DEADLINE_MS - 1000);
    vi.setSystemTime(Date.now() + 5000); // the main thread was blocked for 5 s
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(last().readyState).toBe(1);
    vi.advanceTimersByTime(WELCOME_DEADLINE_MS); // a full window on time: now it is dropped
    expect(last().readyState).toBe(3);
    t.close();
  });

  it('a welcome that is slow on every attempt still gets through (Sol recheck #7)', () => {
    // Every socket opens after 100 ms and sends its welcome 11 s after it was created.
    const t = new WsTransport('ws://x/ws', 'main', () => 'me');
    const welcomes: unknown[] = [];
    t.onMessage((m) => welcomes.push(m));
    const serve = () => {
      const s = last();
      setTimeout(() => s.readyState === 0 && s.open(), 100);
      setTimeout(() => s.readyState === 1 && s.onmessage?.({ data: JSON.stringify({ t: 'welcome' }) }), 11_000);
    };
    t.connect();
    serve();
    for (let ms = 0; ms < 60_000 && welcomes.length === 0; ms += 50) {
      const n = FakeSocket.all.length;
      vi.advanceTimersByTime(50);
      if (FakeSocket.all.length > n) serve();
    }
    // Sol saw `welcomes:0, sockets:5`: the 10 s window dropped it every time. Now the second window is 20 s.
    expect(welcomes).toHaveLength(1);
    expect(FakeSocket.all).toHaveLength(2);
    expect(last().readyState).toBe(1);
    t.close();
  });

  it('deadlines double per timed-out attempt up to the cap, and messages restart the window', () => {
    const t = new WsTransport('ws://x/ws', 'main', () => 'me');
    const drops: number[] = [];
    let opened = 0;
    t.onStatus((st) => {
      if (st === 'connecting') opened = Date.now();
      if (st === 'closed') drops.push(Date.now() - opened);
    });
    t.connect();
    for (let i = 0; i < 6; i++) {
      last().open();
      const n = drops.length;
      while (drops.length === n) vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(t.retryAt! - Date.now());
    }
    expect(drops).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);

    // A server that keeps talking (e.g. it is still loading) is not dropped while it does.
    last().open();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(MAX_WELCOME_DEADLINE_MS - 1000);
      last().onmessage?.({ data: JSON.stringify({ t: 'pong', at: 0 }) });
    }
    expect(drops).toHaveLength(6);
    last().onmessage?.({ data: JSON.stringify({ t: 'welcome' }) });
    // After a welcome the next attempt starts again from 10 s.
    last().drop();
    vi.advanceTimersByTime(t.retryAt! - Date.now());
    last().open();
    vi.advanceTimersByTime(WELCOME_DEADLINE_MS);
    expect(drops.slice(7)).toEqual([WELCOME_DEADLINE_MS]);
    t.close();
  });
});
