import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, type Command } from '@smartcity/shared';
import { ClientStore } from './store';

const welcome = (seq = 0) => ({ t: 'welcome' as const, clientId: 'me', tag: 'T1', color: '#ff0000', room: 'main', seq, doc: createEmptyDoc(), peers: [] });
const addNode: Command = { type: 'node.add', node: { id: 'n1', pos: { x: 0, z: 0 } } };

describe('ClientStore', () => {
  it('welcome loads the doc, marks ready and fires reset', () => {
    const s = new ClientStore('main', '나');
    const reset = vi.fn();
    s.onReset(reset);
    s.receive(welcome(5));
    expect(s.getState().ready).toBe(true);
    expect(s.getState().seq).toBe(5);
    expect(s.getState().tag).toBe('T1');
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('applies commands in seq order and clears pending by ref', () => {
    const s = new ClientStore('main', '나');
    s.receive(welcome());
    const applied = vi.fn();
    s.onApplied(applied);
    s.addPending({ ref: 7, cmd: addNode, ghost: [[{ x: 0, z: 0 }, { x: 1, z: 0 }]], sentAt: 0 });
    s.receive({ t: 'applied', seq: 1, cmd: addNode, by: 'me', ref: 7 });
    expect(s.getState().doc.nodes.n1).toBeDefined();
    expect(s.getState().pending).toHaveLength(0);
    expect(applied).toHaveBeenCalledWith(addNode, 1);
    // Duplicate / old seq is ignored.
    s.receive({ t: 'applied', seq: 1, cmd: addNode, by: 'me', ref: 7 });
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('does not clear my pending entry for another client with the same ref', () => {
    const s = new ClientStore('main', '나');
    s.receive(welcome());
    s.addPending({ ref: 1, cmd: addNode, ghost: [], sentAt: 0 });
    s.receive({ t: 'applied', seq: 1, cmd: { type: 'node.add', node: { id: 'x', pos: { x: 5, z: 5 } } }, by: 'other' });
    expect(s.getState().pending).toHaveLength(1);
  });

  it('requests a resync on a seq gap without applying', () => {
    const s = new ClientStore('main', '나');
    s.receive(welcome());
    const resync = vi.fn();
    s.onResyncNeeded = resync;
    s.receive({ t: 'applied', seq: 3, cmd: addNode, by: 'x' });
    expect(resync).toHaveBeenCalled();
    expect(s.getState().doc.nodes.n1).toBeUndefined();
  });

  it('rejected removes pending, flashes the ghost and shows a toast', () => {
    let now = 1000;
    const s = new ClientStore('main', '나', () => now);
    s.receive(welcome());
    s.addPending({ ref: 2, cmd: addNode, ghost: [[{ x: 0, z: 0 }, { x: 9, z: 0 }]], sentAt: 0 });
    s.receive({ t: 'rejected', ref: 2, error: 'segment shorter than 8m' });
    const st = s.getState();
    expect(st.pending).toHaveLength(0);
    expect(st.flashes).toHaveLength(1);
    expect(st.toasts[0]!.kind).toBe('error');
    expect(st.toasts[0]!.text).toContain('도로가 너무 짧습니다');
    now += 10_000;
    s.expire();
    expect(s.getState().flashes).toHaveLength(0);
    expect(s.getState().toasts).toHaveLength(0);
  });

  it('ignores own presence and drops presence of departed peers', () => {
    const s = new ClientStore('main', '나');
    s.receive(welcome());
    const pr = { cursor: { x: 1, z: 2 }, tool: 'road', ghost: [], selection: null };
    s.receive({ t: 'presence', clientId: 'me', presence: pr });
    expect(s.getState().presence).toEqual({});
    s.receive({ t: 'presence', clientId: 'p2', presence: pr });
    expect(s.getState().presence.p2).toEqual(pr);
    s.receive({ t: 'peers', peers: [{ clientId: 'me', name: '나', color: '#fff000' }] });
    expect(s.getState().presence.p2).toBeUndefined();
  });

  it('connection loss discards pending commands with a notice', () => {
    const s = new ClientStore('main', '나');
    s.receive(welcome());
    s.addPending({ ref: 1, cmd: addNode, ghost: [], sentAt: 0 });
    s.connectionLost('reconnecting');
    expect(s.getState().pending).toHaveLength(0);
    expect(s.getState().connection).toBe('reconnecting');
    expect(s.getState().toasts.at(-1)!.text).toContain('1건');
  });

  it('applies server-approved commands as trusted (policy may differ from when they were accepted)', () => {
    const s = new ClientStore('main', '나');
    s.receive(welcome());
    const onResync = vi.fn();
    s.onResyncNeeded = onResync;
    const road: Command = {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'a', pos: { x: -50, z: 0 } } },
        { type: 'node.add', node: { id: 'b', pos: { x: 50, z: 0 } } },
        { type: 'segment.add', segment: { id: 's', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      ],
    };
    s.receive({ t: 'applied', seq: 1, cmd: road, by: 'other' });
    // Today's rules reject a building on the road, but the server already accepted it.
    s.receive({ t: 'applied', seq: 2, cmd: { type: 'building.place', building: { id: 'old', typeId: 'house', pos: { x: 0, z: 0 }, rotation: 0 } }, by: 'other' });
    expect(onResync).not.toHaveBeenCalled();
    expect(s.getState().doc.buildings.old).toBeDefined();
    expect(s.getState().seq).toBe(2);
  });

  it('migrates the welcome doc and keeps a parcel selection only while the parcel exists', () => {
    const s = new ClientStore('main', '나');
    const doc = createEmptyDoc() as unknown as Record<string, unknown>;
    doc.version = 1;
    delete doc.parcels;
    s.receive({ ...welcome(), doc: doc as never });
    expect(s.getState().doc.parcels).toEqual({});
    const parcel = { id: 'q', polygon: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], zone: 'green' as const, regulation: { coverage: 0.2, far: 1, maxHeight: 12, setback: 5 } };
    s.receive({ t: 'applied', seq: 1, cmd: { type: 'parcel.upsert', parcel }, by: 'me' });
    s.set({ selection: { kind: 'parcel', id: 'q' } });
    s.receive({ t: 'applied', seq: 2, cmd: { type: 'parcel.remove', id: 'q' }, by: 'me' });
    expect(s.getState().selection).toBeNull();
  });
});

describe('command outcomes by ref (Sol review 2026-10-23 #2/#3)', () => {
  it('records ok for my applied commands and the error for rejections', () => {
    const s = new ClientStore('main', '나');
    s.receive(welcome());
    s.addPending({ ref: 3, cmd: addNode, ghost: [], sentAt: 0 });
    s.addPending({ ref: 4, cmd: addNode, ghost: [], sentAt: 0 });
    s.receive({ t: 'applied', seq: 1, cmd: addNode, by: 'me', ref: 3 });
    s.receive({ t: 'rejected', ref: 4, error: 'conflict: the design was changed by someone else' });
    expect(s.getState().results).toEqual({ 3: 'ok', 4: 'conflict: the design was changed by someone else' });
    // Another client's ref with the same number is not mine.
    s.receive({ t: 'applied', seq: 2, cmd: { type: 'node.add', node: { id: 'n9', pos: { x: 50, z: 0 } } }, by: 'other', ref: 5 });
    expect(s.getState().results[5]).toBeUndefined();
  });
});
