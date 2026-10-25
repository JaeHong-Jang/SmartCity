import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, planRoad, resolvePoint, DEFAULT_REGULATIONS, type BuildingType, type Command, type Parcel } from '@smartcity/shared';
import { IdGen } from '@smartcity/shared';
import { road } from '../test/fixtures';
import { crossDoc } from '../test/fixtures';
import { applicableBatch, dryRunProposal, itemLabel, proposalCatalog, proposalCenter, proposalItems, proposalRoadInfos, proposalRoads } from './proposal';

const design = (id: string): BuildingType => ({ ...cloneJson(createEmptyDoc().buildingTypes['house']!), id, name: `카페 ${id}`, rev: 0 });
const place = (id: string, typeId: string, x: number, z = 60): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
const lot = (id: string, x: number): Parcel => ({
  id,
  polygon: [{ x, z: 100 }, { x: x + 16, z: 100 }, { x: x + 16, z: 116 }, { x, z: 116 }],
  zone: 'commercial',
  regulation: { ...DEFAULT_REGULATIONS.commercial },
  auto: true,
});

function proposal(): Command[] {
  return [
    { type: 'batch', commands: [place('b1', 'ai-cafe', 0), place('b2', 'ai-cafe', 30)] },
    { type: 'parcel.upsert', parcel: lot('p1', 200) },
    { type: 'buildingType.upsert', buildingType: design('ai-cafe'), expectedRev: 0 },
  ];
}

describe('proposal items', () => {
  it('flattens batches and puts designs first, parcels next', () => {
    const items = proposalItems(proposal());
    expect(items.map((i) => i.cmd.type)).toEqual(['buildingType.upsert', 'parcel.upsert', 'building.place', 'building.place']);
    expect(items.map((i) => i.index)).toEqual([0, 1, 2, 3]);
  });

  it('bakes a temporary catalog from the proposed designs without touching the doc', () => {
    const doc = createEmptyDoc();
    const cat = proposalCatalog(proposalItems(proposal()));
    expect(Object.keys(cat)).toEqual(['ai-cafe']);
    expect(doc.buildingTypes['ai-cafe']).toBeUndefined();
  });

  it('centers on the proposed buildings and parcels', () => {
    const c = proposalCenter(proposalItems([place('b1', 'x', 0), place('b2', 'x', 40)]))!;
    expect(c).toEqual({ x: 20, z: 60 });
    expect(proposalCenter([])).toBeNull();
  });
});

describe('dry run partitioning', () => {
  it('accepts everything on an untouched doc', () => {
    const doc = createEmptyDoc();
    const items = proposalItems(proposal());
    expect(dryRunProposal(doc, items)).toEqual({});
    expect(doc.buildingTypes['ai-cafe']).toBeUndefined();
    expect(applicableBatch(items, {})!.type).toBe('batch');
  });

  it('marks only the items a conflicting edit breaks, and later items still apply', () => {
    const doc = createEmptyDoc();
    // A collaborator laid a road over the spot of b1 meanwhile (b2 at x = 30 is clear of it).
    road(doc, { x: -20, z: 60 }, { x: 10, z: 60 }, new IdGen('c'));
    const items = proposalItems(proposal());
    const invalid = dryRunProposal(doc, items);
    const failing = Object.keys(invalid).map(Number);
    expect(failing).toHaveLength(1);
    const it = items[failing[0]!]!;
    expect(it.cmd.type === 'building.place' && it.cmd.building.id).toBe('b1');
    const batch = applicableBatch(items, invalid)!;
    expect(batch.type === 'batch' && batch.commands).toHaveLength(items.length - 1);
  });

  it('fails the buildings that need a design that cannot be added', () => {
    const doc = createEmptyDoc();
    doc.buildingTypes['ai-cafe'] = design('ai-cafe'); // the id is taken (expectedRev 0 now stale)
    doc.buildingTypes['ai-cafe']!.rev = 3;
    const invalid = dryRunProposal(doc, proposalItems(proposal()));
    expect(Object.keys(invalid).length).toBeGreaterThanOrEqual(1);
    expect(applicableBatch(proposalItems([]), {})).toBeNull();
  });
});

