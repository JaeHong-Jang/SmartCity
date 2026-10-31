// Validators and sanitisers for the apply module: every check throws through fail().

import { FACILITY_SERVICES, PROP_KINDS } from '../model.js';
import { sensorShapeError } from '../sensors.js';
import {
  bounds,
  boundsOverlap,
  collinearOverlap,
  dist,
  isOrthogonal,
  isSimplePolygon,
  polygonArea,
  polygonsOverlap,
  polylineIntersections,
  polylineLength,
  sampleSegmentCurve,
  type Bounds,
  type Vec2,
} from '../geometry.js';
import { buildingBlocksRoad, buildingFootprints, partOutline, polygonsBlockRoad } from '../editing/buildings.js';
import { medianShapeError, roadHalfWidth } from '../roads.js';
import { TxIndex } from './spatial.js';
import type {
  BuildingType,
  BusLine,
  BusStop,
  CityDoc,
  IntersectionControl,
  Parcel,
  RoadFeature,
  RoadSegment,
  RoadType,
  Sensor,
  VehicleType,
} from '../model.js';
import { LIMITS } from './limits.js';
import { fail, policy, type Tx } from './tx.js';

const ID_RE = /^[A-Za-z0-9_\-:.]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Keys that would hit Object.prototype machinery instead of an own property.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export function checkId(id: unknown, what: string): asserts id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > LIMITS.idLength || !ID_RE.test(id) || RESERVED_IDS.has(id)) {
    fail(`invalid ${what} id`);
  }
}

export function checkName(name: unknown, what: string): asserts name is string {
  if (typeof name !== 'string' || name.length > LIMITS.nameLength) fail(`invalid ${what} name`);
}

