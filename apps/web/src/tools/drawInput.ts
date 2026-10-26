// Road drawing input (ADR 0012 §2), pure: magnet snapping with screen-pixel hysteresis, angle guides,
// curve control rules, free-hand stroke → RDP → quadratic B-spline pieces, and the checks run on the
// FINAL curve. No DOM, no store: the road tool feeds it world points and the current screen scale.

import {
  angleBetween,
  closestPointOnPolyline,
  cross,
  dist,
  dot,
  LIMITS,
  normalize,
  paramOn,
  pointSegmentDistance,
  polylineIntersections,
  quadBezier,
  sampleSegmentCurve,
  segmentLength,
  snapToGrid,
  sub,
  type CityDoc,
  type ResolvedPoint,
  type RoadSegment,
  type Vec2,
} from '@smartcity/shared';

// ---------- spatial index ----------

export interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Bounding box of a road from its end points and control point (the curve stays inside their hull). */
export function segmentBox(doc: CityDoc, s: RoadSegment): Box | null {
  const a = doc.nodes[s.a]?.pos;
  const b = doc.nodes[s.b]?.pos;
  if (!a || !b) return null;
  const c = s.control ?? a;
  return { minX: Math.min(a.x, b.x, c.x), minZ: Math.min(a.z, b.z, c.z), maxX: Math.max(a.x, b.x, c.x), maxZ: Math.max(a.z, b.z, c.z) };
}

/**
 * Uniform grid over the roads' boxes, built once per doc version: snapping, stroke crossings and the
 * planning neighbourhood only look at roads near the pointer or the stroke.
 */
export class RoadIndex {
  static readonly CELL = 64;
  private cells = new Map<string, RoadSegment[]>();
  private boxes = new Map<string, Box>();
  /** Roads at each node (junction degree and far ends for planning checks). */
  readonly atNode = new Map<string, RoadSegment[]>();

  constructor(readonly doc: CityDoc) {
    const C = RoadIndex.CELL;
    for (const id of Object.keys(doc.segments).sort()) {
      const s = doc.segments[id]!;
      const box = segmentBox(doc, s);
      if (!box) continue;
      this.boxes.set(id, box);
      for (const n of [s.a, s.b]) {
        const l = this.atNode.get(n);
        if (l) l.push(s);
        else this.atNode.set(n, [s]);
      }
      for (let i = Math.floor(box.minX / C); i <= Math.floor(box.maxX / C); i++) {
        for (let j = Math.floor(box.minZ / C); j <= Math.floor(box.maxZ / C); j++) {
          const key = `${i},${j}`;
          const list = this.cells.get(key);
          if (list) list.push(s);
          else this.cells.set(key, [s]);
        }
      }
    }
  }

  /** Roads whose box meets `box`, in id order (deterministic). */
  near(box: Box): RoadSegment[] {
    const C = RoadIndex.CELL;
    const seen = new Set<string>();
    const out: RoadSegment[] = [];
    for (let i = Math.floor(box.minX / C); i <= Math.floor(box.maxX / C); i++) {
      for (let j = Math.floor(box.minZ / C); j <= Math.floor(box.maxZ / C); j++) {
        for (const s of this.cells.get(`${i},${j}`) ?? []) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          const b = this.boxes.get(s.id)!;
          if (b.maxX >= box.minX && b.minX <= box.maxX && b.maxZ >= box.minZ && b.minZ <= box.maxZ) out.push(s);
        }
      }
    }
    return out.sort((p, q) => (p.id < q.id ? -1 : 1));
  }
}

/** Box around points, grown by `margin`. */
export function boxAround(pts: readonly Vec2[], margin: number): Box {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX: minX - margin, minZ: minZ - margin, maxX: maxX + margin, maxZ: maxZ + margin };
}

/**
 * The part of `doc` that planning a road inside `box` can touch: the roads there, every road at their end
 * nodes (so junction degrees and far ends are exact), their nodes, and the lots and buildings there. Other
 * collections are shared as they are (planning copies before changing). The tool plans on this and checks
 * the final batch on the whole doc before sending it.
 */
