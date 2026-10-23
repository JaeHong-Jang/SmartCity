import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, docToCommands, LIMITS, normalizeDoc, type CityDoc, type Command, type RoadFeature } from './index.js';

function ok(doc: CityDoc, cmd: Command): void {
  expect(applyCommand(doc, cmd)).toEqual({ ok: true });
}

function fails(doc: CityDoc, cmd: Command, msg: RegExp): void {
  const before = JSON.stringify(doc);
  const res = applyCommand(doc, cmd);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toMatch(msg);
  expect(JSON.stringify(doc)).toBe(before);
}

/** A 200 m straight road s: a(0,0) → b(200,0). */
function cityWithRoad(roadTypeId = 'road-2'): CityDoc {
  const doc = createEmptyDoc();
  ok(doc, { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } });
  ok(doc, { type: 'node.add', node: { id: 'b', pos: { x: 200, z: 0 } } });
  ok(doc, { type: 'segment.add', segment: { id: 's', a: 'a', b: 'b', roadTypeId } });
  return doc;
}

const feature = (id: string, kind: RoadFeature['kind'], t: number, extra: Partial<RoadFeature> = {}): Command => ({
  type: 'feature.upsert',
  feature: { id, segmentId: 's', kind, t, ...extra },
});

describe('road features', () => {
  it('places crosswalks, speed bumps and school zones', () => {
    const doc = cityWithRoad();
    ok(doc, feature('c1', 'crosswalk', 0.5, { signal: true }));
    ok(doc, feature('b1', 'speedBump', 0.25));
    expect(doc.features.c1).toEqual({ id: 'c1', segmentId: 's', kind: 'crosswalk', t: 0.5, signal: true });
    ok(doc, { type: 'feature.remove', id: 'b1' });
    expect(doc.features.b1).toBeUndefined();
  });

  it('rejects features near the segment ends, too close together, or invalid', () => {
    const doc = cityWithRoad();
    fails(doc, feature('c1', 'crosswalk', 0.03), /from the segment ends/);
    fails(doc, feature('c1', 'crosswalk', 0.97), /from the segment ends/);
    ok(doc, feature('c1', 'crosswalk', 0.5));
    fails(doc, feature('b1', 'speedBump', 0.51), /too close/);
    ok(doc, feature('b1', 'speedBump', 0.54));
    fails(doc, feature('x', 'speedBump', 0.3, { signal: true }), /signal flag/);
    fails(doc, { type: 'feature.upsert', feature: { id: 'x', segmentId: 's', kind: 'tunnel' as never, t: 0.3 } }, /kind/);
    fails(doc, { type: 'feature.upsert', feature: { id: 'x', segmentId: 'nope', kind: 'speedBump', t: 0.3 } }, /unknown segment/);
    fails(doc, { type: 'feature.remove', id: 'zz' }, /unknown/);
  });

  it('allows moving a feature by upserting the same id', () => {
    const doc = cityWithRoad();
    ok(doc, feature('c1', 'crosswalk', 0.5));
    ok(doc, feature('c1', 'crosswalk', 0.52));
    expect(doc.features.c1!.t).toBe(0.52);
  });

  it('needs sidewalks for crosswalks, and removing sidewalks removes them', () => {
    const doc = cityWithRoad();
    ok(doc, feature('c1', 'crosswalk', 0.5));
    ok(doc, feature('b1', 'speedBump', 0.3));
    ok(doc, { type: 'roadType.upsert', roadType: { ...doc.roadTypes['road-2']!, id: 'bare', sidewalk: false } });
    ok(doc, { type: 'segment.setType', id: 's', roadTypeId: 'bare' });
    expect(doc.features.c1).toBeUndefined();
    expect(doc.features.b1).toBeDefined();
    fails(doc, feature('c1', 'crosswalk', 0.5), /sidewalks/);
    // Editing a road type to drop sidewalks clears crosswalks on every road of that type.
    ok(doc, { type: 'segment.setType', id: 's', roadTypeId: 'road-2' });
    ok(doc, feature('c1', 'crosswalk', 0.5));
    ok(doc, { type: 'roadType.upsert', roadType: { ...doc.roadTypes['road-2']!, sidewalk: false } });
    expect(doc.features.c1).toBeUndefined();
  });

  it('toggles school zones on segments and keeps them through docToCommands', () => {
    const doc = cityWithRoad();
    ok(doc, { type: 'segment.setSchoolZone', id: 's', schoolZone: true });
    expect(doc.segments.s!.schoolZone).toBe(true);
    const copy = createEmptyDoc();
    for (const cmd of docToCommands(doc)) ok(copy, cmd);
    expect(copy.segments.s!.schoolZone).toBe(true);
    ok(doc, { type: 'segment.setSchoolZone', id: 's', schoolZone: false });
    expect('schoolZone' in doc.segments.s!).toBe(false);
    fails(doc, { type: 'segment.setSchoolZone', id: 's', schoolZone: 'yes' as never }, /schoolZone/);
  });

  it('removes features with their segment', () => {
    const doc = cityWithRoad();
    ok(doc, feature('c1', 'crosswalk', 0.5));
    ok(doc, { type: 'segment.remove', id: 's' });
    expect(doc.features).toEqual({});
  });

  it('remaps features by arc length on split and drops those in the new junction', () => {
    const doc = cityWithRoad();
    ok(doc, feature('near', 'speedBump', 0.25)); // s = 50
    ok(doc, feature('far', 'crosswalk', 0.75)); // s = 150
    ok(doc, feature('mid', 'speedBump', 0.42)); // s = 84, 4 m from the split point
    ok(doc, { type: 'segment.setSchoolZone', id: 's', schoolZone: true });
    ok(doc, { type: 'segment.split', id: 's', t: 0.4, nodeId: 'm', segmentIds: ['s1', 's2'] }); // split at 80 m
    expect(doc.features.near).toMatchObject({ segmentId: 's1' });
    expect(doc.features.near!.t).toBeCloseTo(50 / 80);
    expect(doc.features.far).toMatchObject({ segmentId: 's2' });
    expect(doc.features.far!.t).toBeCloseTo(70 / 120);
    expect(doc.features.mid).toBeUndefined();
    expect(doc.segments.s1!.schoolZone).toBe(true);
    expect(doc.segments.s2!.schoolZone).toBe(true);
  });

  it('removes features that a node move pushes into the junction (Sol 2b #2)', () => {
    const doc = cityWithRoad();
    ok(doc, feature('b1', 'speedBump', 0.1)); // s = 20
    ok(doc, feature('b2', 'speedBump', 0.5)); // s = 100
    ok(doc, { type: 'node.move', id: 'b', pos: { x: 100, z: 0 } });
    // Length 100: b1 at 10 m (too close to a), b2 at 50 m stays.
    expect(doc.features.b1).toBeUndefined();
    expect(doc.features.b2).toBeDefined();
    const copy = createEmptyDoc();
    for (const cmd of docToCommands(doc)) ok(copy, cmd);
  });

  it('keeps split features re-validatable on curved roads (Sol 2b #3)', () => {
    const doc = createEmptyDoc();
    ok(doc, { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } });
    ok(doc, { type: 'node.add', node: { id: 'b', pos: { x: 200, z: 0 } } });
    ok(doc, { type: 'segment.add', segment: { id: 's', a: 'a', b: 'b', roadTypeId: 'road-2', control: { x: 0, z: 200 } } });
    const len = 308.0583502296425;
    ok(doc, feature('edge', 'speedBump', 1 - 12 / len));
    ok(doc, { type: 'segment.split', id: 's', t: 0.3, nodeId: 'm', segmentIds: ['s1', 's2'] });
    const f = doc.features.edge;
    if (f) {
      const again = createEmptyDoc();
      for (const cmd of docToCommands(doc)) ok(again, cmd);
      expect(again.features.edge).toBeDefined();
    }
  });

  it('round-trips through docToCommands', () => {
    const doc = cityWithRoad();
    ok(doc, feature('c1', 'crosswalk', 0.5, { signal: false }));
    const copy = createEmptyDoc();
    for (const cmd of docToCommands(doc)) ok(copy, cmd);
    expect(copy.features).toEqual(doc.features);
  });
});

