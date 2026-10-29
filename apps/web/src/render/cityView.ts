// Camera presets (ADR 0013 §6, P6c-1): frame the densest district (first entry, "도시 보기") or the
// whole built city (buildings and roads, far outliers trimmed, building heights included; "도시 보기"
// pressed again) from a low angle, and a street-level view along a road.
// Pure functions; the renderer applies them only on the first entry into a room with a city and on
// the view buttons, never on collaborators' edits.

import {
  bounds,
  buildingMetrics,
  cumulativeLengths,
  distanceToPolygonEdge,
  partFootprint,
  pointAtLength,
  pointInPolygon,
  sampleSegmentCurve,
  tangentAtLength,
  type Building,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';
import { roofHeight, wallHeight } from './buildingGeometry';

export interface CityFrame {
  center: Vec2;
  /** Half extents of the trimmed box along x and z, m (with a margin). */
  halfX: number;
  halfZ: number;
  /** Tallest building top touching the box, m (0 without buildings). */
  height: number;
  /**
   * Corners (ground and top) of buildings that straddle the box's edge. They need not be on screen
   * (the city runs past the edges) but must stay in front of the camera.
   */
  front?: { x: number; y: number; z: number }[];
}

/** Minimum depth in front of the camera for straddling buildings' corners, m. */
const FRONT_MARGIN = 30;

export interface CameraPose {
  position: { x: number; y: number; z: number };
  target: Vec2;
}

/**
 * Preferred elevation of the city view (low: the city recedes into the haze toward a visible horizon
 * instead of lying under the camera like a model on a table). Below half the 50° field of view, so
 * the sky shows.
 */
export const CITY_VIEW_ELEVATION = (19 * Math.PI) / 180;
/**
 * City view distance limits, m: close enough for a single block; at most 2 km (about 650 m up at 19°,
 * a low flight, inside the camera's 2.5 km zoom range).
 */
export const CITY_VIEW_MIN = 120;
export const CITY_VIEW_MAX = 2000;
/** Every frame corner stays within this share of the screen half-width / half-height (NDC). */
export const CITY_VIEW_NDC_MARGIN = 0.92;
/** Default look direction (azimuth, camera-controls convention: camera at target + (sin, cos)). */
export const DEFAULT_AZIMUTH = Math.atan2(-180, 260);
/** Start pose of an empty city: lower and closer than a map view. */
export const EMPTY_START: CameraPose = { position: { x: -130, y: 150, z: 190 }, target: { x: 0, z: 0 } };
/** Eye level: camera height above the road, how far into the road it stands and how far it looks, m. */
export const EYE_HEIGHT = 8;
const EYE_INTO_ROAD = 14;
const EYE_AHEAD = 70;
/** Clearance between the eye-level camera and any building wall or roof it would stand in, m. */
const EYE_CLEARANCE = 1.5;
/** Junctions tried (nearest first) before giving up on a street-level view. */
const EYE_NODES_TRIED = 24;

/** Value at quantile q of an ascending array. */
function quantile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

/** Margin around road junctions (half a wide road with sidewalks), m. */
const ROAD_MARGIN = 15;

interface Extent {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
}

/** Ground box of a building's real rotated footprint (every part, offsets included) and its top. */
function buildingExtent(doc: CityDoc, b: Building): Extent | null {
  const t = doc.buildingTypes[b.typeId];
  if (!t || t.parts.length === 0) return null;
  const e: Extent = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, top: 0 };
  for (const part of t.parts) {
    for (const v of partFootprint(b, part)) {
      e.minX = Math.min(e.minX, v.x);
      e.maxX = Math.max(e.maxX, v.x);
      e.minZ = Math.min(e.minZ, v.z);
      e.maxZ = Math.max(e.maxZ, v.z);
    }
    // Pitched roofs rise above the walls (same height rule as the baked geometry).
    e.top = Math.max(e.top, part.baseHeight + wallHeight(part) + roofHeight(part));
  }
  return e;
}

