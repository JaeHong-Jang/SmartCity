// AI roads (ADR 0010 §9): add_road plans with the user's road planner and proposes one atomic batch per road.
import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, type CityDoc, type Command } from '@smartcity/shared';
import { runAgent } from './agent.js';
import { scriptedModel } from './model.js';
import { MAX_PROPOSAL_COMMANDS, newSandbox, runTool } from './tools.js';

/** Two crossing 200 m roads (road-2). */
function town(): CityDoc {
  const doc = createEmptyDoc('ai', 3);
  const cmds: Command[] = [
    { type: 'node.add', node: { id: 'w', pos: { x: -100, z: 0 } } },
    { type: 'node.add', node: { id: 'e', pos: { x: 100, z: 0 } } },
    { type: 'node.add', node: { id: 'n', pos: { x: 0, z: -100 } } },
    { type: 'node.add', node: { id: 's', pos: { x: 0, z: 100 } } },
    { type: 'node.add', node: { id: 'c', pos: { x: 0, z: 0 } } },
    { type: 'segment.add', segment: { id: 'W', a: 'w', b: 'c', roadTypeId: 'road-2' } },
    { type: 'segment.add', segment: { id: 'E', a: 'c', b: 'e', roadTypeId: 'road-2' } },
    { type: 'segment.add', segment: { id: 'N', a: 'n', b: 'c', roadTypeId: 'road-2' } },
    { type: 'segment.add', segment: { id: 'S', a: 'c', b: 's', roadTypeId: 'road-2' } },
  ];
  expect(applyCommand(doc, { type: 'batch', commands: cmds })).toEqual({ ok: true });
  return doc;
}

const pts = (...p: [number, number][]) => p.map(([x, z]) => ({ x, z }));
const road = (points: { x: number; z: number }[], extra: Record<string, unknown> = {}) => ({ points, road_type: null, snap: true, ...extra });

function run(sb: ReturnType<typeof newSandbox>, input: unknown) {
  const r = runTool(sb, 'add_road', input);
  return { ...r, json: r.isError ? null : (JSON.parse(r.content) as Record<string, any>) };
}

const roadBatch = (sb: ReturnType<typeof newSandbox>, i = 0) => sb.commands[i] as Extract<Command, { type: 'batch' }>;

