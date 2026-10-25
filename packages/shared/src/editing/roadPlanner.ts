// Turns a road the user drew (start, optional curve control, end) into one atomic batch command:
// snap endpoints to nodes or existing roads, split roads where the new one connects or crosses,
// then add the new segments between all those points.

import { checkFillet, LIMITS, segmentLength, tryApplyCommand, type FilletGeometry } from '../apply.js';
import type { Command } from '../commands.js';
import {
  closestPointOnPolyline,
  closestTOnQuadBezier,
  cumulativeLengths,
  dist,
  pointAtLength,
  polylineIntersections,
  sampleSegmentCurve,
  splitQuadBezier,
  type Vec2,
} from '../geometry.js';
import type { IdGen } from '../ids.js';
import { cloneJson, type CityDoc, type NodeId, type RoadSegment, type SegmentId } from '../model.js';

export const GRID_SIZE = 8;
export const NODE_SNAP_RADIUS = 7;
export const SEGMENT_SNAP_RADIUS = 6;

export type ResolvedPoint =
  | { kind: 'node'; nodeId: NodeId; pos: Vec2 }
  | { kind: 'split'; segmentId: SegmentId; t: number; pos: Vec2 }
  | { kind: 'free'; pos: Vec2 };

// `+ 0` turns -0 into 0 so snapped points compare equal.
export const snapToGrid = (p: Vec2, size = GRID_SIZE): Vec2 => ({
  x: Math.round(p.x / size) * size + 0,
  z: Math.round(p.z / size) * size + 0,
});

function segmentCurve(doc: CityDoc, s: RoadSegment): Vec2[] {
  return sampleSegmentCurve(doc.nodes[s.a]!.pos, doc.nodes[s.b]!.pos, s.control);
}

/** Bezier/linear parameter of the point on `s` closest to `p`. */
function paramOn(doc: CityDoc, s: RoadSegment, p: Vec2): number {
  const a = doc.nodes[s.a]!.pos;
  const b = doc.nodes[s.b]!.pos;
  if (s.control) return closestTOnQuadBezier(a, s.control, b, p);
  const l2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
  return l2 > 0 ? ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / l2 : 0;
}

/** Snap a cursor position: existing node > point on an existing road > grid. */
export function resolvePoint(doc: CityDoc, p: Vec2, gridSnap = true): ResolvedPoint {
  let bestNode: { id: NodeId; d: number } | null = null;
  for (const n of Object.values(doc.nodes)) {
    const d = dist(n.pos, p);
    if (d <= NODE_SNAP_RADIUS && (!bestNode || d < bestNode.d)) bestNode = { id: n.id, d };
  }
  if (bestNode) return { kind: 'node', nodeId: bestNode.id, pos: doc.nodes[bestNode.id]!.pos };

  let bestSeg: { seg: RoadSegment; point: Vec2; s: number; d: number } | null = null;
  for (const seg of Object.values(doc.segments)) {
    const c = closestPointOnPolyline(segmentCurve(doc, seg), p);
    if (c.distance <= SEGMENT_SNAP_RADIUS && (!bestSeg || c.distance < bestSeg.d)) bestSeg = { seg, point: c.point, s: c.s, d: c.distance };
  }
  if (bestSeg) {
    const total = segmentLength(doc, bestSeg.seg);
    // Too close to an end: connect to that node instead of creating a sliver segment.
    if (bestSeg.s < LIMITS.minSegmentLength) return { kind: 'node', nodeId: bestSeg.seg.a, pos: doc.nodes[bestSeg.seg.a]!.pos };
    if (total - bestSeg.s < LIMITS.minSegmentLength) return { kind: 'node', nodeId: bestSeg.seg.b, pos: doc.nodes[bestSeg.seg.b]!.pos };
    return { kind: 'split', segmentId: bestSeg.seg.id, t: paramOn(doc, bestSeg.seg, bestSeg.point), pos: bestSeg.point };
  }
  return { kind: 'free', pos: gridSnap ? snapToGrid(p) : p };
}