export function neighbourhoodDoc(doc: CityDoc, index: RoadIndex, box: Box): CityDoc {
  const segments: CityDoc['segments'] = {};
  const nodes: CityDoc['nodes'] = {};
  const add = (s: RoadSegment): void => {
    segments[s.id] = s;
    nodes[s.a] = doc.nodes[s.a]!;
    nodes[s.b] = doc.nodes[s.b]!;
  };
  const inner = index.near(box);
  for (const s of inner) add(s);
  for (const s of inner) for (const n of [s.a, s.b]) for (const o of index.atNode.get(n) ?? []) add(o);
  const inBox = (pts: readonly Vec2[]): boolean => {
    const b = boxAround(pts, 0);
    return b.maxX >= box.minX && b.minX <= box.maxX && b.maxZ >= box.minZ && b.minZ <= box.maxZ;
  };
  const parcels: CityDoc['parcels'] = {};
  for (const p of Object.values(doc.parcels)) if (inBox(p.polygon)) parcels[p.id] = p;
  const buildings: CityDoc['buildings'] = {};
  for (const b of Object.values(doc.buildings)) if (b.pos.x >= box.minX - 200 && b.pos.x <= box.maxX + 200 && b.pos.z >= box.minZ - 200 && b.pos.z <= box.maxZ + 200) buildings[b.id] = b;
  return { ...doc, nodes, segments, parcels, buildings };
}

// ---------- magnet snapping (b1) ----------

/** A candidate is captured within this many screen pixels of the cursor ... */
export const SNAP_ENTER_PX = 12;
/** ... and, once held, released only beyond this many (hysteresis: no flicker at the boundary). */
export const SNAP_EXIT_PX = 18;
/** Angle guides every 15°, absolute and relative to the roads at the start point. */
export const ANGLE_STEP_DEG = 15;

export type SnapKind = 'node' | 'road' | 'angle' | 'grid' | 'free';
/** Priority: road end point > point on a road > angle guide > grid > free cursor. */
const PRIORITY: Record<SnapKind, number> = { node: 0, road: 1, angle: 2, grid: 3, free: 4 };
export const SNAP_LABEL: Record<SnapKind, string> = { node: '끝점', road: '도로', angle: '각도', grid: '격자', free: '' };

export interface SnapHold {
  kind: SnapKind;
  id: string;
}

export interface SnapResult extends SnapHold {
  pos: Vec2;
  /** The point as the planner takes it. */
  ref: ResolvedPoint;
  /** Distance from the cursor to what it snapped to, m (lateral distance for angle guides). */
  dist: number;
  /** Angle snap: unit direction of the guide from `from`. */
  dir?: Vec2;
}

export interface SnapInput {
  doc: CityDoc;
  cursor: Vec2;
  /** World meters per screen pixel at the cursor. */
  mPerPx: number;
  /** Grid step, m (0 = no grid). */
  gridStep: number;
  /** Start of the piece being drawn: enables angle guides. */
  from?: Vec2 | null;
  /** Directions of the roads at `from` (guides are also relative to them). */
  refDirs?: readonly Vec2[];
  /** What the previous pointer position snapped to. */
  held?: SnapHold | null;
  /** Shift: no snapping at all. */
  disabled?: boolean;
  /** Spatial index of the doc's roads (only roads near the cursor are tested); absent = every road. */
  index?: RoadIndex;
}

const deg = (u: Vec2): number => (((Math.atan2(u.z, u.x) * 180) / Math.PI) % 360 + 360) % 360;
const dirOf = (d: number): Vec2 => ({ x: Math.cos((d * Math.PI) / 180), z: Math.sin((d * Math.PI) / 180) });
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * Snap the cursor. Candidates within SNAP_ENTER_PX (the held one: SNAP_EXIT_PX) compete; the best kind
 * by priority wins, ties by distance, then id (deterministic). Angle guides round the length to 1 m.
 */
