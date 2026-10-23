import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  buildingsInParcel,
  cloneJson,
  createEmptyDoc,
  demand,
  growthStep,
  growthTick,
  lotsAlongSegment,
  lotsToCommand,
  parcelCompliance,
  polygonsBlockRoad,
  polygonsOverlap,
  polygonArea,
  tryApplyCommand,
  type CityDoc,
  type Command,
  type Parcel,
} from './index.js';

function ok(doc: CityDoc, cmd: Command): void {
  expect(applyCommand(doc, cmd)).toEqual({ ok: true });
}

/** A 200 m road along x (id S1, node a at -100) plus optional extras. */
function street(roadType = 'road-2', control?: { x: number; z: number }): CityDoc {
  const doc = createEmptyDoc();
  ok(doc, { type: 'node.add', node: { id: 'a', pos: { x: -100, z: 0 } } });
  ok(doc, { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } });
  ok(doc, { type: 'segment.add', segment: { id: 'S1', a: 'a', b: 'b', roadTypeId: roadType, ...(control ? { control } : {}) } });
  return doc;
}

function zoned(doc: CityDoc, zone: Parcel['zone'] = 'residential', side: 'left' | 'right' = 'right', depth: 1 | 2 | 3 | 4 = 2, prefix = 'z'): Parcel[] {
  const lots = lotsAlongSegment(doc, 'S1', side, 0, 1, depth, zone as 'residential', prefix);
  ok(doc, lotsToCommand(lots));
  return lots;
}

