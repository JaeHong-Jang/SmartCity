import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@smartcity/shared';
import type { Command, ServerMessage } from '@smartcity/shared';
import { startServer } from './server.js';
import { AiService } from './ai/service.js';
import { scriptedModel } from './ai/model.js';

type Srv = Awaited<ReturnType<typeof startServer>>;

class TestClient {
  msgs: ServerMessage[] = [];
  closed: Promise<number>;
  private waiters: Array<() => void> = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.msgs.push(JSON.parse(d.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
    this.closed = new Promise((r) => ws.on('close', (code) => r(code)));
  }
  static async open(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    return new TestClient(ws);
  }
  static async join(port: number, room = 'room-a', name = 'tester'): Promise<TestClient> {
    const c = await TestClient.open(port);
    c.send({ t: 'hello', protocol: PROTOCOL_VERSION, room, name });
    await c.next('welcome');
    return c;
  }
  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  /** Wait for (and consume) the first message of type t. */
  async next<T extends ServerMessage['t']>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t);
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }
  close(): void {
    this.ws.close();
  }
}

const addNode = (id: string, x = 0): Command => ({ type: 'node.add', node: { id, pos: { x, z: 0 } } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let srv: Srv;
const extra: Srv[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sc-server-'));
  srv = await startServer({ port: 0, dataDir: dir, helloTimeoutMs: 300 });
});
afterEach(async () => {
  await srv.close().catch(() => {});
  for (const s of extra.splice(0)) await s.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe('server', () => {
  it('sends welcome with doc, seq, peers', async () => {
    const a = await TestClient.join(srv.port);
    const b = await TestClient.open(srv.port);
    b.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'room-a', name: 'bee' });
    const w = await b.next('welcome');
    expect(w.seq).toBe(0);
    expect(w.doc.nodes).toEqual({});
    expect(w.peers.map((p) => p.name).sort()).toEqual(['bee', 'tester']);
    expect(w.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.tag.length).toBeGreaterThan(0);
    await a.next('peers'); // own join
    expect((await a.next('peers')).peers).toHaveLength(2);
    a.close();
    b.close();
  });

  it('delivers applied in the same order to all clients; sender gets ref', async () => {
    const a = await TestClient.join(srv.port);
    const b = await TestClient.join(srv.port);
    a.send({ t: 'cmd', ref: 1, cmd: addNode('n1') });
    b.send({ t: 'cmd', ref: 7, cmd: addNode('n2', 10) });
    a.send({ t: 'cmd', ref: 2, cmd: addNode('n3', 20) });
    const seqsA: number[] = [];
    const seqsB: number[] = [];
    const refsA: Array<number | undefined> = [];
    const refsB: Array<number | undefined> = [];
    for (let i = 0; i < 3; i++) {
      const x = await a.next('applied');
      const y = await b.next('applied');
      seqsA.push(x.seq);
      seqsB.push(y.seq);
      refsA.push(x.ref);
      refsB.push(y.ref);
      expect(x.cmd).toEqual(y.cmd);
    }
    expect(seqsA).toEqual([1, 2, 3]);
    expect(seqsB).toEqual([1, 2, 3]);
    // ref is present only for the sender's own commands (arrival order across clients is not fixed)
    expect(refsA.filter((r) => r !== undefined).sort()).toEqual([1, 2]);
    expect(refsB.filter((r) => r !== undefined)).toEqual([7]);
    a.close();
    b.close();
  });

  it('rejects an invalid command to the sender only', async () => {
    const a = await TestClient.join(srv.port);
    const b = await TestClient.join(srv.port);
    a.send({ t: 'cmd', ref: 5, cmd: { type: 'node.add', node: { id: 'n', pos: { x: 1e9, z: 0 } } } });
    const r = await a.next('rejected');
    expect(r.ref).toBe(5);
    expect(r.error).toBeTruthy();
    // ping round-trip on b proves nothing else was queued for b before it
    b.send({ t: 'ping', at: 1 });
    await b.next('pong');
    expect(b.msgs.filter((m) => m.t === 'rejected' || m.t === 'applied')).toHaveLength(0);
    a.close();
    b.close();
  });

  it('keeps doc and seq across restart (checkpoint)', async () => {
    const a = await TestClient.join(srv.port);
    a.send({ t: 'cmd', ref: 1, cmd: addNode('n1') });
    a.send({ t: 'cmd', ref: 2, cmd: addNode('n2', 50) });
    await a.next('applied');
    await a.next('applied');
    a.close();
    await srv.close();
    expect(existsSync(join(dir, 'room-a.json'))).toBe(true);
    srv = await startServer({ port: 0, dataDir: dir });
    const b = await TestClient.join(srv.port);
    // welcome already consumed; re-join to inspect
    b.close();
    const c = await TestClient.open(srv.port);
    c.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'room-a', name: 'x' });
    const w = await c.next('welcome');
    expect(w.seq).toBe(2);
    expect(Object.keys(w.doc.nodes).sort()).toEqual(['n1', 'n2']);
    c.send({ t: 'cmd', ref: 1, cmd: addNode('n3', 90) });
    expect((await c.next('applied')).seq).toBe(3);
    c.close();
  });

  it('refuses a room with an unreadable checkpoint and never overwrites it; other rooms work', async () => {
    const body = '{"schema":1,"seq":114,"doc":{"version":6,"nod';
    writeFileSync(join(dir, 'broken.json'), body);
    const a = await TestClient.open(srv.port);
    a.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'broken', name: 'x' });
    expect((await a.next('error')).error).toBe('도시 파일을 읽을 수 없습니다 — 관리자 확인 필요');
    expect(await a.closed).toBe(1011);
    const b = await TestClient.join(srv.port, 'fine');
    b.send({ t: 'cmd', ref: 1, cmd: addNode('n1') });
    await b.next('applied');
    b.close();
    await srv.close(); // checkpoints every loaded room
    expect(readFileSync(join(dir, 'broken.json'), 'utf8')).toBe(body);
    expect(existsSync(join(dir, 'fine.json'))).toBe(true);
    srv = await startServer({ port: 0, dataDir: dir });
  });

  it('refuses a room whose log does not replay and keeps the log (Sol review #2)', async () => {
    const rec = (seq: number, cmd: unknown) => `${JSON.stringify({ seq, cmd })}\n`;
    const body = rec(1, addNode('n1')) + rec(2, { type: 'unknown' }) + rec(3, addNode('n3', 80));
    writeFileSync(join(dir, 'badlog.log.jsonl'), body);
    const a = await TestClient.open(srv.port);
    a.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'badlog', name: 'x' });
    expect((await a.next('error')).error).toBe('도시 파일을 읽을 수 없습니다 — 관리자 확인 필요');
    expect(await a.closed).toBe(1011);
    await srv.close();
    expect(readFileSync(join(dir, 'badlog.log.jsonl'), 'utf8')).toBe(body);
    expect(existsSync(join(dir, 'badlog.json'))).toBe(false);
    srv = await startServer({ port: 0, dataDir: dir });
  });

  it('recovers from the log alone (no checkpoint), ignoring a truncated last line', async () => {
    const a = await TestClient.join(srv.port, 'crash-room');
    a.send({ t: 'cmd', ref: 1, cmd: addNode('n1') });
    a.send({ t: 'cmd', ref: 2, cmd: addNode('n2', 50) });
    await a.next('applied');
    await a.next('applied');
    const log = readFileSync(join(dir, 'crash-room.log.jsonl'), 'utf8');
    a.close();
    await srv.close();
    // simulate a crash: no checkpoint, log intact plus a partial line
    unlinkSync(join(dir, 'crash-room.json'));
    writeFileSync(join(dir, 'crash-room.log.jsonl'), log + '{"seq":3,"cmd":{"type":"node.a');
    srv = await startServer({ port: 0, dataDir: dir });
    const c = await TestClient.open(srv.port);
    c.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'crash-room', name: 'x' });
    const w = await c.next('welcome');
    expect(w.seq).toBe(2);
    expect(Object.keys(w.doc.nodes).sort()).toEqual(['n1', 'n2']);

    // The next edit after recovery must survive another crash (Sol review #5).
    c.send({ t: 'cmd', ref: 3, cmd: addNode('n3', 90) });
    expect((await c.next('applied')).seq).toBe(3);
    const log2 = readFileSync(join(dir, 'crash-room.log.jsonl'), 'utf8');
    c.close();
    await srv.close();
    unlinkSync(join(dir, 'crash-room.json'));
    writeFileSync(join(dir, 'crash-room.log.jsonl'), log2);
    srv = await startServer({ port: 0, dataDir: dir });
    const d = await TestClient.join(srv.port, 'crash-room');
    d.close();
    const e = await TestClient.open(srv.port);
    e.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'crash-room', name: 'y' });
    const w2 = await e.next('welcome');
    expect(w2.seq).toBe(3);
    expect(Object.keys(w2.doc.nodes).sort()).toEqual(['n1', 'n2', 'n3']);
    e.close();
  });

  it('rejects a command it cannot serialize without touching the doc (Sol review #1)', async () => {
    const a = await TestClient.join(srv.port, 'deep-room');
    a.send({ t: 'cmd', ref: 1, cmd: addNode('n1') });
    await a.next('applied');
    a.send({ t: 'cmd', ref: 2, cmd: { type: 'segment.remove', id: 'nope' } });
    await a.next('rejected');
    const deep = '['.repeat(15000) + ']'.repeat(15000);
    a.send(`{"t":"cmd","ref":3,"cmd":{"type":"node.add","node":{"id":"n2","pos":{"x":40,"z":0}},"extra":${deep}}}`);
    const r = await a.next('rejected');
    expect(r.ref).toBe(3);
    const b = await TestClient.open(srv.port);
    b.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'deep-room', name: 'b' });
    const w = await b.next('welcome');
    expect(w.seq).toBe(1);
    expect(Object.keys(w.doc.nodes)).toEqual(['n1']);
    a.close();
    b.close();
  });

  it('refuses and rolls back an edit it cannot persist (Sol review #4)', async () => {
    const a = await TestClient.join(srv.port, 'ro-room');
    a.send({ t: 'cmd', ref: 1, cmd: addNode('n1') });
    await a.next('applied');
    chmodSync(join(dir, 'ro-room.log.jsonl'), 0o444);
    a.send({ t: 'cmd', ref: 2, cmd: addNode('n2', 50) });
    const r = await a.next('rejected');
    expect(r).toMatchObject({ ref: 2, error: 'storage error' });
    chmodSync(join(dir, 'ro-room.log.jsonl'), 0o644);
    const b = await TestClient.open(srv.port);
    b.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'ro-room', name: 'b' });
    const w = await b.next('welcome');
    // The log file was unwritable, so the room may burn the rejected seq number; the doc is what matters.
    expect(w.seq).toBeGreaterThanOrEqual(1);
    expect(Object.keys(w.doc.nodes)).toEqual(['n1']);
    a.close();
    b.close();
  });

  it('rejects an invalid room id and a wrong protocol', async () => {
    const a = await TestClient.open(srv.port);
    a.send({ t: 'hello', protocol: PROTOCOL_VERSION, room: '../etc/passwd', name: 'x' });
    expect((await a.next('error')).error).toMatch(/room/);
    await a.closed;
    const b = await TestClient.open(srv.port);
    b.send({ t: 'hello', protocol: 999, room: 'ok', name: 'x' });
    await b.next('error');
    await b.closed;
  });

  it('answers malformed JSON with error and keeps the connection open', async () => {
    const a = await TestClient.join(srv.port);
    a.send('{not json');
    await a.next('error');
    a.send({ t: 'ping', at: 42 });
    expect((await a.next('pong')).at).toBe(42);
    a.close();
  });

  it('relays presence to others but not the sender', async () => {
    const a = await TestClient.join(srv.port);
    const b = await TestClient.join(srv.port);
    const presence = { cursor: { x: 1, z: 2 }, tool: 'road', ghost: [], selection: null };
    a.send({ t: 'presence', presence });
    const got = await b.next('presence');
    expect(got.presence).toEqual(presence);
    a.send({ t: 'ping', at: 1 });
    await a.next('pong');
    expect(a.msgs.filter((m) => m.t === 'presence')).toHaveLength(0);
    a.close();
    b.close();
  });

  it('rate limits commands', async () => {
    const a = await TestClient.join(srv.port);
    for (let i = 0; i < 80; i++) a.send({ t: 'cmd', ref: i, cmd: { type: 'meta.update', trafficDensity: 0.5 } });
    let limited = 0;
    let applied = 0;
    for (let i = 0; i < 80; i++) {
      for (;;) {
        const m = a.msgs.shift();
        if (!m) {
          await sleep(10);
          continue;
        }
        if (m.t === 'rejected' && m.error === 'rate limited') limited++;
        else if (m.t === 'applied') applied++;
        else continue;
        break;
      }
    }
    expect(limited).toBeGreaterThan(0);
    expect(applied).toBeGreaterThanOrEqual(40);
    a.close();
  });

  it('closes with 4000 on hello timeout', async () => {
    const a = await TestClient.open(srv.port);
    expect(await a.closed).toBe(4000);
  });

  it('serves /health and blocks non-GET', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/health`);
    expect(await r.json()).toMatchObject({ ok: true, rooms: 0, clients: 0 });
    const p = await fetch(`http://127.0.0.1:${srv.port}/health`, { method: 'POST' });
    expect(p.status).toBe(405);
  });
});

