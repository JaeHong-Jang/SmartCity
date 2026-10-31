// P5d rounded volumes (ADR 0012 §4): `BuildingPart.round`, the shared `partOutline` contract, validation,
// normalization, collision/area on the rounded outline, round trips and the v6 → v7 migration.
import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  ARC_SEGMENTS,
  arcSegments,
  buildingBlocksRoad,
  buildingMetrics,
  buildingOverlapsBuildings,
  cloneJson,
  createEmptyDoc,
  DOC_VERSION,
  docProblem,
  docToCommands,
  isSimplePolygon,
  normalizeDoc,
  partArea,
  partBaseOutline,
  partOutline,
  partsToVoxels,
  polygonArea,
  ROUND_TOLERANCE,
  signedArea,
  voxelKey,
  voxelsToParts,
  type BuildingPart,
  type BuildingType,
  type CityDoc,
  type Command,
  type Vec2,
  type VoxelModel,
} from './index.js';

const part = (o: Partial<BuildingPart> = {}): BuildingPart => ({
  offset: { x: 0, z: 0 },
  width: 20,
  depth: 20,
  floors: 6,
  floorHeight: 3.2,
  baseHeight: 0,
  roof: 'flat',
  color: '#cccccc',
  roofColor: '#555555',
  ...o,
});

const design = (id: string, parts: BuildingPart[]): BuildingType => ({ id, name: id, zone: 'office', parts });
const upsert = (bt: BuildingType): Command => ({ type: 'buildingType.upsert', buildingType: bt });

/** Largest distance from the true arc to the chords: every chord midpoint vs the corner circle. */
function maxSagitta(poly: readonly Vec2[], centre: Vec2, r: number): number {
  let worst = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    worst = Math.max(worst, r - Math.hypot(m.x - centre.x, m.z - centre.z));
  }
  return worst;
}