describe('lotsAlongSegment', () => {
  it('lays 16 or 24 m lots along the right side, starting at the sidewalk edge', () => {
    const doc = street();
    const lots = lotsAlongSegment(doc, 'S1', 'right', 0, 1, 2, 'residential', 'r');
    expect(lots.length).toBe(9); // 25 cells = 7 × 3 + 2 + 2
    for (const l of lots) {
      expect(l.polygon).toHaveLength(4);
      expect(l.auto).toBe(true);
      expect(l.frontage).toEqual({ segmentId: 'S1', side: 'right' });
      expect(l.regulation).toEqual({ coverage: 0.6, far: 2.5, maxHeight: 60, setback: 3 });
      const width = Math.hypot(l.polygon[1]!.x - l.polygon[0]!.x, l.polygon[1]!.z - l.polygon[0]!.z);
      expect([16, 24]).toContain(Math.round(width));
      expect(polygonArea(l.polygon)).toBeCloseTo(width * 16);
      // Road half width 6 m (2 × 3.5 / 2 + 2.5 sidewalk); the lot lies on +z.
      expect(l.polygon[0]!.z).toBeCloseTo(6);
      expect(l.polygon[2]!.z).toBeCloseTo(22);
    }
    expect(lots.map((l) => l.id)).toEqual(Array.from({ length: 9 }, (_, i) => `r-${i}`));
    const left = lotsAlongSegment(doc, 'S1', 'left', 0, 1, 1, 'commercial', 'l');
    expect(left[0]!.polygon[0]!.z).toBeCloseTo(-6);
    expect(left[0]!.polygon[2]!.z).toBeCloseTo(-14);
    expect(left[0]!.zone).toBe('commercial');
  });

  it('is deterministic and the lots do not overlap each other', () => {
    const doc = street();
    const a = lotsAlongSegment(doc, 'S1', 'right', 0, 1, 3, 'office', 'p');
    expect(JSON.stringify(lotsAlongSegment(doc, 'S1', 'right', 0, 1, 3, 'office', 'p'))).toBe(JSON.stringify(a));
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) expect(polygonsOverlap(a[i]!.polygon, a[j]!.polygon)).toBe(false);
  });

  it('honours t0..t1 and returns nothing for a missing segment', () => {
    const doc = street();
    const lots = lotsAlongSegment(doc, 'S1', 'right', 0.25, 0.5, 1, 'residential', 'p'); // 50 m = 6 cells
    expect(lots.length).toBe(2);
    expect(Math.min(...lots.flatMap((l) => l.polygon.map((v) => v.x)))).toBeGreaterThanOrEqual(-50 - 1e-6);
    expect(lotsAlongSegment(doc, 'nope', 'right', 0, 1, 1, 'residential', 'p')).toEqual([]);
  });

  it('keeps clear of the junction setback and crosswalk zone, and of crossing roads', () => {
    const doc = street();
    ok(doc, { type: 'segment.split', id: 'S1', t: 0.5, nodeId: 'c', segmentIds: ['S1a', 'S1b'] });
    ok(doc, { type: 'node.add', node: { id: 'd', pos: { x: 0, z: 100 } } });
    ok(doc, { type: 'segment.add', segment: { id: 'X', a: 'c', b: 'd', roadTypeId: 'road-2' } });
    const lots = lotsAlongSegment(doc, 'S1b', 'right', 0, 1, 2, 'residential', 'j');
    expect(lots.length).toBeGreaterThan(0);
    // Setback = half width 6 + 1, crosswalk zone 4 (3 legs, sidewalks).
    for (const l of lots) {
      expect(Math.min(...l.polygon.map((v) => v.x))).toBeGreaterThanOrEqual(11 - 1e-6);
      expect(polygonsBlockRoad(doc, [l.polygon])).toBe(false);
    }
    ok(doc, lotsToCommand(lots));
  });

  it('drops lots that overlap an existing parcel, a building or another road', () => {
    const doc = street();
    const free = lotsAlongSegment(doc, 'S1', 'right', 0, 1, 2, 'residential', 'p');
    ok(doc, { type: 'parcel.upsert', parcel: { id: 'user', polygon: [{ x: -4, z: 8 }, { x: 4, z: 8 }, { x: 4, z: 14 }, { x: -4, z: 14 }], zone: 'green', regulation: { coverage: 0.2, far: 1, maxHeight: 12, setback: 5 } } });
    ok(doc, { type: 'building.place', building: { id: 'bx', typeId: 'house', pos: { x: 60, z: 15 }, rotation: 0 } });
    const lots = lotsAlongSegment(doc, 'S1', 'right', 0, 1, 2, 'residential', 'p');
    expect(lots.length).toBeLessThan(free.length);
    for (const l of lots) expect(polygonsOverlap(l.polygon, doc.parcels.user!.polygon)).toBe(false);
    ok(doc, lotsToCommand(lots));
    // A road running along the other lot positions blocks them.
    ok(doc, { type: 'node.add', node: { id: 'p1', pos: { x: -100, z: 20 } } });
    ok(doc, { type: 'node.add', node: { id: 'p2', pos: { x: 100, z: 20 } } });
    ok(doc, { type: 'segment.add', segment: { id: 'P', a: 'p1', b: 'p2', roadTypeId: 'road-2' } });
    expect(lotsAlongSegment(doc, 'S1', 'right', 0, 1, 4, 'residential', 'q')).toEqual([]);
  });

  it('on a curve, every lot stays off the road; lots whose corners drift more than 1 m are omitted', () => {
    const gentle = street('road-2', { x: 0, z: 10 });
    const lots = lotsAlongSegment(gentle, 'S1', 'right', 0, 1, 1, 'residential', 'c');
    expect(lots.length).toBeGreaterThan(0);
    for (const l of lots) expect(polygonsBlockRoad(gentle, [l.polygon])).toBe(false);
    ok(gentle, lotsToCommand(lots));
    const sharp = street('road-2', { x: 0, z: 120 });
    const sharpLots = lotsAlongSegment(sharp, 'S1', 'right', 0, 1, 1, 'residential', 'c');
    expect(sharpLots.length).toBeLessThan(lotsAlongSegment(street(), 'S1', 'right', 0, 1, 1, 'residential', 'c').length);
    for (const l of sharpLots) expect(polygonsBlockRoad(sharp, [l.polygon])).toBe(false);
  });

  it('lotsToCommand is one batch of parcel.upsert; empty is a valid empty batch', () => {
    const doc = street();
    const lots = lotsAlongSegment(doc, 'S1', 'right', 0, 1, 1, 'residential', 'p');
    const cmd = lotsToCommand(lots);
    expect(cmd.type === 'batch' && cmd.commands.every((c) => c.type === 'parcel.upsert')).toBe(true);
    expect(lotsToCommand([])).toEqual({ type: 'batch', commands: [] });
    ok(doc, lotsToCommand([]));
  });
});

describe('demand', () => {
  it('bootstraps an empty city at 0.2 and reports industrial without growing it', () => {
    const d = demand(createEmptyDoc());
    expect(d).toEqual({ residential: 0.2, commercial: 0.2, office: 0.2, industrial: 0.2 });
  });

  it('is negative for housing when residents have no jobs, positive for jobs', () => {
    const doc = createEmptyDoc();
    ok(doc, { type: 'building.place', building: { id: 'h', typeId: 'apartment', pos: { x: 0, z: 0 }, rotation: 0 } });
    const d = demand(doc);
    expect(d.residential).toBeLessThan(0);
    expect(d.commercial).toBeGreaterThan(0.1);
    expect(d.office).toBeGreaterThan(0.1);
    for (const v of Object.values(d)) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });
});