export function snapCursor(inp: SnapInput): SnapResult {
  const { doc, cursor } = inp;
  const free: SnapResult = { kind: 'free', id: '', pos: cursor, ref: { kind: 'free', pos: cursor }, dist: 0 };
  if (inp.disabled) return free;
  const radius = (kind: SnapKind, id: string): number =>
    (inp.held && inp.held.kind === kind && inp.held.id === id ? SNAP_EXIT_PX : SNAP_ENTER_PX) * inp.mPerPx;
  const cands: SnapResult[] = [];
  const maxR = SNAP_EXIT_PX * inp.mPerPx;

  const segs = inp.index ? inp.index.near({ minX: cursor.x - maxR, minZ: cursor.z - maxR, maxX: cursor.x + maxR, maxZ: cursor.z + maxR }) : Object.values(doc.segments);
  // Every node belongs to a road (orphans are removed), so the nearby roads' end points are all candidates.
  const nodeIds = new Set<string>();
  for (const s of segs) nodeIds.add(s.a).add(s.b);
  for (const id of nodeIds) {
    const n = doc.nodes[id];
    if (!n) continue;
    const d = dist(n.pos, cursor);
    if (d <= radius('node', n.id)) cands.push({ kind: 'node', id: n.id, pos: n.pos, ref: { kind: 'node', nodeId: n.id, pos: n.pos }, dist: d });
  }
  for (const s of segs) {
    const a = doc.nodes[s.a]?.pos;
    const b = doc.nodes[s.b]?.pos;
    if (!a || !b) continue;
    const xs = s.control ? [a.x, b.x, s.control.x] : [a.x, b.x];
    const zs = s.control ? [a.z, b.z, s.control.z] : [a.z, b.z];
    if (cursor.x < Math.min(...xs) - maxR || cursor.x > Math.max(...xs) + maxR || cursor.z < Math.min(...zs) - maxR || cursor.z > Math.max(...zs) + maxR) continue;
    const c = closestPointOnPolyline(sampleSegmentCurve(a, b, s.control), cursor);
    if (c.distance > radius('road', s.id)) continue;
    const total = segmentLength(doc, s);
    // Too close to an end for a junction there: that end node instead (as the planner's resolvePoint).
    const endId = c.s < LIMITS.minSegmentLength ? s.a : total - c.s < LIMITS.minSegmentLength ? s.b : null;
    if (endId) {
      const p = doc.nodes[endId]!.pos;
      cands.push({ kind: 'node', id: endId, pos: p, ref: { kind: 'node', nodeId: endId, pos: p }, dist: c.distance });
    } else {
      cands.push({ kind: 'road', id: s.id, pos: c.point, ref: { kind: 'split', segmentId: s.id, t: paramOn(doc, s, c.point), pos: c.point }, dist: c.distance });
    }
  }
  const from = inp.from;
  // Guides only once the cursor has left the start (no 1 m stub right after a click).
  if (from && dist(from, cursor) > SNAP_EXIT_PX * inp.mPerPx) {
    const angles = new Set<number>();
    for (let k = 0; k < 360 / ANGLE_STEP_DEG; k++) angles.add(k * ANGLE_STEP_DEG);
    for (const r of inp.refDirs ?? []) for (let k = 0; k < 360 / ANGLE_STEP_DEG; k++) angles.add(round6((deg(r) + k * ANGLE_STEP_DEG) % 360));
    const v = sub(cursor, from);
    for (const a of angles) {
      const u = dirOf(a);
      const along = dot(v, u);
      if (along <= 0) continue;
      const id = a.toFixed(3);
      const lateral = Math.abs(cross(u, v));
      if (lateral > radius('angle', id)) continue;
      const len = Math.max(1, Math.round(along));
      const pos = { x: from.x + u.x * len, z: from.z + u.z * len };
      cands.push({ kind: 'angle', id, pos, ref: { kind: 'free', pos }, dist: lateral, dir: u });
    }
  }
  if (inp.gridStep > 0) {
    const g = snapToGrid(cursor, inp.gridStep);
    const id = `${g.x},${g.z}`;
    const d = dist(g, cursor);
    if (d <= radius('grid', id)) cands.push({ kind: 'grid', id, pos: g, ref: { kind: 'free', pos: g }, dist: d });
  }
  if (cands.length === 0) return free;
  cands.sort((p, q) => PRIORITY[p.kind] - PRIORITY[q.kind] || p.dist - q.dist || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  return cands[0]!;
}

/** Guide line pieces (dashes) from a to b. */
export function dashes(a: Vec2, b: Vec2, dash = 3, gap = 2): Vec2[][] {
  const len = dist(a, b);
  if (len < 1e-6) return [];
  const u = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  const out: Vec2[][] = [];
  for (let s = 0; s < len; s += dash + gap) {
    const e = Math.min(len, s + dash);
    out.push([
      { x: a.x + u.x * s, z: a.z + u.z * s },
      { x: a.x + u.x * e, z: a.z + u.z * e },
    ]);
  }
  return out;
}

/** Compass bearing in degrees (0 = north = -Z, clockwise). */
export function bearingDeg(a: Vec2, b: Vec2): number {
  const d = (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
  return (d + 360) % 360;
}

/** "45.0 m · 135°" label of a piece. */
export const pieceLabel = (a: Vec2, b: Vec2, len = dist(a, b)): string => `${len.toFixed(1)} m · ${Math.round(bearingDeg(a, b)) % 360}°`;

// ---------- curves (b2) ----------

/**
 * Direction a road continues in from its dead end `nodeId` (the derivative of its curve at that end,
 * not the chord). Null unless the node has exactly one road.
 */
export function endTangent(doc: CityDoc, nodeId: string): Vec2 | null {
  const at = Object.values(doc.segments).filter((s) => s.a === nodeId || s.b === nodeId);
  if (at.length !== 1) return null;
  const s = at[0]!;
  const here = doc.nodes[nodeId]!.pos;
  const prev = s.control ?? doc.nodes[s.a === nodeId ? s.b : s.a]!.pos;
  return normalize(sub(here, prev));
}

/** Default control point: on the start tangent, half the chord away. Null for a zero-length chord. */
export function defaultControl(start: Vec2, tangent: Vec2, end: Vec2): Vec2 | null {
  const chord = dist(start, end);
  if (chord < 1e-6) return null;
  return { x: start.x + (tangent.x * chord) / 2, z: start.z + (tangent.z * chord) / 2 };
}

/** Control point dragged by its handle: the pointer projected on the tangent ray (at least 1 m out). */
export function handleControl(start: Vec2, tangent: Vec2, pointer: Vec2): Vec2 {
  const t = Math.max(1, dot(sub(pointer, start), tangent));
  return { x: start.x + tangent.x * t, z: start.z + tangent.z * t };
}

/** Exact minimum radius of curvature of a quadratic Bezier (Infinity for a straight one). */
/**
 * True if the curve turns back on itself: collinear control point outside the chord, so the derivative is
 * zero inside the curve and the road runs back over itself (a non-collinear quadratic never does).
 */
export function quadFoldsBack(p0: Vec2, c: Vec2, p2: Vec2): boolean {
  const a = sub(c, p0);
  const b = sub(p2, c);
  const la = Math.hypot(a.x, a.z);
  const lb = Math.hypot(b.x, b.z);
  if (la < 1e-9 || lb < 1e-9) return false;
  return Math.abs(cross(a, b)) <= 1e-9 * la * lb && dot(a, b) < 0;
}

/** Exact minimum radius of curvature of a quadratic Bezier (Infinity for a straight one, 0 for a fold-back). */
export function quadMinRadius(p0: Vec2, c: Vec2, p2: Vec2): number {
  if (quadFoldsBack(p0, c, p2)) return 0;
  const a = sub(c, p0);
  const b = sub(p2, c);
  const k = Math.abs(cross(a, b));
  if (k < 1e-9) return Infinity;
  const ab = sub(a, b);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(a, ab) / l2)) : 0;
  const m = Math.hypot((1 - t) * a.x + t * b.x, (1 - t) * a.z + t * b.z);
  return (2 * m ** 3) / k;
}