export interface RoadPlanInput {
  start: ResolvedPoint;
  end: ResolvedPoint;
  /** Quadratic Bezier control point for a curved road. */
  control?: Vec2;
  roadTypeId: string;
  /**
   * Automatic fillet (ADR 0012 §1): `start` is the corner node where the straight road drawn just before
   * in the same stroke ended; round that corner in the same batch when it can be. The drawing tool never
   * sets it for a node that existed before the stroke (rounding existing roads is a user action).
   */
  filletStart?: boolean;
}

export interface RoadPlan {
  command: Command | null;
  error?: string;
  /** Junction points along the new road, start to end (for previews). */
  junctions: Vec2[];
  /**
   * filletStart: the corner curve the batch adds, by role: `curve` runs from `onPrev` (tangent point on the
   * road drawn before) to `onNew` (tangent point on the new road, where its straight part now starts).
   */
  fillet?: { curve: Vec2[]; onPrev: Vec2; onNew: Vec2 };
  /** filletStart: why the corner stays sharp (applyCommand error text). */
  filletError?: string;
}

interface Stop {
  /** Bezier parameter (or linear t) along the new road. */
  t: number;
  pos: Vec2;
  ref: ResolvedPoint;
}

const OVERLAP_TOLERANCE = 1;

/** True if the new road runs along an existing road for longer than a minimum segment. */
function overlapsExistingRoad(doc: CityDoc, curve: Vec2[]): boolean {
  const cum = cumulativeLengths(curve);
  const total = cum[cum.length - 1]!;
  const step = 2;
  const samples: Vec2[] = [];
  for (let s = 0; s <= total; s += step) samples.push(pointAtLength(curve, cum, s));
  for (const seg of Object.values(doc.segments)) {
    const existing = segmentCurve(doc, seg);
    let run = 0;
    for (const p of samples) {
      run = closestPointOnPolyline(existing, p).distance < OVERLAP_TOLERANCE ? run + step : 0;
      if (run > LIMITS.minSegmentLength) return true;
    }
  }
  return false;
}