describe('AI building assistant over the socket (ADR 0009 §5, scripted model)', () => {
  it('answers only the asker with a proposal that applies as that user\'s own command', async () => {
    const s = await startServer({ port: 0, dataDir: dir, helloTimeoutMs: 300, ai: new AiService(scriptedModel()) });
    extra.push(s);
    const a = await TestClient.join(s.port, 'ai-room', 'asker');
    const b = await TestClient.join(s.port, 'ai-room', 'peer');
    expect(await a.next('ai.status')).toEqual({ t: 'ai.status', enabled: true, model: 'scripted' });
    const road: Command = {
      type: 'batch',
      commands: [addNode('p', -150), addNode('q', 150), { type: 'segment.add', segment: { id: 'r', a: 'p', b: 'q', roadTypeId: 'road-2' } }],
    };
    a.send({ t: 'cmd', ref: 1, cmd: road });
    await a.next('applied');
    await b.next('applied');
    a.send({ t: 'ai.ask', reqId: 7, text: '도로변에 카페 지어줘', focus: { x: 0, z: 0 } });
    const progress = await a.next('ai.progress');
    expect(progress.reqId).toBe(7);
    const p = await a.next('ai.proposal');
    expect(p.commands.filter((c) => c.type === 'building.place')).toHaveLength(3);
    // Nothing changed for anyone yet, and the peer saw no AI traffic.
    expect(b.msgs.some((m) => m.t.startsWith('ai.') && m.t !== 'ai.status')).toBe(false);
    a.send({ t: 'cmd', ref: 2, cmd: { type: 'batch', commands: p.commands } });
    const applied = await b.next('applied');
    expect(applied.cmd.type).toBe('batch');
    expect(applied.by).toBe((await a.next('applied')).by);
    a.close();
    b.close();
  });

  it('reports a disabled assistant and refuses a second request while one is running', async () => {
    const off = await startServer({ port: 0, dataDir: dir, helloTimeoutMs: 300, ai: new AiService(null) });
    extra.push(off);
    const c = await TestClient.join(off.port, 'r2');
    expect(await c.next('ai.status')).toEqual({ t: 'ai.status', enabled: false, model: null });
    c.send({ t: 'ai.ask', reqId: 1, text: '공원', focus: null });
    expect((await c.next('ai.error')).error).toMatch(/키/);
    c.close();

    let release!: () => void;
    const slow = new AiService({ name: 'slow', send: () => new Promise((_, rej) => (release = () => rej(new Error('stop')))) });
    const s2 = await startServer({ port: 0, dataDir: dir, helloTimeoutMs: 300, ai: slow });
    extra.push(s2);
    const d = await TestClient.join(s2.port, 'r3');
    d.send({ t: 'ai.ask', reqId: 1, text: '하나', focus: null });
    await sleep(50);
    d.send({ t: 'ai.ask', reqId: 2, text: '둘', focus: null });
    expect(await d.next('ai.error')).toMatchObject({ reqId: 2, error: expect.stringMatching(/처리 중/) });
    // Cancel: the late failure of request 1 is dropped, not reported.
    d.send({ t: 'ai.cancel', reqId: 1 });
    await sleep(50);
    release();
    await sleep(100);
    expect(d.msgs.some((m) => m.t === 'ai.error' && m.reqId === 1)).toBe(false);
    d.close();
  });
});
