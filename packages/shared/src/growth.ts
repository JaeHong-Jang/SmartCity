// Automatic growth on zoned lots (ADR 0009 §4): a pure function of the document that proposes
// building.place commands. The server (GrowthDirector) and the offline LocalTransport both call it,
// so every change still goes through applyCommand and the command log (invariants 1 and 3).

import type { Command } from './commands.js';
import { buildingFootprints, buildingMetrics, partOutline } from './editing/buildings.js';
import {
  add,
  bounds,
  boundsOverlap,
  closestPointOnPolyline,
  dist,
  dot,
  normalize,
  pointInPolygon,
  polygonsOverlap,
  rightNormal,
  rotateY,
  sampleSegmentCurve,
  scale,
  sub,
  type Bounds,
  type Vec2,
} from './geometry.js';
import { cloneJson, type Building, type BuildingType, type CityDoc, type Parcel } from './model.js';
import { tryApplyCommand } from './apply.js';
import { parcelCompliance } from './planning.js';
import { hash01 } from './rng.js';
import { AREA_PER_JOB, AREA_PER_PERSON, WORKFORCE_SHARE } from './stats.js';

export interface Demand {
  residential: number;
  commercial: number;
  office: number;
  /** Reported for the UI; industrial growth is not supported in the MVP (never grown). */
  industrial: number;
}

/** A zone grows only while its demand is above this. */
export const GROWTH_THRESHOLD = 0.05;
/** Minimum demand of an empty city, so the first lots can start growing. */
export const BOOTSTRAP_DEMAND = 0.2;
/** Per-lot growth probability per step = demand × this (capped at 1). */
const GROWTH_RATE = 2;
/** Expensive verifications per step, as a multiple of maxUnits (lots that cannot be built keep failing). */
const ATTEMPTS_PER_UNIT = 6;
/** Extra clearance on top of the zone setback so float error never trips the compliance check. */
const SETBACK_MARGIN = 0.25;
/**
 * Denominator floor of every demand ratio (research 09 §3.2 d used 100; with 100 a small city stalls after a
 * few buildings, so 30 — game tuning, uncalibrated).
 */
const DEMAND_FLOOR = 30;
/** People keep moving in while there is room: a base residential pull so the feedback loop never settles at 0. */
const RESIDENTIAL_PULL = 0.15;
/** Share of the population that wants shops (research 09 §3.2 d; uncalibrated). */
const SHOPS_PER_RESIDENT = 0.15;

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/**
 * RCI demand in [-1, 1] from the document (research 09 §3.2 d). Same quantities as `designStats`
 * (population, jobs by use), but without its per-parcel compliance scan, which is O(parcels × buildings).
 */
export function demand(doc: CityDoc): Demand {
  const jobsBy = { commercial: 0, office: 0, industrial: 0, public: 0 };
  let residents = 0;
  const metrics = new Map<string, ReturnType<typeof buildingMetrics>>();
  for (const b of Object.values(doc.buildings)) {
    const type = doc.buildingTypes[b.typeId];
    if (!type) continue;
    let m = metrics.get(type.id);
    if (!m) metrics.set(type.id, (m = buildingMetrics(type)));
    residents += m.areaByUse.residential / AREA_PER_PERSON;
    for (const use of Object.keys(jobsBy) as (keyof typeof jobsBy)[]) jobsBy[use] += m.areaByUse[use] / AREA_PER_JOB[use];
  }
  const pop = Math.round(residents);
  const commercialJobs = Math.round(jobsBy.commercial);
  const jobs = commercialJobs + Math.round(jobsBy.office) + Math.round(jobsBy.industrial) + Math.round(jobsBy.public);
  const workers = pop * WORKFORCE_SHARE;
  const shops = pop * SHOPS_PER_RESIDENT;
  const out: Demand = {
    residential: clamp1(RESIDENTIAL_PULL + (jobs - workers) / Math.max(jobs, DEMAND_FLOOR)),
    commercial: clamp1((shops - commercialJobs) / Math.max(shops, DEMAND_FLOOR)),
    office: clamp1((workers - jobs) / Math.max(workers, DEMAND_FLOOR)),
    industrial: clamp1((workers - jobs) / Math.max(workers, DEMAND_FLOOR)),
  };
  if (pop === 0 && jobs === 0) {
    for (const k of Object.keys(out) as (keyof Demand)[]) out[k] = Math.max(out[k], BOOTSTRAP_DEMAND);
  }
  return out;
}