describe('growthStep', () => {
  it('places auto buildings on empty auto lots that comply, deterministically', () => {
    const doc = street();
    zoned(doc, 'residential');
    const a = growthStep(doc, 1);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(4);
    expect(growthStep(doc, 1)).toEqual(a);
    expect(JSON.stringify(doc)).toBe(JSON.stringify(cloneJson(doc))); // input untouched
    for (const c of a) {
      expect(c.type).toBe('building.place');
      if (c.type !== 'building.place') continue;
      expect(c.building.auto).toBe(true);
      expect(c.building.id).toMatch(/^g-1-z-\d+$/);
      expect(doc.buildingTypes[c.building.typeId]!.growth).toBeDefined();
    }
    // Applies cleanly in order on the real doc; every touched lot is violation-free and faces the road.
    ok(doc, { type: 'batch', commands: a });
    for (const c of a) {
      if (c.type !== 'building.place') continue;
      const lot = Object.values(doc.parcels).find((p) => buildingsInParcel(doc, p).includes(c.building.id))!;
      expect(parcelCompliance(doc, lot).violations).toEqual([]);
      // Right side lots lie on +z, so the front (local +z) must look to -z: rotation ≈ π.
      expect(Math.cos(c.building.rotation)).toBeLessThan(-0.99);
    }
  });

  it('faces the road on the left side too', () => {
    const doc = street();
    zoned(doc, 'commercial', 'left');
    const cmds = growthStep(doc, 3);
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) if (c.type === 'building.place') expect(Math.cos(c.building.rotation)).toBeGreaterThan(0.99);
  });

  it('different epochs choose different lots; a long run fills the lots without ever failing', () => {
    const doc = street();
    zoned(doc, 'residential', 'right', 2);
    const e1 = JSON.stringify(growthStep(doc, 1));
    const e2 = JSON.stringify(growthStep(doc, 2));
    expect(e1).not.toBe(e2);
    let placed = 0;
    for (let epoch = 0; epoch < 60; epoch++) {
      const cmds = growthStep(doc, epoch);
      if (!cmds.length) continue;
      ok(doc, { type: 'batch', commands: cmds });
      placed += cmds.length;
    }
    expect(placed).toBeGreaterThan(3);
    const occupied = Object.values(doc.parcels).filter((p) => buildingsInParcel(doc, p).length > 0).length;
    expect(occupied).toBe(placed);
  });

  it('respects meta.growth === false, maxUnits, a removed frontage road and unsupported zones', () => {
    const doc = street();
    zoned(doc, 'residential');
    expect(growthStep(doc, 1, 1).length).toBeLessThanOrEqual(1);
    ok(doc, { type: 'meta.update', growth: false });
    expect(growthStep(doc, 1)).toEqual([]);
    ok(doc, { type: 'meta.update', growth: true });
    expect(growthStep(doc, 1).length).toBeGreaterThan(0);
    expect(growthTick(doc, 1)).toEqual({ type: 'batch', commands: growthStep(doc, 1) });
    // Dangling frontage after segment.remove: the lots stay but never grow.
    ok(doc, { type: 'segment.remove', id: 'S1' });
    expect(Object.keys(doc.parcels).length).toBeGreaterThan(0);
    expect(growthStep(doc, 1)).toEqual([]);
    expect(growthTick(doc, 1)).toBeNull();

    const industrial = street();
    zoned(industrial, 'industrial');
    expect(growthStep(industrial, 1)).toEqual([]);
  });

  it('does not grow a zone whose demand is not above 0.1', () => {
    const doc = street();
    ok(doc, { type: 'building.place', building: { id: 'h', typeId: 'apartment', pos: { x: 0, z: -60 }, rotation: 0 } });
    zoned(doc, 'residential'); // residents without jobs: housing demand < 0
    expect(demand(doc).residential).toBeLessThan(0.1);
    expect(growthStep(doc, 1)).toEqual([]);
  });

  it('skips lots that already have a building or a design that does not fit', () => {
    const doc = street();
    const lots = zoned(doc, 'residential', 'right', 1); // 8 m deep: setback 3 leaves 2 m
    expect(growthStep(doc, 1)).toEqual([]);
    for (const l of lots) expect(l.polygon.length).toBe(4);
    const occupied = street();
    zoned(occupied, 'residential', 'right', 2);
    for (const p of Object.values(occupied.parcels)) {
      const cx = (p.polygon[0]!.x + p.polygon[2]!.x) / 2;
      const cz = (p.polygon[0]!.z + p.polygon[2]!.z) / 2;
      ok(occupied, { type: 'building.place', building: { id: `u-${p.id}`, typeId: 'house', pos: { x: cx, z: cz }, rotation: 0 } });
    }
    expect(growthStep(occupied, 1)).toEqual([]);
  });

  it('a concurrent user building makes the unit fail on the real doc, not corrupt it (id collision)', () => {
    const doc = street();
    zoned(doc, 'residential');
    const cmds = growthStep(doc, 1);
    ok(doc, { type: 'batch', commands: cmds });
    const before = JSON.stringify(doc);
    const again = tryApplyCommand(doc, { type: 'batch', commands: cmds });
    expect(again.ok).toBe(false);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('road edits and auto lots', () => {
  /** Street with one row of lots on the right and a grown building in lot z-4. */
  function withLots(): CityDoc {
    const doc = street();
    zoned(doc, 'residential', 'right', 2);
    ok(doc, { type: 'building.place', building: { id: 'g-0-z-4', typeId: 'grow-res-1', pos: { x: 0, z: 14 }, rotation: Math.PI, auto: true } });
    ok(doc, { type: 'building.place', building: { id: 'user-b', typeId: 'house', pos: { x: 0, z: 14 }, rotation: Math.PI } });
    return doc;
  }
  const userLot: Parcel = { id: 'u', polygon: [{ x: -80, z: 30 }, { x: -70, z: 30 }, { x: -70, z: 40 }, { x: -80, z: 40 }], zone: 'green', regulation: { coverage: 0.2, far: 1, maxHeight: 12, setback: 5 } };

  it('segment.add removes auto lots under the new corridor and their auto buildings only', () => {
    const doc = withLots();
    ok(doc, { type: 'parcel.upsert', parcel: userLot });
    const lotsBefore = Object.keys(doc.parcels).length;
    ok(doc, { type: 'node.add', node: { id: 'p1', pos: { x: -90, z: 30 } } });
    ok(doc, { type: 'node.add', node: { id: 'p2', pos: { x: 90, z: 30 } } });
    // Runs through the user parcel as well as the auto lots (depth 16 → z 6..22 does not reach 30): move closer.
    ok(doc, { type: 'node.move', id: 'p1', pos: { x: -90, z: 14 } });
    ok(doc, { type: 'node.move', id: 'p2', pos: { x: 90, z: 14 } });
    ok(doc, { type: 'segment.add', segment: { id: 'X', a: 'p1', b: 'p2', roadTypeId: 'road-2' } });
    expect(Object.keys(doc.parcels).length).toBeLessThan(lotsBefore);
    expect(Object.values(doc.parcels).filter((p) => p.auto)).toEqual([]);
    expect(doc.parcels.u).toBeDefined();
    expect(doc.buildings['g-0-z-4']).toBeUndefined();
    expect(doc.buildings['user-b']).toBeDefined();
  });

  it('segment.add rolls the pruning back when the command fails', () => {
    const doc = withLots();
    const before = JSON.stringify(doc);
    const res = applyCommand(doc, { type: 'batch', commands: [{ type: 'node.add', node: { id: 'p1', pos: { x: -90, z: 14 } } }, { type: 'node.add', node: { id: 'p2', pos: { x: 90, z: 14 } } }, { type: 'segment.add', segment: { id: 'X', a: 'p1', b: 'p2', roadTypeId: 'road-2' } }, { type: 'segment.remove', id: 'nope' }] });
    expect(res.ok).toBe(false);
    expect(doc).toEqual(JSON.parse(before)); // rollback may reorder keys, so compare structurally
  });

  it('a road that does not touch any lot leaves them alone', () => {
    const doc = withLots();
    const before = JSON.stringify(doc.parcels);
    ok(doc, { type: 'node.add', node: { id: 'p1', pos: { x: -90, z: -50 } } });
    ok(doc, { type: 'node.add', node: { id: 'p2', pos: { x: 90, z: -50 } } });
    ok(doc, { type: 'segment.add', segment: { id: 'X', a: 'p1', b: 'p2', roadTypeId: 'road-2' } });
    expect(JSON.stringify(doc.parcels)).toBe(before);
  });

  it('node.move removes auto lots the stretched road now covers', () => {
    const doc = withLots();
    ok(doc, { type: 'node.add', node: { id: 'p1', pos: { x: -90, z: 40 } } });
    ok(doc, { type: 'node.add', node: { id: 'p2', pos: { x: 90, z: 40 } } });
    ok(doc, { type: 'segment.add', segment: { id: 'X', a: 'p1', b: 'p2', roadTypeId: 'road-2' } });
    const count = Object.keys(doc.parcels).length;
    ok(doc, { type: 'node.move', id: 'p1', pos: { x: -90, z: 14 } });
    ok(doc, { type: 'node.move', id: 'p2', pos: { x: 90, z: 14 } });
    expect(Object.keys(doc.parcels).length).toBeLessThan(count);
    expect(doc.buildings['g-0-z-4']).toBeUndefined();
    expect(doc.buildings['user-b']).toBeDefined();
  });

  it('segment.setType and roadType.upsert prune only when the road gets wider', () => {
    const doc = withLots();
    const count = Object.keys(doc.parcels).length;
    ok(doc, { type: 'segment.setType', id: 'S1', roadTypeId: 'road-2' }); // same width
    expect(Object.keys(doc.parcels).length).toBe(count);
    // road-4 half width 9 m: the front edge at 6 m now lies in the corridor.
    ok(doc, { type: 'segment.setType', id: 'S1', roadTypeId: 'road-4' });
    expect(Object.values(doc.parcels).filter((p) => p.auto)).toEqual([]);
    expect(doc.buildings['g-0-z-4']).toBeUndefined();
    expect(doc.buildings['user-b']).toBeDefined();

    const doc2 = withLots();
    const rt = { ...doc2.roadTypes['road-2']! };
    ok(doc2, { type: 'roadType.upsert', roadType: { ...rt, laneWidth: 3.0 } }); // narrower: untouched
    expect(Object.keys(doc2.parcels).length).toBe(count);
    ok(doc2, { type: 'roadType.upsert', roadType: { ...rt, laneWidth: 4.5 } }); // wider
    expect(Object.values(doc2.parcels).filter((p) => p.auto)).toEqual([]);
    expect(doc2.buildings['g-0-z-4']).toBeUndefined();
  });

  it('segment.split remaps the frontage to the child the lot faces', () => {
    const doc = withLots();
    ok(doc, { type: 'segment.split', id: 'S1', t: 0.5, nodeId: 'c', segmentIds: ['S1a', 'S1b'] });
    let west = 0;
    let east = 0;
    for (const p of Object.values(doc.parcels)) {
      const cx = (p.polygon[0]!.x + p.polygon[2]!.x) / 2;
      const want = cx < 0 ? 'S1a' : 'S1b';
      expect(p.frontage).toEqual({ segmentId: want, side: 'right' });
      if (cx < 0) west++;
      else east++;
    }
    expect(west).toBeGreaterThan(0);
    expect(east).toBeGreaterThan(0);
    // Growth still works on remapped lots (a fresh city: the buildings above changed the demand).
    const fresh = street();
    zoned(fresh, 'residential');
    ok(fresh, { type: 'segment.split', id: 'S1', t: 0.5, nodeId: 'c', segmentIds: ['S1a', 'S1b'] });
    expect(growthStep(fresh, 2).length).toBeGreaterThan(0);
  });

  it('segment.remove keeps the lots (dangling frontage); growth skips them', () => {
    const doc = withLots();
    const count = Object.keys(doc.parcels).length;
    ok(doc, { type: 'segment.remove', id: 'S1' });
    expect(Object.keys(doc.parcels).length).toBe(count);
    expect(growthStep(doc, 1)).toEqual([]);
  });

  it('trusted replay applies the same pruning', () => {
    const doc = withLots();
    const replay = cloneJson(doc);
    const cmds: Command[] = [{ type: 'node.add', node: { id: 'p1', pos: { x: -90, z: 14 } } }, { type: 'node.add', node: { id: 'p2', pos: { x: 90, z: 14 } } }, { type: 'segment.add', segment: { id: 'X', a: 'p1', b: 'p2', roadTypeId: 'road-2' } }];
    for (const c of cmds) {
      ok(doc, c);
      expect(applyCommand(replay, c, { trusted: true })).toEqual({ ok: true });
    }
    expect(JSON.stringify(replay)).toBe(JSON.stringify(doc));
  });
});
