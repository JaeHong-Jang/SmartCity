import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, segmentsAtNode, tryApplyCommand, type CityDoc, type Command } from './index.js';

function ok(doc: CityDoc, cmd: Command): void {
  const r = applyCommand(doc, cmd);
  expect(r).toEqual({ ok: true });
}

function road(doc: CityDoc): void {
  ok(doc, {
    type: 'batch',
    commands: [
      { type: 'node.add', node: { id: 'n1', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'n2', pos: { x: 100, z: 0 } } },
      { type: 'segment.add', segment: { id: 's1', a: 'n1', b: 'n2', roadTypeId: 'road-2' } },
    ],
  });
}

describe('applyCommand', () => {
  it('adds nodes and segments', () => {
    const doc = createEmptyDoc();
    road(doc);
    expect(Object.keys(doc.nodes)).toEqual(['n1', 'n2']);
    expect(doc.segments.s1?.roadTypeId).toBe('road-2');
  });

  it('rolls back the whole batch when one command fails', () => {
    const doc = createEmptyDoc();
    const before = JSON.stringify(doc);
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'n1', pos: { x: 0, z: 0 } } },
        { type: 'segment.add', segment: { id: 's1', a: 'n1', b: 'missing', roadTypeId: 'road-2' } },
      ],
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('rejects malformed and out-of-bounds input', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, { type: 'node.add', node: { id: '../x', pos: { x: 0, z: 0 } } }).ok).toBe(false);
    expect(applyCommand(doc, { type: 'node.add', node: { id: 'n', pos: { x: 1e9, z: 0 } } }).ok).toBe(false);
    expect(applyCommand(doc, { type: 'node.add', node: { id: 'n', pos: { x: NaN, z: 0 } } }).ok).toBe(false);
    expect(applyCommand(doc, { type: 'nope' } as unknown as Command).ok).toBe(false);
    expect(applyCommand(doc, { type: 'batch', commands: [{ type: 'batch', commands: [] }] }).ok).toBe(false);
  });

  it('rejects too-short and duplicate segments', () => {
    const doc = createEmptyDoc();
    road(doc);
    ok(doc, { type: 'node.add', node: { id: 'n3', pos: { x: 103, z: 0 } } });
    expect(applyCommand(doc, { type: 'segment.add', segment: { id: 's2', a: 'n2', b: 'n3', roadTypeId: 'road-2' } }).ok).toBe(false);
    expect(applyCommand(doc, { type: 'segment.add', segment: { id: 's3', a: 'n2', b: 'n1', roadTypeId: 'road-2' } }).ok).toBe(false);
  });

  it('splits a segment and carries stops, closures and signal approaches', () => {
    const doc = createEmptyDoc();
    road(doc);
    ok(doc, { type: 'busStop.add', stop: { id: 'st1', segmentId: 's1', t: 0.8, dir: 'forward' } });
    ok(doc, { type: 'closure.set', closure: { segmentId: 's1', reason: 'test' } });
    ok(doc, { type: 'intersection.set', control: { nodeId: 'n1', kind: 'signal', phases: [{ approaches: ['s1'], green: 20 }], yellow: 3, allRed: 2, offset: 0 } });
    ok(doc, { type: 'segment.split', id: 's1', t: 0.5, nodeId: 'm', segmentIds: ['sa', 'sb'] });

    expect(doc.segments.s1).toBeUndefined();
    expect(doc.nodes.m?.pos).toEqual({ x: 50, z: 0 });
    expect(doc.segments.sa).toMatchObject({ a: 'n1', b: 'm' });
    expect(doc.segments.sb).toMatchObject({ a: 'm', b: 'n2' });
    expect(doc.busStops.st1?.segmentId).toBe('sb');
    expect(doc.busStops.st1?.t).toBeCloseTo(0.6);
    expect(Object.keys(doc.closures).sort()).toEqual(['sa', 'sb']);
    expect(doc.intersections.n1?.phases?.[0]?.approaches).toEqual(['sa']);
  });

  it('splits curved segments into two curved halves meeting at the curve point', () => {
    const doc = createEmptyDoc();
    ok(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
        { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
        { type: 'segment.add', segment: { id: 'c', a: 'a', b: 'b', roadTypeId: 'road-2', control: { x: 50, z: 50 } } },
      ],
    });
    ok(doc, { type: 'segment.split', id: 'c', t: 0.5, nodeId: 'm', segmentIds: ['c1', 'c2'] });
    expect(doc.nodes.m?.pos).toEqual({ x: 50, z: 25 });
    expect(doc.segments.c1?.control).toEqual({ x: 25, z: 25 });
    expect(doc.segments.c2?.control).toEqual({ x: 75, z: 25 });
  });

  it('removing a segment removes orphan nodes, stops and lines that lose their stops', () => {
    const doc = createEmptyDoc();
    road(doc);
    ok(doc, { type: 'busStop.add', stop: { id: 'st1', segmentId: 's1', t: 0.2, dir: 'forward' } });
    ok(doc, { type: 'busStop.add', stop: { id: 'st2', segmentId: 's1', t: 0.8, dir: 'backward' } });
    ok(doc, { type: 'busLine.upsert', line: { id: 'L1', name: '1번', color: '#ff0000', stopIds: ['st1', 'st2'], vehicleTypeId: 'city-bus', buses: 2 } });
    ok(doc, { type: 'segment.remove', id: 's1' });
    expect(doc.nodes).toEqual({});
    expect(doc.busStops).toEqual({});
    expect(doc.busLines).toEqual({});
  });

  it('keeps nodes that still have segments', () => {
    const doc = createEmptyDoc();
    road(doc);
    ok(doc, { type: 'node.add', node: { id: 'n3', pos: { x: 100, z: 100 } } });
    ok(doc, { type: 'segment.add', segment: { id: 's2', a: 'n2', b: 'n3', roadTypeId: 'road-4' } });
    ok(doc, { type: 'segment.remove', id: 's1' });
    expect(Object.keys(doc.nodes).sort()).toEqual(['n2', 'n3']);
    expect(segmentsAtNode(doc, 'n2').map((s) => s.id)).toEqual(['s2']);
  });

  it('protects types that are in use', () => {
    const doc = createEmptyDoc();
    ok(doc, { type: 'building.place', building: { id: 'b1', typeId: 'house', pos: { x: 10, z: 10 }, rotation: 0 } });
    expect(applyCommand(doc, { type: 'buildingType.remove', id: 'house' }).ok).toBe(false);
    ok(doc, { type: 'building.remove', id: 'b1' });
    ok(doc, { type: 'buildingType.remove', id: 'house' });
  });

  it('validates user-defined building, vehicle and road types', () => {
    const doc = createEmptyDoc();
    const bt = cloneJson(doc.buildingTypes.house!);
    bt.id = 'custom';
    bt.parts[0]!.floors = 0;
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: bt }).ok).toBe(false);
    bt.parts[0]!.floors = 3;
    ok(doc, { type: 'buildingType.upsert', buildingType: bt });

    const vt = cloneJson(doc.vehicleTypes.sedan!);
    vt.id = 'mycar';
    vt.parts = [];
    expect(applyCommand(doc, { type: 'vehicleType.upsert', vehicleType: vt }).ok).toBe(false);

    const rt = { ...doc.roadTypes['road-2']!, id: 'r0', lanesForward: 0 };
    expect(applyCommand(doc, { type: 'roadType.upsert', roadType: rt }).ok).toBe(false);
  });

  it('rejects signal phases referencing segments not at the node', () => {
    const doc = createEmptyDoc();
    road(doc);
    const r = applyCommand(doc, {
      type: 'intersection.set',
      control: { nodeId: 'n1', kind: 'signal', phases: [{ approaches: ['other'], green: 20 }], yellow: 3, allRed: 2, offset: 0 },
    });
    expect(r.ok).toBe(false);
  });
});