type GrowZone = 'residential' | 'commercial' | 'office';
const GROW_ZONES: GrowZone[] = ['residential', 'commercial', 'office'];

interface Indexed {
  anchor: Vec2;
  polys: Vec2[][];
  box: Bounds;
}

/** Uniform grid over building footprints so "is this lot empty" does not scan every building. */
class BuildingGrid {
  private static readonly CELL = 64;
  private cells = new Map<string, Indexed[]>();

  constructor(doc: CityDoc) {
    for (const b of Object.values(doc.buildings)) this.add(doc, b);
  }

  add(doc: CityDoc, b: Building): void {
    const type = doc.buildingTypes[b.typeId];
    const polys = type ? buildingFootprints(b, type) : [];
    const box = polys.length ? bounds(polys.flat()) : bounds([b.pos]);
    const e: Indexed = { anchor: b.pos, polys, box };
    this.forCells(box, (k) => {
      const list = this.cells.get(k);
      if (list) list.push(e);
      else this.cells.set(k, [e]);
    });
  }

  /** True if a building stands on the polygon (anchor inside or any footprint overlapping). */
  occupied(poly: readonly Vec2[]): boolean {
    const box = bounds(poly);
    let hit = false;
    this.forCells(box, (k) => {
      if (hit) return;
      for (const e of this.cells.get(k) ?? []) {
        if (!boundsOverlap(box, e.box)) continue;
        if (pointInPolygon(e.anchor, poly) || e.polys.some((q) => polygonsOverlap(q, poly))) {
          hit = true;
          return;
        }
      }
    });
    return hit;
  }

  private forCells(box: Bounds, fn: (key: string) => void): void {
    const c = BuildingGrid.CELL;
    for (let i = Math.floor(box.minX / c); i <= Math.floor(box.maxX / c); i++) {
      for (let j = Math.floor(box.minZ / c); j <= Math.floor(box.maxZ / c); j++) fn(`${i},${j}`);
    }
  }
}

