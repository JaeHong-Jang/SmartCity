import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  buildingMetrics,
  cellKey,
  cellsToOutline,
  cloneJson,
  createEmptyDoc,
  DEFAULT_REGULATIONS,
  designStats,
  docToCommands,
  normalizeDoc,
  outlineToCells,
  parcelCompliance,
  polygonArea,
  polygonsOverlap,
  SMART_CITY_PRESETS,
  type BuildingType,
  type CityDoc,
  type Command,
  type Parcel,
} from './index.js';

function ok(doc: CityDoc, cmd: Command): void {
  expect(applyCommand(doc, cmd)).toEqual({ ok: true });
}

const rect = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

function cells(list: [number, number][]): Set<string> {
  return new Set(list.map(([i, j]) => cellKey(i, j)));
}

function road(doc: CityDoc, x0: number, z0: number, x1: number, z1: number, id = 's'): void {
  ok(doc, {
    type: 'batch',
    commands: [
      { type: 'node.add', node: { id: `${id}a`, pos: { x: x0, z: z0 } } },
      { type: 'node.add', node: { id: `${id}b`, pos: { x: x1, z: z1 } } },
      { type: 'segment.add', segment: { id, a: `${id}a`, b: `${id}b`, roadTypeId: 'road-2' } },
    ],
  });
}

describe('cellsToOutline', () => {
  it('traces a rectangle and an L shape counter-clockwise', () => {
    expect(cellsToOutline(cells([[0, 0], [1, 0], [0, 1], [1, 1]]), 2)).toEqual(rect(0, 0, 4, 4));
    const l = cellsToOutline(cells([[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]]), 1)!;
    expect(l).toHaveLength(6);
    expect(polygonArea(l)).toBe(5);
  });

  it('keeps the largest region and fills holes', () => {
    const ring = cells([[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2], [9, 9]]);
    expect(polygonArea(cellsToOutline(ring, 1)!)).toBe(9);
    // Diagonal neighbours belong to different regions (4-connectivity): only the larger one is kept.
    expect(polygonArea(cellsToOutline(cells([[0, 0], [1, 0], [2, 1]]), 1)!)).toBe(2);
  });

  it('round-trips through outlineToCells', () => {
    const c = cells([[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]]);
    expect(outlineToCells(cellsToOutline(c, 2)!, 2)).toEqual(c);
    expect(cellsToOutline(new Set(), 1)).toBeNull();
  });

  it('drops edge-centred cells symmetrically for outlines off the grid', () => {
    // 36 × 30 m centred on 0: z edges at ±15 fall on 2 m cell centres.
    const got = outlineToCells(rect(-18, -15, 18, 15), 2);
    expect(polygonArea(cellsToOutline(got, 2)!)).toBe(36 * 28);
  });
});

