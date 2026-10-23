import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createEmptyDoc, lotsAlongSegment, lotsToCommand, type Command, type ServerMessage } from '@smartcity/shared';
import { loadRoom } from './persistence.js';
import { Client, Room } from './room.js';

const INTERVAL = 5_000;

function fakeClient(name = 'c'): { client: Client; got: ServerMessage[] } {
  const got: ServerMessage[] = [];
  const ws = { OPEN: 1, readyState: 1, send: (d: string) => got.push(JSON.parse(d) as ServerMessage) } as unknown as WebSocket;
  return { client: new Client(ws, name), got };
}

let dir: string;
let room: Room;
beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'growth-'));
  room = new Room('g', dir, createEmptyDoc(), 0);
});
afterEach(() => {
  room.dispose();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A street with a row of residential auto lots, committed through the room like a user would. */
function setup(owner: Client): void {
  const setupCmds: Command[] = [
    { type: 'node.add', node: { id: 'a', pos: { x: -100, z: 0 } } },
    { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
    { type: 'segment.add', segment: { id: 'S1', a: 'a', b: 'b', roadTypeId: 'road-2' } },
  ];
  setupCmds.forEach((c, i) => room.command(owner, i + 1, c));
  const lots = lotsAlongSegment(room.doc, 'S1', 'right', 0, 1, 2, 'residential', 'z');
  room.command(owner, 10, lotsToCommand(lots));
}

const autoBuildings = (r: Room) => Object.values(r.doc.buildings).filter((b) => b.auto);

describe('GrowthDirector', () => {
  it('grows every 5 s while a client is connected, broadcasting system batches with seq', () => {
    const { client, got } = fakeClient();
    room.join(client);
    setup(client);
    const seqBefore = room.seq;
    got.length = 0;
    expect(autoBuildings(room)).toHaveLength(0);

    vi.advanceTimersByTime(INTERVAL - 1);
    expect(got).toHaveLength(0);
    vi.advanceTimersByTime(1);

    const applied = got.filter((m) => m.t === 'applied');
    expect(applied).toHaveLength(1);
    const msg = applied[0]!;
    if (msg.t !== 'applied') throw new Error('unreachable');
    expect(msg.by).toBe('system');
    expect(msg.seq).toBe(seqBefore + 1);
    expect(msg.ref).toBeUndefined();
    expect(msg.cmd.type).toBe('batch');
    expect(room.seq).toBe(seqBefore + 1);
    expect(autoBuildings(room).length).toBeGreaterThan(0);
    expect(autoBuildings(room).length).toBeLessThanOrEqual(4);
  });

  it('survives replay from the log (a restart loads the grown city)', () => {
    const { client } = fakeClient();
    room.join(client);
    setup(client);
    vi.advanceTimersByTime(INTERVAL * 6);
    expect(autoBuildings(room).length).toBeGreaterThan(0);
    const loaded = loadRoom(dir, 'g'); // no checkpoint was written: pure log replay
    expect(loaded.seq).toBe(room.seq);
    expect(loaded.doc).toEqual(room.doc);
  });

  it('pauses with meta.growth=false and resumes when switched back on', () => {
    const { client } = fakeClient();
    room.join(client);
    setup(client);
    room.command(client, 20, { type: 'meta.update', growth: false });
    const seq = room.seq;
    vi.advanceTimersByTime(INTERVAL * 5);
    expect(room.seq).toBe(seq);
    expect(autoBuildings(room)).toHaveLength(0);
    room.command(client, 21, { type: 'meta.update', growth: true });
    vi.advanceTimersByTime(INTERVAL * 2);
    expect(autoBuildings(room).length).toBeGreaterThan(0);
  });

  it('pauses with no clients connected', () => {
    const { client } = fakeClient();
    room.join(client);
    setup(client);
    room.leave(client);
    const seq = room.seq;
    vi.advanceTimersByTime(INTERVAL * 5);
    expect(room.seq).toBe(seq);
    expect(autoBuildings(room)).toHaveLength(0);
    room.join(fakeClient('again').client);
    vi.advanceTimersByTime(INTERVAL * 2);
    expect(autoBuildings(room).length).toBeGreaterThan(0);
  });

  it('stops its timer on dispose', () => {
    const { client } = fakeClient();
    room.join(client);
    setup(client);
    room.dispose();
    const seq = room.seq;
    vi.advanceTimersByTime(INTERVAL * 5);
    expect(room.seq).toBe(seq);
  });

  it('system commits take the user path: a rejected system command leaves doc and seq untouched', () => {
    const before = JSON.stringify(room.doc);
    const res = room.system({ type: 'building.remove', id: 'nope' });
    expect(res.ok).toBe(false);
    expect(room.seq).toBe(0);
    expect(JSON.stringify(room.doc)).toBe(before);
  });
});
