// Where a roadside sensor stands and looks (ADR 0013 §4): derived from its road, never stored.

import { cumulativeLengths, pointAtLength, rightNormal, sampleSegmentCurve, tangentAtLength, type Vec2 } from './geometry.js';
import { SENSOR_KINDS, type CityDoc, type Sensor } from './model.js';
import { carriagewayWidth, CURB_MARGIN, SIDEWALK_WIDTH } from './roads.js';
import { LIMITS } from './apply/limits.js';

const inRange = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * The one rule set for a sensor's own fields (ADR 0013 §4), shared by `sensor.place` / `sensor.update` and
 * `docProblem` (stored docs): kind, side, t ∈ [0, 1], heading ∈ [−2π, 2π], fov ∈ [1°, 2π], range ∈
 * [sensorRangeMin, sensorRangeMax], all finite numbers. Id and segment references are checked by the callers.
 * Null = well formed.
 */
export function sensorShapeError(s: unknown): string | null {
  if (typeof s !== 'object' || s === null) return 'sensor must be an object';
  const v = s as Record<string, unknown>;
  if (!(SENSOR_KINDS as readonly unknown[]).includes(v.kind)) return 'invalid sensor kind';
  if (v.side !== 'left' && v.side !== 'right') return 'invalid sensor side';
  if (!inRange(v.t, 0, 1)) return 'sensor.t out of range [0, 1]';
  if (!inRange(v.heading, -2 * Math.PI, 2 * Math.PI)) return 'sensor.heading out of range [-2π, 2π]';
  if (!inRange(v.fov, Math.PI / 180, 2 * Math.PI)) return 'sensor.fov out of range [1°, 2π]';
  if (!inRange(v.range, LIMITS.sensorRangeMin, LIMITS.sensorRangeMax)) return `sensor.range out of range [${LIMITS.sensorRangeMin}, ${LIMITS.sensorRangeMax}]`;
  return null;
}

export interface SensorPose {
  /** Mount point: middle of the sidewalk of `side` (half the curb margin out without a sidewalk). */
  pos: Vec2;
  /** Absolute view direction, radians, atan2(z, x) convention (road tangent angle + `heading`). */
  yaw: number;
}

/** Pose of `s` on the current doc, or null when its road is missing. Arc length as `segmentLength`. */
export function sensorPose(doc: CityDoc, s: Sensor): SensorPose | null {
  const seg = doc.segments[s.segmentId];
  const a = seg ? doc.nodes[seg.a] : undefined;
  const b = seg ? doc.nodes[seg.b] : undefined;
  const rt = seg ? doc.roadTypes[seg.roadTypeId] : undefined;
  if (!seg || !a || !b || !rt) return null;
  const pts = sampleSegmentCurve(a.pos, b.pos, seg.control);
  const cum = cumulativeLengths(pts);
  const len = cum[cum.length - 1]!;
  const at = Math.min(len, Math.max(0, s.t * len));
  const p = pointAtLength(pts, cum, at);
  const tan = tangentAtLength(pts, cum, Math.max(1e-6, Math.min(len, at)));
  const off = (carriagewayWidth(rt) / 2 + (rt.sidewalk ? SIDEWALK_WIDTH / 2 : CURB_MARGIN / 2)) * (s.side === 'right' ? 1 : -1);
  const n = rightNormal(tan);
  return { pos: { x: p.x + n.x * off, z: p.z + n.z * off }, yaw: Math.atan2(tan.z, tan.x) + s.heading };
}
