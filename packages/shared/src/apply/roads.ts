// Road-network cascades: segment split/removal, bus stop removal, feature pruning.

import { angleBetween, bounds, boundsOverlap, closestPointOnPolyline, dist, normalize, pointInPolygon, pointSegmentDistance, quadBezier, sampleSegmentCurve, segmentIntersection, splitQuadBezier, sub, type Bounds, type Vec2 } from '../geometry.js';
import { buildingFootprints, polygonsBlockRoad } from '../editing/buildings.js';
import { FILLET_MAX_TURN, FILLET_MIN_TURN, filletFloor, legRoom, minFilletTangent, planCorner, preferredFilletRadius } from '../editing/fillet.js';
import type { Command } from '../commands.js';
import type { BusStop, CityDoc, NodeId, RoadFeature, RoadSegment, SegmentId } from '../model.js';
import { buildingsInParcel } from '../planning.js';
import { roadHalfWidth } from '../roads.js';
import { CONTACT_BUDGET, fail, policy, type Tx } from './tx.js';
import { curveBoxes, roadHullBox, TxIndex } from './spatial.js';
import {
  checkId,
  checkNoNewCrossings,
  checkNum,
  checkPos,
  checkSegmentShape,
  featureEndsClear,
  featureGapClear,
  get,
  has,
  segmentLength,
  segmentsAtNode,
} from './validate.js';

/** Crosswalks need sidewalks to land on: removing the sidewalks removes them. */
export function dropCrosswalks(doc: CityDoc, match: (f: RoadFeature) => boolean, tx: Tx): void {
  for (const f of Object.values(doc.features)) if (f.kind === 'crosswalk' && match(f)) tx.set(doc.features, f.id, undefined);
}

/**
 * After a segment changed shape: keep its features that still satisfy the end clearance and spacing
 * rules (in t order, ties by id) and remove the others — the same rules validateFeature applies.
 */
export function pruneFeatures(doc: CityDoc, segId: SegmentId, tx: Tx): void {
  const seg = doc.segments[segId];
  if (!seg) return;
  const len = segmentLength(doc, seg);
  const list = Object.values(doc.features)
    .filter((f) => f.segmentId === segId)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  let last = -Infinity;
  for (const f of list) {
    const s = f.t * len;
    if (!featureEndsClear(s, len) || !featureGapClear(s - last)) {
      tx.set(doc.features, f.id, undefined);
      continue;
    }
    last = s;
  }
}

/** `ifClear` of segment.add: refuse a road that crosses any building or automatic lot instead of pruning them. */
/** Boxes around a road's surface (center line ± half width), piece by piece. */
function roadSurfaceBoxes(doc: CityDoc, s: RoadSegment): Bounds[] {
  const rt = doc.roadTypes[s.roadTypeId];
  const a = doc.nodes[s.a]?.pos;
  const b = doc.nodes[s.b]?.pos;
  if (!rt || !a || !b) return [];
  return curveBoxes(a, b, s.control, roadHalfWidth(rt) + 1);
}

const checkLimit = (): never => fail('the new road could not be checked against nearby roads (contact check limit)');

export function checkRoadClear(doc: CityDoc, seg: RoadSegment, tx: Tx): void {
  // Only buildings and lots near the road can block it (the transaction's index, charged to its budget).
  const idx = TxIndex.of(doc, tx);
  const boxes = roadSurfaceBoxes(doc, seg);
  const buildings = idx.buildingsNear(boxes, tx.contact) ?? checkLimit();
  for (const id of buildings) {
    const b = doc.buildings[id]!;
    const t = doc.buildingTypes[b.typeId];
    if (t && polygonsBlockRoad(doc, buildingFootprints(b, t), [seg])) fail('road would cross a building');
  }
  const parcels = idx.parcelsNear(boxes, tx.contact) ?? checkLimit();
  for (const id of parcels) {
    const p = doc.parcels[id]!;
    if (p.auto && polygonsBlockRoad(doc, [p.polygon], [seg])) fail('road would cross a zoned lot');
  }
}

/**
 * After roads were added, moved or widened: remove the auto lots whose polygon now overlaps the
 * carriageway or sidewalk of any of `segIds`, together with the auto buildings standing in them
 * (ADR 0009 §4). User parcels and buildings are untouched.
 */