describe('building design validation', () => {
  const base = (): BuildingType => cloneJson(SMART_CITY_PRESETS.find((p) => p.id === 'school')!);

  it('accepts every preset as a user design', () => {
    const doc = createEmptyDoc();
    for (const p of SMART_CITY_PRESETS) ok(doc, { type: 'buildingType.upsert', buildingType: { ...cloneJson(p), id: `${p.id}-copy` } });
  });

  it('rejects non-orthogonal, oversized or pitched-roof footprints', () => {
    const doc = createEmptyDoc();
    const skew = base();
    skew.id = 'skew';
    skew.parts[0]!.footprint = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 8 }];
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: skew }).ok).toBe(false);
    const pitched = base();
    pitched.id = 'pitched';
    pitched.parts[0]!.roof = 'gable';
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: pitched }).ok).toBe(false);
  });

  it('rejects volumes that overlap in space but allows stacking and touching', () => {
    const doc = createEmptyDoc();
    const bt = cloneJson(doc.buildingTypes.house!);
    bt.id = 'stack';
    bt.parts = [
      { ...bt.parts[0]!, roof: 'flat', offset: { x: 0, z: 0 }, width: 10, depth: 10, floors: 2, floorHeight: 3, baseHeight: 0 },
      { ...bt.parts[0]!, roof: 'flat', offset: { x: 10, z: 0 }, width: 10, depth: 10, floors: 2, floorHeight: 3, baseHeight: 0 },
      { ...bt.parts[0]!, roof: 'flat', offset: { x: 0, z: 0 }, width: 6, depth: 6, floors: 3, floorHeight: 3, baseHeight: 6 },
    ];
    ok(doc, { type: 'buildingType.upsert', buildingType: bt });
    bt.parts.push({ ...bt.parts[0]!, offset: { x: 2, z: 2 } });
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: bt })).toEqual({ ok: false, error: 'building volumes overlap' });
  });

  it('enforces the roof budget for smart equipment', () => {
    const doc = createEmptyDoc();
    const bt = base();
    bt.id = 'roof';
    bt.smart = { solarRoof: 0.7, greenRoof: 0.3, evChargers: 0, sensors: false, dronePort: true };
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: bt }).ok).toBe(false);
  });

  it('detects lost updates with expectedRev', () => {
    const doc = createEmptyDoc();
    const bt = base();
    bt.id = 'shared-design';
    ok(doc, { type: 'buildingType.upsert', buildingType: bt, expectedRev: 0 });
    expect(doc.buildingTypes['shared-design']!.rev).toBe(1);
    ok(doc, { type: 'buildingType.upsert', buildingType: { ...bt, name: 'A' }, expectedRev: 1 });
    const stale = applyCommand(doc, { type: 'buildingType.upsert', buildingType: { ...bt, name: 'B' }, expectedRev: 1 });
    expect(stale.ok).toBe(false);
    expect(doc.buildingTypes['shared-design']!.name).toBe('A');
  });
});

describe('metrics and mixed use', () => {
  it('splits floor area by use and only counts ground volumes in the footprint', () => {
    const m = buildingMetrics(SMART_CITY_PRESETS.find((p) => p.id === 'mixed-use')!);
    expect(m.areaByUse.commercial).toBeCloseTo(36 * 30 * 3);
    expect(m.areaByUse.residential).toBeCloseTo(24 * 18 * 22);
    expect(m.footprintArea).toBeCloseTo(36 * 30);
    expect(m.height).toBeCloseTo(13.5 + 22 * 2.9);
  });

  it('uses the drawn footprint area for L-shaped volumes', () => {
    const m = buildingMetrics(SMART_CITY_PRESETS.find((p) => p.id === 'school')!);
    expect(m.footprintArea).toBeCloseTo(44 * 12 + 12 * 24);
  });
});

describe('hard-blocking rules', () => {
  it('refuses buildings placed or moved onto a road', () => {
    const doc = createEmptyDoc();
    road(doc, -100, 0, 100, 0);
    expect(applyCommand(doc, { type: 'building.place', building: { id: 'b', typeId: 'house', pos: { x: 0, z: 2 }, rotation: 0 } }).ok).toBe(false);
    ok(doc, { type: 'building.place', building: { id: 'b', typeId: 'house', pos: { x: 0, z: 20 }, rotation: 0 } });
    expect(applyCommand(doc, { type: 'building.move', id: 'b', pos: { x: 0, z: 6 }, rotation: 0 }).ok).toBe(false);
    ok(doc, { type: 'building.move', id: 'b', pos: { x: 30, z: 25 }, rotation: Math.PI / 2 });
    expect(doc.buildings.b).toMatchObject({ pos: { x: 30, z: 25 }, rotation: Math.PI / 2 });
  });

  it('refuses node moves that make a road cross another one', () => {
    const doc = createEmptyDoc();
    road(doc, -100, 0, 100, 0, 'h');
    road(doc, 0, 20, 0, 100, 'v');
    ok(doc, { type: 'node.move', id: 'va', pos: { x: 10, z: 30 } });
    expect(applyCommand(doc, { type: 'node.move', id: 'va', pos: { x: 10, z: -30 } }).ok).toBe(false);
  });

  it('refuses overlapping parcels but allows neighbours', () => {
    const doc = createEmptyDoc();
    const parcel = (id: string, poly: { x: number; z: number }[]): Parcel => ({ id, polygon: poly, zone: 'residential', regulation: DEFAULT_REGULATIONS.residential });
    ok(doc, { type: 'parcel.upsert', parcel: parcel('p1', rect(0, 0, 40, 40)) });
    ok(doc, { type: 'parcel.upsert', parcel: parcel('p2', rect(40, 0, 80, 40)) });
    expect(applyCommand(doc, { type: 'parcel.upsert', parcel: parcel('p3', rect(20, 20, 60, 60)) }).ok).toBe(false);
    expect(applyCommand(doc, { type: 'parcel.upsert', parcel: parcel('p4', rect(0, 0, 40, 40)) }).ok).toBe(false);
    expect(polygonsOverlap(rect(0, 0, 10, 10), rect(10, 0, 20, 10))).toBe(false);
  });
});

