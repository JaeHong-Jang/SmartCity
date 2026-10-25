// Pure placement logic for buildings (ADR 0012 §3): road selection with hysteresis and lock,
// arc-length secant alignment on curved roads, longitudinal magnet snap, continuous rotation, and the
// render-only critically damped pose spring. The target pose computed here is the authority
// (collision, colour, commands); the spring only drives what the ghost looks like.

import {
  add,
  closestPointOnPolyline,
  cumulativeLengths,
  dist,
  dot,
  buildingFootprints,
  partOutline,
  pointAtLength,
  rightNormal,
  roadHalfWidth,
  sampleSegmentCurve,
  scale,
  sub,
  tangentAtLength,
  type BuildingType,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';
import type { SnapStep } from '../app/store';
import type { RoadFrame } from './guideGrid';
import type { PickIndex, SegmentHit } from './picking';
import { snapAlong, snapPoint } from './snap';

export const ALIGN_RADIUS = 40;
export const SETBACK_MARGIN = 1;
/** A road other than the current one must be this much closer (m) before the selection switches. */
export const SWITCH_MARGIN = 3;
/** Within this lateral distance (m) of the centerline the previously chosen side is kept. */
export const SIDE_HYSTERESIS = 2;
/** Along-road magnet reach (m): neighbours closer than this pull the building flush. */
export const MAGNET_PULL = 1.5;
/** Neighbour search distance (m) for the magnet. */
const MAGNET_SCAN = 60;
export const ROT_STEP = (15 * Math.PI) / 180;
/** Spring natural frequency (rad/s): ~95 % settled in 0.2 s. */
export const SPRING_OMEGA = 22;
/** Longest frame step the spring integrates (s); longer gaps (tab switch) are clamped. */
export const SPRING_MAX_DT = 0.05;
const POS_EPS = 0.004;
const ROT_EPS = 0.0004;
const VEL_EPS = 0.02;

export interface Placement {
  pos: Vec2;
  rotation: number;
  segmentId: string | null;
  /** Road frame of an aligned placement (for the local guide grid). */
  frame?: RoadFrame;
  /** +1 / -1: which side of the road (right of its direction = +1) the building stands on. */
  side?: 1 | -1;
}

/** Angle wrapped to (-π, π]. */
export const wrapAngle = (r: number): number => Math.atan2(Math.sin(r), Math.cos(r));

/** Local +z extent of the building (its front edge). */
export function frontExtent(type: BuildingType): number {
  return Math.max(...type.parts.flatMap((p) => partOutline(p).map((v) => v.z)));
}

/** Local x extent of the building (the width that faces the road). */
export function buildingWidth(type: BuildingType): number {
  const xs = type.parts.flatMap((p) => partOutline(p).map((v) => v.x));
  return Math.max(...xs) - Math.min(...xs);
}

// --- Road selection -------------------------------------------------------------------------

/** Remembers the road a building aligns to: switching needs a margin, and L can lock it. */
export class RoadSelector {
  id: string | null = null;
  locked = false;
  side: 1 | -1 | undefined;

  clear(): void {
    this.id = null;
    this.locked = false;
    this.side = undefined;
  }

  toggleLock(): boolean {
    if (this.id) this.locked = !this.locked;
    return this.locked;
  }

  /** Hit on the selected road or the nearest one; null when none is in reach. */
  pick(doc: CityDoc, idx: PickIndex, cursor: Vec2): SegmentHit | null {
    // A road removed (e.g. by a collaborator) invalidates the candidate and the lock.
    if (this.id && !doc.segments[this.id]) this.clear();
    const cur = this.id ? segmentHit(doc, this.id, cursor) : null;
    if (cur && this.locked) return cur;
    const near = idx.nearestSegment(cursor, ALIGN_RADIUS);
    let chosen: SegmentHit | null;
    if (cur && cur.distance <= ALIGN_RADIUS + SWITCH_MARGIN && (!near || near.id === cur.id || near.distance + SWITCH_MARGIN >= cur.distance)) chosen = cur;
    else chosen = near;
    if (chosen?.id !== this.id) this.side = undefined;
    this.id = chosen?.id ?? null;
    return chosen;
  }
}

/** Closest point of one road's centerline to `cursor` (null if the road or its nodes are gone). */
function segmentHit(doc: CityDoc, id: string, cursor: Vec2): SegmentHit | null {
  const seg = doc.segments[id];
  const a = seg && doc.nodes[seg.a];
  const b = seg && doc.nodes[seg.b];
  if (!seg || !a || !b) return null;
  const curve = sampleSegmentCurve(a.pos, b.pos, seg.control);
  const h = closestPointOnPolyline(curve, cursor);
  const cum = cumulativeLengths(curve);
  return { id, point: h.point, s: h.s, length: cum[cum.length - 1]!, distance: h.distance, curve };
}

// --- Magnet ---------------------------------------------------------------------------------

/** Occupied interval along the road direction, relative to the cursor's road point. */
export interface AlongSpan {
  min: number;
  max: number;
}

/**
 * Offset (m) that makes a building of half width `halfW`, centred at 0, flush with one of the spans
 * (abutting or edge-aligned) when that moves it at most `pull`; null = stay free.
 */
export function magnetDelta(halfW: number, spans: readonly AlongSpan[], pull = MAGNET_PULL): number | null {
  let best: number | null = null;
  const consider = (d: number): void => {
    if (Math.abs(d) <= pull && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  };
  for (const sp of spans) {
    consider(sp.max + halfW);
    consider(sp.min - halfW);
    consider(sp.min + halfW);
    consider(sp.max - halfW);
  }
  return best;
}

/** Neighbouring buildings and parcel corners on the building's side of the road, along `u`. */
function alongSpans(doc: CityDoc, origin: Vec2, u: Vec2, away: Vec2, excludeId: string | undefined): AlongSpan[] {
  const out: AlongSpan[] = [];
  const lateralOk = (p: Vec2): boolean => {
    const d = dot(sub(p, origin), away);
    return d >= -1 && d <= MAGNET_SCAN;
  };
  for (const o of Object.values(doc.buildings)) {
    if (o.id === excludeId || dist(o.pos, origin) > MAGNET_SCAN * 1.5) continue;
    const t = doc.buildingTypes[o.typeId];
    if (!t || !lateralOk(o.pos)) continue;
    let min = Infinity;
    let max = -Infinity;
    for (const poly of buildingFootprints(o, t)) {
      for (const c of poly) {
        const a = dot(sub(c, origin), u);
        if (a < min) min = a;
        if (a > max) max = a;
      }
    }
    out.push({ min, max });
  }
  for (const pc of Object.values(doc.parcels)) {
    for (const v of pc.polygon) {
      if (dist(v, origin) > MAGNET_SCAN || !lateralOk(v)) continue;
      const a = dot(sub(v, origin), u);
      out.push({ min: a, max: a });
    }
  }
  return out;
}

// --- Alignment on a (curved) road -----------------------------------------------------------

/**
 * Align a building to a road: local +z (the front) faces the road and the front edge sits
 * SETBACK_MARGIN outside the road's full half width. The rotation comes from the secant over the
 * building's width measured in ARC LENGTH around the snapped position, so curved roads give a
 * chord direction rather than the tangent at one point. The secant only proposes the rotation;
 * whether the placement is allowed is decided by the full-footprint road test (placementValid).
 */
export function alignOnCurve(
  doc: CityDoc,
  type: BuildingType,
  hit: SegmentHit,
  cursor: Vec2,
  step: SnapStep,
  prevSide?: 1 | -1,
  excludeId?: string,
): Placement {
  const seg = doc.segments[hit.id]!;
  const rt = doc.roadTypes[seg.roadTypeId]!;
  const curve = hit.curve;
  const cum = cumulativeLengths(curve);
  const length = hit.length;
  const t0 = tangentAtLength(curve, cum, hit.s);
  const signed = dot(sub(cursor, hit.point), rightNormal(t0));
  const side: 1 | -1 = prevSide && Math.abs(signed) < SIDE_HYSTERESIS ? prevSide : signed >= 0 ? 1 : -1;
  const away0 = scale(rightNormal(t0), side);

  const width = buildingWidth(type);
  const halfW = width / 2;
  const magnet = magnetDelta(halfW, alongSpans(doc, hit.point, t0, away0, excludeId));
  const s = magnet !== null ? Math.min(Math.max(hit.s + magnet, 0.01), Math.max(0.01, length - 0.01)) : snapAlong(hit.s, length, step);

  // Width window [a, b] in arc length, shifted (not shrunk) to stay on the road.
  let a = s - halfW;
  let b = s + halfW;
  if (width >= length) {
    a = 0;
    b = length;
  } else if (a < 0) {
    a = 0;
    b = width;
  } else if (b > length) {
    b = length;
    a = length - width;
  }
  const pa = pointAtLength(curve, cum, a);
  const pb = pointAtLength(curve, cum, b);
  const chord = sub(pb, pa);
  const clen = Math.hypot(chord.x, chord.z);
  const u = clen > 1e-6 ? scale(chord, 1 / clen) : tangentAtLength(curve, cum, s);
  const away = scale(rightNormal(u), side);
  const mid = scale(add(pa, pb), 0.5);
  // Curve bulging toward the building pushes the front line out so the margin holds everywhere.
  let bulge = 0;
  for (let k = 1; k <= 3; k++) bulge = Math.max(bulge, dot(sub(pointAtLength(curve, cum, a + ((b - a) * k) / 4), mid), away));
  const edge = roadHalfWidth(rt) + SETBACK_MARGIN + bulge;
  const toRoad = scale(away, -1);
  // rotateY maps local (0, 1) to (sin r, cos r).
  const rotation = Math.atan2(toRoad.x, toRoad.z);
  const pos = add(mid, scale(away, edge + frontExtent(type)));
  return { pos, rotation, segmentId: hit.id, side, frame: { anchor: add(mid, scale(away, edge)), u, v: away } };
}

/** Owns the road selection for one placing gesture and turns a cursor into a target placement. */
export class PlacementSolver {
  readonly selector = new RoadSelector();

  solve(doc: CityDoc, idx: PickIndex, type: BuildingType, cursor: Vec2, o: { rotation: number; step: SnapStep; free: boolean; excludeId?: string }): Placement {
    const hit = o.free ? null : this.selector.pick(doc, idx, cursor);
    if (!hit) return { pos: snapPoint(cursor, o.step), rotation: o.rotation, segmentId: null };
    const p = alignOnCurve(doc, type, hit, cursor, o.step, this.selector.side, o.excludeId);
    this.selector.side = p.side;
    return p;
  }
}

// --- Rotation -------------------------------------------------------------------------------

/** Round to the 15° step (or leave as is when `snap` is false). */
export function snapRotation(r: number, snap: boolean): number {
  return wrapAngle(snap ? Math.round(r / ROT_STEP) * ROT_STEP : r);
}

/** Facing angle of a ground vector in the building's rotation convention (local +z → (sin, cos)). */
export const facingAngle = (v: Vec2): number => Math.atan2(v.x, v.z);

/**
 * Hold-to-rotate: accumulates the cursor's angular travel around a fixed anchor, ignoring moves
 * that stay within `deadZone` m of the anchor (angle is meaningless there).
 */
export class RotateGesture {
  private prev: number | null = null;
  private total = 0;
  constructor(
    readonly anchor: Vec2,
    readonly base: number,
    cursor: Vec2,
    private readonly deadZone = 2,
  ) {
    this.move(cursor);
  }

  /** Feed a cursor position; returns the unsnapped rotation. */
  move(cursor: Vec2): number {
    const v = sub(cursor, this.anchor);
    if (Math.hypot(v.x, v.z) >= this.deadZone) {
      const a = facingAngle(v);
      if (this.prev !== null) this.total += wrapAngle(a - this.prev);
      this.prev = a;
    }
    return this.base + this.total;
  }

  get travelled(): number {
    return this.total;
  }
}

// --- Display spring -------------------------------------------------------------------------

/** Display pose (position + rotation) chasing a target; rotation takes the shortest way around. */
export class PoseSpring {
  x = 0;
  z = 0;
  r = 0;
  private vx = 0;
  private vz = 0;
  private vr = 0;
  /** False until the first target: the first pose is adopted, not animated to. */
  active = false;
  private ex = 0;
  private ez = 0;
  private er = 0;

  reset(): void {
    this.active = false;
    this.vx = this.vz = this.vr = 0;
  }

  /** Jump to the pose with no motion (first show, click, tool switch). */
  snapTo(x: number, z: number, r: number): void {
    this.x = x;
    this.z = z;
    this.r = wrapAngle(r);
    this.vx = this.vz = this.vr = 0;
    this.active = true;
  }

  /** Advance by `dt` seconds (clamped to SPRING_MAX_DT); false when settled exactly on the target. */
  step(dt: number, tx: number, tz: number, tr: number): boolean {
    if (!this.active) {
      this.snapTo(tx, tz, tr);
      return false;
    }
    const d = Math.min(Math.max(dt, 0), SPRING_MAX_DT);
    this.ex = this.x - tx;
    this.ez = this.z - tz;
    this.er = wrapAngle(this.r - tr);
    if (Math.abs(this.ex) < POS_EPS && Math.abs(this.ez) < POS_EPS && Math.abs(this.er) < ROT_EPS && Math.abs(this.vx) + Math.abs(this.vz) + Math.abs(this.vr) < VEL_EPS) {
      this.snapTo(tx, tz, tr);
      return false;
    }
    // Exact critically damped step: e' = (e + c·dt)·k, v' = (v − ω·c·dt)·k with c = v + ω·e.
    const k = Math.exp(-SPRING_OMEGA * d);
    const cx = this.vx + SPRING_OMEGA * this.ex;
    const cz = this.vz + SPRING_OMEGA * this.ez;
    const cr = this.vr + SPRING_OMEGA * this.er;
    this.x = tx + (this.ex + cx * d) * k;
    this.z = tz + (this.ez + cz * d) * k;
    this.r = wrapAngle(tr + (this.er + cr * d) * k);
    this.vx = (this.vx - SPRING_OMEGA * cx * d) * k;
    this.vz = (this.vz - SPRING_OMEGA * cz * d) * k;
    this.vr = (this.vr - SPRING_OMEGA * cr * d) * k;
    return true;
  }
}