export function pruneAutoLots(doc: CityDoc, segIds: SegmentId[], tx: Tx): void {
  const segs = segIds.map((id) => doc.segments[id]).filter((s): s is RoadSegment => !!s);
  if (segs.length === 0) return;
  // Only lots near the roads can overlap them, and only buildings inside a lot's box can stand in it
  // (the transaction's index, charged to its budget; same lots and buildings, same order as a full scan).
  const idx = TxIndex.of(doc, tx);
  const lots = idx.parcelsNear(segs.flatMap((s) => roadSurfaceBoxes(doc, s)), tx.contact) ?? checkLimit();
  for (const pid of lots) {
    const p = doc.parcels[pid]!;
    if (!p.auto || !polygonsBlockRoad(doc, [p.polygon], segs)) continue;
    const near = idx.buildingsNear([bounds(p.polygon)], tx.contact) ?? checkLimit();
    for (const id of near) if (pointInPolygon(doc.buildings[id]!.pos, p.polygon) && doc.buildings[id]!.auto) tx.set(doc.buildings, id, undefined);
    tx.set(doc.parcels, p.id, undefined);
  }
}

export function removeStop(doc: CityDoc, stopId: string, tx: Tx): void {
  tx.set(doc.busStops, stopId, undefined);
  for (const line of Object.values(doc.busLines)) {
    if (!line.stopIds.includes(stopId)) continue;
    const stopIds = line.stopIds.filter((id) => id !== stopId);
    // A line needs at least two stops; drop it otherwise.
    tx.set(doc.busLines, line.id, stopIds.length >= 2 ? { ...line, stopIds } : undefined);
  }
}

function replaceApproach(doc: CityDoc, nodeId: string, from: SegmentId, to: SegmentId[], tx: Tx): void {
  let c = doc.intersections[nodeId];
  if (c?.crosswalkLegs?.includes(from)) {
    c = { ...c, crosswalkLegs: c.crosswalkLegs.flatMap((l) => (l === from ? to : [l])).sort() };
    tx.set(doc.intersections, nodeId, c);
  }
  if (!c?.phases) return;
  const phases = c.phases
    .map((p) => ({ ...p, approaches: p.approaches.flatMap((a) => (a === from ? to : [a])) }))
    .filter((p) => p.approaches.length > 0);
  if (phases.length === 0) {
    const { phases: _dropped, ...rest } = c;
    tx.set(doc.intersections, nodeId, rest);
  } else {
    tx.set(doc.intersections, nodeId, { ...c, phases });
  }
}

export function removeSegment(doc: CityDoc, s: RoadSegment, tx: Tx): void {
  tx.set(doc.segments, s.id, undefined);
  for (const stop of Object.values(doc.busStops)) if (stop.segmentId === s.id) removeStop(doc, stop.id, tx);
  if (has(doc.closures, s.id)) tx.set(doc.closures, s.id, undefined);
  for (const f of Object.values(doc.features)) if (f.segmentId === s.id) tx.set(doc.features, f.id, undefined);
  const idx = TxIndex.of(doc, tx);
  for (const nodeId of [s.a, s.b]) {
    replaceApproach(doc, nodeId, s.id, [], tx);
    // Orphan check from the transaction's road adjacency (not a scan of every road per removal).
    if (idx.segmentsAt(nodeId).length === 0) {
      tx.set(doc.nodes, nodeId, undefined);
      if (has(doc.intersections, nodeId)) tx.set(doc.intersections, nodeId, undefined);
    }
  }
}

