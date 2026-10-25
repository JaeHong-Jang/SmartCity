// Road corner fillets (ADR 0012 §1): pure geometry, no doc access.
// A corner V between two straight legs is replaced by a symmetric quadratic Bezier from P0 (on the
// first leg, T before V) to P2 (on the second leg, T after V) with control point V. Its smallest
// radius of curvature is at the apex: ρ_min = T·cos²(δ/2)/sin(δ/2), δ = change of travel direction.
// So a required radius ρ needs T = ρ·sin(δ/2)/cos²(δ/2) (the circular-arc formula T = R·tan(δ/2)
// would give a curve that is too tight: R/√2 at 90°).

import { LIMITS } from '../apply/limits.js';
import { angleBetween, dist, normalize, polylineLength, sampleSegmentCurve, sub, type Vec2 } from '../geometry.js';
import type { RoadType } from '../model.js';
import { roadHalfWidth } from '../roads.js';

const DEG = Math.PI / 180;
/** Below this turn the corner is left as it is (nothing to round). */
export const FILLET_MIN_TURN = 10 * DEG;
/** Above this turn (almost a U-turn) a corner is never rounded. */
export const FILLET_MAX_TURN = 150 * DEG;
/** Geometric floor: radius ≥ road half width + this margin, so the inner road edge never folds. */
export const FILLET_FLOOR_MARGIN = 4;
/** Arc-length tolerance of the budget comparisons (planned values are re-measured by apply). */
const EPS = 1e-6;

/** Change of travel direction at v (0 = straight on, π = U-turn), radians. NaN when a leg is degenerate. */
export function turnAngle(a: Vec2, v: Vec2, b: Vec2): number {
  if (dist(a, v) < EPS || dist(v, b) < EPS) return NaN;
  return Math.abs(angleBetween(normalize(sub(v, a)), normalize(sub(b, v))));
}

/** Tangent length T giving the symmetric quadratic Bezier a minimum curvature radius of `radius`. */
export const filletTangent = (radius: number, delta: number): number => (radius * Math.sin(delta / 2)) / Math.cos(delta / 2) ** 2;

/** Minimum curvature radius (at the apex) of the symmetric quadratic Bezier with tangent length `t`. */
export const bezierMinRadius = (t: number, delta: number): number => (t * Math.cos(delta / 2) ** 2) / Math.sin(delta / 2);

/** Safety floor of the radius for a road type: half width (with sidewalks) + 4 m. */
export const filletFloor = (rt: RoadType): number => roadHalfWidth(rt) + FILLET_FLOOR_MARGIN;

/** Preferred radius by total lane count (tuning table); never below the floor. */
const PREFERRED_BY_LANES: [maxLanes: number, radius: number][] = [
  [2, 15],
  [4, 25],
  [6, 35],
];
const PREFERRED_WIDE = 45;

export function preferredFilletRadius(rt: RoadType): number {
  const lanes = rt.lanesForward + rt.lanesBackward;
  const row = PREFERRED_BY_LANES.find(([max]) => lanes <= max);
  return Math.max(filletFloor(rt), row ? row[1] : PREFERRED_WIDE);
}

/** Corner curve from tangent length t (P0 on the a-leg, P2 on the b-leg). */
function cornerPoints(a: Vec2, v: Vec2, b: Vec2, t: number): { p0: Vec2; p2: Vec2 } {
  const ua = normalize(sub(a, v));
  const ub = normalize(sub(b, v));
  return { p0: { x: v.x + ua.x * t, z: v.z + ua.z * t }, p2: { x: v.x + ub.x * t, z: v.z + ub.z * t } };
}

/** Arc length of the corner curve as the doc measures segments (sampled polyline, same as apply). */
function arcLength(a: Vec2, v: Vec2, b: Vec2, t: number): number {
  const { p0, p2 } = cornerPoints(a, v, b, t);
  return polylineLength(sampleSegmentCurve(p0, p2, v));
}

/** Smallest tangent length whose curve is at least `LIMITS.minSegmentLength` long (measured like apply). */
function minArcTangent(a: Vec2, v: Vec2, b: Vec2): number {
  const target = LIMITS.minSegmentLength + 1e-3;
  // The arc grows linearly with t; start from the straight-line estimate and correct the sampling error.
  let t = target / 2;
  for (let i = 0; i < 6; i++) {
    const len = arcLength(a, v, b, t);
    if (len >= target) break;
    t *= target / len;
  }
  return t;
}

/** Shortest tangent length a rounded corner needs (radius at the floor, curve at least the minimum length). */
export function minFilletTangent(a: Vec2, v: Vec2, b: Vec2, floor: number): number {
  return Math.max(filletTangent(floor, turnAngle(a, v, b)), minArcTangent(a, v, b));
}

export type FilletRejection = 'degenerate' | 'tooSharp' | 'noRoom';

export type CornerPlan =
  | { kind: 'skip'; delta: number }
  | { kind: 'reject'; reason: FilletRejection; delta: number }
  | { kind: 'ok'; delta: number; t: number; radius: number; p0: Vec2; p2: Vec2; arcLength: number };

export interface CornerInput {
  a: Vec2;
  v: Vec2;
  b: Vec2;
  /** Radius floor (filletFloor) and preferred radius (≥ floor). */
  floor: number;
  preferred: number;
  /**
   * Longest T each leg can give: leg length − whatever its far end needs (another fillet's T, a junction
   * reserve) − the minimum straight piece (legRoom).
   */
  roomA: number;
  roomB: number;
}

/** Kept on top of the minimum straight piece so float noise never makes it 7.999… m. */
const LEG_MARGIN = 1e-3;

/** Tangent length a leg can give up (may be negative: none). */
export const legRoom = (length: number, reserve: number): number => length - reserve - LIMITS.minSegmentLength - LEG_MARGIN;

/**
 * Round the corner a → v → b. The preferred radius shrinks to fit the legs, never below the floor; a
 * corner that cannot reach the floor is rejected (kept sharp). Deterministic.
 */
export function planCorner(c: CornerInput): CornerPlan {
  const pts = [c.a, c.v, c.b];
  const finite = pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)) && [c.floor, c.preferred, c.roomA, c.roomB].every(Number.isFinite);
  const delta = finite ? turnAngle(c.a, c.v, c.b) : NaN;
  if (!Number.isFinite(delta) || !(c.floor > 0)) return { kind: 'reject', reason: 'degenerate', delta };
  if (delta < FILLET_MIN_TURN) return { kind: 'skip', delta };
  if (delta > FILLET_MAX_TURN) return { kind: 'reject', reason: 'tooSharp', delta };
  const tMin = minFilletTangent(c.a, c.v, c.b, c.floor);
  const room = Math.min(c.roomA, c.roomB);
  if (room + EPS < tMin) return { kind: 'reject', reason: 'noRoom', delta };
  const t = Math.min(Math.max(filletTangent(Math.max(c.preferred, c.floor), delta), tMin), Math.max(room, tMin));
  const { p0, p2 } = cornerPoints(c.a, c.v, c.b, t);
  return { kind: 'ok', delta, t, radius: bezierMinRadius(t, delta), p0, p2, arcLength: arcLength(c.a, c.v, c.b, t) };
}