// ---------- free-hand strokes (b3) ----------

/**
 * RDP tolerance: 2 screen pixels, kept between 0.5 and 1.5 m of world distance. Coarser polygons put the
 * whole turn on few vertices and the spline gets tighter than the drawn path (then refused by the radius check).
 */
export const rdpTolerance = (mPerPx: number): number => Math.min(1.5, Math.max(0.5, 2 * mPerPx));

/**
 * Ramer–Douglas–Peucker; the first and last points are always kept. Distances are to the chord SEGMENT,
 * not its infinite line: a stroke that runs out and comes back keeps its turnaround point.
 */
export function rdp(pts: readonly Vec2[], eps: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  let best = -1;
  let bestD = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointSegmentDistance(pts[i]!, a, b);
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  if (bestD <= eps) return [a, b];
  const left = rdp(pts.slice(0, best + 1), eps);
  return [...left.slice(0, -1), ...rdp(pts.slice(best), eps)];
}

/** Turns sharper than this at a vertex are features of the drawing, never merged away. */
export const KEEP_TURN_DEG = 60;

/**
 * Vertices of the spline polygon: RDP, then an interior vertex closer than `minSpacing` to the previous kept
 * vertex (or to the end) is merged away when the stroke only bends gently there (< KEEP_TURN_DEG), so the
 * pieces between midpoints keep the minimum road length. A sharp feature is kept even when short, and the
 * final-curve checks refuse it: a zig-zag is never straightened silently. This is part of the
 * simplification, before the curve exists, so continuity is never repaired afterwards.
 */