export function splitSegment(
  doc: CityDoc,
  id: SegmentId,
  t: number,
  nodeId: string,
  ids: [SegmentId, SegmentId],
  tx: Tx,
): void {
  const s = get(doc.segments, id);
  if (!s) fail('unknown segment');
  // Piece lengths are validated below; t only has to be strictly inside the curve.
  checkNum(t, 0, 1, 'split t');
  if (t <= 0 || t >= 1) fail('split t must be inside the segment');
  checkId(nodeId, 'node');
  if (has(doc.nodes, nodeId)) fail('node exists');
  if (!Array.isArray(ids) || ids.length !== 2) fail('split needs two segment ids');
  checkId(ids[0], 'segment');
  checkId(ids[1], 'segment');
  if (ids[0] === ids[1] || has(doc.segments, ids[0]) || has(doc.segments, ids[1])) fail('invalid split segment ids');
  const a = doc.nodes[s.a]!.pos;
  const b = doc.nodes[s.b]!.pos;

  let mid: Vec2;
  let c0: Vec2 | undefined;
  let c1: Vec2 | undefined;
  if (s.control) {
    ({ mid, c0, c1 } = splitQuadBezier(a, s.control, b, t));
  } else {
    mid = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }

  const first: RoadSegment = { id: ids[0], a: s.a, b: nodeId, roadTypeId: s.roadTypeId };
  const second: RoadSegment = { id: ids[1], a: nodeId, b: s.b, roadTypeId: s.roadTypeId };
  if (s.schoolZone) first.schoolZone = second.schoolZone = true;
  if (c0 && c1) {
    first.control = c0;
    second.control = c1;
  }

  // Measure the split position by arc length so stops keep their real location.
  const total = segmentLength(doc, s);
  tx.set(doc.nodes, nodeId, { id: nodeId, pos: mid });
  tx.set(doc.segments, s.id, undefined);
  tx.set(doc.segments, first.id, first);
  tx.set(doc.segments, second.id, second);
  checkSegmentShape(doc, first);
  checkSegmentShape(doc, second);
  const firstLen = segmentLength(doc, first);
  const splitS = total > 0 ? firstLen / total : t;

  for (const stop of Object.values(doc.busStops)) {
    if (stop.segmentId !== s.id) continue;
    const moved: BusStop =
      stop.t < splitS
        ? { ...stop, segmentId: first.id, t: stop.t / splitS }
        : { ...stop, segmentId: second.id, t: (stop.t - splitS) / (1 - splitS) };
    tx.set(doc.busStops, stop.id, moved);
  }
  // Features move with their arc-length position (each piece measured on its own curve); those that
  // now sit in the new junction are dropped by the same rules that validate a new feature.
  const secondLen = segmentLength(doc, second);
  for (const f of Object.values(doc.features)) {
    if (f.segmentId !== s.id) continue;
    const onFirst = f.t < splitS;
    const local = onFirst ? f.t * total : f.t * total - firstLen;
    const t = Math.min(1, Math.max(0, onFirst ? local / firstLen : local / secondLen));
    tx.set(doc.features, f.id, { ...f, segmentId: onFirst ? first.id : second.id, t });
  }
  pruneFeatures(doc, first.id, tx);
  pruneFeatures(doc, second.id, tx);
  // Lots keep facing the half of the road they are next to. (segment.remove instead leaves its lots
  // in place with a dangling frontage; growth skips them.)
  const firstPts = sampleSegmentCurve(a, mid, c0);
  const secondPts = sampleSegmentCurve(mid, doc.nodes[s.b]!.pos, c1);
  for (const p of Object.values(doc.parcels)) {
    if (p.frontage?.segmentId !== s.id) continue;
    let cx = 0;
    let cz = 0;
    for (const v of p.polygon) {
      cx += v.x / p.polygon.length;
      cz += v.z / p.polygon.length;
    }
    const c = { x: cx, z: cz };
    const onFirst = closestPointOnPolyline(firstPts, c).distance <= closestPointOnPolyline(secondPts, c).distance;
    tx.set(doc.parcels, p.id, { ...p, frontage: { segmentId: onFirst ? first.id : second.id, side: p.frontage.side } });
  }
  const closure = doc.closures[s.id];
  if (closure) {
    tx.set(doc.closures, s.id, undefined);
    tx.set(doc.closures, first.id, { ...closure, segmentId: first.id });
    tx.set(doc.closures, second.id, { ...closure, segmentId: second.id });
  }
  replaceApproach(doc, s.a, s.id, [first.id], tx);
  replaceApproach(doc, s.b, s.id, [second.id], tx);
}

// ---------- road.fillet (ADR 0012 §1) ----------

/** Junction crosswalk zone kept at a far end of degree ≥ 3 (matches the sim compiler's CROSSWALK_ZONE). */
const JUNCTION_CROSSWALK_ZONE = 4;
/** Two roads of one type meeting within this angle continue without a junction cut (sim: CONTINUE_ANGLE). */
const CONTINUE_ANGLE = (20 * Math.PI) / 180;
const FILLET_EPS = 1e-6;
/** Upper bound of an explicit fillet radius, m. */
export const FILLET_MAX_RADIUS = 1000;

function notRounded(why: string): never {
  fail(`cannot round the corner: ${why}`);
}

/** Unit direction leaving `nodeId` along the segment (true end tangent, also for curves). */
function awayDir(doc: CityDoc, s: RoadSegment, nodeId: NodeId): Vec2 {
  const here = doc.nodes[nodeId]!.pos;
  const next = s.control ?? doc.nodes[s.a === nodeId ? s.b : s.a]!.pos;
  return normalize(sub(next, here));
}

/**
 * Length the far end `far` of leg `seg` needs for itself (length budget): 0 at a dead end or where the
 * road just continues, the smallest fillet of a straight corner that may be rounded later (so both ends
 * of one road share it), otherwise the junction cut (half width + 1, plus the crosswalk zone at 3+ legs).
 */