describe('parcel compliance (warnings only)', () => {
  it('reports coverage, FAR, height, setback and use violations', () => {
    const doc = createEmptyDoc();
    const reg = { coverage: 0.3, far: 1, maxHeight: 20, setback: 4 };
    ok(doc, { type: 'parcel.upsert', parcel: { id: 'p', polygon: rect(0, 0, 40, 40), zone: 'residential', regulation: reg } });
    ok(doc, { type: 'building.place', building: { id: 'a', typeId: 'apartment', pos: { x: 20, z: 20 }, rotation: 0 } });
    ok(doc, { type: 'building.place', building: { id: 'f', typeId: 'factory', pos: { x: 20, z: 6 }, rotation: 0 } });
    const c = parcelCompliance(doc, doc.parcels.p!);
    expect(c.buildingIds).toEqual(['a', 'f']);
    const kinds = c.violations.map((v) => `${v.kind}:${v.buildingId ?? ''}`).sort();
    expect(kinds).toEqual(['coverage:', 'far:', 'height:a', 'outside:f', 'use:f']);
  });
});

describe('designStats', () => {
  it('starts with a demand for housing in an empty city', () => {
    const s = designStats(createEmptyDoc());
    expect(s.population).toBe(0);
    expect(s.demand.residential).toBeGreaterThan(0);
  });

  it('counts residents, jobs, solar and violations', () => {
    const doc = createEmptyDoc();
    ok(doc, { type: 'building.place', building: { id: 'm', typeId: 'mixed-use', pos: { x: 0, z: 0 }, rotation: 0 } });
    ok(doc, { type: 'building.place', building: { id: 'o', typeId: 'smart-office', pos: { x: 100, z: 0 }, rotation: 0 } });
    const s = designStats(doc);
    expect(s.population).toBe(Math.round((24 * 18 * 22) / 30));
    expect(s.jobsByUse.office).toBe(Math.round((30 * 30 * 24) / 20));
    expect(s.solarProduction).toBeGreaterThan(0);
    expect(s.co2).toBeGreaterThan(0);
    expect(s.evChargers).toBe(70);
  });
});

describe('older documents', () => {
  it('normalizeDoc adds parcels and docToCommands replays them', () => {
    const old = createEmptyDoc() as unknown as Record<string, unknown>;
    delete old.parcels;
    const doc = normalizeDoc(old as unknown as CityDoc);
    expect(doc.parcels).toEqual({});
    ok(doc, { type: 'parcel.upsert', parcel: { id: 'p', polygon: rect(0, 0, 20, 20), zone: 'green', regulation: DEFAULT_REGULATIONS.green } });
    const copy = createEmptyDoc();
    for (const c of docToCommands(doc)) ok(copy, c);
    expect(copy.parcels.p).toEqual(doc.parcels.p);
  });
});

