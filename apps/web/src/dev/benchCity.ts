// Benchmark city for performance measurement (ADR 0013 §7; development and e2e only, never shipped
// in a production build). Deterministic: the same options always give the same doc. A 23 × 23 road
// grid (~1,000 segments, avenues every 4th line) with ~2,000 buildings of many designs along the
// frontages: towers downtown, apartments and shops around them, houses and factories outside, a few
// park lots. Every item goes through applyCommand, so the doc obeys the same rules as an edited city.

import {
  applyCommand,
  bounds,
  buildingFootprints,
  createEmptyDoc,
  hash01,
  roadHalfWidth,
  type Bounds,
  type CityDoc,
  type Command,
  type Vec2,
} from '@smartcity/shared';

export interface BenchOptions {
  /** Nodes per grid side (segments = 2·n·(n−1)). */
  grid?: number;
  /** Block size, meters (road centerline to centerline). */
  spacing?: number;
  /** Buildings to place (stops early if the frontages run out). */
  buildings?: number;
  trafficDensity?: number;
  seed?: number;
  /** Center of the grid (default the origin). */
  offset?: Vec2;
}

const DOWNTOWN = ['office-tower', 'smart-office', 'mixed-use', 'eco-tower', 'apartment', 'shop'];
const MIDTOWN = ['apartment', 'shop', 'mixed-use', 'house', 'apartment', 'shop', 'school', 'hospital'];
const SUBURB = ['house', 'house', 'shop', 'house', 'apartment', 'vertical-farm'];
const INDUSTRY = ['factory', 'factory', 'data-center', 'shop'];

function pick(list: readonly string[], doc: CityDoc, h: number): string {
  for (let k = 0; k < list.length; k++) {
    const id = list[(Math.floor(h * list.length) + k) % list.length]!;
    if (doc.buildingTypes[id]) return id;
  }
  return 'house';
}

const overlaps = (a: Bounds, b: Bounds, m: number): boolean => a.minX - m < b.maxX && b.minX - m < a.maxX && a.minZ - m < b.maxZ && b.minZ - m < a.maxZ;

