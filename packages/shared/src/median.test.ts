// Road median contract (ADR 0014 §4) and the v9 presets (§5): cross-section, validation, storage,
// round trips, the v8 → v9 migration and the width consumers that follow the curb-to-curb width.

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  carriagewayWidth,
  cloneJson,
  createEmptyDoc,
  DEFAULT_ROAD_TYPES,
  demand,
  DOC_VERSION,
  docProblem,
  docToCommands,
  drivableWidth,
  filletFloor,
  growthStep,
  laneOffset,
  lotsAlongSegment,
  lotsToCommand,
  MEDIAN_ROAD_PRESETS,
  medianShapeError,
  medianWidth,
  MODERN_BUILDING_PRESETS,
  normalizeDoc,
  preferredFilletRadius,
  roadHalfWidth,
  sensorPose,
  type CityDoc,
  type Command,
  type RoadType,
} from './index.js';

const ok = (doc: CityDoc, cmd: Command): void => expect(applyCommand(doc, cmd)).toEqual({ ok: true });
const M6 = MEDIAN_ROAD_PRESETS[0]!;
const M8 = MEDIAN_ROAD_PRESETS[1]!;

function street(roadTypeId: string): CityDoc {
  const doc = createEmptyDoc();
  ok(doc, { type: 'node.add', node: { id: 'a', pos: { x: -100, z: 0 } } });
  ok(doc, { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } });
  ok(doc, { type: 'segment.add', segment: { id: 'S1', a: 'a', b: 'b', roadTypeId } });
  return doc;
}

describe('median cross-section', () => {
  it('without a median every width and lane offset is the pre-v9 formula', () => {
    for (const rt of DEFAULT_ROAD_TYPES) {
      expect(rt.median).toBeUndefined();
      expect(medianWidth(rt)).toBe(0);
      expect(carriagewayWidth(rt)).toBe((rt.lanesForward + rt.lanesBackward) * rt.laneWidth);
      expect(drivableWidth(rt)).toBe(carriagewayWidth(rt));
      for (let i = 0; i < rt.lanesForward; i++) {
        const old = rt.lanesBackward === 0 ? (i - (rt.lanesForward - 1) / 2) * rt.laneWidth : (i + 0.5) * rt.laneWidth;
        expect(laneOffset(rt, 'forward', i)).toBe(old);
      }
      for (let i = 0; i < rt.lanesBackward; i++) expect(laneOffset(rt, 'backward', i)).toBe(-(i + 0.5) * rt.laneWidth);
    }
  });

  it('separates the drivable width from the curb-to-curb width and starts the lanes at the median edge', () => {
    expect(drivableWidth(M6)).toBe(21);
    expect(medianWidth(M6)).toBe(4);
    expect(carriagewayWidth(M6)).toBe(25);
    expect(roadHalfWidth(M6)).toBe(15);
    expect([0, 1, 2].map((i) => laneOffset(M6, 'forward', i))).toEqual([3.75, 7.25, 10.75]);
    expect([0, 1, 2].map((i) => laneOffset(M6, 'backward', i))).toEqual([-3.75, -7.25, -10.75]);
    // The curb lane's outer edge is the curb.
    expect(laneOffset(M6, 'forward', 2) + M6.laneWidth / 2).toBe(carriagewayWidth(M6) / 2);
    expect(carriagewayWidth(M8)).toBe(34);
    expect(roadHalfWidth(M8)).toBe(19.5);
  });
});

