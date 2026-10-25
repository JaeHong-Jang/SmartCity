import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  buildingMetrics,
  cloneJson,
  createEmptyDoc,
  DOC_VERSION,
  docToCommands,
  growthStep,
  GROWTH_PRESETS,
  lotsAlongSegment,
  lotsToCommand,
  normalizeDoc,
  partOutline,
  type BuildingType,
  type CityDoc,
  type Command,
} from './index.js';

function ok(doc: CityDoc, cmd: Command): void {
  expect(applyCommand(doc, cmd)).toEqual({ ok: true });
}

const BASES = ['grow-res-1', 'grow-res-2', 'grow-com-1', 'grow-com-2', 'grow-off-1', 'grow-off-2'];
const byId = (id: string): BuildingType => GROWTH_PRESETS.find((t) => t.id === id)!;
const variantsOf = (base: string): BuildingType[] => GROWTH_PRESETS.filter((t) => t.id.startsWith(`${base}`) && t.id !== base && /^[a-z]$/.test(t.id.slice(base.length)));
const SETBACK = { residential: 3, commercial: 2, office: 3 } as const;

function bbox(t: BuildingType): { w: number; d: number } {
  const pts = t.parts.flatMap(partOutline);
  const xs = pts.map((p) => p.x);
  const zs = pts.map((p) => p.z);
  return { w: Math.max(...xs) - Math.min(...xs), d: Math.max(...zs) - Math.min(...zs) };
}

/** Which of the lot sizes growth lays out (16/24 m wide, 16..64 m deep) a design fits, as growth.ts decides. */
function fitSet(t: BuildingType): string {
  const { w, d } = bbox(t);
  const s = SETBACK[t.zone as keyof typeof SETBACK];
  const out: string[] = [];
  for (const lw of [16, 24]) for (const ld of [16, 32, 48, 64]) if (w <= lw - 2 * s && d <= ld - 2 * s) out.push(`${lw}x${ld}`);
  return out.join(',');
}

describe('growth preset variants', () => {
  it('has at least 3 variants for each of the 6 base presets (24+ designs, unique ids)', () => {
    expect(new Set(GROWTH_PRESETS.map((t) => t.id)).size).toBe(GROWTH_PRESETS.length);
    expect(GROWTH_PRESETS.length).toBeGreaterThanOrEqual(24);
    for (const b of BASES) expect(variantsOf(b).length).toBeGreaterThanOrEqual(3);
    expect(GROWTH_PRESETS.length).toBe(BASES.length + BASES.reduce((n, b) => n + variantsOf(b).length, 0));
  });

  it('every variant keeps the base zone and lot class, floor area within ±15% and a distinct look', () => {
    for (const b of BASES) {
      const base = byId(b);
      const baseArea = buildingMetrics(base).grossFloorArea;
      const looks = new Set([JSON.stringify(base.parts)]);
      for (const v of variantsOf(b)) {
        expect(v.zone, v.id).toBe(base.zone);
        expect(v.growth, v.id).toEqual({ level: 1 });
        expect(fitSet(v), v.id).toBe(fitSet(base));
        const ratio = buildingMetrics(v).grossFloorArea / baseArea;
        expect(ratio, v.id).toBeGreaterThanOrEqual(0.85);
        expect(ratio, v.id).toBeLessThanOrEqual(1.15);
        const look = JSON.stringify(v.parts);
        expect(looks.has(look), v.id).toBe(false);
        looks.add(look);
      }
    }
  });

  it('are valid designs that a city accepts', () => {
    const doc = createEmptyDoc();
    for (const t of GROWTH_PRESETS) ok(doc, { type: 'buildingType.upsert', buildingType: cloneJson(t) });
  });
});

