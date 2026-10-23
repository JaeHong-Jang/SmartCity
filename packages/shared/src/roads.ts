import type { RoadType } from './model.js';

export const SIDEWALK_WIDTH = 2.5;
export const CURB_MARGIN = 0.5;

/** Width of the drivable carriageway. */
export const carriagewayWidth = (rt: RoadType): number => (rt.lanesForward + rt.lanesBackward) * rt.laneWidth;

/** Half of the full road width including sidewalks; used for setbacks, picking and building clearance. */
export const roadHalfWidth = (rt: RoadType): number =>
  carriagewayWidth(rt) / 2 + (rt.sidewalk ? SIDEWALK_WIDTH : CURB_MARGIN);

/**
 * Lateral offset (to the right of a→b, meters) of a lane centerline.
 * Lane index 0 is the leftmost lane in the travel direction (next to the center line on two-way
 * roads); the highest index is the rightmost (curb) lane. One-way roads center their lanes on the segment.
 */
export function laneOffset(rt: RoadType, dir: 'forward' | 'backward', index: number): number {
  const w = rt.laneWidth;
  if (rt.lanesBackward === 0) {
    const n = rt.lanesForward;
    return (index - (n - 1) / 2) * w;
  }
  const off = (index + 0.5) * w;
  return dir === 'forward' ? off : -off;
}