const touches = (e: Extent, b: Extent): boolean => e.maxX >= b.minX && e.minX <= b.maxX && e.maxZ >= b.minZ && e.minZ <= b.maxZ;

/**
 * Frame of a ground box whose height is the tallest of `all` buildings whose footprint touches it;
 * the touching ones that reach past the box keep their corners as front-only points.
 */
function frameOver(box: Extent, all: readonly Extent[]): CityFrame {
  let top = 0;
  const front: { x: number; y: number; z: number }[] = [];
  for (const m of all) {
    if (!touches(m, box)) continue;
    top = Math.max(top, m.top);
    if (m.minX >= box.minX && m.maxX <= box.maxX && m.minZ >= box.minZ && m.maxZ <= box.maxZ) continue;
    for (const x of [m.minX, m.maxX]) for (const z of [m.minZ, m.maxZ]) front.push({ x, y: 0, z }, { x, y: m.top, z });
  }
  const f: CityFrame = { center: { x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2 }, halfX: (box.maxX - box.minX) / 2, halfZ: (box.maxZ - box.minZ) / 2, height: top };
  if (front.length) f.front = front;
  return f;
}

/** Buildings sorted by id: every result below is independent of insertion order. */
const byId = (doc: CityDoc): Building[] => Object.values(doc.buildings).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Box around buildings and road junctions. With enough points the 4th–96th percentiles of their
 * origins are used per axis, so a lone far road or building does not pull the view back out. The box
 * is then, in one pass, the union of the kept buildings' (origin inside those bounds) real rotated
 * footprints and the kept junctions with a road-width margin. Its height is the tallest building
 * whose footprint touches the box, outliers included. A union and a max do not depend on order.
 */
export function cityFrame(doc: CityDoc): CityFrame | null {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const b of Object.values(doc.buildings)) {
    xs.push(b.pos.x);
    zs.push(b.pos.z);
  }
  for (const n of Object.values(doc.nodes)) {
    xs.push(n.pos.x);
    zs.push(n.pos.z);
  }
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const trim = xs.length >= 20 ? 0.04 : 0;
  const minX = quantile(xs, trim);
  const maxX = quantile(xs, 1 - trim);
  const minZ = quantile(zs, trim);
  const maxZ = quantile(zs, 1 - trim);
  const inside = (p: Vec2): boolean => p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ;
  const box: Extent = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, top: 0 };
  for (const n of Object.values(doc.nodes)) {
    if (!inside(n.pos)) continue;
    box.minX = Math.min(box.minX, n.pos.x - ROAD_MARGIN);
    box.maxX = Math.max(box.maxX, n.pos.x + ROAD_MARGIN);
    box.minZ = Math.min(box.minZ, n.pos.z - ROAD_MARGIN);
    box.maxZ = Math.max(box.maxZ, n.pos.z + ROAD_MARGIN);
  }
  const all: Extent[] = [];
  for (const b of byId(doc)) {
    const e = buildingExtent(doc, b);
    if (!e) continue;
    all.push(e);
    if (!inside(b.pos)) continue;
    box.minX = Math.min(box.minX, e.minX);
    box.maxX = Math.max(box.maxX, e.maxX);
    box.minZ = Math.min(box.minZ, e.minZ);
    box.maxZ = Math.max(box.maxZ, e.maxZ);
  }
  if (!Number.isFinite(box.minX)) {
    // Only buildings without a known design: frame their origins.
    Object.assign(box, { minX: minX - ROAD_MARGIN, maxX: maxX + ROAD_MARGIN, minZ: minZ - ROAD_MARGIN, maxZ: maxZ + ROAD_MARGIN });
  }
  return frameOver(box, all);
}

/** Side of the district view's box, m: about one dense district (5×5 blocks of 120 m). */
export const DISTRICT_SIZE = 600;
const DISTRICT_BIN = 50;