export function createBenchCity(opts: BenchOptions = {}): CityDoc {
  const n = opts.grid ?? 23;
  const spacing = opts.spacing ?? 120;
  const target = opts.buildings ?? 2000;
  const seed = opts.seed ?? 7;
  const doc = createEmptyDoc('성능 기준 도시', seed);
  doc.meta.trafficDensity = opts.trafficDensity ?? 2;
  const apply = (cmd: Command): boolean => applyCommand(doc, cmd).ok;
  const half = ((n - 1) * spacing) / 2;
  const mid = (n - 1) / 2;
  const ox = opts.offset?.x ?? 0;
  const oz = opts.offset?.z ?? 0;
  const pos = (i: number): number => i * spacing - half;
  const lineType = (i: number): string => (i === Math.round(mid) ? 'road-6' : i % 4 === 0 ? 'road-4' : 'road-2');

  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) apply({ type: 'node.add', node: { id: `n${i}_${j}`, pos: { x: ox + pos(i), z: oz + pos(j) } } });
  const segs: { id: string; a: Vec2; b: Vec2; type: string }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) {
        const s = { id: `sx${i}_${j}`, a: { x: ox + pos(i), z: oz + pos(j) }, b: { x: ox + pos(i + 1), z: oz + pos(j) }, type: lineType(j) };
        if (apply({ type: 'segment.add', segment: { id: s.id, a: `n${i}_${j}`, b: `n${i + 1}_${j}`, roadTypeId: s.type } })) segs.push(s);
      }
      if (j + 1 < n) {
        const s = { id: `sz${i}_${j}`, a: { x: ox + pos(i), z: oz + pos(j) }, b: { x: ox + pos(i), z: oz + pos(j + 1) }, type: lineType(i) };
        if (apply({ type: 'segment.add', segment: { id: s.id, a: `n${i}_${j}`, b: `n${i}_${j + 1}`, roadTypeId: s.type } })) segs.push(s);
      }
    }
  }

  // Park lots on a few blocks (green zone: grass, no buildings).
  const parks = new Set<string>();
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j + 1 < n; j++) {
      if (hash01(seed, 1, `park|${i}|${j}`) > 0.06) continue;
      const inset = 14;
      const x0 = ox + pos(i) + inset;
      const z0 = oz + pos(j) + inset;
      const x1 = ox + pos(i + 1) - inset;
      const z1 = oz + pos(j + 1) - inset;
      const polygon = [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
      if (apply({ type: 'parcel.upsert', parcel: { id: `park${i}_${j}`, polygon, zone: 'green', regulation: { coverage: 0.2, far: 0.2, maxHeight: 12, setback: 0 } } })) parks.add(`${i}_${j}`);
    }
  }
  const inPark = (p: Vec2): boolean => parks.has(`${Math.floor((p.x - ox + half) / spacing)}_${Math.floor((p.z - oz + half) / spacing)}`);

  // Candidate frontage slots: three per segment side, shuffled deterministically.
  const slots: { seg: (typeof segs)[number]; t: number; side: 1 | -1; h: number }[] = [];
  for (const seg of segs) for (const t of [0.3, 0.5, 0.7]) for (const side of [1, -1] as const) slots.push({ seg, t, side, h: hash01(seed, 2, `${seg.id}|${t}|${side}`) });
  slots.sort((a, b) => a.h - b.h);

  const placed: Bounds[] = [];
  const cell = 64;
  const grid = new Map<string, number[]>();
  const cellsOf = (b: Bounds): string[] => {
    const out: string[] = [];
    for (let x = Math.floor(b.minX / cell); x <= Math.floor(b.maxX / cell); x++) for (let z = Math.floor(b.minZ / cell); z <= Math.floor(b.maxZ / cell); z++) out.push(`${x},${z}`);
    return out;
  };
  let count = 0;
  for (const s of slots) {
    if (count >= target) break;
    const { seg, t, side } = s;
    const rt = doc.roadTypes[seg.type]!;
    const dx = seg.b.x - seg.a.x;
    const dz = seg.b.z - seg.a.z;
    const L = Math.hypot(dx, dz);
    const nx = (-dz / L) * side;
    const nz = (dx / L) * side;
    const p = { x: seg.a.x + dx * t, z: seg.a.z + dz * t };
    const r = Math.hypot(p.x - ox, p.z - oz);
    const industrial = p.x - ox > half * 0.45 && p.z - oz > half * 0.45;
    const list = industrial ? INDUSTRY : r < 330 ? DOWNTOWN : r < 820 ? MIDTOWN : SUBURB;
    const typeId = pick(list, doc, hash01(seed, 3, `type|${seg.id}|${t}|${side}`));
    const type = doc.buildingTypes[typeId]!;
    // Front (+Z local) faces the road: rotation turns +Z into −normal.
    const rotation = Math.atan2(-nx, -nz);
    const local = bounds(buildingFootprints({ pos: { x: 0, z: 0 }, rotation: 0 }, type).flat());
    const off = roadHalfWidth(rt) + local.maxZ + 0.6;
    const at = { x: p.x + nx * off, z: p.z + nz * off };
    if (inPark(at)) continue;
    const box = bounds(buildingFootprints({ pos: at, rotation }, type).flat());
    const keys = cellsOf(box);
    if (keys.some((k) => (grid.get(k) ?? []).some((i) => overlaps(placed[i]!, box, 1.5)))) continue;
    if (!apply({ type: 'building.place', building: { id: `b${count}`, typeId, pos: at, rotation } })) continue;
    placed.push(box);
    for (const k of keys) {
      const list = grid.get(k);
      if (list) list.push(placed.length - 1);
      else grid.set(k, [placed.length - 1]);
    }
    count++;
  }
  return doc;
}
