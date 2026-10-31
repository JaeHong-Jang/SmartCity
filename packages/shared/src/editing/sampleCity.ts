// "현대 신도시 샘플" (ADR 0014 §7): a planned Korean new town as ONE command batch for a fresh room — at most
// LIMITS.batchSize commands and well under the message limit, so it lands atomically (no growth or other edit
// in between; its first command requires the room to be still empty when the server applies it, the second
// switches automatic growth off). Pure and deterministic: the same seed
// always gives the same batch, every coordinate is computed here (no doc is read but the preset designs).
//
// Plan, 1.26 km square (x = east–west, +z = south, the side the sun is on):
// - 7 × 7 road lines 210 m apart: the central cross is the 8-lane median boulevard (중앙녹지 대로), ±420 m the
//   6-lane median roads, ±210 m and the outer ring 4-lane roads; two 2-lane shopping streets (상업 가로) cut the
//   downtown blocks east–west at z = ±105.
// - Downtown (the four blocks around the center): glass office podiums, office towers and mixed-use towers
//   (주상복합) facing the boulevards, low-rise shops on both sides of the shopping streets; business blocks
//   north and south of it along the north–south boulevard, with a lawn plaza.
// - Apartment complexes (단지) on most other blocks, every building facing south in parallel rows: 25-floor
//   slabs (판상) or 35-floor cross towers (타워), some swapped by the seed. The complexes have no inner roads: a
//   building whose center is farther than ACCESS m from the block's roads is left out and its place becomes
//   lawn, so every building reaches a sidewalk and the vehicle demand (both use 80 m). Lawn lots between rows.
// - Six park blocks, three schools, a school with the fire station and one with the hospital (facility presets).
// - Two bus lines on the boulevards, each running out on one side and back on the other.
// Sized to stay within the P6 benchmark city's load (population, jobs, roads, lanes; see the tests).

import type { Command } from '../commands.js';
import { createEmptyDoc } from '../defaults.js';
import { bounds } from '../geometry.js';
import type { BusStop, BuildingType, CityDoc, Parcel, TravelDir } from '../model.js';
import { hash01 } from '../rng.js';
import { roadHalfWidth } from '../roads.js';
import { buildingFootprints } from './buildings.js';

export const SAMPLE_CITY_SEED = 28;
export const SAMPLE_CITY_NAME = '현대 신도시 샘플';

/** Road lines (centerline coordinate), shared by both axes. */
const LINES = [-630, -420, -210, 0, 210, 420, 630];
/** Shopping streets: z of the 2-lane east–west streets inside downtown, and their x extent. */
const SHOP_STREETS = [-105, 105];
const SHOP_SPAN = [-210, 210] as const;
/** Building front kept back from the sidewalk edge, m. */
const SETBACK = 4;
/** Max distance (m) from a building's center to a road centerline of its block (sim access is 80 m). */
const ACCESS = 72;

const lineRoad = (c: number): string => (c === 0 ? 'road-8-median' : Math.abs(c) === 420 ? 'road-6-median' : 'road-4');

type Kind = 'downtown' | 'business' | 'slab' | 'tower' | 'park' | 'school' | 'school-fire' | 'school-hospital';

/**
 * Land use of block (i, j): x between LINES[i] and LINES[i + 1], z between LINES[j] and LINES[j + 1] (j = 0 is
 * the north edge). D downtown, B business, s slab complex, t tower complex, P park, E school, F school + fire
 * station, H school + hospital. The seed swaps some slab and tower complexes.
 */
const PLAN = ['PstEtP', 'tEBBss', 'sPDDHt', 'tFDDPs', 'ssBBEt', 'PtstsP'];
const KIND: Record<string, Kind> = { D: 'downtown', B: 'business', s: 'slab', t: 'tower', P: 'park', E: 'school', F: 'school-fire', H: 'school-hospital' };