describe('add_road', () => {
  it('extends from a road end: one batch, joined to the existing node, nothing else touched', () => {
    const doc = town();
    const before = JSON.stringify(doc);
    const sb = newSandbox(doc, 't', null, null);
    const r = run(sb, road(pts([100, 0], [224, 0])));
    expect(r.json).toMatchObject({ length_m: 124, connected_existing_nodes: 1, splits: 0, warnings: [] });
    expect(sb.commands).toHaveLength(1);
    const b = roadBatch(sb);
    expect(b.type).toBe('batch');
    expect(b.commands.map((c) => c.type)).toEqual(['node.add', 'segment.add']);
    const seg = b.commands.find((c) => c.type === 'segment.add') as Extract<Command, { type: 'segment.add' }>;
    expect(seg.segment.a).toBe('e');
    expect(seg.segment.id.startsWith('ai-t-')).toBe(true);
    expect(sb.leaves).toBe(2);
    // The sandbox works on a copy.
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('never touches the live doc and applies to it unchanged', () => {
    const live = town();
    const sb = newSandbox(live, 't', null, null);
    run(sb, road(pts([100, 0], [224, 0])));
    const fresh = town();
    expect(applyCommand(fresh, roadBatch(sb))).toEqual({ ok: true });
    expect(Object.keys(fresh.segments)).toHaveLength(5);
  });

  it('crossing an existing road splits it and joins at the crossing', () => {
    const doc = town();
    const sb = newSandbox(cloneJson(doc), 't', null, null);
    const r = run(sb, road(pts([48, -64], [48, 64])));
    expect(r.json).toMatchObject({ splits: 1, connected_existing_nodes: 0 });
    expect(r.json!.warnings).toEqual([]); // joined to the network by the split
    const types = roadBatch(sb).commands.map((c) => c.type);
    expect(types.filter((t) => t === 'segment.split')).toHaveLength(1);
    expect(types.filter((t) => t === 'segment.add')).toHaveLength(2);
    const live = cloneJson(doc);
    expect(applyCommand(live, roadBatch(sb))).toEqual({ ok: true });
    expect(live.segments['E']).toBeUndefined();
    expect(Object.keys(live.segments)).toHaveLength(4 - 1 + 2 + 2);
  });

  it('snaps an end that is near an existing node, but not with snap=false', () => {
    const sb = newSandbox(town(), 't', null, null);
    expect(run(sb, road(pts([97, 3], [224, 0]))).json).toMatchObject({ connected_existing_nodes: 1 });
    const sb2 = newSandbox(town(), 't', null, null);
    const r = run(sb2, road(pts([97, 40], [220, 40]), { snap: false }));
    expect(r.json).toMatchObject({ connected_existing_nodes: 0, splits: 0 });
  });

  it('chains several points into one batch', () => {
    const sb = newSandbox(town(), 't', null, null);
    const r = run(sb, road(pts([100, 0], [160, 0], [160, 64], [224, 64])));
    expect(r.json).toMatchObject({ connected_existing_nodes: 1, splits: 0 });
    expect(sb.commands).toHaveLength(1);
    expect(roadBatch(sb).commands.filter((c) => c.type === 'segment.add')).toHaveLength(3);
  });

  it('warns about an isolated road and about junctions closer than 40 m', () => {
    const sb = newSandbox(town(), 't', null, null);
    expect(run(sb, road(pts([-80, 60], [-80, 120]))).json!.warnings.join(' ')).toMatch(/고립/);
    // Branching off E 20 m from the existing 4-way junction at the origin.
    const sb2 = newSandbox(town(), 't', null, null);
    expect(run(sb2, road(pts([16, -64], [16, 64]))).json!.warnings.join(' ')).toMatch(/40 m/);
  });

  it('only adds: every command is a node, split or segment, never a delete/type change/move', () => {
    const sb = newSandbox(town(), 't', null, null);
    run(sb, road(pts([48, -64], [48, 64])));
    run(sb, road(pts([100, 0], [224, 0])));
    for (const c of sb.commands.flatMap((x) => (x.type === 'batch' ? x.commands : [x]))) expect(['node.add', 'segment.split', 'segment.add']).toContain(c.type);
  });

  it('rejects bad input and unplannable roads without changing the proposal', () => {
    const sb = newSandbox(town(), 't', null, null);
    const before = JSON.stringify(sb.doc);
    expect(run(sb, road(pts([0, 0])))).toMatchObject({ isError: true });
    expect(run(sb, road(pts([100, 0], [224, 0]), { road_type: 'nope' })).content).toMatch(/road type/);
    expect(run(sb, road(pts([100, 0], [104, 0]))).content).toMatch(/짧/);
    // Along an existing road.
    expect(run(sb, road(pts([-80, 0], [-20, 0]))).isError).toBe(true);
    expect(sb.commands).toEqual([]);
    expect(JSON.stringify(sb.doc)).toBe(before);
  });

  it('counts the road\'s leaves in the 200-command budget and refuses to overflow', () => {
    const sb = newSandbox(town(), 't', null, null);
    sb.leaves = MAX_PROPOSAL_COMMANDS - 1;
    const before = JSON.stringify(sb.doc);
    const r = run(sb, road(pts([100, 0], [224, 0])));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/proposal is full/);
    expect(sb.commands).toEqual([]);
    expect(JSON.stringify(sb.doc)).toBe(before);
    sb.leaves = MAX_PROPOSAL_COMMANDS - 2;
    expect(run(sb, road(pts([100, 0], [224, 0]))).isError).toBe(false);
    expect(sb.leaves).toBe(MAX_PROPOSAL_COMMANDS);
  });

  it('find_spots sees the new road (it is already in the sandbox document)', () => {
    const sb = newSandbox(town(), 't', null, null);
    run(sb, road(pts([100, 0], [224, 0])));
    const r = runTool(sb, 'find_spots', { x: 160, z: 0, near_building: null, near_road: null, width: 12, depth: 10, count: 4 });
    const spots = (JSON.parse(r.content) as { spots: { x: number; road: string }[] }).spots;
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.some((s) => s.road.startsWith('ai-t-') && s.x > 110)).toBe(true);
  });
});