describe('intersection controls', () => {
  it('accepts all-way stops and per-leg crosswalks', () => {
    const doc = cityWithRoad();
    ok(doc, { type: 'intersection.set', control: { nodeId: 'a', kind: 'allStop', yellow: 3, allRed: 2, offset: 0, crosswalkLegs: [] } });
    expect(doc.intersections.a).toMatchObject({ kind: 'allStop', crosswalkLegs: [] });
    ok(doc, { type: 'intersection.set', control: { nodeId: 'a', kind: 'signal', yellow: 3, allRed: 2, offset: 0, crosswalkLegs: ['s'] } });
    fails(doc, { type: 'intersection.set', control: { nodeId: 'a', kind: 'signal', yellow: 3, allRed: 2, offset: 0, crosswalkLegs: ['zz'] } }, /leg/);
  });

  it('keeps crosswalk legs pointing at the right pieces after a split', () => {
    const doc = cityWithRoad();
    ok(doc, { type: 'intersection.set', control: { nodeId: 'b', kind: 'signal', yellow: 3, allRed: 2, offset: 0, crosswalkLegs: ['s'] } });
    ok(doc, { type: 'segment.split', id: 's', t: 0.5, nodeId: 'm', segmentIds: ['s1', 's2'] });
    expect(doc.intersections.b!.crosswalkLegs).toEqual(['s2']);
    ok(doc, { type: 'segment.remove', id: 's2' });
    expect(doc.intersections.b).toBeUndefined();
  });
});