function farEndReserve(doc: CityDoc, seg: RoadSegment, far: NodeId): number {
  const here = segmentsAtNode(doc, far);
  if (here.length <= 1) return 0;
  let hw = 0;
  for (const s of here) {
    const t = doc.roadTypes[s.roadTypeId];
    if (t) hw = Math.max(hw, roadHalfWidth(t));
  }
  if (here.length >= 3) return hw + 1 + JUNCTION_CROSSWALK_ZONE;
  const other = here.find((s) => s.id !== seg.id)!;
  if (other.roadTypeId === seg.roadTypeId) {
    const x = doc.nodes[far]!.pos;
    if (!seg.control && !other.control) {
      const p = doc.nodes[seg.a === far ? seg.b : seg.a]!.pos;
      const q = doc.nodes[other.a === far ? other.b : other.a]!.pos;
      const d = Math.abs(angleBetween(normalize(sub(x, p)), normalize(sub(q, x))));
      if (d >= FILLET_MIN_TURN && d <= FILLET_MAX_TURN) return minFilletTangent(p, x, q, filletFloor(doc.roadTypes[seg.roadTypeId]!));
    }
    if (Math.abs(angleBetween(awayDir(doc, seg, far), sub({ x: 0, z: 0 }, awayDir(doc, other, far)))) < CONTINUE_ANGLE) return 0;
  }
  return hw + 1;
}

export interface FilletGeometry {
  nodeId: NodeId;
  /** The two roads at the corner, lower id first. */
  segments: [RoadSegment, RoadSegment];
  /** Far end positions of the two roads and the corner itself. */
  points: [Vec2, Vec2, Vec2];
  /** Tangent length (how far each road is shortened) and the curve's minimum curvature radius. */
  t: number;
  radius: number;
  /** New ends: on the first road, on the second road. */
  p0: Vec2;
  p2: Vec2;
  /** The curve runs from the second road to the first (follows the one-way / lane direction). */
  reversed: boolean;
}

/** Arc length from the corner along a straight leg of length `len` to the position `t` (fraction from node a). */
const fromCorner = (seg: RoadSegment, nodeId: NodeId, t: number, len: number): number => (seg.a === nodeId ? t * len : (1 - t) * len);

/**
 * Validate a fillet of `nodeId` against the current doc and compute it (throws through fail()). Initial
 * scope (ADR 0012 §1): two straight roads of one type at a degree-2 node without own control settings,
 * and no stop, bus line, closure, crosswalk or speed bump, or facing lot in the stretch that is cut away.
 */
export function planNodeFillet(doc: CityDoc, nodeId: unknown, radius?: unknown, tx?: Tx): FilletGeometry {
  const node = get(doc.nodes, nodeId);
  if (!node) fail('unknown node');
  const segs = segmentsAtNode(doc, node.id).sort((p, q) => (p.id < q.id ? -1 : 1));
  if (segs.length !== 2) notRounded('the corner must join exactly two roads');
  const [s1, s2] = segs as [RoadSegment, RoadSegment];
  if (s1.control || s2.control) notRounded('only straight roads can be rounded');
  if (s1.roadTypeId !== s2.roadTypeId) notRounded('the two roads differ in type');
  if (!!s1.schoolZone !== !!s2.schoolZone) notRounded('the two roads differ in school zone');
  const rt = doc.roadTypes[s1.roadTypeId]!;
  const inOut = s1.b === node.id && s2.a === node.id;
  const outIn = s1.a === node.id && s2.b === node.id;
  if (!inOut && !outIn && rt.lanesForward !== rt.lanesBackward) notRounded('the roads run in opposite directions');
  if (has(doc.intersections, node.id)) notRounded('the junction has its own control settings');
  const floor = filletFloor(rt);
  if (radius !== undefined) checkNum(radius, floor, FILLET_MAX_RADIUS, 'fillet radius');
  const far1 = s1.a === node.id ? s1.b : s1.a;
  const far2 = s2.a === node.id ? s2.b : s2.a;
  const a = doc.nodes[far1]!.pos;
  const c = doc.nodes[far2]!.pos;
  const v = node.pos;
  const len1 = dist(a, v);
  const len2 = dist(v, c);
  const corner = planCorner({
    a,
    v,
    b: c,
    floor,
    preferred: (radius as number | undefined) ?? preferredFilletRadius(rt),
    roomA: legRoom(len1, farEndReserve(doc, s1, far1)),
    roomB: legRoom(len2, farEndReserve(doc, s2, far2)),
  });
  if (corner.kind === 'skip') notRounded('the corner is almost straight');
  if (corner.kind === 'reject') {
    if (corner.reason === 'tooSharp') notRounded('the turn is too sharp');
    if (corner.reason === 'noRoom') notRounded('not enough room on the roads');
    notRounded('degenerate corner');
  }
  const { t } = corner;
  // References in the cut-away stretch are not moved in this version: refuse instead.
  for (const s of segs) if (has(doc.closures, s.id)) notRounded('a road is closed');
  const lens = new Map([
    [s1.id, len1],
    [s2.id, len2],
  ]);
  for (const stop of Object.values(doc.busStops)) {
    const len = lens.get(stop.segmentId);
    if (len !== undefined && fromCorner(doc.segments[stop.segmentId]!, node.id, stop.t, len) < t + FILLET_EPS) notRounded('a bus stop is in the corner');
  }
  for (const line of Object.values(doc.busLines)) {
    if (line.stopIds.some((id) => lens.has(doc.busStops[id]?.segmentId ?? ''))) notRounded('a bus line serves the roads');
  }
  for (const f of Object.values(doc.features)) {
    const len = lens.get(f.segmentId);
    if (len === undefined) continue;
    const s = fromCorner(doc.segments[f.segmentId]!, node.id, f.t, len) - t;
    if (!featureEndsClear(s, len - t)) notRounded(f.kind === 'crosswalk' ? 'a crosswalk is in the corner' : 'a speed bump is in the corner');
  }
  for (const p of Object.values(doc.parcels)) {
    const sid = p.frontage?.segmentId;
    const len = sid !== undefined ? lens.get(sid) : undefined;
    if (len === undefined) continue;
    const u = normalize(sub(sid === s1.id ? a : c, v));
    const near = Math.min(...p.polygon.map((q) => Math.max(0, (q.x - v.x) * u.x + (q.z - v.z) * u.z)));
    if (near < t + FILLET_EPS) notRounded('a lot faces the corner');
  }
  if (policy.enforce) checkCurveClear(doc, s1, s2, corner.p0, corner.p2, v, tx);
  return { nodeId: node.id, segments: [s1, s2], points: [a, v, c], t, radius: corner.radius, p0: corner.p0, p2: corner.p2, reversed: outIn };
}

