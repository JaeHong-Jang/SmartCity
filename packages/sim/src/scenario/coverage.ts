// Sensor coverage (ADR 0013 §3, §4): each sensor's view sector — disc of `range` around its mount point,
// within ±fov/2 of its yaw — as lane intervals and buildings. Derived from the doc and the compiled graph
// (deterministic, no RNG); computed once per graph / building set / sensor set and cached by the caller.
// Boundary rule (fixed): closed sets — a point at distance ≤ range and at an angle ≤ fov/2 from the yaw is
// covered (both up to EPS). A lane polyline that enters and leaves the sector several times (curves) keeps
// one interval per stretch inside; touching stretches (gap ≤ EPS) merge. Building occlusion is not modelled.

import { sensorPose, sensorShapeError, type CityDoc, type Sensor, type SensorKind, type Vec2 } from '@smartcity/shared';
import type { RoadGraph } from '../types.js';

const EPS = 1e-6;

/** What each kind can notice (ADR 0013 §4): video sees accidents and fires from outside; radar only traffic stopping. */
export const SENSOR_DETECTS: Record<SensorKind, { accident: boolean; fire: boolean }> = {
  cctv: { accident: true, fire: true },
  radar: { accident: true, fire: false },
  smartpole: { accident: true, fire: true },
};

export interface LaneInterval {
  /** Stable lane id (`Lane.id`). */
  laneId: string;
  /** Lane arc length (travel direction), sFrom ≤ sTo. */
  sFrom: number;
  sTo: number;
}

export interface SensorCoverage {
  sensorId: string;
  kind: SensorKind;
  /** Mount point and absolute yaw (null pose = road missing: no coverage). */
  x: number;
  z: number;
  yaw: number;
  /** Lane index order, then along the lane. */
  lanes: LaneInterval[];
  /** Buildings whose reference point (`Building.pos`) is in the sector, id order; only kinds that detect fires. */
  buildings: string[];
}

interface Sector {
  c: Vec2;
  r: number;
  /** Unit vectors of the two edges (−fov/2, +fov/2); `full` = 360°. */
  e1: Vec2;
  e2: Vec2;
  wide: boolean;
  full: boolean;
}

const cross = (a: Vec2, bx: number, bz: number): number => a.x * bz - a.z * bx;

function sectorOf(x: number, z: number, yaw: number, s: Sensor): Sector {
  const h = s.fov / 2;
  return {
    c: { x, z },
    r: s.range,
    e1: { x: Math.cos(yaw - h), z: Math.sin(yaw - h) },
    e2: { x: Math.cos(yaw + h), z: Math.sin(yaw + h) },
    wide: h > Math.PI / 2,
    full: s.fov >= 2 * Math.PI - EPS,
  };
}

/** Point in the closed sector. */
function inSector(q: Sector, px: number, pz: number): boolean {
  const dx = px - q.c.x;
  const dz = pz - q.c.z;
  if (Math.hypot(dx, dz) > q.r + EPS) return false;
  if (q.full) return true;
  const g1 = cross(q.e1, dx, dz) >= -EPS;
  const g2 = -cross(q.e2, dx, dz) >= -EPS;
  return q.wide ? g1 || g2 : g1 && g2;
}

/** u-range in [0, 1] where the linear function g0 + u·(g1 − g0) ≥ −EPS (null = none). */
function halfInterval(g0: number, g1: number): [number, number] | null {
  const a = g0 >= -EPS;
  const b = g1 >= -EPS;
  if (a && b) return [0, 1];
  if (!a && !b) return null;
  const u = (-EPS - g0) / (g1 - g0);
  return a ? [0, u] : [u, 1];
}

const meet = (p: [number, number], q: [number, number]): [number, number] | null => {
  const lo = Math.max(p[0], q[0]);
  const hi = Math.min(p[1], q[1]);
  return lo <= hi ? [lo, hi] : null;
};