describe('partOutline contract', () => {
  it('without round (omitted, 0, null) returns exactly the rectangle or the stored footprint', () => {
    const rect = partBaseOutline(part());
    expect(partOutline(part())).toEqual(rect);
    expect(partOutline(part({ round: 0 }))).toEqual(rect);
    expect(partOutline(part({ round: null as unknown as number }))).toEqual(rect);
    const fp = [
      { x: -10, z: -10 },
      { x: 10, z: -10 },
      { x: 10, z: 10 },
      { x: -10, z: 10 },
    ];
    expect(partOutline(part({ footprint: fp }))).toBe(fp);
    expect(rect).toEqual(fp);
  });

  it('square at the largest radius is a circle: CCW, starts at the bottom, chords on the circle within tolerance', () => {
    const p = part({ width: 20, depth: 20, round: 10, offset: { x: 3, z: -4 } });
    const o = partOutline(p);
    const n = arcSegments(10);
    expect(n).toBe(8);
    expect(o).toHaveLength(4 * n);
    expect(signedArea(o)).toBeGreaterThan(0);
    expect(isSimplePolygon(o)).toBe(true);
    expect(o[0]).toEqual({ x: 3, z: -14 });
    for (const v of o) expect(Math.hypot(v.x - 3, v.z + 4)).toBeCloseTo(10, 5);
    expect(maxSagitta(o, { x: 3, z: -4 }, 10)).toBeLessThanOrEqual(ROUND_TOLERANCE);
    // No repeated points (also across the wrap).
    for (let i = 0; i < o.length; i++) expect(o[i]).not.toEqual(o[(i + 1) % o.length]);
  });

  it('rectangle at the largest radius is a capsule (two half circles, two straight sides)', () => {
    const o = partOutline(part({ width: 30, depth: 10, round: 5 }));
    const n = arcSegments(5);
    expect(o).toHaveLength(4 * n + 2);
    expect(o[0]).toEqual({ x: -10, z: -5 });
    expect(o[1]).toEqual({ x: 10, z: -5 });
    // The x extremes are single points at mid depth (no vertical straight side).
    expect(o.filter((v) => v.x === 15)).toEqual([{ x: 15, z: 0 }]);
    expect(o.filter((v) => v.x === -15)).toEqual([{ x: -15, z: 0 }]);
    // Inscribed chords: slightly less than the exact capsule, by at most tolerance × arc length.
    const exact = 20 * 10 + Math.PI * 25;
    const a = partArea(part({ width: 30, depth: 10, round: 5 }));
    expect(a).toBeLessThan(exact);
    expect(exact - a).toBeLessThan(ROUND_TOLERANCE * 2 * Math.PI * 5);
  });

  it('small radius keeps straight sides and the bounding box; area = the approximated polygon', () => {
    const p = part({ width: 24, depth: 16, round: 3 });
    const o = partOutline(p);
    const n = arcSegments(3);
    expect(o).toHaveLength(4 * (n + 1));
    const xs = o.map((v) => v.x);
    const zs = o.map((v) => v.z);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]).toEqual([-12, 12, -8, 8]);
    expect(partArea(p)).toBe(polygonArea(o));
    const exact = 24 * 16 - (4 - Math.PI) * 9;
    expect(partArea(p)).toBeLessThan(exact);
    expect(exact - partArea(p)).toBeLessThan(4 * ROUND_TOLERANCE * 3 * (Math.PI / 2));
  });

  it('segment table: every row keeps the sagitta within the tolerance at its largest radius, and covers 150 m', () => {
    let prev = 0;
    for (const [maxR, n] of ARC_SEGMENTS) {
      expect(maxR * (1 - Math.cos(Math.PI / (4 * n)))).toBeLessThanOrEqual(ROUND_TOLERANCE);
      expect(n).toBeGreaterThan(prev);
      prev = n;
    }
    expect(ARC_SEGMENTS.at(-1)![0]).toBeGreaterThanOrEqual(150);
    // Measured on real outlines across the range (circles: worst case per radius).
    for (const r of [0.05, 0.17, 0.5, 1, 2.6, 4, 5.84, 8, 12, 23.35, 30, 60, 93.38, 120, 150]) {
      const o = partOutline(part({ width: 2 * r, depth: 2 * r, round: r }));
      expect(maxSagitta(o, { x: 0, z: 0 }, r), `r = ${r}`).toBeLessThanOrEqual(ROUND_TOLERANCE + 1e-6);
    }
    // Vertex counts of circles, from the table only (no camera, no LOD).
    expect([0.1, 0.5, 1, 2, 5, 10, 20, 40, 90, 150].map((r) => partOutline(part({ width: 2 * r, depth: 2 * r, round: r })).length)).toEqual([
      4, 8, 12, 16, 24, 32, 48, 64, 96, 128,
    ]);
  });

  it('is deterministic: same bits every call, snapped to 1 µm, agrees with Math.cos/sin', () => {
    const p = part({ width: 37.4, depth: 21.8, round: 7.3, offset: { x: 0.1, z: -0.7 } });
    const a = JSON.stringify(partOutline(p));
    expect(JSON.stringify(partOutline(cloneJson(p)))).toBe(a);
    for (const v of partOutline(p)) {
      expect(Math.round(v.x * 1e6) / 1e6).toBe(v.x);
      expect(Math.round(v.z * 1e6) / 1e6).toBe(v.z);
    }
    // Top-right corner arc against the library trigonometry.
    const n = arcSegments(7.3);
    const o = partOutline(p);
    const cx = 0.1 + 37.4 / 2 - 7.3;
    const cz = -0.7 + 21.8 / 2 - 7.3;
    const start = o.findIndex((v) => Math.abs(v.x - (0.1 + 37.4 / 2)) < 1e-9 && Math.abs(v.z - cz) < 1e-6);
    for (let k = 0; k <= n; k++) {
      const v = o[start + k]!;
      expect(v.x).toBeCloseTo(cx + 7.3 * Math.cos((Math.PI * k) / (2 * n)), 6);
      expect(v.z).toBeCloseTo(cz + 7.3 * Math.sin((Math.PI * k) / (2 * n)), 6);
    }
  });
});