/**
 * The new curve must not cross another road or run over a building or an automatic lot (the `ifClear`
 * rule of road placement; nothing is removed for a fillet). The shortened straight roads only lose
 * length, so they cannot gain an overlap.
 */
function checkCurveClear(doc: CityDoc, s1: RoadSegment, s2: RoadSegment, p0: Vec2, p2: Vec2, v: Vec2, tx: Tx | undefined): void {
  // A two-node view is enough for polygonsBlockRoad (it reads the segment's nodes and road type only).
  const view = { ...doc, nodes: { p0: { id: 'p0', pos: p0 }, p2: { id: 'p2', pos: p2 } } } as CityDoc;
  const curveSeg: RoadSegment = { id: '', a: 'p0', b: 'p2', roadTypeId: s1.roadTypeId, control: v };
  for (const b of Object.values(doc.buildings)) {
    const type = doc.buildingTypes[b.typeId];
    if (type && polygonsBlockRoad(view, buildingFootprints(b, type), [curveSeg])) notRounded('the curve would cross a building');
  }
  for (const p of Object.values(doc.parcels)) if (p.auto && polygonsBlockRoad(view, [p.polygon], [curveSeg])) notRounded('the curve would cross a zoned lot');
  const hit = crossedRoad(doc, { a: p0, b: p2, control: v }, (o) => o.id === s1.id || o.id === s2.id, () => [], tx?.contact, tx && TxIndex.of(doc, tx));
  if (hit?.unverified) notRounded('the curve could not be checked against nearby roads (check limit)');
  if (hit) notRounded('the curve would cross another road');
}

/**
 * Two roads are in CONTACT when their center lines come closer than this (m): crossing, touching at a
 * point (also tangentially), or running along each other (collinear overlap). Decided on the true curves
 * (see `curvesTouch`), not on sampled polylines.
 */
export const ROAD_CONTACT_EPS = 0.05;
/**
 * Precision of the contact decision (m): a piece pair is decided from its chords once the two chords'
 * deviation bounds add up to at most this. Contract: true distance < ROAD_CONTACT_EPS − 2·CONTACT_PRECISION
 * (0.0499 m) is always contact; ≥ ROAD_CONTACT_EPS is never contact; in between it may go either way.
 */
export const CONTACT_PRECISION = 5e-5;
export { CONTACT_BUDGET } from './tx.js';
/** Contact this close to a junction node the two roads share is that junction. */
const SHARED_NODE_RADIUS = 1;
/**
 * Recursion path guard. Each split halves ONE of the two pieces (the longer one), so this bounds the path,
 * not the work (the budget does that); with CONTACT_PRECISION a path normally ends after a few dozen splits.
 */