export function checkNum(v: unknown, min: number, max: number, what: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${what} out of range [${min}, ${max}]`);
}

export function checkInt(v: unknown, min: number, max: number, what: string): asserts v is number {
  checkNum(v, min, max, what);
  if (!Number.isInteger(v)) fail(`${what} must be an integer`);
}

function checkColor(v: unknown, what: string): void {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) fail(`invalid ${what} color`);
}

export function checkPos(doc: CityDoc, p: unknown, what: string): asserts p is Vec2 {
  const v = p as Vec2;
  if (!v || typeof v !== 'object') fail(`${what} must be a point`);
  const h = doc.meta.halfSize;
  checkNum(v.x, -h, h, `${what}.x`);
  checkNum(v.z, -h, h, `${what}.z`);
}

/**
 * Capacity is admission control for new edits. A trusted (already sequenced) command passed it when
 * it was accepted; replaying it must not fail because a doc migration since added presets (ADR 0011).
 */
export function checkCapacity(rec: Record<string, unknown>, id: string, max: number, what: string, tx?: Tx): void {
  // With the transaction, the size is counted once and then kept (large batches stay linear).
  if (policy.enforce && !(id in rec) && (tx ? tx.count(rec) : Object.keys(rec).length) >= max) fail(`too many ${what}`);
}

/** Own-property lookup for ids that come from commands (never trusts the prototype or non-strings). */
export function has(rec: Record<string, unknown>, id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(rec, id);
}

export function get<T>(rec: Record<string, T>, id: unknown): T | undefined {
  return has(rec, id) ? rec[id] : undefined;
}

/** Segments attached to a node. Linear scan: docs are small enough and this keeps the doc free of derived indexes. */
export function segmentsAtNode(doc: CityDoc, nodeId: string): RoadSegment[] {
  const out: RoadSegment[] = [];
  for (const s of Object.values(doc.segments)) if (s.a === nodeId || s.b === nodeId) out.push(s);
  return out;
}

export function segmentLength(doc: CityDoc, seg: RoadSegment): number {
  const a = doc.nodes[seg.a];
  const b = doc.nodes[seg.b];
  if (!a || !b) return 0;
  return polylineLength(sampleSegmentCurve(a.pos, b.pos, seg.control));
}

export function checkSegmentShape(doc: CityDoc, seg: RoadSegment): void {
  if (segmentLength(doc, seg) < LIMITS.minSegmentLength) fail(`segment shorter than ${LIMITS.minSegmentLength}m`);
}

export function validateRoadType(rt: RoadType): void {
  checkId(rt.id, 'road type');
  checkName(rt.name, 'road type');
  checkInt(rt.lanesForward, 0, 4, 'lanesForward');
  checkInt(rt.lanesBackward, 0, 4, 'lanesBackward');
  if (rt.lanesForward < 1) fail('a road needs at least one forward lane');
  checkNum(rt.laneWidth, 2.5, 5, 'laneWidth');
  checkNum(rt.speedLimit, 2, 40, 'speedLimit');
  if (typeof rt.sidewalk !== 'boolean' || typeof rt.busOnlyRightLane !== 'boolean') fail('invalid road type flags');
  const median = medianShapeError(rt);
  if (median) fail(median);
}

const ZONES = ['residential', 'commercial', 'office', 'industrial', 'public'];

function checkPolygon(poly: unknown, extent: number, what: string): asserts poly is Vec2[] {
  if (!Array.isArray(poly) || poly.length < 3 || poly.length > LIMITS.polygonVertices) fail(`invalid ${what}`);
  for (const v of poly) {
    checkNum((v as Vec2)?.x, -extent, extent, `${what}.x`);
    checkNum((v as Vec2)?.z, -extent, extent, `${what}.z`);
  }
  if (!isSimplePolygon(poly as Vec2[])) fail(`${what} must be a simple polygon`);
}

export function validateBuildingType(bt: BuildingType): void {
  checkId(bt.id, 'building type');
  checkName(bt.name, 'building type');
  if (!ZONES.includes(bt.zone)) fail('invalid zone');
  if (bt.growth !== undefined && bt.growth?.level !== 1) fail('invalid growth level');
  if (bt.origin !== undefined && bt.origin !== 'ai') fail('invalid origin');
  if (bt.service !== undefined && !(FACILITY_SERVICES as readonly string[]).includes(bt.service)) fail('invalid service');
  if (!Array.isArray(bt.parts) || bt.parts.length < 1 || bt.parts.length > LIMITS.buildingParts) fail('invalid building parts');
  for (const p of bt.parts) {
    checkNum(p.offset?.x, -200, 200, 'part.offset.x');
    checkNum(p.offset?.z, -200, 200, 'part.offset.z');
    checkNum(p.width, 1, 300, 'part.width');
    checkNum(p.depth, 1, 300, 'part.depth');
    checkInt(p.floors, 1, 200, 'part.floors');
    checkNum(p.floorHeight, 2, 12, 'part.floorHeight');
    checkNum(p.baseHeight, 0, 1000, 'part.baseHeight');
    if (!['flat', 'gable', 'pyramid'].includes(p.roof)) fail('invalid roof');
    checkColor(p.color, 'part');
    checkColor(p.roofColor, 'roof');
    if (p.footprint !== undefined) {
      checkPolygon(p.footprint, 200, 'part.footprint');
      if (p.footprint.length > LIMITS.footprintVertices) fail('part footprint has too many corners');
      if (!isOrthogonal(p.footprint)) fail('part footprint must be orthogonal');
      if (polygonArea(p.footprint) < 1) fail('part footprint too small');
      if (p.roof !== 'flat') fail('drawn footprints need a flat roof');
    }
    // null and 0 mean "not rounded" (normalized away on upsert).
    const round = p.round as unknown;
    if (round !== undefined && round !== null) {
      checkNum(round, 0, Math.min(p.width, p.depth) / 2, 'part.round');
      if (round > 0 && p.footprint !== undefined) fail('rounded corners need a rectangular volume (no drawn footprint)');
      if (round > 0 && p.roof !== 'flat') fail('rounded volumes need a flat roof');
    }
    if (p.use !== undefined && !ZONES.includes(p.use)) fail('invalid part use');
    if (p.facade !== undefined) {
      if (!['grid', 'ribbon', 'curtain', 'none'].includes(p.facade?.style)) fail('invalid facade style');
      checkNum(p.facade.windowRatio, 0.1, 0.95, 'windowRatio');
      if (!['none', 'shop', 'lobby', 'pilotis'].includes(p.facade.ground)) fail('invalid ground floor');
    }
  }
  // Volumes may touch but not overlap in space (overlaps would double-count floor area).
  // Outlines and tops are computed once per call (outlines only when a check needs them).
  const tops = bt.parts.map((p) => p.baseHeight + p.floors * p.floorHeight);
  const outlines: (Vec2[] | undefined)[] = [];
  const outline = (i: number): Vec2[] => (outlines[i] ??= partOutline(bt.parts[i]!));
  for (let i = 0; i < bt.parts.length; i++) {
    for (let j = i + 1; j < bt.parts.length; j++) {
      const a = bt.parts[i]!;
      const b = bt.parts[j]!;
      const aTop = tops[i]!;
      const bTop = tops[j]!;
      if (policy.enforce && a.baseHeight < bTop - 1e-6 && b.baseHeight < aTop - 1e-6 && polygonsOverlap(outline(i), outline(j))) {
        fail('building volumes overlap');
      }
    }
  }
  if (bt.props !== undefined) {
    if (!Array.isArray(bt.props) || bt.props.length > LIMITS.buildingProps) fail('invalid building props');
    // Props hang on the building: within 2 m of its plan extent and at most 6 m above its top.
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    let top = 0;
    for (let i = 0; i < bt.parts.length; i++) {
      for (const v of outline(i)) {
        x0 = Math.min(x0, v.x);
        z0 = Math.min(z0, v.z);
        x1 = Math.max(x1, v.x);
        z1 = Math.max(z1, v.z);
      }
      top = Math.max(top, tops[i]!);
    }
    for (const pr of bt.props) {
      if (!(PROP_KINDS as readonly string[]).includes(pr?.kind)) fail('invalid prop kind');
      checkNum(pr.pos?.x, x0 - 2, x1 + 2, 'prop.pos.x');
      checkNum(pr.pos.y, 0, top + 6, 'prop.pos.y');
      checkNum(pr.pos.z, z0 - 2, z1 + 2, 'prop.pos.z');
      checkInt(pr.rot, 0, 3, 'prop.rot');
      checkNum(pr.size, 0.5, 4, 'prop.size');
      checkColor(pr.color, 'prop');
    }
  }
  if (bt.smart !== undefined) {
    const m = bt.smart;
    checkNum(m?.solarRoof, 0, 1, 'solarRoof');
    checkNum(m.greenRoof, 0, 1, 'greenRoof');
    // Solar, planting and a drone pad (≈10 % of the roof) share the same roof.
    if (m.solarRoof + m.greenRoof + (m.dronePort ? 0.1 : 0) > 1 + 1e-9) fail('roof equipment exceeds the roof area');
    checkInt(m.evChargers, 0, LIMITS.evChargers, 'evChargers');
    if (typeof m.sensors !== 'boolean' || typeof m.dronePort !== 'boolean') fail('invalid smart flags');
  }
}

export function validateParcel(doc: CityDoc, pc: Parcel): void {
  checkId(pc.id, 'parcel');
  checkPolygon(pc.polygon, doc.meta.halfSize, 'parcel.polygon');
  if (polygonArea(pc.polygon) < 16) fail('parcel smaller than 16 m²');
  if (![...ZONES, 'green'].includes(pc.zone)) fail('invalid parcel zone');
  const r = pc.regulation;
  checkNum(r?.coverage, 0, 1, 'coverage');
  checkNum(r.far, 0, 20, 'far');
  checkNum(r.maxHeight, 0, 1000, 'maxHeight');
  checkNum(r.setback, 0, 50, 'setback');
  if (pc.auto !== undefined && pc.auto !== true) fail('invalid auto flag');
  if (pc.frontage !== undefined) {
    if (!has(doc.segments, pc.frontage?.segmentId)) fail('unknown frontage segment');
    if (pc.frontage.side !== 'left' && pc.frontage.side !== 'right') fail('invalid frontage side');
  }
  if (!policy.enforce) return;
  // Bounding boxes first: zoning lays out hundreds of lots per command (ADR 0009 §1).
  const box = bounds(pc.polygon);
  for (const other of Object.values(doc.parcels)) {
    if (other.id === pc.id || !boundsOverlap(box, bounds(other.polygon), 1e-6)) continue;
    if (polygonsOverlap(other.polygon, pc.polygon)) fail('parcels overlap');
  }
}

/** Segments at a moved node must not cross any other road (only meet at shared nodes). */
/** Segments at a moved node must not cross or run along any other road (only meet at shared nodes). */
export function checkNoNewCrossings(
  doc: CityDoc,
  nodeId: string,
  /** The transaction's spatial index: only roads near the moved ones are compared (and charged to its budget). */
  near?: { at: (nodeId: string) => RoadSegment[]; roads: (box: Bounds) => RoadSegment[] | null },
): void {
  if (!policy.enforce) return;
  // Each road is sampled once per call, however many moved segments it is compared against.
  const samples = new Map<string, { curve: Vec2[]; box: ReturnType<typeof bounds> }>();
  const sampled = (seg: RoadSegment) => {
    let e = samples.get(seg.id);
    if (!e) {
      const curve = sampleSegmentCurve(doc.nodes[seg.a]!.pos, doc.nodes[seg.b]!.pos, seg.control);
      e = { curve, box: bounds(curve) };
      samples.set(seg.id, e);
    }
    return e;
  };
  for (const s of near ? near.at(nodeId) : segmentsAtNode(doc, nodeId)) {
    const { curve, box } = sampled(s);
    const candidates = near ? near.roads({ minX: box.minX - 1, minZ: box.minZ - 1, maxX: box.maxX + 1, maxZ: box.maxZ + 1 }) : Object.values(doc.segments);
    if (!candidates) fail('the moved road could not be checked against nearby roads (contact check limit)');
    for (const o of candidates) {
      if (o.id === s.id) continue;
      const { curve: other, box: otherBox } = sampled(o);
      if (!boundsOverlap(box, otherBox, 1)) continue;
      const shared = [o.a, o.b].filter((n) => n === s.a || n === s.b).map((n) => doc.nodes[n]!.pos);
      const nearShared = (p: Vec2): boolean => shared.some((q) => dist(q, p) < 1);
      for (const hit of polylineIntersections(curve, other)) {
        if (!nearShared(hit.point)) fail('the moved road would cross another road');
      }
      // Collinear overlap is not a crossing: any shared stretch of positive length is refused.
      for (let i = 1; i < curve.length; i++) {
        for (let j = 1; j < other.length; j++) {
          if (collinearOverlap(curve[i - 1]!, curve[i]!, other[j - 1]!, other[j]!, 1e-3) > 1e-3) {
            fail('the moved road would run along another road');
          }
        }
      }
    }
  }
}

export function checkBuildingClear(doc: CityDoc, typeId: string, pos: Vec2, rotation: number, tx?: Tx): void {
  if (!policy.enforce) return;
  const type = doc.buildingTypes[typeId]!;
  const h = doc.meta.halfSize;
  const polys = buildingFootprints({ pos, rotation }, type);
  for (const poly of polys) {
    if (poly.some((c) => Math.abs(c.x) > h || Math.abs(c.z) > h)) fail('building extends beyond the map');
  }
  if (!tx) {
    if (buildingBlocksRoad(doc, { pos, rotation }, type)) fail('building overlaps a road');
    return;
  }
  // With the transaction: only roads whose center line comes within the widest road's half width of the
  // footprint box can reach it (the transaction's index, charged to its budget).
  const box = bounds(polys.flat());
  let hw = 0;
  for (const rt of Object.values(doc.roadTypes)) hw = Math.max(hw, roadHalfWidth(rt));
  const near = TxIndex.of(doc, tx).roadsNear([{ minX: box.minX - hw - 1, minZ: box.minZ - hw - 1, maxX: box.maxX + hw + 1, maxZ: box.maxZ + hw + 1 }], tx.contact);
  if (!near) fail('the building could not be checked against nearby roads (contact check limit)');
  if (polygonsBlockRoad(doc, polys, near)) fail('building overlaps a road');
}

export function validateVehicleType(vt: VehicleType): void {
  checkId(vt.id, 'vehicle type');
  checkName(vt.name, 'vehicle type');
  if (!['car', 'bus', 'truck', 'emergency'].includes(vt.kind)) fail('invalid vehicle kind');
  checkNum(vt.length, 2, 30, 'length');
  checkNum(vt.width, 1, 4, 'width');
  checkNum(vt.height, 1, 6, 'height');
  checkNum(vt.maxSpeed, 2, 60, 'maxSpeed');
  checkNum(vt.maxAccel, 0.3, 6, 'maxAccel');
  checkNum(vt.comfortDecel, 0.5, 8, 'comfortDecel');
  checkColor(vt.color, 'vehicle');
  checkNum(vt.spawnWeight, 0, 100, 'spawnWeight');
  if (vt.capacity !== undefined) checkInt(vt.capacity, 1, 200, 'capacity');
  if (!Array.isArray(vt.parts) || vt.parts.length < 1 || vt.parts.length > LIMITS.vehicleParts) fail('invalid vehicle parts');
  for (const p of vt.parts) {
    checkNum(p.offset?.x, -20, 20, 'part.offset.x');
    checkNum(p.offset?.y, 0, 6, 'part.offset.y');
    checkNum(p.offset?.z, -3, 3, 'part.offset.z');
    checkNum(p.length, 0.1, 30, 'part.length');
    checkNum(p.width, 0.1, 4, 'part.width');
    checkNum(p.height, 0.05, 6, 'part.height');
    checkColor(p.color, 'part');
  }
}

export function validateControl(doc: CityDoc, c: IntersectionControl): void {
  checkId(c.nodeId, 'node');
  if (!has(doc.nodes, c.nodeId)) fail('unknown node');
  if (c.kind !== 'signal' && c.kind !== 'uncontrolled' && c.kind !== 'allStop') fail('invalid intersection kind');
  if (c.crosswalkLegs !== undefined) {
    if (!Array.isArray(c.crosswalkLegs) || c.crosswalkLegs.length > 16) fail('invalid crosswalk legs');
    const atNode = new Set(segmentsAtNode(doc, c.nodeId).map((s) => s.id));
    for (const leg of c.crosswalkLegs) if (!atNode.has(leg)) fail('crosswalk leg is not connected to this node');
  }
  checkNum(c.yellow, 0, 10, 'yellow');
  checkNum(c.allRed, 0, 10, 'allRed');
  checkNum(c.offset, 0, 600, 'offset');
  if (c.scramble !== undefined) {
    if (typeof c.scramble !== 'boolean') fail('invalid scramble flag');
    if (c.scramble) {
      if (c.kind !== 'signal') fail('a pedestrian-only phase needs a signal');
      const legs = segmentsAtNode(doc, c.nodeId);
      if (legs.length < 3 || legs.length > 4) fail('a pedestrian-only phase needs a junction of 3 or 4 legs');
      const walked = legs.filter((s) => doc.roadTypes[s.roadTypeId]?.sidewalk && (!c.crosswalkLegs || c.crosswalkLegs.includes(s.id)));
      if (walked.length < 2) fail('a pedestrian-only phase needs crosswalks on at least 2 legs');
    }
  }
  if (c.phases !== undefined) {
    if (!Array.isArray(c.phases) || c.phases.length < 1 || c.phases.length > 8) fail('invalid phases');
    const atNode = new Set(segmentsAtNode(doc, c.nodeId).map((s) => s.id));
    for (const ph of c.phases) {
      checkNum(ph.green, 3, 180, 'green');
      if (!Array.isArray(ph.approaches) || ph.approaches.length < 1) fail('phase needs approaches');
      for (const a of ph.approaches) if (!atNode.has(a)) fail('phase approach is not connected to this node');
    }
  }
}

export function validateStop(doc: CityDoc, s: BusStop): void {
  checkId(s.id, 'bus stop');
  if (!has(doc.segments, s.segmentId)) fail('unknown segment');
  checkNum(s.t, 0, 1, 'stop.t');
  if (s.dir !== 'forward' && s.dir !== 'backward') fail('invalid stop dir');
  const seg = doc.segments[s.segmentId]!;
  const rt = doc.roadTypes[seg.roadTypeId]!;
  if (s.dir === 'backward' && rt.lanesBackward === 0) fail('no lanes in that direction');
}

export function validateLine(doc: CityDoc, l: BusLine): void {
  checkId(l.id, 'bus line');
  checkName(l.name, 'bus line');
  checkColor(l.color, 'bus line');
  if (!Array.isArray(l.stopIds) || l.stopIds.length < 2 || l.stopIds.length > LIMITS.stopsPerLine) fail('a line needs 2..100 stops');
  for (const id of l.stopIds) if (!has(doc.busStops, id)) fail('unknown bus stop');
  if (!has(doc.vehicleTypes, l.vehicleTypeId)) fail('unknown vehicle type');
  checkInt(l.buses, 0, LIMITS.busesPerLine, 'buses');
}

export function cleanVehicleType(vt: VehicleType): VehicleType {
  return {
    id: vt.id,
    name: vt.name,
    kind: vt.kind,
    length: vt.length,
    width: vt.width,
    height: vt.height,
    maxSpeed: vt.maxSpeed,
    maxAccel: vt.maxAccel,
    comfortDecel: vt.comfortDecel,
    color: vt.color,
    spawnWeight: vt.spawnWeight,
    parts: vt.parts.map((p) => ({
      offset: { x: p.offset.x, y: p.offset.y, z: p.offset.z },
      length: p.length,
      width: p.width,
      height: p.height,
      color: p.color,
    })),
    ...(vt.capacity !== undefined ? { capacity: vt.capacity } : {}),
  };
}

export function cleanControl(c: IntersectionControl): IntersectionControl {
  const out: IntersectionControl = { nodeId: c.nodeId, kind: c.kind, yellow: c.yellow, allRed: c.allRed, offset: c.offset };
  if (c.phases) out.phases = c.phases.map((p) => ({ approaches: p.approaches.slice(), green: p.green }));
  if (c.crosswalkLegs !== undefined) out.crosswalkLegs = [...new Set(c.crosswalkLegs)].sort();
  if (c.scramble) out.scramble = true;
  return out;
}

const FEATURE_KINDS = ['crosswalk', 'speedBump'];


export function validateFeature(doc: CityDoc, f: RoadFeature): void {
  checkId(f?.id, 'road feature');
  if (!FEATURE_KINDS.includes(f.kind)) fail('invalid road feature kind');
  const seg = get(doc.segments, f.segmentId);
  if (!seg) fail('unknown segment');
  checkNum(f.t, 0, 1, 'feature.t');
  if (f.signal !== undefined && (f.kind !== 'crosswalk' || typeof f.signal !== 'boolean')) fail('invalid feature signal flag');
  const others = Object.values(doc.features).filter((o) => o.segmentId === seg.id && o.id !== f.id);
  if (f.kind === 'crosswalk' && !doc.roadTypes[seg.roadTypeId]!.sidewalk) fail('crosswalks need a road with sidewalks');
  const len = segmentLength(doc, seg);
  const s = f.t * len;
  if (!featureEndsClear(s, len)) fail(`road features must be at least ${LIMITS.featureEndClearance}m from the segment ends`);
  for (const o of others) {
    if (!featureGapClear(Math.abs(o.t * len - s))) fail('too close to another road feature');
  }
}

/** A roadside sensor (ADR 0013 §4): finite values in range, on an existing segment. */
export function validateSensor(doc: CityDoc, s: Sensor): void {
  checkId(s?.id, 'sensor');
  if (!has(doc.segments, s.segmentId)) fail('unknown segment');
  const bad = sensorShapeError(s);
  if (bad) fail(bad);
}

/** Tolerance of the feature distance rules, so remapped positions re-validate exactly. */
export const FEATURE_EPS = 1e-6;

/** Arc length `s` along a segment of length `len` is far enough from both ends. */
export function featureEndsClear(s: number, len: number): boolean {
  const c = LIMITS.featureEndClearance - FEATURE_EPS;
  return !(s < c || len - s < c);
}

/** Two features `gap` metres apart (arc length) satisfy the spacing rule. */
export function featureGapClear(gap: number): boolean {
  return !(gap < LIMITS.featureSpacing - FEATURE_EPS);
}