describe('Sol review of Phase 2a shared (2026-10-23)', () => {
  const rect2 = rect;

  it('#1 rejects distant roads cheaply even with many stacked volumes', () => {
    const doc = createEmptyDoc();
    const cmds: Command[] = [];
    for (let i = 0; i < 100; i++) {
      cmds.push({ type: 'node.add', node: { id: `a${i}`, pos: { x: -1900, z: -1900 + i * 10 } } });
      cmds.push({ type: 'node.add', node: { id: `b${i}`, pos: { x: 1900, z: -1900 + i * 10 } } });
      cmds.push({ type: 'segment.add', segment: { id: `s${i}`, a: `a${i}`, b: `b${i}`, roadTypeId: 'road-2', control: { x: 0, z: -1500 + i * 10 } } });
    }
    ok(doc, { type: 'batch', commands: cmds });
    const bt = cloneJson(doc.buildingTypes.house!);
    bt.id = 'stack16';
    bt.parts = Array.from({ length: 16 }, (_, i) => ({ ...bt.parts[0]!, roof: 'flat' as const, width: 10, depth: 10, floors: 1, floorHeight: 3, baseHeight: 3 * i }));
    ok(doc, { type: 'buildingType.upsert', buildingType: bt });
    const t0 = Date.now();
    ok(doc, { type: 'building.place', building: { id: 'far', typeId: 'stack16', pos: { x: 0, z: 1000 }, rotation: 0 } });
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('#2 detects overlap of axis-aligned polygons sharing collinear edges', () => {
    expect(polygonsOverlap(rect2(0, 0, 40, 40), rect2(32, 0, 72, 40))).toBe(true);
    expect(polygonsOverlap(rect2(32, 0, 72, 40), rect2(0, 0, 40, 40))).toBe(true);
    expect(polygonsOverlap(rect2(0, 0, 40, 40), [...rect2(32, 0, 72, 40)].reverse())).toBe(true);
    expect(polygonsOverlap(rect2(0, 0, 40, 40), rect2(40, 0, 80, 40))).toBe(false);
  });

  it('#3 replays commands accepted under older rules in trusted mode', () => {
    const doc = createEmptyDoc();
    road(doc, -100, 0, 100, 0);
    const onRoad: Command = { type: 'building.place', building: { id: 'old', typeId: 'house', pos: { x: 0, z: 1 }, rotation: 0 } };
    expect(applyCommand(doc, onRoad).ok).toBe(false);
    ok2(doc, onRoad);
    expect(doc.buildings.old).toBeDefined();
  });

  it('#3 migrates the v1 city-hall preset so it validates', () => {
    const v1 = createEmptyDoc() as CityDoc;
    v1.version = 1;
    v1.buildingTypes['city-hall']!.parts[1]!.offset.z = 14;
    delete v1.buildingTypes['city-hall']!.rev;
    const doc = normalizeDoc(v1);
    expect(doc.version).toBe(2);
    expect(doc.buildingTypes['city-hall']!.rev).toBe(1);
    const fresh = createEmptyDoc();
    ok(fresh, { type: 'buildingType.upsert', buildingType: { ...doc.buildingTypes['city-hall']!, id: 'hall2' } });
  });

  it('#4 refuses a node move that lays one road along another', () => {
    const doc = createEmptyDoc();
    ok(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
        { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
        { type: 'node.add', node: { id: 'c', pos: { x: 0, z: 100 } } },
        { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
        { type: 'segment.add', segment: { id: 'ac', a: 'a', b: 'c', roadTypeId: 'road-2' } },
      ],
    });
    expect(applyCommand(doc, { type: 'node.move', id: 'c', pos: { x: 50, z: 0 } }).ok).toBe(false);
  });

  it('#5 keeps the whole footprint inside the map', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, { type: 'building.place', building: { id: 'edge', typeId: 'house', pos: { x: 2000, z: 2000 }, rotation: 0 } }).ok).toBe(false);
  });

  it('#6 expectedRev 0 only creates, never overwrites', () => {
    const doc = createEmptyDoc();
    const house = cloneJson(doc.buildingTypes.house!);
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: { ...house, name: 'x' }, expectedRev: 0 }).ok).toBe(false);
    ok(doc, { type: 'buildingType.upsert', buildingType: { ...house, name: 'x' }, expectedRev: 1 });
    expect(doc.buildingTypes.house!.rev).toBe(2);
  });

  it('#7 flags a building crossing the notch of a concave parcel', () => {
    const doc = createEmptyDoc();
    const u = [
      { x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 60, z: 100 },
      { x: 60, z: 40 }, { x: 40, z: 40 }, { x: 40, z: 100 }, { x: 0, z: 100 },
    ];
    ok(doc, { type: 'parcel.upsert', parcel: { id: 'u', polygon: u, zone: 'commercial', regulation: { coverage: 1, far: 20, maxHeight: 999, setback: 3 } } });
    const bar = cloneJson(doc.buildingTypes.shop!);
    bar.id = 'bar';
    bar.parts[0]!.width = 80;
    bar.parts[0]!.depth = 10;
    ok(doc, { type: 'buildingType.upsert', buildingType: bar });
    ok(doc, { type: 'building.place', building: { id: 'b', typeId: 'bar', pos: { x: 50, z: 80 }, rotation: 0 } });
    // Anchor (50,80) sits in the notch, so check membership by moving the anchor inside the left arm.
    ok(doc, { type: 'building.move', id: 'b', pos: { x: 30, z: 80 }, rotation: 0 });
    bar.parts[0]!.offset = { x: 20, z: 0 };
    ok(doc, { type: 'buildingType.upsert', buildingType: bar, expectedRev: 1 });
    const kinds = parcelCompliance(doc, doc.parcels.u!).violations.map((v) => v.kind);
    expect(kinds).toContain('outside');
  });

  it('#8 counts the exposed roof from real plan overlap', () => {
    const base = cloneJson(SMART_CITY_PRESETS.find((p) => p.id === 'data-center')!);
    const two = (dx: number): BuildingType => ({
      ...base,
      parts: [
        { ...base.parts[0]!, width: 10, depth: 10, floors: 1, floorHeight: 3, baseHeight: 0, offset: { x: 0, z: 0 } },
        { ...base.parts[0]!, width: 10, depth: 10, floors: 1, floorHeight: 3, baseHeight: 3, offset: { x: dx, z: 0 } },
      ],
    });
    expect(buildingMetrics(two(0)).roofArea).toBeCloseTo(100);
    expect(buildingMetrics(two(30)).roofArea).toBeCloseTo(200);
    expect(buildingMetrics(two(5)).roofArea).toBeCloseTo(150);
  });
});