describe('applyCommand hardening (Sol review 2026-10-23)', () => {
  it('rejects prototype-polluting ids and leaves the prototype untouched after a failed batch (#2)', () => {
    const doc = createEmptyDoc();
    const proto = Object.getPrototypeOf(doc.nodes);
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: '__proto__', pos: { x: 0, z: 0 } } },
        { type: 'node.add', node: { id: 'far', pos: { x: 1e9, z: 0 } } },
      ],
    });
    expect(r.ok).toBe(false);
    expect(Object.getPrototypeOf(doc.nodes)).toBe(proto);
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      expect(applyCommand(doc, { type: 'node.add', node: { id, pos: { x: 0, z: 0 } } }).ok).toBe(false);
    }
  });

  it('never resolves references through the prototype or non-string ids (#3)', () => {
    const doc = createEmptyDoc();
    road(doc);
    expect(applyCommand(doc, { type: 'segment.setType', id: 's1', roadTypeId: 'constructor' }).ok).toBe(false);
    expect(doc.segments.s1?.roadTypeId).toBe('road-2');
    const placed = applyCommand(doc, {
      type: 'building.place',
      building: { id: 'b1', typeId: ['house'] as unknown as string, pos: { x: 10, z: 10 }, rotation: 0 },
    });
    expect(placed.ok).toBe(false);
  });

  it('stores only validated fields, dropping unknown nested data (#1)', () => {
    const doc = createEmptyDoc();
    road(doc);
    let deep: unknown = [];
    for (let i = 0; i < 2000; i++) deep = [deep];
    ok(doc, { type: 'busStop.add', stop: { id: 'st', segmentId: 's1', t: 0.5, dir: 'forward', extra: deep } as never });
    expect(doc.busStops.st).toEqual({ id: 'st', segmentId: 's1', t: 0.5, dir: 'forward' });
    const vt = { ...cloneJson(doc.vehicleTypes.sedan!), id: 'v2', junk: deep } as never;
    ok(doc, { type: 'vehicleType.upsert', vehicleType: vt });
    expect('junk' in doc.vehicleTypes.v2!).toBe(false);
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it('allows splits close to an end as long as both pieces are long enough (#9)', () => {
    const doc = createEmptyDoc();
    ok(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'a', pos: { x: -2000, z: 0 } } },
        { type: 'node.add', node: { id: 'b', pos: { x: 2000, z: 0 } } },
        { type: 'segment.add', segment: { id: 's', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      ],
    });
    ok(doc, { type: 'segment.split', id: 's', t: 0.004, nodeId: 'm', segmentIds: ['s1', 's2'] });
    expect(applyCommand(doc, { type: 'segment.split', id: 's1', t: 0.1, nodeId: 'm2', segmentIds: ['x1', 'x2'] }).ok).toBe(false);
  });

  it('tryApplyCommand can roll back a successful command', () => {
    const doc = createEmptyDoc();
    const before = JSON.stringify(doc);
    const r = tryApplyCommand(doc, { type: 'node.add', node: { id: 'n', pos: { x: 1, z: 1 } } });
    expect(r.ok).toBe(true);
    if (r.ok) r.rollback();
    expect(JSON.stringify(doc)).toBe(before);
  });
});