/**
 * The densest district: the DISTRICT_SIZE square (on a 50 m grid) holding the most built floor area
 * (buildings; road junctions count lightly when there are no buildings), re-centered on the floor-area
 * weighted centroid inside it. The box is exactly that square — it never grows sideways — and its
 * height is the tallest building whose real footprint touches it (outliers included), so the square
 * at that height is fully on screen. Buildings straddling the square's edge may run past the screen
 * edges: that is the intended look (the city continues beyond the view, into the haze). They are
 * only kept in front of the camera (`front` points, FRONT_MARGIN). Ties between
 * equally dense windows go to the one nearest the city's center. A city whose whole frame already fits in that size gets the whole
 * frame (the district and the full view are then the same).
 */
export function districtFrame(doc: CityDoc): CityFrame | null {
  const full = cityFrame(doc);
  if (!full) return null;
  if (full.halfX <= DISTRICT_SIZE / 2 && full.halfZ <= DISTRICT_SIZE / 2) return full;
  const pts: { p: Vec2; w: number; e: Extent | null }[] = [];
  const area = new Map<string, number>();
  for (const b of byId(doc)) {
    const t = doc.buildingTypes[b.typeId];
    if (!t) continue;
    let a = area.get(t.id);
    if (a === undefined) area.set(t.id, (a = buildingMetrics(t).grossFloorArea));
    pts.push({ p: b.pos, w: Math.max(1, a), e: buildingExtent(doc, b) });
  }
  if (pts.length === 0) for (const n of Object.values(doc.nodes).sort((a, b) => (a.id < b.id ? -1 : 1))) pts.push({ p: n.pos, w: 1, e: null });
  // Floor area per 50 m cell, then the best DISTRICT_SIZE window by a 2D prefix sum.
  const cell = (v: number): number => Math.floor(v / DISTRICT_BIN);
  let minI = Infinity, minJ = Infinity, maxI = -Infinity, maxJ = -Infinity;
  for (const { p } of pts) {
    minI = Math.min(minI, cell(p.x));
    maxI = Math.max(maxI, cell(p.x));
    minJ = Math.min(minJ, cell(p.z));
    maxJ = Math.max(maxJ, cell(p.z));
  }
  const W = maxI - minI + 1;
  const H = maxJ - minJ + 1;
  const sum = new Float64Array((W + 1) * (H + 1));
  for (const { p, w } of pts) sum[(cell(p.x) - minI + 1) * (H + 1) + (cell(p.z) - minJ + 1)]! += w;
  for (let i = 1; i <= W; i++) for (let j = 1; j <= H; j++) sum[i * (H + 1) + j]! += sum[(i - 1) * (H + 1) + j]! + sum[i * (H + 1) + j - 1]! - sum[(i - 1) * (H + 1) + j - 1]!;
  const k = DISTRICT_SIZE / DISTRICT_BIN;
  const at = (i: number, j: number): number => sum[Math.max(0, Math.min(W, i)) * (H + 1) + Math.max(0, Math.min(H, j))]!;
  let best = -1;
  let bi = 0;
  let bj = 0;
  for (let i = 0; i <= Math.max(0, W - k); i++) {
    for (let j = 0; j <= Math.max(0, H - k); j++) {
      const v = at(i + k, j + k) - at(i, j + k) - at(i + k, j) + at(i, j);
      // Ties go to the window nearest the city's center.
      const cx = (minI + i + k / 2) * DISTRICT_BIN;
      const cz = (minJ + j + k / 2) * DISTRICT_BIN;
      const score = v - 1e-6 * Math.hypot(cx - full.center.x, cz - full.center.z);
      if (score > best) {
        best = score;
        bi = i;
        bj = j;
      }
    }
  }
  const x0 = (minI + bi) * DISTRICT_BIN;
  const z0 = (minJ + bj) * DISTRICT_BIN;
  let wx = 0, wz = 0, ws = 0;
  for (const { p, w } of pts) {
    if (p.x < x0 || p.x >= x0 + DISTRICT_SIZE || p.z < z0 || p.z >= z0 + DISTRICT_SIZE) continue;
    wx += p.x * w;
    wz += p.z * w;
    ws += w;
  }
  const c = ws > 0 ? { x: wx / ws, z: wz / ws } : { x: x0 + DISTRICT_SIZE / 2, z: z0 + DISTRICT_SIZE / 2 };
  const half = DISTRICT_SIZE / 2;
  const square: Extent = { minX: c.x - half, maxX: c.x + half, minZ: c.z - half, maxZ: c.z + half, top: 0 };
  const extents: Extent[] = [];
  for (const { e } of pts) if (e) extents.push(e);
  return frameOver(square, extents);
}