describe('AI roads', () => {
  /** The road piece the new road crosses: the x axis road east of the junction. */
  const eastHalf = (d: ReturnType<typeof crossDoc>['doc']) => Object.values(d.segments).find((s) => d.nodes[s.a]!.pos.z === 0 && d.nodes[s.b]!.pos.z === 0 && Math.max(d.nodes[s.a]!.pos.x, d.nodes[s.b]!.pos.x) === 96)!;

  /** A road from (50, -64) to (50, 64): crosses the x axis road of crossDoc, so it splits it. */
  function crossingRoad(doc: ReturnType<typeof crossDoc>['doc']): Command {
    const plan = planRoad(doc, { start: resolvePoint(doc, { x: 48, z: -64 }), end: resolvePoint(doc, { x: 48, z: 64 }), roadTypeId: 'road-2' }, new IdGen('ai-x'));
    if (!plan.command) throw new Error(plan.error);
    return plan.command;
  }
  const withRoad = (doc: ReturnType<typeof crossDoc>['doc']): Command[] => [
    { type: 'batch', commands: [place('b1', 'ai-cafe', 70, 20), place('b2', 'ai-cafe', 70, -20)] },
    { type: 'parcel.upsert', parcel: lot('p1', 200) },
    crossingRoad(doc),
    { type: 'buildingType.upsert', buildingType: design('ai-cafe'), expectedRev: 0 },
  ];

  it('keeps a road batch as one item: design, road, lot, buildings', () => {
    const { doc } = crossDoc();
    const items = proposalItems(withRoad(doc));
    expect(items.map((i) => i.cmd.type)).toEqual(['buildingType.upsert', 'batch', 'parcel.upsert', 'building.place', 'building.place']);
    const roadItem = items[1]!.cmd;
    expect(roadItem.type === 'batch' && roadItem.commands.map((c) => c.type)).toEqual(['node.add', 'segment.split', 'node.add', 'segment.add', 'segment.add']);
  });

  it('labels the road with length, joins and splits', () => {
    const { doc } = crossDoc();
    const items = proposalItems(withRoad(doc));
    expect(itemLabel(doc, {}, items[1]!.cmd, proposalRoadInfos(doc, items, 1).get(items[1]!.index))).toBe('도로 128 m (연결 0, 분할 1)');
  });

  it('previews the new pieces and frames the camera on the road', () => {
    const { doc } = crossDoc();
    const items = proposalItems([crossingRoad(doc)]);
    const roads = proposalRoads(doc, items, 1);
    expect(roads).toHaveLength(1);
    expect(roads[0]!.pieces).toHaveLength(2);
    expect(proposalCenter(items)).toEqual({ x: 48, z: 0 }); // middle of the road's free end nodes
  });

  it('dry run: the road passes or fails as a whole, and the lot/buildings beside it still follow', () => {
    const { doc } = crossDoc();
    const items = proposalItems(withRoad(doc));
    expect(dryRunProposal(doc, items)).toEqual({});
    // A collaborator splits the target road meanwhile: the whole road item fails, nothing of it is left in the copy.
    const live = cloneJson(doc);
    expect(applyCommand(live, { type: 'segment.remove', id: eastHalf(live).id }).ok).toBe(true);
    const invalid = dryRunProposal(live, items);
    expect(Object.keys(invalid).map(Number)).toEqual([1]);
    const batch = applicableBatch(items, invalid)!;
    expect(batch.type === 'batch' && batch.commands.every((c) => c.type !== 'segment.add' && c.type !== 'segment.split')).toBe(true);
  });

  it('applies as one flat batch (batches cannot nest) and is atomic on the live doc', () => {
    const { doc } = crossDoc();
    const items = proposalItems(withRoad(doc));
    const batch = applicableBatch(items, {})!;
    expect(batch.type === 'batch' && batch.commands.some((c) => c.type === 'batch')).toBe(false);
    const live = cloneJson(doc);
    expect(applyCommand(live, batch)).toEqual({ ok: true });
    expect(Object.keys(live.segments).length).toBe(Object.keys(doc.segments).length + 3);
    // Same batch once the road's target is gone: refused as a whole, document unchanged.
    const hurt = cloneJson(doc);
    applyCommand(hurt, { type: 'segment.remove', id: eastHalf(hurt).id });
    const before = JSON.stringify(hurt);
    expect(applyCommand(hurt, batch).ok).toBe(false);
    expect(JSON.stringify(hurt)).toBe(before);
  });
});

describe('road descriptions follow the sequential doc and doc edits (Sol 4b #5, #6)', () => {
  const planned = (doc: ReturnType<typeof crossDoc>['doc'], from: [number, number], to: [number, number], tag: string): Command => {
    const plan = planRoad(doc, { start: resolvePoint(doc, { x: from[0], z: from[1] }), end: resolvePoint(doc, { x: to[0], z: to[1] }), roadTypeId: 'road-2' }, new IdGen(tag));
    if (!plan.command) throw new Error(plan.error);
    return plan.command;
  };

  it('a later road that splits an earlier proposed road keeps its description and preview', () => {
    const { doc } = crossDoc();
    const a = planned(doc, [96, 0], [224, 0], 'A');
    const work = cloneJson(doc);
    expect(applyCommand(work, a).ok).toBe(true);
    const b = planned(work, [160, 0], [160, 64], 'B');
    const items = proposalItems([a, b]);
    expect(dryRunProposal(doc, items)).toEqual({});
    const infos = proposalRoadInfos(doc, items, 1);
    expect(infos.get(0)).not.toBeNull();
    expect(infos.get(1)).not.toBeNull();
    expect(infos.get(1)!.splits).toBe(1);
    expect(proposalRoads(doc, items, 1).map((r) => r.pieces.length)).toEqual([1, 1]);
    expect(itemLabel(doc, {}, items[1]!.cmd, infos.get(1))).toMatch(/^도로 \d+ m \(연결 \d+, 분할 1\)$/);
  });

  it('refreshes coordinates when the doc changes even though the proposal stays valid', () => {
    const { doc } = crossDoc();
    const cmd = planned(doc, [48, -64], [48, 64], 'C');
    const items = proposalItems([cmd]);
    const before = proposalRoadInfos(doc, items, 1).get(0)!;
    // Same version: cached. A node moves (version 2): the junction moves with it.
    expect(proposalRoadInfos(doc, items, 1).get(0)).toBe(before);
    const east = Object.values(doc.nodes).find((n) => n.pos.x === 96)!;
    expect(applyCommand(doc, { type: 'node.move', id: east.id, pos: { x: 96, z: 20 } }).ok).toBe(true);
    expect(dryRunProposal(doc, items)).toEqual({});
    const after = proposalRoadInfos(doc, items, 2).get(0)!;
    expect(after).not.toBe(before);
    const junction = (i: typeof before) => i.pieces[0]!.points[i.pieces[0]!.points.length - 1]!;
    expect(junction(after).z).not.toBeCloseTo(junction(before).z, 1);
  });
});