function blockKind(i: number, j: number, seed: number): Kind {
  const kind = KIND[PLAN[j]![i]!]!;
  if ((kind === 'slab' || kind === 'tower') && hash01(seed, 1, `block|${i}|${j}`) < 0.25) return kind === 'slab' ? 'tower' : 'slab';
  return kind;
}

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** A design with a rotation and its footprint box relative to the building position. */
interface Item {
  typeId: string;
  rotation: number;
  box: Rect;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

export interface SampleCityPlan {
  /** The whole city: one `batch` command (growth off first, then roads, buildings, lots, transit). */
  batch: Extract<Command, { type: 'batch' }>;
}

/**
 * Build the sample new town. `types` are the designs it may use (default: a new city's presets); the batch
 * expects the default road types and presets of a new room.
 */
export function sampleCityPlan(seed: number = SAMPLE_CITY_SEED, types: CityDoc['buildingTypes'] = createEmptyDoc().buildingTypes): SampleCityPlan {
  // The room must still be empty when the server applies the batch (another user may have edited it after our
  // welcome); then automatic growth goes off before anything is built.
  const out: Command[] = [
    { type: 'doc.expect', empty: true },
    { type: 'meta.update', name: SAMPLE_CITY_NAME, growth: false },
  ];

  // ---------- roads ----------
  const lo = LINES[0]!;
  const hi = LINES[LINES.length - 1]!;
  // Lines: horizontal (constant z, west → east) and vertical (constant x, north → south).
  const lines: { horiz: boolean; c: number; from: number; to: number; road: string }[] = [];
  for (const c of LINES) lines.push({ horiz: true, c, from: lo, to: hi, road: lineRoad(c) });
  for (const c of LINES) lines.push({ horiz: false, c, from: lo, to: hi, road: lineRoad(c) });
  for (const c of SHOP_STREETS) lines.push({ horiz: true, c, from: SHOP_SPAN[0], to: SHOP_SPAN[1], road: 'road-2' });
  const nodeId = (x: number, z: number): string => `n${x}_${z}`;
  const nodes = new Set<string>();
  /** Segment ids along each line, in line order. */
  const segsOf: string[][] = [];
  let segN = 0;
  for (const l of lines) {
    const stops = new Set<number>();
    for (const o of lines) {
      if (o.horiz === l.horiz) continue;
      if (o.c >= l.from && o.c <= l.to && l.c >= o.from && l.c <= o.to) stops.add(o.c);
    }
    const along = [...stops].sort((a, b) => a - b);
    const segs: string[] = [];
    for (let k = 0; k < along.length; k++) {
      const p = along[k]!;
      const [x, z] = l.horiz ? [p, l.c] : [l.c, p];
      const id = nodeId(x, z);
      if (!nodes.has(id)) {
        nodes.add(id);
        out.push({ type: 'node.add', node: { id, pos: { x, z } } });
      }
      if (k === 0) continue;
      const q = along[k - 1]!;
      const a = l.horiz ? nodeId(q, l.c) : nodeId(l.c, q);
      const sid = `s${segN++}`;
      out.push({ type: 'segment.add', segment: { id: sid, a, b: id, roadTypeId: l.road } });
      segs.push(sid);
    }
    segsOf.push(segs);
  }
  const roadTypes = createEmptyDoc().roadTypes;
  // Road half width (sidewalk included) of the road on line coordinate c of the given axis, inside [lo, hi] of the other.
  const halfAt = (horiz: boolean, c: number, at: number): number => {
    for (const l of lines) if (l.horiz === horiz && l.c === c && at >= l.from && at <= l.to) return roadHalfWidth(roadTypes[l.road]!);
    return 0;
  };

  // ---------- buildings ----------
  const item = (typeId: string, rotation: number): Item => {
    const type: BuildingType | undefined = types[typeId];
    if (!type) throw new Error(`sample city: missing design ${typeId}`);
    const b = bounds(buildingFootprints({ pos: { x: 0, z: 0 }, rotation }, type).flat());
    return { typeId, rotation, box: { x0: b.minX, x1: b.maxX, z0: b.minZ, z1: b.maxZ } };
  };
  const placed: Rect[] = [];
  let bN = 0;
  const overlapsPlaced = (r: Rect): boolean => placed.some((p) => r.x0 < p.x1 + 2 && p.x0 < r.x1 + 2 && r.z0 < p.z1 + 2 && p.z0 < r.z1 + 2);
  const place = (it: Item, x: number, z: number): Rect | null => {
    const pos = { x: r2(x), z: r2(z) };
    const r = { x0: pos.x + it.box.x0, x1: pos.x + it.box.x1, z0: pos.z + it.box.z0, z1: pos.z + it.box.z1 };
    if (overlapsPlaced(r)) return null;
    placed.push(r);
    out.push({ type: 'building.place', building: { id: `b${bN++}`, typeId: it.typeId, pos, rotation: it.rotation } });
    return r;
  };
  let pN = 0;
  /**
   * Green lot over `r`. Landscaping lots of complexes, campuses and business blocks are `auto` (like zoning lots:
   * no permanent label, a road drawn later across one removes it; growth never builds on green); a park block's
   * lot is a plain user lot.
   */
  const lawn = (r: Rect, park = false): void => {
    if (r.x1 - r.x0 < 8 || r.z1 - r.z0 < 8) return;
    const polygon = [
      { x: r2(r.x0), z: r2(r.z0) },
      { x: r2(r.x1), z: r2(r.z0) },
      { x: r2(r.x1), z: r2(r.z1) },
      { x: r2(r.x0), z: r2(r.z1) },
    ];
    const parcel: Parcel = { id: `g${pN++}`, polygon, zone: 'green', regulation: { coverage: 0, far: 0, maxHeight: 0, setback: 0 }, ...(park ? {} : { auto: true as const }) };
    out.push({ type: 'parcel.upsert', parcel });
  };
  const width = (it: Item): number => it.box.x1 - it.box.x0;
  const depth = (it: Item): number => it.box.z1 - it.box.z0;
  /** Left x of each item spread over [x0, x1] with equal gaps (ends flush); null when the gap would be < minGap. */
  const spread = (row: Item[], x0: number, x1: number, minGap: number): number[] | null => {
    const used = row.reduce((s, it) => s + width(it), 0);
    const gap = row.length > 1 ? (x1 - x0 - used) / (row.length - 1) : 0;
    if (used > x1 - x0 || (row.length > 1 && gap < minGap)) return null;
    // A single item stands in the middle.
    let x = row.length === 1 ? (x0 + x1 - used) / 2 : x0;
    return row.map((it) => {
      const left = x;
      x += width(it) + gap;
      return left;
    });
  };

  for (let i = 0; i + 1 < LINES.length; i++) {
    for (let j = 0; j + 1 < LINES.length; j++) {
      const X0 = LINES[i]!;
      const X1 = LINES[i + 1]!;
      const Z0 = LINES[j]!;
      const Z1 = LINES[j + 1]!;
      const kind = blockKind(i, j, seed);
      const xm = (X0 + X1) / 2;
      // Sub-blocks: downtown blocks are cut by a shopping street.
      const cuts = kind === 'downtown' ? [Z0, ...SHOP_STREETS.filter((z) => z > Z0 && z < Z1), Z1] : [Z0, Z1];
      for (let k = 0; k + 1 < cuts.length; k++) {
        const z0 = cuts[k]!;
        const z1 = cuts[k + 1]!;
        const R: Rect = {
          x0: X0 + halfAt(false, X0, (z0 + z1) / 2) + SETBACK,
          x1: X1 - halfAt(false, X1, (z0 + z1) / 2) - SETBACK,
          z0: z0 + halfAt(true, z0, xm) + SETBACK,
          z1: z1 - halfAt(true, z1, xm) - SETBACK,
        };
        const reach = (x: number, z: number): boolean => Math.min(x - X0, X1 - x, z - z0, z1 - z) <= ACCESS;
        if (kind === 'park') {
          lawn(R, true);
        } else if (kind === 'downtown') {
          downtown(R, z0, z1, i);
        } else if (kind === 'business') {
          const north = frontage(R, 'n', ['glass-podium', 'smart-office', 'office-tower'], 10);
          const south = frontage(R, 's', ['smart-office', 'glass-podium', 'office-tower'], 10);
          // The plaza between the two rows is a lawn.
          lawn({ ...R, z0: north + 8, z1: south - 8 });
        } else if (kind === 'school' || kind === 'school-fire' || kind === 'school-hospital') {
          campus(R, kind, j);
        } else {
          complex(R, kind, reach, `${i}|${j}`);
        }
      }
    }
  }

  /** Rows facing the roads on the north (front −z) or south (front +z) edge of R; returns the row's far edge. */
  function frontage(R: Rect, edge: 'n' | 's', ids: string[], minGap: number): number {
    const rotation = edge === 's' ? 0 : Math.PI;
    let row: Item[] = [];
    for (const id of ids) {
      const next = [...row, item(id, rotation)];
      if (!spread(next, R.x0, R.x1, minGap)) break;
      row = next;
    }
    const xs = spread(row, R.x0, R.x1, minGap) ?? [];
    let far = edge === 's' ? R.z1 : R.z0;
    row.forEach((it, k) => {
      const x = xs[k]! - it.box.x0;
      const z = edge === 's' ? R.z1 - it.box.z1 : R.z0 - it.box.z0;
      const r = place(it, x, z);
      if (r) far = edge === 's' ? Math.min(far, r.z0) : Math.max(far, r.z1);
    });
    return far;
  }

  /** Downtown sub-block of block column i: offices on its outer road, shops on the shopping street. */
  function downtown(R: Rect, z0: number, z1: number, i: number): void {
    const west = i === 2;
    const podiums = west ? ['glass-podium', 'smart-office', 'mixed-tower'] : ['mixed-tower', 'office-tower', 'glass-podium'];
    const towers = west ? ['office-tower', 'smart-office', 'office-tower', 'smart-office'] : ['smart-office', 'office-tower', 'smart-office', 'office-tower'];
    const shops = Array.from({ length: 12 }, () => 'shop');
    const shopNorth = SHOP_STREETS.includes(z0);
    const shopSouth = SHOP_STREETS.includes(z1);
    // The edge on the boulevard (z = 0) gets the podiums, the outer 4-lane road the towers.
    const big = z0 === 0 || z1 === 0 ? podiums : towers;
    if (shopNorth) frontage(R, 'n', shops, 4);
    if (shopSouth) frontage(R, 's', shops, 4);
    if (!shopNorth) frontage(R, 'n', big, 10);
    if (!shopSouth) frontage(R, 's', big, 10);
  }

  /** A school (with the fire station or the hospital) on the side toward the center, the rest a park. */
  function campus(R: Rect, kind: Kind, j: number): void {
    const ids = kind === 'school-fire' ? ['school', 'svc-fire-station'] : kind === 'school-hospital' ? ['svc-hospital', 'school'] : ['school'];
    const edge = j < 3 ? 's' : 'n';
    const far = frontage(R, edge, ids, 24);
    lawn(edge === 's' ? { ...R, z1: far - 8 } : { ...R, z0: far + 8 });
  }

  /**
   * Apartment complex: parallel rows, every building facing south (front +z). The first row keeps its north
   * faces on the block edge, the last its south faces, inner rows are centered; a building out of reach of the
   * block's roads is left out. Lawn lots fill the gaps in a row and the space between rows.
   */
  function complex(R: Rect, kind: Kind, reach: (x: number, z: number) => boolean, key: string): void {
    const S = 'apt-slab-25';
    const T = 'apt-tower-35';
    const slab = kind === 'slab';
    // Row designs, the first that fits the width; rows about 0.9 × (slab height) and 0.6 × (tower height) apart.
    const alts = slab ? [[S, S, S], [S, T, S], [S, S]] : [[T, T, T], [T, T]];
    const minGap = slab ? 10 : 16;
    const minRowGap = slab ? 60 : 40;
    const pick = (list: string[][]): { row: Item[]; xs: number[] } => {
      for (const ids of list) {
        const row = ids.map((id) => item(id, 0));
        const xs = spread(row, R.x0, R.x1, minGap);
        if (xs) return { row, xs };
      }
      return { row: [], xs: [] };
    };
    const first = pick(alts);
    if (first.row.length === 0) return;
    // Band depth = depth of the row's first (end) building; as many rows as fit with minRowGap between them.
    const band = depth(first.row[0]!);
    const n = Math.max(1, Math.floor((R.z1 - R.z0 - band) / (band + minRowGap)) + 1);
    const rowGap = n > 1 ? (R.z1 - R.z0 - n * band) / (n - 1) : 0;
    // Seeded shift of the inner rows (± 4 m) so neighbouring complexes do not line up exactly.
    const shift = (hash01(seed, 2, `rows|${key}`) - 0.5) * 8;
    const kept: Rect[][] = [];
    for (let ri = 0; ri < n; ri++) {
      const inner = ri > 0 && ri < n - 1;
      const bz0 = n > 1 ? R.z0 + ri * (band + rowGap) + (inner ? shift : 0) : (R.z0 + R.z1 - band) / 2;
      const bz1 = bz0 + band;
      const got: Rect[] = [];
      first.row.forEach((it, c) => {
        const x = first.xs[c]! - it.box.x0;
        const z = ri === 0 && n > 1 ? bz0 - it.box.z0 : ri === n - 1 && n > 1 ? bz1 - it.box.z1 : (bz0 + bz1) / 2 - (it.box.z0 + it.box.z1) / 2;
        const rect = reach(x, z) ? place(it, x, z) : null;
        if (rect) got.push(rect);
      });
      // Lawn in the row's gaps wider than 20 m (left-out buildings, a two-slab row).
      const xs = [R.x0, ...got.flatMap((g) => [g.x0, g.x1]), R.x1];
      for (let g = 0; g + 1 < xs.length; g += 2) if (xs[g + 1]! - xs[g]! > 20) lawn({ x0: xs[g]! + (g === 0 ? 0 : 6), x1: xs[g + 1]! - (g + 2 === xs.length ? 0 : 6), z0: bz0, z1: bz1 });
      kept.push(got.length ? got : [{ x0: R.x0, x1: R.x1, z0: bz0, z1: bz1 }]);
    }
    // Lawn between the rows (clear of every building of both rows).
    for (let b = 0; b + 1 < kept.length; b++) {
      const z0 = Math.max(...kept[b]!.map((g) => g.z1)) + 3;
      const z1 = Math.min(...kept[b + 1]!.map((g) => g.z0)) - 3;
      lawn({ x0: R.x0, x1: R.x1, z0, z1 });
    }
  }

  // ---------- transit ----------
  // Line 1 on the east–west boulevard (z = 0), line 2 on the north–south one (x = 0): out on the forward
  // lanes (east / south), back on the backward lanes, one stop in the middle of every segment.
  const stops: BusStop[] = [];
  const lineStops = (horiz: boolean, prefix: string): string[] => {
    const li = lines.findIndex((l) => l.horiz === horiz && l.c === 0);
    const segs = segsOf[li]!;
    const ids: string[] = [];
    const add = (segmentId: string, dir: TravelDir): void => {
      const id = `${prefix}${ids.length}`;
      stops.push({ id, segmentId, t: 0.5, dir });
      ids.push(id);
    };
    for (const s of segs) add(s, 'forward');
    for (const s of [...segs].reverse()) add(s, 'backward');
    return ids;
  };
  const line1 = lineStops(true, 'a');
  const line2 = lineStops(false, 'c');
  for (const stop of stops) out.push({ type: 'busStop.add', stop });
  out.push({ type: 'busLine.upsert', line: { id: 'L1', name: '100 동서 대로선', color: '#2f9e62', stopIds: line1, vehicleTypeId: 'city-bus', buses: 6 } });
  out.push({ type: 'busLine.upsert', line: { id: 'L2', name: '200 남북 대로선', color: '#1f6fd1', stopIds: line2, vehicleTypeId: 'city-bus', buses: 6 } });

  return { batch: { type: 'batch', commands: out } };
}