/** Parts of the piece A → B inside the sector, as u-ranges (ascending, disjoint). */
function pieceInside(q: Sector, A: Vec2, B: Vec2): [number, number][] {
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  const fx = A.x - q.c.x;
  const fz = A.z - q.c.z;
  const a = dx * dx + dz * dz;
  if (a === 0) return [];
  const r = q.r + EPS;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const d = meet([(-b - sq) / (2 * a), (-b + sq) / (2 * a)], [0, 1]);
  if (!d || q.full) return d ? [d] : [];
  // Edge half-planes: cross(e1, P − C) ≥ 0 and cross(P − C, e2) ≥ 0 (AND for fov ≤ 180°, OR beyond).
  const h1 = halfInterval(cross(q.e1, fx, fz), cross(q.e1, fx + dx, fz + dz));
  const h2 = halfInterval(-cross(q.e2, fx, fz), -cross(q.e2, fx + dx, fz + dz));
  let parts: [number, number][];
  if (!q.wide) {
    const w = h1 && h2 ? meet(h1, h2) : null;
    parts = w ? [w] : [];
  } else {
    parts = [h1, h2].filter((x): x is [number, number] => x !== null).sort((p, s) => p[0] - s[0]);
    if (parts.length === 2 && parts[1]![0] <= parts[0]![1]) parts = [[parts[0]![0], Math.max(parts[0]![1], parts[1]![1])]];
  }
  const out: [number, number][] = [];
  for (const p of parts) {
    const m = meet(p, d);
    if (m) out.push(m);
  }
  return out;
}

/** Lane bounding boxes, computed once per graph. */
export interface LaneBoxes {
  graph: RoadGraph;
  box: Float64Array;
}

export function laneBoxes(graph: RoadGraph): LaneBoxes {
  const box = new Float64Array(graph.lanes.length * 4);
  for (const l of graph.lanes) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const p of l.points) {
      x0 = Math.min(x0, p.x);
      z0 = Math.min(z0, p.z);
      x1 = Math.max(x1, p.x);
      z1 = Math.max(z1, p.z);
    }
    box.set([x0, z0, x1, z1], l.index * 4);
  }
  return { graph, box };
}

/** Coverage of one sensor (also for a not-yet-placed one: tool previews). */
export function sensorCoverage(doc: CityDoc, graph: RoadGraph, s: Sensor, boxes: LaneBoxes = laneBoxes(graph)): SensorCoverage {
  // A malformed sensor (only reachable through an unchecked doc copy) covers nothing.
  const pose = sensorShapeError(s) === null ? sensorPose(doc, s) : null;
  const out: SensorCoverage = { sensorId: s.id, kind: s.kind, x: pose?.pos.x ?? 0, z: pose?.pos.z ?? 0, yaw: pose?.yaw ?? 0, lanes: [], buildings: [] };
  if (!pose) return out;
  const q = sectorOf(pose.pos.x, pose.pos.z, pose.yaw, s);
  const bx = boxes.box;
  for (const l of graph.lanes) {
    const o = l.index * 4;
    if (bx[o]! > q.c.x + q.r || bx[o + 2]! < q.c.x - q.r || bx[o + 1]! > q.c.z + q.r || bx[o + 3]! < q.c.z - q.r) continue;
    let last: LaneInterval | null = null;
    for (let i = 0; i + 1 < l.points.length; i++) {
      const s0 = l.cum[i]!;
      const len = l.cum[i + 1]! - s0;
      for (const [u0, u1] of pieceInside(q, l.points[i]!, l.points[i + 1]!)) {
        const from = s0 + u0 * len;
        const to = s0 + u1 * len;
        if (last !== null && from <= last.sTo + EPS) last.sTo = Math.max(last.sTo, to);
        else out.lanes.push((last = { laneId: l.id, sFrom: from, sTo: to }));
      }
    }
  }
  if (SENSOR_DETECTS[s.kind]?.fire) {
    for (const id of Object.keys(doc.buildings).sort()) {
      const b = doc.buildings[id]!;
      if (inSector(q, b.pos.x, b.pos.z)) out.buildings.push(id);
    }
  }
  return out;
}

/** Every sensor's coverage, sensor id order (the order sensors were added never matters). */
export function compileSensorCoverage(doc: CityDoc, graph: RoadGraph): SensorCoverage[] {
  const sensors = doc.sensors ?? {};
  const ids = Object.keys(sensors)
    .sort()
    .filter((id) => sensorShapeError(sensors[id]) === null);
  if (ids.length === 0) return [];
  const boxes = laneBoxes(graph);
  return ids.map((id) => sensorCoverage(doc, graph, sensors[id]!, boxes));
}
