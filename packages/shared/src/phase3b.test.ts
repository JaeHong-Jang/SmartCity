import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  cloneJson,
  createEmptyDoc,
  docToCommands,
  DOC_VERSION,
  GROWTH_PRESETS,
  normalizeDoc,
  type CityDoc,
  type Command,
  type Parcel,
} from './index.js';

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

/** Cross at c(0,0) with arms n, s, w, e (100 m, road-2) and the given extra arms removed. */
function cross(arms = ['n', 's', 'w', 'e']): CityDoc {
  const doc = createEmptyDoc();
  const pos: Record<string, { x: number; z: number }> = { n: { x: 0, z: -100 }, s: { x: 0, z: 100 }, w: { x: -100, z: 0 }, e: { x: 100, z: 0 } };
  ok(doc, { type: 'node.add', node: { id: 'c', pos: { x: 0, z: 0 } } });
  for (const k of arms) {
    ok(doc, { type: 'node.add', node: { id: k, pos: pos[k]! } });
    ok(doc, { type: 'segment.add', segment: { id: k.toUpperCase(), a: k, b: 'c', roadTypeId: 'road-2' } });
  }
  return doc;
}

const lot = (id: string, x: number, extra: Partial<Parcel> = {}): Parcel => ({
  id,
  polygon: [
    { x, z: 10 },
    { x: x + 16, z: 10 },
    { x: x + 16, z: 26 },
    { x, z: 26 },
  ],
  zone: 'residential',
  regulation: { coverage: 0.6, far: 2.5, maxHeight: 60, setback: 3 },
  ...extra,
});

describe('doc v4 fields (ADR 0009 §1)', () => {
  it('keeps every new optional field through apply and docToCommands replay', () => {
    const doc = cross();
    ok(doc, { type: 'meta.update', growth: false });
    ok(doc, { type: 'vehicleType.upsert', vehicleType: { ...doc.vehicleTypes['city-bus']!, capacity: 55 } });
    ok(doc, { type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: true } });
    ok(doc, { type: 'parcel.upsert', parcel: lot('p1', 10, { auto: true, frontage: { segmentId: 'E', side: 'right' } }) });
    ok(doc, { type: 'building.place', building: { id: 'b1', typeId: 'grow-res-1', pos: { x: 18, z: 18 }, rotation: 0, auto: true } });
    ok(doc, { type: 'buildingType.upsert', buildingType: { ...cloneJson(GROWTH_PRESETS[0]!), id: 'mine', name: '내 성장 설계' } });
    expect(doc.meta.growth).toBe(false);
    expect(doc.vehicleTypes['city-bus']!.capacity).toBe(55);
    expect(doc.intersections['c']!.scramble).toBe(true);
    expect(doc.parcels['p1']).toMatchObject({ auto: true, frontage: { segmentId: 'E', side: 'right' } });
    expect(doc.buildings['b1']!.auto).toBe(true);
    expect(doc.buildingTypes['mine']!.growth).toEqual({ level: 1 });

    const replay = createEmptyDoc();
    for (const cmd of docToCommands(doc)) ok(replay, cmd);
    const strip = (d: CityDoc) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'rev' ? undefined : v)));
    expect(strip(replay)).toEqual(strip(doc));
  });

  it('drops the auto mark when a user moves a grown building', () => {
    const doc = cross();
    ok(doc, { type: 'building.place', building: { id: 'b1', typeId: 'grow-res-1', pos: { x: 18, z: 18 }, rotation: 0, auto: true } });
    ok(doc, { type: 'building.move', id: 'b1', pos: { x: 20, z: 20 }, rotation: 0 });
    expect(doc.buildings['b1']!.auto).toBeUndefined();
  });

  it('validates the new fields', () => {
    const doc = cross();
    fails(doc, { type: 'vehicleType.upsert', vehicleType: { ...doc.vehicleTypes['city-bus']!, capacity: 0 } }, /capacity/);
    fails(doc, { type: 'vehicleType.upsert', vehicleType: { ...doc.vehicleTypes['city-bus']!, capacity: 12.5 } }, /capacity/);
    fails(doc, { type: 'meta.update', growth: 'yes' as unknown as boolean }, /growth/);
    fails(doc, { type: 'parcel.upsert', parcel: lot('p', 10, { frontage: { segmentId: 'nope', side: 'left' } }) }, /frontage segment/);
    fails(doc, { type: 'parcel.upsert', parcel: lot('p', 10, { frontage: { segmentId: 'E', side: 'up' as 'left' } }) }, /frontage side/);
    fails(doc, { type: 'parcel.upsert', parcel: lot('p', 10, { auto: false as unknown as true }) }, /auto/);
    fails(doc, { type: 'buildingType.upsert', buildingType: { ...cloneJson(GROWTH_PRESETS[0]!), id: 'x', growth: { level: 2 as 1 } } }, /growth/);
  });

  it('allows a pedestrian-only phase only at signalized junctions of 3–4 legs with ≥ 2 crosswalk legs', () => {
    const set = (extra: object): Command => ({ type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: true, ...extra } });
    fails(cross(), set({ kind: 'uncontrolled' }), /signal/);
    fails(cross(['n', 's']), set({}), /3 or 4 legs/);
    fails(cross(), set({ crosswalkLegs: ['N'] }), /at least 2/);
    ok(cross(['n', 's', 'e']), set({}));
    ok(cross(), set({ crosswalkLegs: ['N', 'S'] }));
    // scramble: false is the same as omitted.
    const doc = cross();
    ok(doc, set({ scramble: false }));
    expect(doc.intersections['c']!.scramble).toBeUndefined();
  });

  it('still refuses overlapping parcels (bounding-box prefilter keeps the exact test)', () => {
    const doc = cross();
    ok(doc, { type: 'parcel.upsert', parcel: lot('a', 10) });
    fails(doc, { type: 'parcel.upsert', parcel: lot('b', 20) }, /overlap/);
    ok(doc, { type: 'parcel.upsert', parcel: lot('c', 26) });
  });
});