const MAX_DEPTH = 96;

interface Curve {
  a: Vec2;
  b: Vec2;
  control?: Vec2;
}

const curvePoint = (c: Curve, t: number): Vec2 =>
  c.control ? quadBezier(c.a, c.control, c.b, t) : { x: c.a.x + (c.b.x - c.a.x) * t, z: c.a.z + (c.b.z - c.a.z) * t };

/**
 * The same point set with exact degenerate cases removed: a quadratic whose control point is collinear with
 * its end points is a straight segment (when it folds back past an end, the segment reaches its turnaround
 * point), so it is handled with exact segment distances and no deviation bound.
 */
function normalizeCurve(c: Curve): Curve {
  if (!c.control) return c;
  const ax = c.control.x - c.a.x;
  const az = c.control.z - c.a.z;
  const bx = c.b.x - c.control.x;
  const bz = c.b.z - c.control.z;
  const la = Math.hypot(ax, az);
  const lb = Math.hypot(bx, bz);
  if (la === 0 || lb === 0) return { a: c.a, b: c.b };
  // Only EXACTLY collinear: a nearly collinear quad keeps its (tiny) deviation bound on the quad path.
  if (ax * bz - az * bx !== 0) return c;
  // Collinear: the curve covers the line between its extreme points (ends, or the turnaround of a fold-back).
  const ux = c.b.x - c.a.x;
  const uz = c.b.z - c.a.z;
  const pts = [c.a, c.b];
  const dx = ax - bx;
  const dz = az - bz;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? (ax * dx + az * dz) / l2 : -1;
  if (t > 0 && t < 1) pts.push(curvePoint(c, t));
  const along = (p: Vec2): number => (p.x - c.a.x) * (ux || ax) + (p.z - c.a.z) * (uz || az);
  pts.sort((p, q) => along(p) - along(q));
  return { a: pts[0]!, b: pts[pts.length - 1]! };
}

/** Control points of the piece [t0, t1] of a curve (its convex hull contains that piece). */
function pieceHull(c: Curve, t0: number, t1: number): Vec2[] {
  const p0 = curvePoint(c, t0);
  const p1 = curvePoint(c, t1);
  if (!c.control) return [p0, p1];
  // Quadratic piece: control = B(t0) + (t1 − t0)·B'(t0)/2, B'(t) = 2((1−t)(C−A) + t(B−C)).
  const h = t1 - t0;
  const dx = (1 - t0) * (c.control.x - c.a.x) + t0 * (c.b.x - c.control.x);
  const dz = (1 - t0) * (c.control.z - c.a.z) + t0 * (c.b.z - c.control.z);
  return [p0, { x: p0.x + h * dx, z: p0.z + h * dz }, p1];
}

/** Chord-to-curve deviation bound of a piece of parameter length h: |A − 2C + B|·h²/4 (0 for a straight). */
const sagBound = (c: Curve, h: number): number => (c.control ? (Math.hypot(c.a.x - 2 * c.control.x + c.b.x, c.a.z - 2 * c.control.z + c.b.z) / 4) * h * h : 0);

/** Closest approach of two segments: distance and a point where it happens (the crossing point if they cross). */
function segmentContact(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): { d: number; at: Vec2 } {
  const hit = segmentIntersection(p1, p2, q1, q2);
  if (hit) return { d: 0, at: hit.point };
  let best = { d: pointSegmentDistance(p1, q1, q2), at: p1 };
  for (const [p, a, b] of [
    [p2, q1, q2],
    [q1, p1, p2],
    [q2, p1, p2],
  ] as const) {
    const d = pointSegmentDistance(p, a, b);
    if (d < best.d) best = { d, at: p };
  }
  return best;
}

export type ContactResult = 'contact' | 'clear' | 'budget';

/**
 * Whether two curves come closer than ROAD_CONTACT_EPS anywhere outside SHARED_NODE_RADIUS of the `shared`
 * points (precision: CONTACT_PRECISION). Adaptive subdivision with guaranteed bounds: a piece pair is
 * dropped when the hulls are apart or the chord distance minus both deviation bounds is ≥ eps, accepted
 * when the distance plus the bounds is < eps clear of the shared zones, decided from the chords once the
 * bounds are within the precision, and split otherwise. `budget.left` piece-pair evaluations are shared by
 * the caller; running out returns 'budget'.
 */