export function simplifyStroke(pts: readonly Vec2[], eps: number, minSpacing = 2 * LIMITS.minSegmentLength): Vec2[] {
  const r = rdp(pts, eps);
  if (r.length <= 2) return r;
  const end = r[r.length - 1]!;
  const out = [r[0]!];
  for (let i = 1; i < r.length - 1; i++) {
    const p = r[i]!;
    const prev = out[out.length - 1]!;
    const close = dist(p, prev) < minSpacing || dist(p, end) < minSpacing;
    const turn = Math.abs((angleBetween(normalize(sub(p, prev)), normalize(sub(r[i + 1]!, p))) * 180) / Math.PI);
    if (!close || turn >= KEEP_TURN_DEG) out.push(p);
  }
  out.push(end);
  return out;
}

export interface SplinePiece {
  from: Vec2;
  to: Vec2;
  control?: Vec2;
}

/**
 * Clamped quadratic B-spline through the polygon's end points: pieces run between the midpoints of the
 * inner edges with the polygon vertices as control points, so consecutive pieces share their tangent (C1).
 */
export function splinePieces(v: readonly Vec2[]): SplinePiece[] {
  const n = v.length - 1;
  if (n < 1) return [];
  if (n === 1) return [{ from: v[0]!, to: v[1]! }];
  const knots: Vec2[] = [v[0]!];
  for (let i = 1; i <= n - 2; i++) knots.push({ x: (v[i]!.x + v[i + 1]!.x) / 2, z: (v[i]!.z + v[i + 1]!.z) / 2 });
  knots.push(v[n]!);
  const out: SplinePiece[] = [];
  for (let i = 0; i < knots.length - 1; i++) out.push({ from: knots[i]!, to: knots[i + 1]!, control: v[i + 1]! });
  return out;
}

export interface StrokePiece extends SplinePiece {
  /** The end is where the stroke crosses this existing road (id): a junction to keep, on that road. */
  crossing?: string;
}

/**
 * Free-hand stroke → road pieces. Points where the raw stroke crosses existing roads are kept exactly
 * (the stroke is cut there; each part is simplified and splined on its own), so junctions stay where the
 * user crossed. Crossings within `endGuard` of the stroke's ends belong to the snapped end points.
 */
