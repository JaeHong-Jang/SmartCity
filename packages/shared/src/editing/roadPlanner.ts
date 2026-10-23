// Turns a road the user drew (start, optional curve control, end) into one atomic batch command:
// snap endpoints to nodes or existing roads, split roads where the new one connects or crosses,
// then add the new segments between all those points.

import { LIMITS, segmentLength } from '../apply.js';
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
import type { CityDoc, NodeId, RoadSegment, SegmentId } from '../model.js';

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
}

export interface RoadPlan {
  command: Command | null;
  error?: string;
  /** Junction points along the new road, start to end (for previews). */
  junctions: Vec2[];
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

  return { command: { type: 'batch', commands }, junctions: points.map((p) => p.pos) };
}