export function curvesTouch(A0: Curve, B0: Curve, shared: readonly Vec2[], budget: { left: number } = { left: CONTACT_BUDGET }): ContactResult {
  const A = normalizeCurve(A0);
  const B = normalizeCurve(B0);
  const outside = (p: Vec2, margin: number): boolean => shared.every((s) => dist(s, p) >= SHARED_NODE_RADIUS + margin);
  const go = (ta0: number, ta1: number, tb0: number, tb1: number, depth: number): ContactResult => {
    if (--budget.left < 0) return 'budget';
    const ha = pieceHull(A, ta0, ta1);
    const hb = pieceHull(B, tb0, tb1);
    if (!boundsOverlap(bounds(ha), bounds(hb), ROAD_CONTACT_EPS)) return 'clear';
    const pa0 = ha[0]!;
    const pa1 = ha[ha.length - 1]!;
    const pb0 = hb[0]!;
    const pb1 = hb[hb.length - 1]!;
    const sagA = sagBound(A, ta1 - ta0);
    const sagB = sagBound(B, tb1 - tb0);
    const sag = sagA + sagB;
    const c = segmentContact(pa0, pa1, pb0, pb1);
    if (c.d - sag >= ROAD_CONTACT_EPS) return 'clear';
    // A piece entirely inside a shared junction zone: any contact there is the junction.
    for (const s of shared) if (ha.every((p) => dist(p, s) < SHARED_NODE_RADIUS) || hb.every((p) => dist(p, s) < SHARED_NODE_RADIUS)) return 'clear';
    const near = c.d + sag < ROAD_CONTACT_EPS;
    if (near && outside(c.at, sag)) return 'contact';
    // Within the precision: decide from the chords (see CONTACT_PRECISION for what this guarantees). Only
    // a near pair whose closest point lies by a shared zone is split further, to separate it from the zone.
    if (sag <= CONTACT_PRECISION) {
      if (!near) return 'clear';
      if (outside(c.at, 0)) return 'contact';
    }
    if (depth >= MAX_DEPTH) return near && outside(c.at, 0) ? 'contact' : 'clear';
    // Split the longer piece.
    let r: ContactResult;
    if (dist(pa0, pa1) + sagA >= dist(pb0, pb1) + sagB) {
      const m = (ta0 + ta1) / 2;
      r = go(ta0, m, tb0, tb1, depth + 1);
      return r !== 'clear' ? r : go(m, ta1, tb0, tb1, depth + 1);
    }
    const m = (tb0 + tb1) / 2;
    r = go(ta0, ta1, tb0, m, depth + 1);
    return r !== 'clear' ? r : go(ta0, ta1, m, tb1, depth + 1);
  };
  return go(0, 1, 0, 1, 0);
}

/**
 * First road (id order) in contact with `curve` (see ROAD_CONTACT_EPS), or `unverified` when the shared
 * CONTACT_BUDGET ran out. `sharedWith(o)`: positions of the nodes road `o` really shares (by id) with the new
 * road; only there is contact the junction. With the transaction's `grid`, only the roads filed under the
 * curve's cells are candidates (cells and candidates are charged to the budget); without it (UI previews)
 * every road is. Candidates whose control-point hull is farther than eps from the curve's hull are rejected
 * before any curve math.
 */
export function crossedRoad(
  doc: CityDoc,
  curve: Curve,
  skip: (o: RoadSegment) => boolean,
  sharedWith: (o: RoadSegment) => Vec2[],
  budget: { left: number } = { left: CONTACT_BUDGET },
  index?: TxIndex,
): { road: RoadSegment | null; unverified?: true } | null {
  const box = bounds(pieceHull(curve, 0, 1));
  const roads = index ? index.roadsNear(curveBoxes(curve.a, curve.b, curve.control, ROAD_CONTACT_EPS), budget) : Object.keys(doc.segments).sort().map((id) => doc.segments[id]!);
  if (!roads) return { road: null, unverified: true };
  for (const o of roads) {
    if (skip(o)) continue;
    const ob = roadHullBox(doc, o);
    if (!ob || !boundsOverlap(box, ob, ROAD_CONTACT_EPS)) continue;
    const r = curvesTouch(curve, { a: doc.nodes[o.a]!.pos, b: doc.nodes[o.b]!.pos, ...(o.control ? { control: o.control } : {}) }, sharedWith(o), budget);
    if (r === 'contact') return { road: o };
    if (r === 'budget') return { road: o, unverified: true };
  }
  return null;
}

/**
 * A new road may meet other roads only at its own end nodes (enforced edits). The planner splits roads
 * where a new one crosses them; this refuses a plan made before someone else built a road across it, an AI
 * road, or any hand-made segment that would cross without a junction. Trusted replay skips it.
 */