describe('building props', () => {
  const base = () => cloneJson(createEmptyDoc().buildingTypes['house']!);

  it('stores validated props only', () => {
    const doc = createEmptyDoc();
    const bt = base();
    bt.props = [{ kind: 'balcony', pos: { x: 1, y: 3.2, z: 4 }, rot: 1, size: 2, color: '#ffffff', extra: 1 } as never];
    ok(doc, { type: 'buildingType.upsert', buildingType: bt });
    expect(doc.buildingTypes.house!.props).toEqual([{ kind: 'balcony', pos: { x: 1, y: 3.2, z: 4 }, rot: 1, size: 2, color: '#ffffff' }]);
  });

  it('rejects unknown kinds, bad rotations and too many props', () => {
    const doc = createEmptyDoc();
    const prop = { kind: 'balcony' as const, pos: { x: 0, y: 0, z: 0 }, rot: 0, size: 1, color: '#ffffff' };
    fails(doc, { type: 'buildingType.upsert', buildingType: { ...base(), props: [{ ...prop, kind: 'ufo' as never }] } }, /prop kind/);
    fails(doc, { type: 'buildingType.upsert', buildingType: { ...base(), props: [{ ...prop, rot: 1.5 }] } }, /prop.rot/);
    fails(doc, { type: 'buildingType.upsert', buildingType: { ...base(), props: [{ ...prop, pos: { x: 0, y: -1, z: 0 } }] } }, /prop.pos.y/);
    // Props must hang on the building, not float away from it.
    fails(doc, { type: 'buildingType.upsert', buildingType: { ...base(), props: [{ ...prop, pos: { x: 100, y: 0, z: 0 } }] } }, /prop.pos.x/);
    fails(doc, { type: 'buildingType.upsert', buildingType: { ...base(), props: [{ ...prop, pos: { x: 0, y: 300, z: 0 } }] } }, /prop.pos.y/);
    const many = Array.from({ length: LIMITS.buildingProps + 1 }, () => prop);
    fails(doc, { type: 'buildingType.upsert', buildingType: { ...base(), props: many } }, /props/);
  });
});

describe('doc v3 migration', () => {
  it('adds the features collection to v2 docs', () => {
    const doc = createEmptyDoc() as Partial<CityDoc> & CityDoc;
    delete (doc as { features?: unknown }).features;
    doc.version = 2;
    normalizeDoc(doc);
    expect(doc.version).toBe(3);
    expect(doc.features).toEqual({});
  });
});