describe('round validation and normalization', () => {
  const tryRound = (o: Partial<BuildingPart>) => applyCommand(createEmptyDoc(), upsert(design('t', [part(o)])));

  it('accepts 0..min(width, depth)/2 and refuses negative, larger, non-finite and non-numbers', () => {
    expect(tryRound({ width: 20, depth: 12, round: 0 }).ok).toBe(true);
    expect(tryRound({ width: 20, depth: 12, round: 6 }).ok).toBe(true);
    expect(tryRound({ width: 20, depth: 12, round: 2.5 }).ok).toBe(true);
    for (const bad of [-0.01, 6.000001, 7, NaN, Infinity, -Infinity, '3', true]) {
      const r = tryRound({ width: 20, depth: 12, round: bad as unknown as number });
      expect(r.ok, String(bad)).toBe(false);
    }
    expect(tryRound({ width: 20, depth: 12, round: 6.5 })).toMatchObject({ ok: false, error: expect.stringMatching(/part\.round out of range/) });
  });

  it('refuses a positive radius with a drawn footprint or a pitched roof (0 is fine with both)', () => {
    const fp = [
      { x: -10, z: -6 },
      { x: 10, z: -6 },
      { x: 10, z: 6 },
      { x: 0, z: 6 },
      { x: 0, z: 2 },
      { x: -10, z: 2 },
    ];
    expect(tryRound({ width: 20, depth: 12, footprint: fp, round: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/rectangular/) });
    expect(tryRound({ width: 20, depth: 12, footprint: fp, round: 0 }).ok).toBe(true);
    expect(tryRound({ width: 20, depth: 12, roof: 'gable', round: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/flat roof/) });
    expect(tryRound({ width: 20, depth: 12, roof: 'pyramid', round: 2 }).ok).toBe(false);
    expect(tryRound({ width: 20, depth: 12, roof: 'gable', round: 0 }).ok).toBe(true);
  });

  it('stores 0 and null like an omitted field (byte-identical) and keeps a positive radius', () => {
    const stored = (o: Partial<BuildingPart>): string => {
      const doc = createEmptyDoc();
      expect(applyCommand(doc, upsert(design('t', [part(o)]))).ok).toBe(true);
      return JSON.stringify(doc.buildingTypes['t']);
    };
    const plain = stored({});
    expect(stored({ round: 0 })).toBe(plain);
    expect(stored({ round: null as unknown as number })).toBe(plain);
    expect(plain).not.toContain('round');
    expect(JSON.parse(stored({ round: 4 })).parts[0].round).toBe(4);
  });
});

describe('collision and area follow the rounded outline', () => {
  /** A round tower (r = 10 at the origin) and a 4 × 4 kiosk in the square's corner, off the circle. */
  function corner(round: number): { doc: CityDoc; kiosk: BuildingType } {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, upsert(design('tower', [part({ round })]))).ok).toBe(true);
    expect(applyCommand(doc, { type: 'building.place', building: { id: 'b1', typeId: 'tower', pos: { x: 0, z: 0 }, rotation: 0 } }).ok).toBe(true);
    const kiosk = design('kiosk', [part({ width: 4, depth: 4, floors: 1 })]);
    expect(applyCommand(doc, upsert(kiosk)).ok).toBe(true);
    return { doc, kiosk: doc.buildingTypes['kiosk']! };
  }

  it('a building fits in the corner of a round tower but not of a square one', () => {
    // Kiosk corner nearest the tower at (8.4, 8.4): 11.9 m from the centre, outside r = 10, inside the square.
    const at = { id: 'k', pos: { x: 10.4, z: 10.4 }, rotation: 0 };
    const round = corner(10);
    expect(buildingOverlapsBuildings(round.doc, at, round.kiosk)).toBe(false);
    const square = corner(0);
    expect(buildingOverlapsBuildings(square.doc, at, square.kiosk)).toBe(true);
  });

  it('a road past the corner clears a round tower but not a square one', () => {
    const roadPast = (round: number): boolean => {
      const doc = createEmptyDoc();
      // A diagonal street (x + z = 25.46): centreline 18 m from the tower centre, road-2's surface
      // (≈ 6 m half width) from ≈ 12 m — past the circle (10 m), over the square's corner (14.14 m).
      for (const c of [
        { type: 'node.add', node: { id: 'a', pos: { x: -60, z: 85.46 } } },
        { type: 'node.add', node: { id: 'b', pos: { x: 85.46, z: -60 } } },
        { type: 'segment.add', segment: { id: 's', a: 'a', b: 'b', roadTypeId: 'road-2' } },
        upsert(design('tower', [part({ round })])),
      ] as Command[])
        expect(applyCommand(doc, c).ok).toBe(true);
      return buildingBlocksRoad(doc, { pos: { x: 0, z: 0 }, rotation: 0 }, doc.buildingTypes['tower']!);
    };
    expect(roadPast(10)).toBe(false);
    expect(roadPast(0)).toBe(true);
  });

  it('volumes of one design may fill the corners of a rounded volume', () => {
    const parts = [part({ round: 10 }), part({ width: 3, depth: 3, offset: { x: 9.5, z: 9.5 }, floors: 2 })];
    expect(applyCommand(createEmptyDoc(), upsert(design('t', parts))).ok).toBe(true);
    expect(applyCommand(createEmptyDoc(), upsert(design('t', [part(), parts[1]!]))).ok).toBe(false);
  });

  it('metrics use the polygon area', () => {
    const t = design('t', [part({ round: 10 })]);
    const m = buildingMetrics(t);
    const a = polygonArea(partOutline(t.parts[0]!));
    expect(m.footprintArea).toBe(a);
    expect(m.grossFloorArea).toBeCloseTo(a * 6, 9);
    expect(a / (Math.PI * 100)).toBeGreaterThan(0.99);
    expect(a / (Math.PI * 100)).toBeLessThan(1);
  });
});