describe('v4 → v5 migration', () => {
  const variantIds = GROWTH_PRESETS.map((t) => t.id).filter((id) => !BASES.includes(id));

  function v4(): CityDoc {
    const doc = createEmptyDoc();
    for (const id of variantIds) delete doc.buildingTypes[id];
    doc.version = 4;
    return doc;
  }

  it('adds only the missing presets, keeps edited ones, and is idempotent', () => {
    const doc = v4();
    doc.buildingTypes['grow-res-1b'] = { ...cloneJson(byId('grow-res-1b')), name: '내 설계', rev: 7 };
    normalizeDoc(doc);
    expect(doc.version).toBe(DOC_VERSION);
    for (const t of GROWTH_PRESETS) expect(doc.buildingTypes[t.id], t.id).toBeDefined();
    expect(doc.buildingTypes['grow-res-1b']).toMatchObject({ name: '내 설계', rev: 7 });
    expect(doc.buildingTypes['grow-com-2c']).toMatchObject({ growth: { level: 1 }, rev: 1 });
    const once = JSON.stringify(doc);
    normalizeDoc(doc);
    expect(JSON.stringify(doc)).toBe(once);
  });

  it('a v4 doc keeps a deleted base preset deleted, and a v3 doc ends with all of them', () => {
    const doc = v4();
    delete doc.buildingTypes['grow-res-1'];
    normalizeDoc(doc);
    expect(doc.buildingTypes['grow-res-1']).toBeUndefined();
    expect(doc.buildingTypes['grow-res-1b']).toBeDefined();

    const v3 = createEmptyDoc();
    for (const t of GROWTH_PRESETS) delete v3.buildingTypes[t.id];
    v3.version = 3;
    normalizeDoc(v3);
    expect(GROWTH_PRESETS.filter((t) => v3.buildingTypes[t.id]).length).toBe(GROWTH_PRESETS.length);
  });

  it('a v5 doc does not get a deleted preset back', () => {
    const doc = createEmptyDoc();
    ok(doc, { type: 'buildingType.remove', id: 'grow-off-2d' });
    normalizeDoc(doc);
    expect(doc.buildingTypes['grow-off-2d']).toBeUndefined();
  });

  it('new cities include everything and the command round trip keeps the designs', () => {
    const doc = createEmptyDoc();
    expect(doc.version).toBe(DOC_VERSION);
    for (const t of GROWTH_PRESETS) expect(doc.buildingTypes[t.id]).toMatchObject({ growth: { level: 1 } });
    const replay = createEmptyDoc();
    for (const cmd of docToCommands(doc)) ok(replay, cmd);
    for (const t of GROWTH_PRESETS) expect(replay.buildingTypes[t.id]!.parts).toEqual(doc.buildingTypes[t.id]!.parts);
  });
});

describe('variant selection by growthStep', () => {
  function city(depth: 1 | 2 | 3 | 4): CityDoc {
    const doc = createEmptyDoc();
    ok(doc, { type: 'node.add', node: { id: 'a', pos: { x: -100, z: 0 } } });
    ok(doc, { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } });
    ok(doc, { type: 'segment.add', segment: { id: 'S1', a: 'a', b: 'b', roadTypeId: 'road-2' } });
    for (const side of ['left', 'right'] as const) {
      for (const zone of ['residential', 'commercial', 'office'] as const) {
        const lots = lotsAlongSegment(doc, 'S1', side, zone === 'residential' ? 0 : zone === 'commercial' ? 0.34 : 0.67, zone === 'residential' ? 0.33 : zone === 'commercial' ? 0.66 : 1, depth, zone, `${zone[0]}${side[0]}`);
        const cmd = lotsToCommand(lots);
        if (cmd) ok(doc, cmd);
      }
    }
    return doc;
  }

  function tally(doc: CityDoc, epochs: number): Map<string, number> {
    const counts = new Map<string, number>();
    for (let e = 0; e < epochs; e++) {
      for (const c of growthStep(doc, e, 50)) {
        if (c.type !== 'building.place') continue;
        counts.set(c.building.typeId, (counts.get(c.building.typeId) ?? 0) + 1);
      }
    }
    return counts;
  }

  it('is deterministic per lot and epoch', () => {
    const doc = city(4);
    expect(JSON.stringify(growthStep(doc, 5, 50))).toBe(JSON.stringify(growthStep(cloneJson(doc), 5, 50)));
  });

  it('spreads small-lot growth over every variant of the small class', () => {
    const counts = tally(city(2), 300);
    for (const base of ['grow-res-1', 'grow-com-1']) {
      const ids = [base, ...variantsOf(base).map((t) => t.id)];
      const total = ids.reduce((n, id) => n + (counts.get(id) ?? 0), 0);
      for (const id of ids) {
        expect(counts.get(id) ?? 0, id).toBeGreaterThan(0);
        expect((counts.get(id) ?? 0) / total, id).toBeLessThan(0.5);
      }
    }
  });

  it('on roomy lots every design of each zone shows up without one dominating', () => {
    const counts = tally(city(4), 300);
    for (const zone of ['residential', 'commercial', 'office']) {
      const ids = GROWTH_PRESETS.filter((t) => t.zone === zone).map((t) => t.id);
      const total = ids.reduce((n, id) => n + (counts.get(id) ?? 0), 0);
      expect(total).toBeGreaterThan(200);
      for (const id of ids) {
        expect(counts.get(id) ?? 0, id).toBeGreaterThan(0);
        expect((counts.get(id) ?? 0) / total, id).toBeLessThan(0.5);
      }
    }
  });
});