/** Unit vector from the target to the camera for an azimuth and an elevation above the horizon. */
function viewOffset(azimuth: number, elevation: number): { x: number; y: number; z: number } {
  return { x: Math.cos(elevation) * Math.sin(azimuth), y: Math.sin(elevation), z: Math.cos(elevation) * Math.cos(azimuth) };
}

/**
 * Smallest camera distance (target = frame center on the ground) at which all 8 corners of the frame
 * box (ground to building tops) project inside ±CITY_VIEW_NDC_MARGIN of both the horizontal and the
 * vertical field of view. Exact: a corner q (relative to the target) has view depth d − q·o and
 * lateral offsets q·right, q·up, so it fits once d ≥ q·o + max(|q·right| / tanH, |q·up| / tanV) / margin.
 */
export function cityFitDistance(frame: CityFrame, fovDeg: number, aspect: number, azimuth: number, elevation: number): number {
  const tanV = Math.tan((fovDeg * Math.PI) / 360) * CITY_VIEW_NDC_MARGIN;
  const tanH = tanV * aspect;
  const o = viewOffset(azimuth, elevation);
  // right = forward × up with forward = −o; up' = right × forward.
  const rl = Math.hypot(o.z, o.x);
  const r = { x: -o.z / rl, y: 0, z: o.x / rl };
  const u = { x: -(r.y * o.z - r.z * o.y), y: -(r.z * o.x - r.x * o.z), z: -(r.x * o.y - r.y * o.x) };
  let d = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const y of [0, frame.height]) {
        const q = { x: sx * frame.halfX, y, z: sz * frame.halfZ };
        const along = q.x * o.x + q.y * o.y + q.z * o.z;
        const lx = Math.abs(q.x * r.x + q.y * r.y + q.z * r.z);
        const ly = Math.abs(q.x * u.x + q.y * u.y + q.z * u.z);
        d = Math.max(d, along + Math.max(lx / tanH, ly / tanV));
      }
    }
  }
  // Straddling buildings: in front of the camera by FRONT_MARGIN (depth d − q·o), not necessarily on screen.
  for (const p of frame.front ?? []) {
    const q = { x: p.x - frame.center.x, y: p.y, z: p.z - frame.center.z };
    d = Math.max(d, q.x * o.x + q.y * o.y + q.z * o.z + FRONT_MARGIN);
  }
  return d;
}

/**
 * The whole (trimmed) city from the given azimuth at 19° above the horizon, at the distance where
 * every frame corner is on screen. Policy when that distance exceeds CITY_VIEW_MAX: keep 19° and the
 * capped distance — the city center stays framed and the outer blocks run past the screen edges (and
 * into the haze). Climbing to a steeper angle does not help: at a low angle the city's depth is
 * foreshortened, so a steeper view needs an even larger distance for the same box.
 */
export function cityViewPose(frame: CityFrame, fovDeg: number, aspect: number, azimuth = DEFAULT_AZIMUTH): CameraPose & { elevation: number; fits: boolean } {
  const elevation = CITY_VIEW_ELEVATION;
  let d = cityFitDistance(frame, fovDeg, aspect, azimuth, elevation);
  const fits = d <= CITY_VIEW_MAX;
  d = Math.min(CITY_VIEW_MAX, Math.max(CITY_VIEW_MIN, d));
  const o = viewOffset(azimuth, elevation);
  return {
    position: { x: frame.center.x + o.x * d, y: o.y * d, z: frame.center.z + o.z * d },
    target: { x: frame.center.x, z: frame.center.z },
    elevation,
    fits,
  };
}