describe('road split keeps references (route, closure, frontage)', () => {
  function withRefs(): CityDoc {
    const doc = town();
    const cmds: Command[] = [
      { type: 'busStop.add', stop: { id: 'bs1', segmentId: 'E', t: 0.2, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'bs2', segmentId: 'E', t: 0.8, dir: 'forward' } },
      { type: 'busLine.upsert', line: { id: 'L1', name: '1번', color: '#ff0000', stopIds: ['bs1', 'bs2'], vehicleTypeId: Object.keys(doc.vehicleTypes).find((k) => doc.vehicleTypes[k]!.kind === 'bus') ?? 'bus', buses: 1 } },
      { type: 'closure.set', closure: { segmentId: 'E', reason: '공사' } },
      {
        type: 'parcel.upsert',
        parcel: { id: 'lotA', polygon: [{ x: 70, z: 10 }, { x: 90, z: 10 }, { x: 90, z: 30 }, { x: 70, z: 30 }], zone: 'residential', regulation: { coverage: 0.5, far: 1, maxHeight: 20, setback: 1 }, auto: true, frontage: { segmentId: 'E', side: 'right' } },
      },
    ];
    for (const c of cmds) {
      const r = applyCommand(doc, c);
      if (!r.ok) throw new Error(`fixture: ${c.type}: ${r.error}`);
    }
    return doc;
  }

  it('moves stops, route, closure and frontage onto the pieces', () => {
    const doc = withRefs();
    const sb = newSandbox(cloneJson(doc), 't', null, null);
    expect(run(sb, road(pts([48, -64], [48, 64]))).json).toMatchObject({ splits: 1 });
    expect(applyCommand(doc, roadBatch(sb))).toEqual({ ok: true });
    expect(doc.segments['E']).toBeUndefined();
    // Stops are re-homed to a surviving piece of E and the line still lists both.
    expect(Object.values(doc.busStops).every((s) => !!doc.segments[s.segmentId])).toBe(true);
    expect(doc.busLines['L1']!.stopIds).toEqual(['bs1', 'bs2']);
    // The closure is on both pieces.
    const closed = Object.keys(doc.closures);
    expect(closed).toHaveLength(2);
    expect(closed.every((id) => !!doc.segments[id])).toBe(true);
    expect(doc.closures['E']).toBeUndefined();
    // The lot faces a piece that exists; the lot is at x 70..90, past the split at x 48.
    expect(doc.segments[doc.parcels['lotA']!.frontage!.segmentId]).toBeDefined();
  });
});

describe('atomicity under concurrent edits', () => {
  it('a split target deleted or split by someone else fails the whole road and leaves the doc unchanged', () => {
    const doc = town();
    const sb = newSandbox(cloneJson(doc), 't', null, null);
    run(sb, road(pts([48, -64], [48, 64])));
    const cmd = roadBatch(sb);

    const deleted = cloneJson(doc);
    expect(applyCommand(deleted, { type: 'segment.remove', id: 'E' }).ok).toBe(true);
    const snap1 = JSON.stringify(deleted);
    expect(applyCommand(deleted, cmd).ok).toBe(false);
    expect(JSON.stringify(deleted)).toBe(snap1);

    const split = cloneJson(doc);
    expect(applyCommand(split, { type: 'segment.split', id: 'E', t: 0.3, nodeId: 'zz', segmentIds: ['z1', 'z2'] }).ok).toBe(true);
    const snap2 = JSON.stringify(split);
    const r = applyCommand(split, cmd);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(split)).toBe(snap2);
  });
});