describe('doc v4 migration and growth presets', () => {
  it('new cities and v3 docs get the growth presets; a deleted preset does not come back', () => {
    const fresh = createEmptyDoc();
    expect(fresh.version).toBe(DOC_VERSION);
    expect(DOC_VERSION).toBe(6);
    for (const t of GROWTH_PRESETS) expect(fresh.buildingTypes[t.id]).toMatchObject({ growth: { level: 1 }, rev: 1 });

    const v3 = createEmptyDoc();
    for (const t of GROWTH_PRESETS) delete v3.buildingTypes[t.id];
    v3.version = 3;
    normalizeDoc(v3);
    expect(v3.version).toBe(DOC_VERSION);
    for (const t of GROWTH_PRESETS) expect(v3.buildingTypes[t.id]).toBeDefined();

    ok(v3, { type: 'buildingType.remove', id: 'grow-res-1' });
    normalizeDoc(v3);
    expect(v3.buildingTypes['grow-res-1']).toBeUndefined();
  });

  it('growth presets are valid designs that fit a 24 m lot with their zone setback', () => {
    const doc = createEmptyDoc();
    for (const t of GROWTH_PRESETS) {
      ok(doc, { type: 'buildingType.upsert', buildingType: cloneJson(t) });
      for (const p of t.parts) {
        expect(p.width + 2 * 3).toBeLessThanOrEqual(24);
        expect(p.depth + 2 * 3).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe('Sol 3b review fixes', () => {
  it('#1 ifAbsent: a stale zoning proposal cannot overwrite a parcel created meanwhile', () => {
    const doc = cross();
    ok(doc, { type: 'parcel.upsert', parcel: lot('ai-x-lot1-0', 10, { zone: 'public' }) });
    fails(doc, { type: 'parcel.upsert', parcel: lot('ai-x-lot1-0', 10, { auto: true }), ifAbsent: true }, /parcel exists/);
    expect(doc.parcels['ai-x-lot1-0']!.zone).toBe('public');
  });

  it('#2 ifClear: a proposed building is refused when someone built there meanwhile', () => {
    const doc = cross();
    ok(doc, { type: 'building.place', building: { id: 'mine', typeId: 'house', pos: { x: 40, z: 30 }, rotation: 0 } });
    fails(doc, { type: 'building.place', building: { id: 'ai', typeId: 'house', pos: { x: 42, z: 31 }, rotation: 0 }, ifClear: true }, /overlaps another building/);
    // Without the precondition the old rule (no building-building check) is unchanged.
    ok(doc, { type: 'building.place', building: { id: 'free', typeId: 'house', pos: { x: 42, z: 31 }, rotation: 0 } });
  });

  it('#9 export/import keeps lots whose frontage road is gone and junctions whose scramble became invalid', () => {
    const doc = cross();
    ok(doc, { type: 'parcel.upsert', parcel: lot('p1', 10, { auto: true, frontage: { segmentId: 'E', side: 'right' } }) });
    ok(doc, { type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: true } });
    ok(doc, { type: 'segment.remove', id: 'N' });
    ok(doc, { type: 'segment.remove', id: 'W' });
    // E is still there; remove it last so the lot's frontage dangles.
    ok(doc, { type: 'segment.remove', id: 'E' });
    const replay = createEmptyDoc();
    for (const cmd of docToCommands(doc)) ok(replay, cmd);
    expect(replay.parcels['p1']).toMatchObject({ auto: true });
    expect(replay.parcels['p1']!.frontage).toBeUndefined();
    expect(doc.intersections['c']!.scramble).toBe(true);
    expect(replay.intersections['c']).toMatchObject({ kind: 'signal' });
    expect(replay.intersections['c']!.scramble).toBeUndefined();
  });
});