function ok2(doc: CityDoc, cmd: Command): void {
  expect(applyCommand(doc, cmd, { trusted: true })).toEqual({ ok: true });
}

describe('Sol re-check of Phase 2a shared (2026-10-23)', () => {
  it('B: leaves v2 designs that resemble the v1 preset untouched', () => {
    const doc = createEmptyDoc();
    doc.buildingTypes['city-hall']!.parts[0]!.depth = 12;
    doc.buildingTypes['city-hall']!.parts[1]!.offset.z = 14;
    normalizeDoc(doc);
    expect(doc.buildingTypes['city-hall']!.parts[1]!.offset.z).toBe(14);
  });

  it('C: refuses even a short collinear overlap after a node move', () => {
    const doc = createEmptyDoc();
    road(doc, 0, 0, 100, 0, 'p');
    road(doc, 99.5, 100, 200, 0, 'q');
    expect(applyCommand(doc, { type: 'node.move', id: 'qa', pos: { x: 99.5, z: 0 } }).ok).toBe(false);
  });

  it('D: stays fast for a building inside the hull of long curves but clear of them', () => {
    const doc = createEmptyDoc();
    const cmds: Command[] = [];
    for (let i = 0; i < 100; i++) {
      cmds.push({ type: 'node.add', node: { id: `a${i}`, pos: { x: -1900, z: -1900 + i } } });
      cmds.push({ type: 'node.add', node: { id: `b${i}`, pos: { x: 1900, z: -1900 + i } } });
      cmds.push({ type: 'segment.add', segment: { id: `s${i}`, a: `a${i}`, b: `b${i}`, roadTypeId: 'road-2', control: { x: 0, z: -1500 + i } } });
    }
    ok(doc, { type: 'batch', commands: cmds });
    const bt = cloneJson(doc.buildingTypes.house!);
    bt.id = 'varied16';
    bt.parts = Array.from({ length: 16 }, (_, i) => ({ ...bt.parts[0]!, roof: 'flat' as const, width: 10 + i / 100, depth: 10, floors: 1, floorHeight: 3, baseHeight: 3 * i }));
    ok(doc, { type: 'buildingType.upsert', buildingType: bt });
    const t0 = Date.now();
    ok(doc, { type: 'building.place', building: { id: 'mid', typeId: 'varied16', pos: { x: 0, z: -1550 }, rotation: 0 } });
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