/** True if a camera at (p, y) would stand inside a building volume or within EYE_CLEARANCE of one. */
function insideBuilding(doc: CityDoc, p: Vec2, y: number): boolean {
  for (const b of Object.values(doc.buildings)) {
    const t = doc.buildingTypes[b.typeId];
    if (!t) continue;
    for (const part of t.parts) {
      const top = part.baseHeight + part.floors * part.floorHeight;
      if (y < part.baseHeight - EYE_CLEARANCE || y > top + EYE_CLEARANCE) continue;
      const poly = partFootprint(b, part);
      const box = bounds(poly);
      if (p.x < box.minX - EYE_CLEARANCE || p.x > box.maxX + EYE_CLEARANCE || p.z < box.minZ - EYE_CLEARANCE || p.z > box.maxZ + EYE_CLEARANCE) continue;
      if (pointInPolygon(p, poly) || distanceToPolygonEdge(p, poly) < EYE_CLEARANCE) return true;
    }
  }
  return false;
}

/**
 * Street level: the camera stands on a road (on its centerline, a few meters in from a junction),
 * eye height above it, looking along the road. Junctions are tried nearest to `near` first, and at
 * each the road heading most toward `center` first; a spot inside or against a building is skipped.
 * Works for dead ends, short roads (the camera stays within the road) and curves (camera on the
 * curve, looking along its tangent). Null when no road gives a free spot.
 */
export function eyeLevelPose(doc: CityDoc, near: Vec2, center: Vec2): CameraPose | null {
  const nodes = Object.values(doc.nodes)
    .map((n) => ({ id: n.id, pos: n.pos, d: Math.hypot(n.pos.x - near.x, n.pos.z - near.z) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, EYE_NODES_TRIED);
  const segs = Object.values(doc.segments);
  for (const node of nodes) {
    const options: { pts: Vec2[]; score: number }[] = [];
    for (const s of segs) {
      if (s.a !== node.id && s.b !== node.id) continue;
      const a = doc.nodes[s.a];
      const b = doc.nodes[s.b];
      if (!a || !b) continue;
      const curve = sampleSegmentCurve(a.pos, b.pos, s.control);
      const pts = s.a === node.id ? curve : curve.slice().reverse();
      if (pts.length < 2) continue;
      const dir = { x: pts[1]!.x - pts[0]!.x, z: pts[1]!.z - pts[0]!.z };
      const len = Math.hypot(dir.x, dir.z);
      const c = Math.hypot(center.x - node.pos.x, center.z - node.pos.z);
      const score = len < 1e-9 || c < 1e-6 ? 0 : (dir.x * (center.x - node.pos.x) + dir.z * (center.z - node.pos.z)) / (len * c);
      options.push({ pts, score });
    }
    options.sort((p, q) => q.score - p.score);
    for (const { pts } of options) {
      const cum = cumulativeLengths(pts);
      const total = cum[cum.length - 1]!;
      if (total < 1e-6) continue;
      // A few meters in from the junction, never past the road's middle on short roads.
      const s = Math.min(EYE_INTO_ROAD, total / 2);
      const cam = pointAtLength(pts, cum, s);
      if (insideBuilding(doc, cam, EYE_HEIGHT)) continue;
      const tan = tangentAtLength(pts, cum, s);
      const tl = Math.hypot(tan.x, tan.z) || 1;
      return {
        position: { x: cam.x, y: EYE_HEIGHT, z: cam.z },
        target: { x: cam.x + (tan.x / tl) * EYE_AHEAD, z: cam.z + (tan.z / tl) * EYE_AHEAD },
      };
    }
  }
  return null;
}