describe('round trips and versions', () => {
  function roundCity(): CityDoc {
    const doc = createEmptyDoc();
    for (const c of [
      upsert(design('tower', [part({ round: 10 }), part({ width: 12, depth: 12, round: 6, baseHeight: 6 * 3.2, floors: 4 })])),
      upsert(design('capsule', [part({ width: 30, depth: 10, round: 5 })])),
      { type: 'building.place', building: { id: 'b1', typeId: 'tower', pos: { x: 40, z: 40 }, rotation: 0.3 } },
      { type: 'building.place', building: { id: 'b2', typeId: 'capsule', pos: { x: -40, z: 40 }, rotation: 0 } },
    ] as Command[])
      expect(applyCommand(doc, c).ok).toBe(true);
    return doc;
  }

  it('docToCommands replays a city with rounded volumes into an equal doc', () => {
    const doc = roundCity();
    const replay = createEmptyDoc();
    for (const c of docToCommands(doc)) expect(applyCommand(replay, c).ok).toBe(true);
    expect(replay.buildingTypes['tower']).toEqual(doc.buildingTypes['tower']);
    expect(replay.buildingTypes['capsule']!.parts[0]!.round).toBe(5);
    expect(replay.buildings).toEqual(doc.buildings);
  });

  // Sol P5d review #4: load-time and command-time contracts agree (both directions).
  it('load normalizes round: null away and refuses what an upsert refuses', () => {
    const stored = (o: Partial<BuildingPart>): CityDoc => {
      const doc = createEmptyDoc();
      (doc.buildingTypes['t'] as unknown) = { ...design('t', [part(o)]), rev: 1 };
      return doc;
    };
    const both = (o: Partial<BuildingPart>) => ({
      load: docProblem(normalizeDoc(stored(o))) === null,
      upsert: applyCommand(createEmptyDoc(), upsert(design('t', [part(o)]))).ok,
    });
    const nul = normalizeDoc(stored({ round: null as unknown as number }));
    expect('round' in nul.buildingTypes['t']!.parts[0]!).toBe(false);
    expect('round' in normalizeDoc(stored({ round: 0 })).buildingTypes['t']!.parts[0]!).toBe(false);
    expect(both({ round: null as unknown as number })).toEqual({ load: true, upsert: true });
    expect(both({ round: 10 })).toEqual({ load: true, upsert: true });
    expect(both({ round: 0, roof: 'gable' })).toEqual({ load: true, upsert: true });
    const fp = [
      { x: -10, z: -10 },
      { x: 10, z: -10 },
      { x: 10, z: 10 },
      { x: -10, z: 10 },
    ];
    for (const bad of [{ round: -1 }, { round: 11 }, { round: NaN }, { round: 4, roof: 'gable' as const }, { round: 4, footprint: fp }]) {
      expect(both(bad), JSON.stringify(bad)).toEqual({ load: false, upsert: false });
    }
  });

  it('v6 → v7 changes nothing but the version; docProblem checks the radius type', () => {
    expect(DOC_VERSION).toBe(9);
    const v6 = { ...cloneJson(createEmptyDoc()), version: 6 };
    const before = cloneJson(v6);
    const v7 = normalizeDoc(v6);
    expect(v7.version).toBe(DOC_VERSION);
    expect({ ...v7, version: 6 }).toEqual(before);
    expect(docProblem(roundCity())).toBeNull();
    const bad = roundCity();
    (bad.buildingTypes['tower']!.parts[0] as unknown as { round: unknown }).round = 'big';
    expect(docProblem(bad)).toMatch(/buildingTypes\["tower"\]/);
  });
});