/** The transaction index in the form checkNoNewCrossings takes (roads at a node; roads near a box, budgeted). */
export function nearRoads(doc: CityDoc, tx: Tx): { at: (nodeId: string) => RoadSegment[]; roads: (box: Bounds) => RoadSegment[] | null } {
  const idx = TxIndex.of(doc, tx);
  return { at: (n) => idx.segmentsAt(n), roads: (box) => idx.roadsNear([box], tx.contact) };
}

export function checkSegmentCrossings(doc: CityDoc, seg: RoadSegment, tx: Tx): void {
  if (!policy.enforce) return;
  const curve = { a: doc.nodes[seg.a]!.pos, b: doc.nodes[seg.b]!.pos, ...(seg.control ? { control: seg.control } : {}) };
  // Each road may meet the new one only at the nodes it really shares with it (by id), nowhere else.
  const sharedWith = (o: RoadSegment): Vec2[] => [seg.a, seg.b].filter((n) => n === o.a || n === o.b).map((n) => doc.nodes[n]!.pos);
  const hit = crossedRoad(doc, curve, (o) => o.id === seg.id, sharedWith, tx.contact, TxIndex.of(doc, tx));
  if (hit?.unverified) fail('the new road could not be checked against nearby roads (contact check limit)');
  if (hit) fail('the new road would cross another road without a junction');
}

const samePoint = (p: Vec2 | undefined, q: Vec2): boolean => !!p && typeof p === 'object' && Math.abs(p.x - q.x) <= FILLET_EPS && Math.abs(p.z - q.z) <= FILLET_EPS;

/**
 * road.fillet: shorten both roads by T (their ids stay; the corner end moves to a new node), add the
 * curve with control point = the old corner, and remove the corner node. Stops and features on the kept
 * stretches keep their world position (their t is remapped to the shorter road).
 */
export function filletCorner(doc: CityDoc, cmd: Extract<Command, { type: 'road.fillet' }>, tx: Tx): void {
  const g = planNodeFillet(doc, cmd.nodeId, cmd.radius, tx);
  const [s1, s2] = g.segments;
  if (cmd.expect !== undefined) {
    const e = cmd.expect;
    const segsOk = Array.isArray(e?.segments) && e.segments.length === 2 && e.segments[0] === s1.id && e.segments[1] === s2.id;
    const ptsOk = Array.isArray(e?.points) && e.points.length === 3 && g.points.every((p, i) => samePoint(e.points[i], p));
    if (!segsOk || !ptsOk) notRounded('the corner changed since it was planned');
  }
  const ids = cmd.ids;
  checkId(ids?.a, 'node');
  checkId(ids.b, 'node');
  checkId(ids.seg, 'segment');
  if (ids.a === ids.b || has(doc.nodes, ids.a) || has(doc.nodes, ids.b)) fail('invalid fillet node ids');
  if (has(doc.segments, ids.seg)) fail('segment exists');
  checkPos(doc, g.p0, 'fillet point');
  checkPos(doc, g.p2, 'fillet point');

  const corner = g.nodeId;
  const shorten = (s: RoadSegment, newEnd: NodeId): void => {
    const len = segmentLength(doc, s);
    const kept = len - g.t;
    const remap = (t: number): number => Math.min(1, Math.max(0, (s.a === corner ? t * len - g.t : t * len) / kept));
    for (const stop of Object.values(doc.busStops)) if (stop.segmentId === s.id) tx.set(doc.busStops, stop.id, { ...stop, t: remap(stop.t) });
    for (const f of Object.values(doc.features)) if (f.segmentId === s.id) tx.set(doc.features, f.id, { ...f, t: remap(f.t) });
    tx.set(doc.segments, s.id, s.a === corner ? { ...s, a: newEnd } : { ...s, b: newEnd });
  };
  tx.set(doc.nodes, ids.a, { id: ids.a, pos: g.p0 });
  tx.set(doc.nodes, ids.b, { id: ids.b, pos: g.p2 });
  shorten(s1, ids.a);
  shorten(s2, ids.b);
  const v = g.points[1];
  const curve: RoadSegment = { id: ids.seg, a: g.reversed ? ids.b : ids.a, b: g.reversed ? ids.a : ids.b, roadTypeId: s1.roadTypeId, control: { x: v.x, z: v.z } };
  if (s1.schoolZone) curve.schoolZone = true;
  tx.set(doc.segments, curve.id, curve);
  tx.set(doc.nodes, corner, undefined);
  for (const s of [doc.segments[s1.id]!, doc.segments[s2.id]!, curve]) checkSegmentShape(doc, s);
  const near = nearRoads(doc, tx);
  checkNoNewCrossings(doc, ids.a, near);
  checkNoNewCrossings(doc, ids.b, near);
  pruneAutoLots(doc, [curve.id], tx);
}