describe('scripted road request', () => {
  it('lays a 120 m road from a road end plus two buildings beside it, all valid on the live doc', async () => {
    const doc = town();
    const res = await runAgent({ model: scriptedModel(), doc, text: '이 동네에 도로 깔아줘', focus: { x: 90, z: 0 }, tag: 'r1', zoneLots: null, signal: new AbortController().signal });
    expect(JSON.stringify(doc)).toBe(JSON.stringify(town()));
    expect(res.commands.map((c) => c.type)).toEqual(['batch', 'buildingType.upsert', 'building.place', 'building.place']);
    expect(applyCommand(doc, { type: 'batch', commands: res.commands.flatMap((c) => (c.type === 'batch' && c.commands.some((x) => x.type === 'segment.add') ? c.commands : c.type === 'batch' ? c.commands : [c])) })).toEqual({ ok: true });
    expect(Object.keys(doc.segments).length).toBe(5);
  });

  it('does not build roads for other requests', async () => {
    const res = await runAgent({ model: scriptedModel(), doc: town(), text: '도로 북쪽에 카페 지어줘', focus: { x: 20, z: 20 }, tag: 'r2', zoneLots: null, signal: new AbortController().signal });
    expect(res.commands.some((c) => c.type === 'batch')).toBe(false);
  });
});

describe('add_road never damages buildings or lots (Sol 4b #1)', () => {
  const place = (doc: CityDoc, c: Command): void => {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`fixture ${c.type}: ${r.error}`);
  };
  const autoLot = (doc: CityDoc): void => {
    place(doc, { type: 'parcel.upsert', parcel: { id: 'lotX', polygon: [{ x: 36, z: 14 }, { x: 60, z: 14 }, { x: 60, z: 40 }, { x: 36, z: 40 }], zone: 'residential', regulation: { coverage: 0.5, far: 1, maxHeight: 20, setback: 1 }, auto: true } });
    place(doc, { type: 'building.place', building: { id: 'autoH', typeId: 'house', pos: { x: 48, z: 26 }, rotation: 0, auto: true } });
  };
  const snapshot = (d: CityDoc) => JSON.stringify(d);

  it('rejects a road through a user building', () => {
    const doc = town();
    place(doc, { type: 'building.place', building: { id: 'userH', typeId: 'house', pos: { x: 160, z: 0 }, rotation: 0 } });
    const sb = newSandbox(doc, 't', null, null);
    const before = snapshot(sb.doc);
    const r = run(sb, road(pts([100, 0], [224, 0])));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/building/);
    expect(sb.commands).toEqual([]);
    expect(snapshot(sb.doc)).toBe(before);
  });

  it('rejects a road across an auto building and lot instead of deleting them', () => {
    const doc = town();
    autoLot(doc);
    const sb = newSandbox(doc, 't', null, null);
    const r = run(sb, road(pts([48, -64], [48, 64])));
    expect(r.isError).toBe(true);
    expect(sb.doc.buildings['autoH']).toBeDefined();
    expect(sb.doc.parcels['lotX']).toBeDefined();
    expect(sb.commands).toEqual([]);
  });

  it('a stale road fails atomically when an auto building grows on its path after the proposal', () => {
    const doc = town();
    const sb = newSandbox(cloneJson(doc), 't', null, null);
    expect(run(sb, road(pts([48, -64], [48, 64]))).isError).toBe(false);
    const live = cloneJson(doc);
    autoLot(live);
    const before = cloneJson(live);
    const r = applyCommand(live, roadBatch(sb));
    expect(r.ok).toBe(false);
    // Rollback may reorder object keys; the content must be identical.
    expect(live).toEqual(before);
  });

  it('the precondition is only on AI roads: the same road without it still applies as for a user', () => {
    const doc = town();
    autoLot(doc);
    const sb = newSandbox(cloneJson(doc), 't', null, null);
    run(sb, road(pts([48, -64], [48, 64]))); // rejected above; plan the same road without the flag:
    // (Started south of road E: a segment crossing a road without a junction is refused for everyone, P5b.)
    const plain: Command = {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'q1', pos: { x: 48, z: 8 } } },
        { type: 'node.add', node: { id: 'q2', pos: { x: 48, z: 64 } } },
        { type: 'segment.add', segment: { id: 'qs', a: 'q1', b: 'q2', roadTypeId: 'road-2' } },
      ],
    };
    expect(applyCommand(doc, plain).ok).toBe(true);
  });

  it('requires snap to be a real boolean', () => {
    const sb = newSandbox(town(), 't', null, null);
    expect(run(sb, road(pts([100, 0], [224, 0]), { snap: 'false' })).content).toMatch(/snap/);
    expect(run(sb, { points: pts([100, 0], [224, 0]), road_type: null }).isError).toBe(true);
    expect(sb.commands).toEqual([]);
  });
});