interface DesignInfo {
  type: BuildingType;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function designInfo(type: BuildingType): DesignInfo {
  const pts = type.parts.flatMap(partOutline);
  const box = bounds(pts);
  return { type, minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ };
}

interface LotFrame {
  /** Middle of the edge facing the road. */
  front: Vec2;
  /** Unit vector from the front edge into the lot. */
  inward: Vec2;
  width: number;
  depth: number;
}

/** The polygon edge nearest to the frontage road is the front; null if the road is gone. */
function lotFrame(doc: CityDoc, lot: Parcel): LotFrame | null {
  const seg = lot.frontage && doc.segments[lot.frontage.segmentId];
  const a = seg && doc.nodes[seg.a];
  const b = seg && doc.nodes[seg.b];
  if (!seg || !a || !b) return null;
  const curve = sampleSegmentCurve(a.pos, b.pos, seg.control);
  const poly = lot.polygon;
  let best = -1;
  let bestD = Infinity;
  let bestMid: Vec2 = poly[0]!;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const mid = scale(add(p, q), 0.5);
    const d = closestPointOnPolyline(curve, mid).distance;
    if (d < bestD - 1e-9) {
      bestD = d;
      best = i;
      bestMid = mid;
    }
  }
  const p = poly[best]!;
  const q = poly[(best + 1) % poly.length]!;
  const width = dist(p, q);
  if (width < 1e-6) return null;
  let inward = rightNormal(normalize(sub(q, p)));
  let cx = 0;
  let cz = 0;
  for (const v of poly) {
    cx += v.x / poly.length;
    cz += v.z / poly.length;
  }
  if (dot(inward, sub({ x: cx, z: cz }, bestMid)) < 0) inward = scale(inward, -1);
  let depth = 0;
  for (const v of poly) depth = Math.max(depth, dot(sub(v, bestMid), inward));
  return { front: bestMid, inward, width, depth };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Anchor and rotation that put the design's front face `setback` inside the lot's front edge, centred. */
function placement(d: DesignInfo, frame: LotFrame, setback: number): { pos: Vec2; rotation: number } {
  // The design's front is local +z; it must look at the road, i.e. against `inward`.
  const rotation = Math.atan2(-frame.inward.x, -frame.inward.z);
  const xAxis = rotateY({ x: 1, z: 0 }, rotation);
  const centre = (d.minX + d.maxX) / 2;
  const pos = add(add(frame.front, scale(frame.inward, setback + d.maxZ)), scale(xAxis, -centre));
  return { pos: { x: round3(pos.x), z: round3(pos.z) }, rotation: round3(rotation) };
}

/**
 * Up to `maxUnits` independent building.place commands (auto: true) for empty auto lots whose zone is
 * in demand. Reads only the document; randomness is `hash01(meta.seed, epoch, lotId)`. Each unit is
 * verified on a copy of the document (including the lot's compliance) and applied sequentially there,
 * so the flat list applies cleanly in order to the real document. A lot whose frontage road was removed
 * is skipped (it keeps existing as a plain parcel).
 */
export function growthStep(doc: CityDoc, epoch: number, maxUnits = 4): Command[] {
  if (doc.meta.growth === false) return [];
  const dem = demand(doc);
  const designs = new Map<GrowZone, DesignInfo[]>();
  for (const zone of GROW_ZONES) {
    if (dem[zone] <= GROWTH_THRESHOLD) continue;
    const list = Object.values(doc.buildingTypes)
      .filter((t) => t.growth && t.zone === zone)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(designInfo);
    if (list.length) designs.set(zone, list);
  }
  if (designs.size === 0) return [];

  const lots = Object.values(doc.parcels)
    .filter((p) => p.auto && p.frontage && designs.has(p.zone as GrowZone) && doc.segments[p.frontage.segmentId])
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (lots.length === 0) return [];

  const seed = doc.meta.seed;
  const grid = new BuildingGrid(doc);
  let work: CityDoc | null = null;
  const out: Command[] = [];
  let attempts = 0;
  // Rotate the start so low ids do not always win; lots are still visited in id order.
  const first = Math.floor(hash01(seed, epoch, '#start') * lots.length);
  for (let k = 0; k < lots.length && out.length < maxUnits && attempts < maxUnits * ATTEMPTS_PER_UNIT; k++) {
    const lot = lots[(first + k) % lots.length]!;
    const zone = lot.zone as GrowZone;
    if (hash01(seed, epoch, lot.id) >= Math.min(1, dem[zone] * GROWTH_RATE)) continue;
    const id = `g-${epoch}-${lot.id}`;
    if (id.length > 64 || doc.buildings[id] || grid.occupied(lot.polygon)) continue;
    const frame = lotFrame(doc, lot);
    if (!frame) continue;
    const setback = lot.regulation.setback;
    const fits = designs
      .get(zone)!
      .filter((d) => d.maxX - d.minX <= frame.width - 2 * setback && d.maxZ - d.minZ <= frame.depth - 2 * setback);
    if (fits.length === 0) continue;
    attempts++;
    const design = fits[Math.floor(hash01(seed, epoch, `${lot.id}#design`) * fits.length)]!;
    const { pos, rotation } = placement(design, frame, setback + SETBACK_MARGIN);
    const building: Building = { id, typeId: design.type.id, pos, rotation, auto: true };
    const cmd: Command = { type: 'building.place', building, ifClear: true };
    work ??= cloneJson(doc);
    const res = tryApplyCommand(work, cmd);
    if (!res.ok) continue;
    if (parcelCompliance(work, work.parcels[lot.id]!).violations.length > 0) {
      res.rollback();
      continue;
    }
    grid.add(work, building);
    out.push(cmd);
  }
  return out;
}

/** The batch a growth tick commits (as the system), or null when nothing grows. Shared by server and offline mode. */
export function growthTick(doc: CityDoc, epoch: number): Command | null {
  const commands = growthStep(doc, epoch);
  return commands.length ? { type: 'batch', commands } : null;
}
