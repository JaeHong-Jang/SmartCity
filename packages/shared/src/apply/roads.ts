// Road-network cascades: segment split/removal, bus stop removal, feature pruning.

import { closestPointOnPolyline, sampleSegmentCurve, splitQuadBezier, type Vec2 } from '../geometry.js';
import { polygonsBlockRoad } from '../editing/buildings.js';
import type { BusStop, CityDoc, RoadFeature, RoadSegment, SegmentId } from '../model.js';
import { buildingsInParcel } from '../planning.js';
import { fail, type Tx } from './tx.js';
import {
  checkId,
  checkNum,
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

/**
 * After roads were added, moved or widened: remove the auto lots whose polygon now overlaps the
 * carriageway or sidewalk of any of `segIds`, together with the auto buildings standing in them
 * (ADR 0009 §4). User parcels and buildings are untouched.
 */
export function pruneAutoLots(doc: CityDoc, segIds: SegmentId[], tx: Tx): void {
  const segs = segIds.map((id) => doc.segments[id]).filter((s): s is RoadSegment => !!s);
  if (segs.length === 0) return;
  for (const p of Object.values(doc.parcels)) {
    if (!p.auto || !polygonsBlockRoad(doc, [p.polygon], segs)) continue;
    for (const id of buildingsInParcel(doc, p)) if (doc.buildings[id]!.auto) tx.set(doc.buildings, id, undefined);
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
  for (const nodeId of [s.a, s.b]) {
    replaceApproach(doc, nodeId, s.id, [], tx);
    if (segmentsAtNode(doc, nodeId).length === 0) {
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
