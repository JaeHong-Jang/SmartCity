// Click → scenario target. Pure functions over the copy's doc and compiled road graph.

import { closestPointOnPolyline, type Vec2 } from '@smartcity/shared';
import type { RoadGraph } from '@smartcity/sim';
import type { PickIndex } from '../tools/picking';

export interface AccidentSpot {
  segmentId: string;
  /** Index into the segment's lanes, forward lanes first (ScenarioTarget.lane). */
  lane: number;
  /** Rear end of the obstacle along the lane's travel direction, meters. */
  s: number;
}

/** Road segment under the point (closures take the whole segment). */
export function segmentAt(index: PickIndex, p: Vec2): string | null {
  return index.nearestSegment(p)?.id ?? null;
}

export function buildingAt(index: PickIndex, p: Vec2): string | null {
  return index.buildingAt(p);
}

/** The lane of the clicked segment closest to the point, and the position along it (obstacle centered on the click). */
export function accidentAt(index: PickIndex, graph: RoadGraph, p: Vec2, obstacleLength = 9): AccidentSpot | null {
  const segmentId = segmentAt(index, p);
  if (!segmentId) return null;
  const seg = graph.segments.get(segmentId);
  if (!seg) return null;
  let best: { lane: number; s: number; length: number; d: number } | null = null;
  seg.lanes.forEach((laneIndex, i) => {
    const lane = graph.lanes[laneIndex];
    if (!lane) return;
    const hit = closestPointOnPolyline(lane.points, p);
    if (!best || hit.distance < best.d) best = { lane: i, s: hit.s, length: lane.length, d: hit.distance };
  });
  if (!best) return null;
  const b = best as { lane: number; s: number; length: number };
  const s = Math.max(0, Math.min(b.length - obstacleLength, b.s - obstacleLength / 2));
  return { segmentId, lane: b.lane, s };
}