describe('studio voxels keep the radius per rectangular volume', () => {
  const model = (round?: number): VoxelModel => {
    const m: VoxelModel = { cell: 2, floorHeight: 3, cells: new Map(), styles: [{ color: '#aaaaaa', roofColor: '#555555', roof: 'gable', ...(round ? { round } : {}) }] };
    for (let i = -3; i < 3; i++) for (let j = -2; j < 2; j++) for (let k = 0; k < 3; k++) m.cells.set(voxelKey(i, j, k), 0);
    return m;
  };

  it('voxelsToParts rounds rectangles (clamped, flat roof) and partsToVoxels reopens them losslessly', () => {
    const [p] = voxelsToParts(model(3)).parts;
    expect(p).toMatchObject({ width: 12, depth: 8, round: 3, roof: 'flat' });
    expect(voxelsToParts(model(99)).parts[0]!.round).toBe(4);
    expect(voxelsToParts(model()).parts[0]).not.toHaveProperty('round');
    expect(voxelsToParts(model()).parts[0]!.roof).toBe('gable');
    const back = partsToVoxels([p!], 2);
    expect(back.lossy).toBe(false);
    expect(back.model.cells.size).toBe(6 * 4 * 3);
    expect(voxelsToParts(back.model).parts).toEqual([p]);
  });

  it('drops the radius on non-rectangular volumes and reports them', () => {
    const m = model(3);
    m.cells.delete(voxelKey(2, 1, 0));
    m.cells.delete(voxelKey(2, 1, 1));
    m.cells.delete(voxelKey(2, 1, 2));
    const r = voxelsToParts(m);
    expect(r.parts[0]!.footprint).toBeDefined();
    expect(r.parts[0]).not.toHaveProperty('round');
    expect(r.unrounded).toEqual([0]);
    expect(voxelsToParts(model(3)).unrounded).toEqual([]);
  });

  // Sol P5d review #3: two touching 8 × 8 m volumes of the same look, each rounded (r = 4), used to
  // reopen as one 16 × 8 m capsule (area 99.39 → 113.69 m²) with lossy = false.
  it('reopens touching rounded twins as two rounded volumes, same area', () => {
    const twin = (x: number): BuildingPart => part({ width: 8, depth: 8, floors: 2, floorHeight: 3, round: 4, offset: { x, z: 0 } });
    const parts = [twin(-4), twin(4)];
    expect(applyCommand(createEmptyDoc(), upsert(design('t', parts))).ok).toBe(true);
    const area = (ps: BuildingPart[]) => ps.reduce((a, p) => a + partArea(p), 0);
    expect(area(parts)).toBeCloseTo(99.386512, 5);
    const open = partsToVoxels(parts, 2);
    expect(open.lossy).toBe(false);
    const back = voxelsToParts(open.model).parts;
    expect(back).toHaveLength(2);
    expect(back.map((p) => [p.offset.x, p.width, p.round])).toEqual([
      [-4, 8, 4],
      [4, 8, 4],
    ]);
    expect(area(back)).toBeCloseTo(99.386512, 5);
  });

  it('flags a rounded volume that cannot come back as itself as lossy', () => {
    // Off the 2 m grid: snapped, so the rounded box changes.
    expect(partsToVoxels([part({ width: 9, depth: 8, floorHeight: 3, round: 4 })], 2).lossy).toBe(true);
    // Overlapping another volume's cells (one of them loses cells).
    const a = part({ width: 8, depth: 8, floorHeight: 3, floors: 2, round: 4 });
    const b = part({ width: 8, depth: 8, floorHeight: 3, floors: 2, baseHeight: 3 });
    expect(partsToVoxels([a, b], 2).lossy).toBe(true);
  });
});