describe('median validation and storage', () => {
  const upsert = (rt: unknown) => applyCommand(createEmptyDoc(), { type: 'roadType.upsert', roadType: rt as RoadType });
  const base = { ...cloneJson(M6), id: 'm' };

  it('accepts a median on symmetric two-way roads only, with a bounded width and a boolean planted', () => {
    expect(upsert(base).ok).toBe(true);
    expect(upsert({ ...base, median: { width: 1, planted: false } }).ok).toBe(true);
    expect(upsert({ ...base, median: { width: 10, planted: true } }).ok).toBe(true);
    const BAD: unknown[] = [
      { ...base, lanesBackward: 2 },
      { ...base, lanesForward: 2, lanesBackward: 0 },
      { ...base, median: { width: 0, planted: true } },
      { ...base, median: { width: 0.5, planted: true } },
      { ...base, median: { width: 10.5, planted: true } },
      { ...base, median: { width: NaN, planted: true } },
      { ...base, median: { width: Infinity, planted: true } },
      { ...base, median: { width: '4', planted: true } },
      { ...base, median: { width: 4 } },
      { ...base, median: { width: 4, planted: 1 } },
      { ...base, median: null },
      { ...base, median: [4, true] },
      { ...base, median: 4 },
    ];
    for (const bad of BAD) {
      expect(upsert(bad).ok, JSON.stringify(bad)).toBe(false);
      expect(medianShapeError(bad as RoadType), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('stores exactly width and planted, and no median key on roads without one', () => {
    const doc = createEmptyDoc();
    ok(doc, { type: 'roadType.upsert', roadType: { ...base, median: { width: 3, planted: false, extra: 1 } as never } });
    expect(doc.roadTypes.m!.median).toEqual({ width: 3, planted: false });
    const { median: _m, ...plain } = base;
    ok(doc, { type: 'roadType.upsert', roadType: plain });
    expect('median' in doc.roadTypes.m!).toBe(false);
    for (const rt of Object.values(createEmptyDoc().roadTypes)) if (!rt.id.endsWith('-median')) expect('median' in rt).toBe(false);
  });

  it('a stored doc with a bad median is refused by docProblem (the same rule as the upsert)', () => {
    const doc = street('road-6-median');
    expect(docProblem(doc)).toBeNull();
    for (const bad of [{ median: { width: 0, planted: true } }, { median: null }, { lanesBackward: 2 }, { median: { width: 4, planted: 'yes' } }]) {
      const d = cloneJson(doc);
      Object.assign(d.roadTypes['road-6-median']!, bad);
      expect(docProblem(d), JSON.stringify(bad)).toBe('doc.roadTypes["road-6-median"] is malformed');
    }
  });

  it('docToCommands replays a city on median roads to the same roads and road types', () => {
    const doc = street('road-6-median');
    ok(doc, { type: 'roadType.upsert', roadType: { ...base, id: 'mine', median: { width: 2.5, planted: false } } });
    ok(doc, { type: 'segment.setType', id: 'S1', roadTypeId: 'mine' });
    const replay = createEmptyDoc();
    for (const c of docToCommands(doc)) expect(applyCommand(replay, c), c.type).toEqual({ ok: true });
    expect(replay.roadTypes).toEqual(doc.roadTypes);
    expect({ n: replay.nodes, s: replay.segments }).toEqual({ n: doc.nodes, s: doc.segments });
  });
});

describe('v8 → v9 migration', () => {
  /** A doc as v8 saved it: no median presets, no modern designs. */
  function v8(): CityDoc {
    const doc = street('road-4');
    for (const t of MEDIAN_ROAD_PRESETS) delete doc.roadTypes[t.id];
    for (const t of MODERN_BUILDING_PRESETS) delete doc.buildingTypes[t.id];
    doc.version = 8;
    return doc;
  }

  it('adds the median roads and modern designs, keeps every existing road type byte for byte, and is idempotent', () => {
    expect(DOC_VERSION).toBe(9);
    const old = v8();
    const before = cloneJson(old);
    normalizeDoc(old);
    expect(old.version).toBe(9);
    for (const t of MEDIAN_ROAD_PRESETS) expect(old.roadTypes[t.id]).toEqual(t);
    for (const t of MODERN_BUILDING_PRESETS) expect(old.buildingTypes[t.id]).toEqual({ ...t, rev: 1 });
    for (const id of Object.keys(before.roadTypes)) expect(JSON.stringify(old.roadTypes[id])).toBe(JSON.stringify(before.roadTypes[id]));
    for (const id of Object.keys(before.buildingTypes)) expect(JSON.stringify(old.buildingTypes[id])).toBe(JSON.stringify(before.buildingTypes[id]));
    const rest = (d: CityDoc) => JSON.stringify({ ...d, version: 0, roadTypes: null, buildingTypes: null });
    expect(rest(old)).toBe(rest(before));
    expect(docProblem(old)).toBeNull();
    const once = JSON.stringify(old);
    normalizeDoc(old);
    expect(JSON.stringify(old)).toBe(once);
  });

  it('never overwrites a user type with a preset id, and a deleted preset does not come back', () => {
    const old = v8();
    old.roadTypes['road-6-median'] = { ...cloneJson(DEFAULT_ROAD_TYPES[0]!), id: 'road-6-median', name: '내 도로' };
    old.buildingTypes['apt-slab-25'] = { ...cloneJson(old.buildingTypes.house!), id: 'apt-slab-25', name: '내 집', rev: 3 };
    normalizeDoc(old);
    expect(old.roadTypes['road-6-median']).toMatchObject({ name: '내 도로' });
    expect('median' in old.roadTypes['road-6-median']!).toBe(false);
    expect(old.buildingTypes['apt-slab-25']).toMatchObject({ name: '내 집', rev: 3 });
    const now = createEmptyDoc();
    delete now.roadTypes['road-8-median']; // road types have no remove command; a v9 doc without it
    ok(now, { type: 'buildingType.remove', id: 'glass-podium' });
    normalizeDoc(now);
    expect(now.roadTypes['road-8-median']).toBeUndefined();
    expect(now.buildingTypes['glass-podium']).toBeUndefined();
  });
});

describe('median width consumers (curb-to-curb width)', () => {
  it('auto lots, fillet radius, sensors and building clearance follow the wider road', () => {
    const doc = street('road-6-median');
    const lots = lotsAlongSegment(doc, 'S1', 'right', 0, 1, 2, 'residential', 'r');
    expect(lots.length).toBeGreaterThan(0);
    for (const l of lots) expect(l.polygon[0]!.z).toBeCloseTo(15);
    expect(filletFloor(M6)).toBe(19);
    expect(preferredFilletRadius(M6)).toBe(35);
    expect(filletFloor(M8)).toBe(23.5);
    expect(preferredFilletRadius(M8)).toBe(45);
    const pose = sensorPose(doc, { id: 's', kind: 'cctv', segmentId: 'S1', t: 0.5, side: 'right', heading: 0, fov: 1, range: 50 })!;
    expect(Math.abs(pose.pos.z)).toBeCloseTo(12.5 + 1.25);
    // A house whose edge is 1 m inside the sidewalk overlaps; 1 m outside it fits.
    expect(applyCommand(cloneJson(doc), { type: 'building.place', building: { id: 'h', typeId: 'house', pos: { x: 0, z: 15 + 4.5 - 1 }, rotation: 0 } }).ok).toBe(false);
    expect(applyCommand(cloneJson(doc), { type: 'building.place', building: { id: 'h', typeId: 'house', pos: { x: 0, z: 15 + 4.5 + 1 }, rotation: 0 } }).ok).toBe(true);
  });
});

describe('modern presets (ADR 0014 §5)', () => {
  it('are valid designs with their own ids and no growth', () => {
    const fresh = createEmptyDoc();
    const ids = MODERN_BUILDING_PRESETS.map((t) => t.id);
    expect(ids).toEqual(['apt-slab-25', 'apt-tower-35', 'mixed-tower', 'glass-podium']);
    for (const t of MODERN_BUILDING_PRESETS) {
      expect(t.growth).toBeUndefined();
      expect(fresh.buildingTypes[t.id]).toEqual({ ...t, rev: 1 });
      const d = createEmptyDoc();
      ok(d, { type: 'buildingType.upsert', buildingType: { ...cloneJson(t), id: `copy-${t.id}` } });
    }
    expect(MODERN_BUILDING_PRESETS.find((t) => t.id === 'apt-slab-25')!.parts[0]!.floors).toBe(25);
    expect(MODERN_BUILDING_PRESETS.find((t) => t.id === 'apt-tower-35')!.parts[0]!.floors).toBe(35);
  });

  it('do not change automatic growth: the same commands with and without them', () => {
    const city = (): CityDoc => {
      const doc = street('road-4');
      for (const [side, zone] of [['right', 'residential'], ['left', 'commercial']] as const) ok(doc, lotsToCommand(lotsAlongSegment(doc, 'S1', side, 0, 1, 3, zone, side)));
      return doc;
    };
    const run = (doc: CityDoc): string[] => {
      const out: string[] = [];
      for (let epoch = 1; epoch <= 8; epoch++) {
        const cmds = growthStep(doc, epoch);
        out.push(JSON.stringify(cmds));
        if (cmds.length) ok(doc, { type: 'batch', commands: cmds });
      }
      return out;
    };
    const withPresets = city();
    const without = city();
    for (const t of MODERN_BUILDING_PRESETS) delete without.buildingTypes[t.id];
    for (const t of MEDIAN_ROAD_PRESETS) delete without.roadTypes[t.id];
    expect(demand(withPresets)).toEqual(demand(without));
    const a = run(withPresets);
    expect(a.some((s) => s !== '[]')).toBe(true);
    expect(a).toEqual(run(without));
    expect(withPresets.buildings).toEqual(without.buildings);
  });
});