export function planRoad(doc: CityDoc, input: RoadPlanInput, ids: IdGen): RoadPlan {
  const { start, end, control } = input;
  const fail = (error: string): RoadPlan => ({ command: null, error, junctions: [] });
  if (!doc.roadTypes[input.roadTypeId]) return fail('알 수 없는 도로 타입');
  if (dist(start.pos, end.pos) < LIMITS.minSegmentLength) return fail('도로가 너무 짧습니다');
  if (start.kind === 'node' && end.kind === 'node' && start.nodeId === end.nodeId) return fail('같은 지점을 연결할 수 없습니다');

  const curve = sampleSegmentCurve(start.pos, end.pos, control);
  if (overlapsExistingRoad(doc, curve)) return fail('기존 도로와 겹칩니다');
  const tOf = (p: Vec2): number => {
    if (control) return closestTOnQuadBezier(start.pos, control, end.pos, p);
    const d = dist(start.pos, end.pos);
    return d > 0 ? dist(start.pos, p) / d : 0;
  };

  // Segments that touch our endpoints never count as crossings there.
  const touched = new Set<SegmentId>();
  const endpointNodes = new Set<NodeId>();
  for (const r of [start, end]) {
    if (r.kind === 'split') touched.add(r.segmentId);
    if (r.kind === 'node') endpointNodes.add(r.nodeId);
  }
  if (start.kind === 'split' && end.kind === 'split' && start.segmentId === end.segmentId) return fail('같은 도로 위 두 점은 연결할 수 없습니다');

  const stops: Stop[] = [];
  for (const seg of Object.values(doc.segments)) {
    // A crossing exactly on a shared polyline vertex is reported by both neighbouring pieces.
    const hits = polylineIntersections(curve, segmentCurve(doc, seg)).filter(
      (h, i, all) => !all.slice(0, i).some((o) => dist(o.point, h.point) < 0.5),
    );
    const total = segmentLength(doc, seg);
    const useful = hits.filter((h) => {
      const nearNode = h.sb < LIMITS.minSegmentLength ? seg.a : total - h.sb < LIMITS.minSegmentLength ? seg.b : null;
      if (nearNode && endpointNodes.has(nearNode) && Math.min(dist(h.point, start.pos), dist(h.point, end.pos)) < NODE_SNAP_RADIUS) return false;
      if (touched.has(seg.id) && Math.min(dist(h.point, start.pos), dist(h.point, end.pos)) < SEGMENT_SNAP_RADIUS) return false;
      return true;
    });
    if (useful.length === 0) continue;
    if (useful.length > 1 || touched.has(seg.id)) return fail('같은 도로를 여러 번 교차할 수 없습니다');
    const h = useful[0]!;
    let ref: ResolvedPoint;
    if (h.sb < LIMITS.minSegmentLength) ref = { kind: 'node', nodeId: seg.a, pos: doc.nodes[seg.a]!.pos };
    else if (total - h.sb < LIMITS.minSegmentLength) ref = { kind: 'node', nodeId: seg.b, pos: doc.nodes[seg.b]!.pos };
    else ref = { kind: 'split', segmentId: seg.id, t: paramOn(doc, seg, h.point), pos: h.point };
    stops.push({ t: tOf(ref.pos), pos: ref.pos, ref });
  }

  // Merge crossings that resolved to the same existing node (e.g. passing exactly through a junction).
  const unique: Stop[] = [];
  for (const s of stops.sort((p, q) => p.t - q.t)) {
    const prev = unique[unique.length - 1];
    if (prev && prev.ref.kind === 'node' && s.ref.kind === 'node' && prev.ref.nodeId === s.ref.nodeId) continue;
    unique.push(s);
  }
  const points: Stop[] = [{ t: 0, pos: start.pos, ref: start }, ...unique, { t: 1, pos: end.pos, ref: end }];

  const commands: Command[] = [];
  const nodeIds: NodeId[] = [];
  for (const p of points) {
    const r = p.ref;
    if (r.kind === 'node') {
      nodeIds.push(r.nodeId);
    } else if (r.kind === 'free') {
      const id = ids.next('n');
      commands.push({ type: 'node.add', node: { id, pos: r.pos } });
      nodeIds.push(id);
    } else {
      const id = ids.next('n');
      commands.push({ type: 'segment.split', id: r.segmentId, t: r.t, nodeId: id, segmentIds: [ids.next('s'), ids.next('s')] });
      nodeIds.push(id);
    }
  }

  // Cut the new road at each junction parameter and add one segment per piece.
  let rest: { from: Vec2; c?: Vec2; to: Vec2; t0: number } = { from: start.pos, c: control, to: end.pos, t0: 0 };
  for (let i = 1; i < points.length; i++) {
    const a = nodeIds[i - 1]!;
    const b = nodeIds[i]!;
    if (a === b) return fail('교차점이 너무 가깝습니다');
    const p = points[i]!;
    let pieceControl: Vec2 | undefined;
    if (rest.c && i < points.length - 1) {
      const local = (p.t - rest.t0) / (1 - rest.t0);
      const sp = splitQuadBezier(rest.from, rest.c, rest.to, local);
      pieceControl = sp.c0;
      rest = { from: sp.mid, c: sp.c1, to: rest.to, t0: p.t };
    } else {
      pieceControl = rest.c;
    }
    const prevPos = points[i - 1]!.pos;
    if (dist(prevPos, p.pos) < LIMITS.minSegmentLength) return fail('교차점 사이 간격이 너무 짧습니다');
    const seg: RoadSegment = { id: ids.next('s'), a, b, roadTypeId: input.roadTypeId };
    if (pieceControl) seg.control = pieceControl;
    commands.push({ type: 'segment.add', segment: seg });
  }

  const plan: RoadPlan = { command: { type: 'batch', commands }, junctions: points.map((p) => p.pos) };
  if (input.filletStart && !control && start.kind === 'node') addStartFillet(doc, plan, commands, start.nodeId, ids);
  return plan;
}

/** Copy of the doc whose collections can be changed by road commands without touching `doc` (values are shared, never mutated). */
function scratchDoc(doc: CityDoc): CityDoc {
  return {
    ...doc,
    nodes: { ...doc.nodes },
    segments: { ...doc.segments },
    buildings: { ...doc.buildings },
    intersections: { ...doc.intersections },
    busStops: { ...doc.busStops },
    busLines: { ...doc.busLines },
    closures: { ...doc.closures },
    parcels: { ...doc.parcels },
    features: { ...doc.features },
  };
}