export function strokePieces(path: readonly Vec2[], roads: readonly { id: string; pts: Vec2[] }[], eps: number, endGuard = LIMITS.minSegmentLength): StrokePiece[] {
  if (path.length < 2) return [];
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + dist(path[i - 1]!, path[i]!));
  const total = cum[cum.length - 1]!;
  const cuts: { s: number; p: Vec2; road: string }[] = [];
  for (const road of roads) for (const h of polylineIntersections(path, road.pts)) if (h.sa > endGuard && total - h.sa > endGuard) cuts.push({ s: h.sa, p: h.point, road: road.id });
  cuts.sort((a, b) => a.s - b.s || (a.road < b.road ? -1 : a.road > b.road ? 1 : 0));
  // A crossing exactly on a sample vertex of the road is reported by both neighbouring pieces.
  for (let i = cuts.length - 1; i > 0; i--) if (cuts[i]!.s - cuts[i - 1]!.s < 1) cuts.splice(i, 1);
  const parts: Vec2[][] = [];
  const crossed: string[] = [];
  let cur: Vec2[] = [path[0]!];
  let k = 0;
  for (let i = 1; i < path.length; i++) {
    while (k < cuts.length && cuts[k]!.s <= cum[i]!) {
      cur.push(cuts[k]!.p);
      parts.push(cur);
      crossed.push(cuts[k]!.road);
      cur = [cuts[k]!.p];
      k++;
    }
    cur.push(path[i]!);
  }
  parts.push(cur);
  const out: StrokePiece[] = [];
  parts.forEach((part, i) => {
    const pieces = splinePieces(simplifyStroke(part, eps));
    pieces.forEach((p, j) => out.push(j === pieces.length - 1 && i < parts.length - 1 ? { ...p, crossing: crossed[i]! } : p));
  });
  return out;
}

/** Sampled center lines of pieces. */
export const pieceCurves = (pieces: readonly SplinePiece[]): Vec2[][] => pieces.map((p) => sampleSegmentCurve(p.from, p.to, p.control, 1));

/** True if non-adjacent pieces cross or touch, or a piece crosses itself. */
export function selfIntersects(curves: readonly Vec2[][]): boolean {
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const hits = polylineIntersections(curves[i]!, curves[j]!);
      // Neighbours meet at their shared end point only.
      const shared = j === i + 1 ? curves[j]![0]! : null;
      if (hits.some((h) => !shared || dist(h.point, shared) > 0.5)) return true;
    }
  }
  return false;
}

/**
 * Checks on the FINAL curve (never auto-corrected): no self-intersection and every curved piece at least
 * the fillet floor radius. Returns the reason (Korean, for the preview) or null.
 */
export function finalCurveProblem(pieces: readonly SplinePiece[], floor: number): string | null {
  if (pieces.some((p) => p.control && quadFoldsBack(p.from, p.control, p.to))) return '곡선이 제자리에서 되돌아갑니다';
  if (selfIntersects(pieceCurves(pieces))) return '도로가 자기 자신과 교차합니다';
  let tight = Infinity;
  for (const p of pieces) if (p.control) tight = Math.min(tight, quadMinRadius(p.from, p.control, p.to));
  if (tight < floor - 1e-9) return `곡선이 너무 급합니다 (최소 반경 ${tight.toFixed(1)} m < ${floor.toFixed(1)} m)`;
  return null;
}

/** Point on a piece at parameter t (previews). */
export const piecePoint = (p: SplinePiece, t: number): Vec2 => (p.control ? quadBezier(p.from, p.control, p.to, t) : { x: p.from.x + (p.to.x - p.from.x) * t, z: p.from.z + (p.to.z - p.from.z) * t });

// ---------- finishing ----------

export const DOUBLE_CLICK_MS = 350;
export const DOUBLE_CLICK_PX = 5;

export interface ClickStamp {
  t: number;
  x: number;
  y: number;
}

/** A second click close in time and place: it finishes the stroke and adds no point. */
export const isDoubleClick = (prev: ClickStamp | null, cur: ClickStamp): boolean =>
  !!prev && cur.t - prev.t <= DOUBLE_CLICK_MS && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= DOUBLE_CLICK_PX;
