import type { RoadType } from './model.js';

export const SIDEWALK_WIDTH = 2.5;
export const CURB_MARGIN = 0.5;
/** Allowed total width of a median strip (중앙분리대), meters (ADR 0014 §4). */
export const MEDIAN_MIN_WIDTH = 1;
export const MEDIAN_MAX_WIDTH = 10;

/**
 * Why `rt.median` is not a valid median, or null when it is valid or omitted: an object of a finite width in
 * [MEDIAN_MIN_WIDTH, MEDIAN_MAX_WIDTH] and a boolean `planted`, on a symmetric two-way road. One rule for
 * roadType.upsert and stored docs (docProblem).
 */
export function medianShapeError(rt: { median?: unknown; lanesForward?: unknown; lanesBackward?: unknown }): string | null {
  if (rt.median === undefined) return null;
  const m = rt.median as { width?: unknown; planted?: unknown } | null;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return 'invalid median';
  const w = m.width;
  if (typeof w !== 'number' || !Number.isFinite(w) || w < MEDIAN_MIN_WIDTH || w > MEDIAN_MAX_WIDTH) return `median.width out of range [${MEDIAN_MIN_WIDTH}, ${MEDIAN_MAX_WIDTH}]`;
  if (typeof m.planted !== 'boolean') return 'invalid median.planted flag';
  if (typeof rt.lanesBackward !== 'number' || rt.lanesBackward < 1 || rt.lanesForward !== rt.lanesBackward) return 'a median needs the same number of lanes in both directions';
  return null;
}

/** Total width of the median strip between the two directions; 0 without one. */
export const medianWidth = (rt: RoadType): number => rt.median?.width ?? 0;

/** Width of the drivable lanes only (sum of every lane, the median excluded). */
export const drivableWidth = (rt: RoadType): number => (rt.lanesForward + rt.lanesBackward) * rt.laneWidth;

/**
 * Width between the curbs (보도 사이 전체 폭): the drivable lanes plus the median. Sidewalks, curbs,
 * crossings, sensors and pedestrian paths all sit at its edge. Without a median it is the lane width sum.
 */
export const carriagewayWidth = (rt: RoadType): number => (rt.median ? drivableWidth(rt) + rt.median.width : drivableWidth(rt));

/**
 * Lateral spans (offsets from the center line, + = right) a speed bump covers on a carriageway of half
 * width `halfWidth`: all of it, or with a median of half width `inner` > 0 the two driving areas only.
 * Render-only geometry shared by the road mesh and the street tool's ghost (P7c-2).
 */
export function bumpSpans(halfWidth: number, inner = 0): [number, number][] {
  if (inner <= 0) return [[-halfWidth, halfWidth]];
  return inner >= halfWidth ? [] : [[inner, halfWidth], [-halfWidth, -inner]];
}

/** Half of the full road width including sidewalks; used for setbacks, picking and building clearance. */
export const roadHalfWidth = (rt: RoadType): number =>
  carriagewayWidth(rt) / 2 + (rt.sidewalk ? SIDEWALK_WIDTH : CURB_MARGIN);

/**
 * Lateral offset (to the right of a→b, meters) of a lane centerline.
 * Lane index 0 is the leftmost lane in the travel direction (next to the center line on two-way
 * roads); the highest index is the rightmost (curb) lane. One-way roads center their lanes on the segment.
 * With a median (symmetric two-way roads only) each direction starts at the median edge:
 * ±(median/2 + (index + 0.5) · laneWidth).
 */
export function laneOffset(rt: RoadType, dir: 'forward' | 'backward', index: number): number {
  const w = rt.laneWidth;
  if (rt.lanesBackward === 0) {
    const n = rt.lanesForward;
    return (index - (n - 1) / 2) * w;
  }
  const off = rt.median ? rt.median.width / 2 + (index + 0.5) * w : (index + 0.5) * w;
  return dir === 'forward' ? off : -off;
}