/** The road.fillet command for a checked corner (`expect` pins the planned geometry). */
function filletCommand(g: FilletGeometry, ids: IdGen, radius?: number): Command {
  return {
    type: 'road.fillet',
    nodeId: g.nodeId,
    ...(radius !== undefined ? { radius } : {}),
    ids: { a: ids.next('n'), b: ids.next('n'), seg: ids.next('s') },
    expect: { segments: [g.segments[0].id, g.segments[1].id], points: [{ ...g.points[0] }, { ...g.points[1] }, { ...g.points[2] }] },
  };
}

const filletCurve = (g: FilletGeometry): Vec2[] => sampleSegmentCurve(g.p0, g.p2, g.points[1]);

/**
 * Append road.fillet of `nodeId` when the corner can be rounded once the new road is in place. The whole
 * batch, fillet included, is dry-run on a scratch doc: if only the fillet fails, it is dropped (the corner
 * stays sharp, `filletError` says why) and the plain road batch is kept.
 */
function addStartFillet(doc: CityDoc, plan: RoadPlan, commands: Command[], nodeId: NodeId, ids: IdGen): void {
  const work = scratchDoc(doc);
  // A batch that fails anyway is reported at dispatch, as without fillets.
  if (!tryApplyCommand(work, plan.command!).ok) return;
  const r = checkFillet(work, nodeId);
  if (!r.ok) {
    if (!/almost straight/.test(r.error)) plan.filletError = r.error;
    return;
  }
  const cmd = filletCommand(r.geometry, ids);
  const applied = tryApplyCommand(work, cmd);
  if (!applied.ok) {
    plan.filletError = applied.error;
    return;
  }
  commands.push(cmd);
  // The new road is the first segment the batch adds at the corner; geometry p0 belongs to the lower-id road.
  const added = commands.find((c) => c.type === 'segment.add' && (c.segment.a === nodeId || c.segment.b === nodeId));
  const newId = added?.type === 'segment.add' ? added.segment.id : '';
  const g = r.geometry;
  const [onPrev, onNew] = g.segments[0].id === newId ? [g.p2, g.p0] : [g.p0, g.p2];
  plan.fillet = { curve: sampleSegmentCurve(onPrev, onNew, g.points[1]), onPrev, onNew };
}

export interface FilletPlan {
  command: Command | null;
  error?: string;
  /** Center line of the corner curve (for previews). */
  curve?: Vec2[];
  /** Minimum curvature radius of the curve, m. */
  radius?: number;
}

/** "모서리 둥글게" on an existing corner: the road.fillet command, or why it cannot be rounded. */
export function planFillet(doc: CityDoc, nodeId: NodeId, ids: IdGen, radius?: number): FilletPlan {
  const r = checkFillet(doc, nodeId, radius);
  if (!r.ok) return { command: null, error: r.error };
  return { command: filletCommand(r.geometry, ids, radius), curve: filletCurve(r.geometry), radius: r.geometry.radius };
}

export interface RoadBatchInfo {
  /** Total length of the segments the batch adds, meters. */
  lengthM: number;
  /** Existing nodes the new segments attach to. */
  connected: number;
  /** Existing segments the batch splits. */
  splits: number;
  /** The new segments' center lines (for previews). */
  pieces: { points: Vec2[]; roadTypeId: string }[];
}

/** What a road batch (as made by planRoad) would build on `doc`; null when it does not apply. `doc` is not touched. */
export function describeRoadBatch(doc: CityDoc, cmd: Command): RoadBatchInfo | null {
  if (cmd.type !== 'batch') return null;
  const work = cloneJson(doc);
  if (!tryApplyCommand(work, cmd).ok) return null;
  const info: RoadBatchInfo = { lengthM: 0, connected: 0, splits: 0, pieces: [] };
  const connected = new Set<NodeId>();
  for (const c of cmd.commands) {
    if (c.type === 'segment.split') info.splits++;
    if (c.type !== 'segment.add') continue;
    const s = work.segments[c.segment.id];
    if (!s) continue;
    info.lengthM += segmentLength(work, s);
    info.pieces.push({ points: segmentCurve(work, s), roadTypeId: s.roadTypeId });
    for (const n of [s.a, s.b]) if (doc.nodes[n]) connected.add(n);
  }
  info.connected = connected.size;
  return info;
}
