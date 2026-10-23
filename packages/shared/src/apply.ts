// applyCommand: the only way a CityDoc changes. Deterministic, validates everything (the server
// runs it on untrusted input), and leaves the doc untouched when a command fails.

import type { Command } from './commands.js';
import { PROP_KINDS } from './model.js';
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
  splitQuadBezier,
  type Vec2,
} from './geometry.js';
import { buildingBlocksRoad, buildingFootprints, partOutline } from './editing/buildings.js';
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
  SegmentId,
  VehicleType,
} from './model.js';

export const LIMITS = {
  idLength: 64,
  nameLength: 80,
  batchSize: 1000,
  nodes: 50_000,
  segments: 50_000,
  buildings: 100_000,
  buildingTypes: 2_000,
  buildingParts: 48,
  buildingProps: 64,
  features: 50_000,
  /** Point features keep this far (m, arc length) from the segment ends: the junction is there. */
  featureEndClearance: 12,
  /** Minimum distance between two point features on one segment, m. */
  featureSpacing: 6,
  vehicleParts: 24,
  vehicleTypes: 500,
  roadTypes: 200,
  busStops: 10_000,
  busLines: 1_000,
  stopsPerLine: 100,
  busesPerLine: 50,
  minSegmentLength: 8,
  parcels: 50_000,
  polygonVertices: 128,
  footprintVertices: 32,
  evChargers: 500,
} as const;

export type ApplyResult = { ok: true } | { ok: false; error: string };

class ApplyError extends Error {}

function fail(msg: string): never {
  throw new ApplyError(msg);
}

/** Undo log so a failed batch can be rolled back without cloning the whole doc. */
class Tx {
  private undo: (() => void)[] = [];

  set<T>(rec: Record<string, T>, id: string, value: T | undefined): void {
    const had = Object.prototype.hasOwnProperty.call(rec, id);
    const prev = rec[id];
    this.undo.push(() => {
      if (had) rec[id] = prev as T;
      else delete rec[id];
    });
    if (value === undefined) delete rec[id];
    else rec[id] = value;
  }

  field<O extends object, K extends keyof O>(obj: O, key: K, value: O[K]): void {
    const prev = obj[key];
    this.undo.push(() => {
      obj[key] = prev;
    });
    obj[key] = value;
  }

  rollback(): void {
    for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i]!();
    this.undo = [];
  }
}

export type TryApplyResult = { ok: true; rollback: () => void } | { ok: false; error: string };

export interface ApplyOptions {
  /**
   * The command was already accepted by the authoritative server (live `applied` messages, log
   * replay). Skips design-policy checks (road clearance, overlaps, crossings, footprint map bounds,
   * revisions), which may have been different when it was accepted. Structural validation still runs.
   */
  trusted?: boolean;
}

// Policy checks consult this flag; applyCommand is synchronous, so a module-level flag is safe.
let enforcePolicy = true;

/** Like applyCommand, but the caller can still undo a successful command (e.g. when persisting it fails). */
export function tryApplyCommand(doc: CityDoc, cmd: Command, opts: ApplyOptions = {}): TryApplyResult {
  const tx = new Tx();
  enforcePolicy = !opts.trusted;
  try {
    if (!cmd || typeof cmd !== 'object') fail('command must be an object');
    if (cmd.type === 'batch') {
      if (!Array.isArray(cmd.commands)) fail('batch.commands must be an array');
      if (cmd.commands.length > LIMITS.batchSize) fail('batch too large');
      for (const c of cmd.commands) {
        if (c?.type === 'batch') fail('nested batch not allowed');
        applyOne(doc, c, tx);
      }
    } else {
      applyOne(doc, cmd, tx);
    }
    return { ok: true, rollback: () => tx.rollback() };
  } catch (e) {
    tx.rollback();
    if (e instanceof ApplyError) return { ok: false, error: e.message };
    return { ok: false, error: `invalid command: ${(e as Error).message}` };
  } finally {
    enforcePolicy = true;
  }
}

export function applyCommand(doc: CityDoc, cmd: Command, opts: ApplyOptions = {}): ApplyResult {
  const r = tryApplyCommand(doc, cmd, opts);
  return r.ok ? { ok: true } : r;
}

// ---------- validation helpers ----------

const ID_RE = /^[A-Za-z0-9_\-:.]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Keys that would hit Object.prototype machinery instead of an own property.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function checkId(id: unknown, what: string): asserts id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > LIMITS.idLength || !ID_RE.test(id) || RESERVED_IDS.has(id)) {
    fail(`invalid ${what} id`);
  }
}

function checkName(name: unknown, what: string): asserts name is string {
  if (typeof name !== 'string' || name.length > LIMITS.nameLength) fail(`invalid ${what} name`);
}

function checkNum(v: unknown, min: number, max: number, what: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${what} out of range [${min}, ${max}]`);
}

function checkInt(v: unknown, min: number, max: number, what: string): asserts v is number {
  checkNum(v, min, max, what);
  if (!Number.isInteger(v)) fail(`${what} must be an integer`);
}

function checkColor(v: unknown, what: string): void {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) fail(`invalid ${what} color`);
}

function checkPos(doc: CityDoc, p: unknown, what: string): asserts p is Vec2 {
  const v = p as Vec2;
  if (!v || typeof v !== 'object') fail(`${what} must be a point`);
  const h = doc.meta.halfSize;
  checkNum(v.x, -h, h, `${what}.x`);
  checkNum(v.z, -h, h, `${what}.z`);
}

function checkCapacity(rec: Record<string, unknown>, id: string, max: number, what: string): void {
  if (!(id in rec) && Object.keys(rec).length >= max) fail(`too many ${what}`);
}

/** Own-property lookup for ids that come from commands (never trusts the prototype or non-strings). */
function has(rec: Record<string, unknown>, id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(rec, id);
}

function get<T>(rec: Record<string, T>, id: unknown): T | undefined {
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

function checkSegmentShape(doc: CityDoc, seg: RoadSegment): void {
  if (segmentLength(doc, seg) < LIMITS.minSegmentLength) fail(`segment shorter than ${LIMITS.minSegmentLength}m`);
}

function validateRoadType(rt: RoadType): void {
  checkId(rt.id, 'road type');
  checkName(rt.name, 'road type');
  checkInt(rt.lanesForward, 0, 4, 'lanesForward');
  checkInt(rt.lanesBackward, 0, 4, 'lanesBackward');
  if (rt.lanesForward < 1) fail('a road needs at least one forward lane');
  checkNum(rt.laneWidth, 2.5, 5, 'laneWidth');
  checkNum(rt.speedLimit, 2, 40, 'speedLimit');
  if (typeof rt.sidewalk !== 'boolean' || typeof rt.busOnlyRightLane !== 'boolean') fail('invalid road type flags');
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

function validateBuildingType(bt: BuildingType): void {
  checkId(bt.id, 'building type');
  checkName(bt.name, 'building type');
  if (!ZONES.includes(bt.zone)) fail('invalid zone');
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
    if (p.use !== undefined && !ZONES.includes(p.use)) fail('invalid part use');
    if (p.facade !== undefined) {
      if (!['grid', 'ribbon', 'curtain', 'none'].includes(p.facade?.style)) fail('invalid facade style');
      checkNum(p.facade.windowRatio, 0.1, 0.95, 'windowRatio');
      if (!['none', 'shop', 'lobby', 'pilotis'].includes(p.facade.ground)) fail('invalid ground floor');
    }
  }
  // Volumes may touch but not overlap in space (overlaps would double-count floor area).
  for (let i = 0; i < bt.parts.length; i++) {
    for (let j = i + 1; j < bt.parts.length; j++) {
      const a = bt.parts[i]!;
      const b = bt.parts[j]!;
      const aTop = a.baseHeight + a.floors * a.floorHeight;
      const bTop = b.baseHeight + b.floors * b.floorHeight;
      if (enforcePolicy && a.baseHeight < bTop - 1e-6 && b.baseHeight < aTop - 1e-6 && polygonsOverlap(partOutline(a), partOutline(b))) {
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
    for (const p of bt.parts) {
      for (const v of partOutline(p)) {
        x0 = Math.min(x0, v.x);
        z0 = Math.min(z0, v.z);
        x1 = Math.max(x1, v.x);
        z1 = Math.max(z1, v.z);
      }
      top = Math.max(top, p.baseHeight + p.floors * p.floorHeight);
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

function validateParcel(doc: CityDoc, pc: Parcel): void {
  checkId(pc.id, 'parcel');
  checkPolygon(pc.polygon, doc.meta.halfSize, 'parcel.polygon');
  if (polygonArea(pc.polygon) < 16) fail('parcel smaller than 16 m²');
  if (![...ZONES, 'green'].includes(pc.zone)) fail('invalid parcel zone');
  const r = pc.regulation;
  checkNum(r?.coverage, 0, 1, 'coverage');
  checkNum(r.far, 0, 20, 'far');
  checkNum(r.maxHeight, 0, 1000, 'maxHeight');
  checkNum(r.setback, 0, 50, 'setback');
  for (const other of Object.values(doc.parcels)) {
    if (enforcePolicy && other.id !== pc.id && polygonsOverlap(other.polygon, pc.polygon)) fail('parcels overlap');
  }
}

/** Segments at a moved node must not cross any other road (only meet at shared nodes). */
/** Segments at a moved node must not cross or run along any other road (only meet at shared nodes). */
function checkNoNewCrossings(doc: CityDoc, nodeId: string): void {
  if (!enforcePolicy) return;
  for (const s of segmentsAtNode(doc, nodeId)) {
    const curve = sampleSegmentCurve(doc.nodes[s.a]!.pos, doc.nodes[s.b]!.pos, s.control);
    const box = bounds(curve);
    for (const o of Object.values(doc.segments)) {
      if (o.id === s.id) continue;
      const other = sampleSegmentCurve(doc.nodes[o.a]!.pos, doc.nodes[o.b]!.pos, o.control);
      if (!boundsOverlap(box, bounds(other), 1)) continue;
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

function checkBuildingClear(doc: CityDoc, typeId: string, pos: Vec2, rotation: number): void {
  if (!enforcePolicy) return;
  const type = doc.buildingTypes[typeId]!;
  const h = doc.meta.halfSize;
  for (const poly of buildingFootprints({ pos, rotation }, type)) {
    if (poly.some((c) => Math.abs(c.x) > h || Math.abs(c.z) > h)) fail('building extends beyond the map');
  }
  if (buildingBlocksRoad(doc, { pos, rotation }, type)) fail('building overlaps a road');
}

function validateVehicleType(vt: VehicleType): void {
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

function validateControl(doc: CityDoc, c: IntersectionControl): void {
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

function validateStop(doc: CityDoc, s: BusStop): void {
  checkId(s.id, 'bus stop');
  if (!has(doc.segments, s.segmentId)) fail('unknown segment');
  checkNum(s.t, 0, 1, 'stop.t');
  if (s.dir !== 'forward' && s.dir !== 'backward') fail('invalid stop dir');
  const seg = doc.segments[s.segmentId]!;
  const rt = doc.roadTypes[seg.roadTypeId]!;
  if (s.dir === 'backward' && rt.lanesBackward === 0) fail('no lanes in that direction');
}

function validateLine(doc: CityDoc, l: BusLine): void {
  checkId(l.id, 'bus line');
  checkName(l.name, 'bus line');
  checkColor(l.color, 'bus line');
  if (!Array.isArray(l.stopIds) || l.stopIds.length < 2 || l.stopIds.length > LIMITS.stopsPerLine) fail('a line needs 2..100 stops');
  for (const id of l.stopIds) if (!has(doc.busStops, id)) fail('unknown bus stop');
  if (!has(doc.vehicleTypes, l.vehicleTypeId)) fail('unknown vehicle type');
  checkInt(l.buses, 0, LIMITS.busesPerLine, 'buses');
}

function cleanVehicleType(vt: VehicleType): VehicleType {
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
  };
}

function cleanControl(c: IntersectionControl): IntersectionControl {
  const out: IntersectionControl = { nodeId: c.nodeId, kind: c.kind, yellow: c.yellow, allRed: c.allRed, offset: c.offset };
  if (c.phases) out.phases = c.phases.map((p) => ({ approaches: p.approaches.slice(), green: p.green }));
  if (c.crosswalkLegs !== undefined) out.crosswalkLegs = [...new Set(c.crosswalkLegs)].sort();
  return out;
}

// ---------- command handlers ----------

function applyOne(doc: CityDoc, cmd: Command, tx: Tx): void {
  switch (cmd?.type) {
    case 'node.add': {
      const n = cmd.node;
      checkId(n?.id, 'node');
      if (has(doc.nodes, n.id)) fail('node exists');
      checkCapacity(doc.nodes, n.id, LIMITS.nodes, 'nodes');
      checkPos(doc, n.pos, 'node.pos');
      tx.set(doc.nodes, n.id, { id: n.id, pos: { x: n.pos.x, z: n.pos.z } });
      return;
    }
    case 'node.move': {
      const n = get(doc.nodes, cmd.id);
      if (!n) fail('unknown node');
      checkPos(doc, cmd.pos, 'pos');
      tx.set(doc.nodes, n.id, { id: n.id, pos: { x: cmd.pos.x, z: cmd.pos.z } });
      for (const s of segmentsAtNode(doc, n.id)) checkSegmentShape(doc, s);
      checkNoNewCrossings(doc, n.id);
      // Moving a node stretches its roads: features that no longer fit are removed with the move.
      for (const s of segmentsAtNode(doc, n.id)) pruneFeatures(doc, s.id, tx);
      return;
    }
    case 'segment.add': {
      const s = cmd.segment;
      checkId(s?.id, 'segment');
      if (has(doc.segments, s.id)) fail('segment exists');
      checkCapacity(doc.segments, s.id, LIMITS.segments, 'segments');
      if (!has(doc.nodes, s.a) || !has(doc.nodes, s.b)) fail('unknown node');
      if (s.a === s.b) fail('segment must connect two different nodes');
      if (!has(doc.roadTypes, s.roadTypeId)) fail('unknown road type');
      if (s.control !== undefined) checkPos(doc, s.control, 'control');
      for (const o of segmentsAtNode(doc, s.a)) {
        if ((o.a === s.a && o.b === s.b) || (o.a === s.b && o.b === s.a)) fail('nodes already connected');
      }
      const seg: RoadSegment = { id: s.id, a: s.a, b: s.b, roadTypeId: s.roadTypeId };
      if (s.control) seg.control = { x: s.control.x, z: s.control.z };
      if (s.schoolZone !== undefined && typeof s.schoolZone !== 'boolean') fail('invalid schoolZone flag');
      if (s.schoolZone) seg.schoolZone = true;
      checkSegmentShape(doc, seg);
      tx.set(doc.segments, seg.id, seg);
      return;
    }
    case 'segment.remove': {
      const s = get(doc.segments, cmd.id);
      if (!s) fail('unknown segment');
      removeSegment(doc, s, tx);
      return;
    }
    case 'segment.split':
      splitSegment(doc, cmd.id, cmd.t, cmd.nodeId, cmd.segmentIds, tx);
      return;
    case 'segment.setType': {
      const s = get(doc.segments, cmd.id);
      if (!s) fail('unknown segment');
      const rt = get(doc.roadTypes, cmd.roadTypeId);
      if (!rt) fail('unknown road type');
      tx.set(doc.segments, s.id, { ...s, roadTypeId: rt.id });
      if (!rt.sidewalk) dropCrosswalks(doc, (f) => f.segmentId === s.id, tx);
      for (const stop of Object.values(doc.busStops)) {
        if (stop.segmentId === s.id && stop.dir === 'backward' && rt.lanesBackward === 0) removeStop(doc, stop.id, tx);
      }
      return;
    }
    case 'segment.setSchoolZone': {
      const s = get(doc.segments, cmd.id);
      if (!s) fail('unknown segment');
      if (typeof cmd.schoolZone !== 'boolean') fail('invalid schoolZone flag');
      const { schoolZone: _old, ...rest } = s;
      tx.set(doc.segments, s.id, cmd.schoolZone ? { ...rest, schoolZone: true } : rest);
      return;
    }
    case 'roadType.upsert': {
      validateRoadType(cmd.roadType);
      checkCapacity(doc.roadTypes, cmd.roadType.id, LIMITS.roadTypes, 'road types');
      const rt = cmd.roadType;
      if (!rt.sidewalk) dropCrosswalks(doc, (f) => doc.segments[f.segmentId]?.roadTypeId === rt.id, tx);
      tx.set(doc.roadTypes, rt.id, {
        id: rt.id,
        name: rt.name,
        lanesForward: rt.lanesForward,
        lanesBackward: rt.lanesBackward,
        laneWidth: rt.laneWidth,
        speedLimit: rt.speedLimit,
        sidewalk: rt.sidewalk,
        busOnlyRightLane: rt.busOnlyRightLane,
      });
      return;
    }
    case 'building.place': {
      const b = cmd.building;
      checkId(b?.id, 'building');
      if (has(doc.buildings, b.id)) fail('building exists');
      checkCapacity(doc.buildings, b.id, LIMITS.buildings, 'buildings');
      if (!has(doc.buildingTypes, b.typeId)) fail('unknown building type');
      checkPos(doc, b.pos, 'building.pos');
      checkNum(b.rotation, -Math.PI * 4, Math.PI * 4, 'rotation');
      checkBuildingClear(doc, b.typeId, b.pos, b.rotation);
      tx.set(doc.buildings, b.id, { id: b.id, typeId: b.typeId, pos: { x: b.pos.x, z: b.pos.z }, rotation: b.rotation });
      return;
    }
    case 'building.remove':
      if (!has(doc.buildings, cmd.id)) fail('unknown building');
      tx.set(doc.buildings, cmd.id, undefined);
      return;
    case 'building.move': {
      const b = get(doc.buildings, cmd.id);
      if (!b) fail('unknown building');
      checkPos(doc, cmd.pos, 'pos');
      checkNum(cmd.rotation, -Math.PI * 4, Math.PI * 4, 'rotation');
      checkBuildingClear(doc, b.typeId, cmd.pos, cmd.rotation);
      tx.set(doc.buildings, b.id, { id: b.id, typeId: b.typeId, pos: { x: cmd.pos.x, z: cmd.pos.z }, rotation: cmd.rotation });
      return;
    }
    case 'parcel.upsert': {
      validateParcel(doc, cmd.parcel);
      checkCapacity(doc.parcels, cmd.parcel.id, LIMITS.parcels, 'parcels');
      const pc = cmd.parcel;
      tx.set(doc.parcels, pc.id, {
        id: pc.id,
        polygon: pc.polygon.map((v) => ({ x: v.x, z: v.z })),
        zone: pc.zone,
        regulation: { coverage: pc.regulation.coverage, far: pc.regulation.far, maxHeight: pc.regulation.maxHeight, setback: pc.regulation.setback },
      });
      return;
    }
    case 'parcel.remove':
      if (!has(doc.parcels, cmd.id)) fail('unknown parcel');
      tx.set(doc.parcels, cmd.id, undefined);
      return;
    case 'buildingType.upsert': {
      validateBuildingType(cmd.buildingType);
      checkCapacity(doc.buildingTypes, cmd.buildingType.id, LIMITS.buildingTypes, 'building types');
      const bt = cmd.buildingType;
      const existing = get(doc.buildingTypes, bt.id);
      // Stored designs always have rev ≥ 1 (normalizeDoc migrates); 0 means "must not exist yet".
      const prevRev = existing ? (existing.rev ?? 1) : 0;
      if (cmd.expectedRev !== undefined && enforcePolicy) {
        checkInt(cmd.expectedRev, 0, Number.MAX_SAFE_INTEGER, 'expectedRev');
        if (cmd.expectedRev !== prevRev) fail('conflict: the design was changed by someone else');
      }
      tx.set(doc.buildingTypes, bt.id, {
        id: bt.id,
        rev: prevRev + 1,
        name: bt.name,
        zone: bt.zone,
        parts: bt.parts.map((p) => ({
          offset: { x: p.offset.x, z: p.offset.z },
          width: p.width,
          depth: p.depth,
          floors: p.floors,
          floorHeight: p.floorHeight,
          baseHeight: p.baseHeight,
          roof: p.roof,
          color: p.color,
          roofColor: p.roofColor,
          ...(p.footprint ? { footprint: p.footprint.map((v) => ({ x: v.x, z: v.z })) } : {}),
          ...(p.use ? { use: p.use } : {}),
          ...(p.facade ? { facade: { style: p.facade.style, windowRatio: p.facade.windowRatio, ground: p.facade.ground } } : {}),
        })),
        ...(bt.smart
          ? {
              smart: {
                solarRoof: bt.smart.solarRoof,
                greenRoof: bt.smart.greenRoof,
                evChargers: bt.smart.evChargers,
                sensors: bt.smart.sensors,
                dronePort: bt.smart.dronePort,
              },
            }
          : {}),
        ...(bt.props
          ? {
              props: bt.props.map((pr) => ({
                kind: pr.kind,
                pos: { x: pr.pos.x, y: pr.pos.y, z: pr.pos.z },
                rot: pr.rot,
                size: pr.size,
                color: pr.color,
              })),
            }
          : {}),
      });
      return;
    }
    case 'buildingType.remove':
      if (!has(doc.buildingTypes, cmd.id)) fail('unknown building type');
      if (Object.values(doc.buildings).some((b) => b.typeId === cmd.id)) fail('building type in use');
      tx.set(doc.buildingTypes, cmd.id, undefined);
      return;
    case 'vehicleType.upsert':
      validateVehicleType(cmd.vehicleType);
      checkCapacity(doc.vehicleTypes, cmd.vehicleType.id, LIMITS.vehicleTypes, 'vehicle types');
      tx.set(doc.vehicleTypes, cmd.vehicleType.id, cleanVehicleType(cmd.vehicleType));
      return;
    case 'vehicleType.remove':
      if (!has(doc.vehicleTypes, cmd.id)) fail('unknown vehicle type');
      if (Object.values(doc.busLines).some((l) => l.vehicleTypeId === cmd.id)) fail('vehicle type in use');
      tx.set(doc.vehicleTypes, cmd.id, undefined);
      return;
    case 'intersection.set':
      validateControl(doc, cmd.control);
      tx.set(doc.intersections, cmd.control.nodeId, cleanControl(cmd.control));
      return;
    case 'intersection.reset':
      if (!has(doc.intersections, cmd.nodeId)) fail('no custom control on this node');
      tx.set(doc.intersections, cmd.nodeId, undefined);
      return;
    case 'busStop.add':
      validateStop(doc, cmd.stop);
      if (has(doc.busStops, cmd.stop.id)) fail('bus stop exists');
      checkCapacity(doc.busStops, cmd.stop.id, LIMITS.busStops, 'bus stops');
      tx.set(doc.busStops, cmd.stop.id, { id: cmd.stop.id, segmentId: cmd.stop.segmentId, t: cmd.stop.t, dir: cmd.stop.dir });
      return;
    case 'busStop.remove':
      if (!has(doc.busStops, cmd.id)) fail('unknown bus stop');
      removeStop(doc, cmd.id, tx);
      return;
    case 'busLine.upsert':
      validateLine(doc, cmd.line);
      checkCapacity(doc.busLines, cmd.line.id, LIMITS.busLines, 'bus lines');
      tx.set(doc.busLines, cmd.line.id, {
        id: cmd.line.id,
        name: cmd.line.name,
        color: cmd.line.color,
        stopIds: cmd.line.stopIds.slice(),
        vehicleTypeId: cmd.line.vehicleTypeId,
        buses: cmd.line.buses,
      });
      return;
    case 'busLine.remove':
      if (!has(doc.busLines, cmd.id)) fail('unknown bus line');
      tx.set(doc.busLines, cmd.id, undefined);
      return;
    case 'closure.set':
      if (!has(doc.segments, cmd.closure?.segmentId)) fail('unknown segment');
      checkName(cmd.closure.reason, 'closure reason');
      tx.set(doc.closures, cmd.closure.segmentId, { segmentId: cmd.closure.segmentId, reason: cmd.closure.reason });
      return;
    case 'closure.remove':
      if (!has(doc.closures, cmd.segmentId)) fail('segment is not closed');
      tx.set(doc.closures, cmd.segmentId, undefined);
      return;
    case 'feature.upsert': {
      const f = cmd.feature;
      validateFeature(doc, f);
      checkCapacity(doc.features, f.id, LIMITS.features, 'road features');
      const out: RoadFeature = { id: f.id, segmentId: f.segmentId, kind: f.kind, t: f.t };
      if (f.kind === 'crosswalk' && f.signal !== undefined) out.signal = f.signal;
      tx.set(doc.features, f.id, out);
      return;
    }
    case 'feature.remove':
      if (!has(doc.features, cmd.id)) fail('unknown road feature');
      tx.set(doc.features, cmd.id, undefined);
      return;
    case 'meta.update':
      if (cmd.name !== undefined) {
        checkName(cmd.name, 'city');
        tx.field(doc.meta, 'name', cmd.name);
      }
      if (cmd.trafficDensity !== undefined) {
        checkNum(cmd.trafficDensity, 0, 3, 'trafficDensity');
        tx.field(doc.meta, 'trafficDensity', cmd.trafficDensity);
      }
      return;
    default:
      fail(`unknown command type: ${String((cmd as { type?: unknown })?.type)}`);
  }
}

const FEATURE_KINDS = ['crosswalk', 'speedBump'];

/** Crosswalks need sidewalks to land on: removing the sidewalks removes them. */
function dropCrosswalks(doc: CityDoc, match: (f: RoadFeature) => boolean, tx: Tx): void {
  for (const f of Object.values(doc.features)) if (f.kind === 'crosswalk' && match(f)) tx.set(doc.features, f.id, undefined);
}

function validateFeature(doc: CityDoc, f: RoadFeature): void {
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
  const c = LIMITS.featureEndClearance;
  if (s < c - FEATURE_EPS || len - s < c - FEATURE_EPS) fail(`road features must be at least ${c}m from the segment ends`);
  for (const o of others) {
    if (Math.abs(o.t * len - s) < LIMITS.featureSpacing - FEATURE_EPS) fail('too close to another road feature');
  }
}

/** Tolerance of the feature distance rules, so remapped positions re-validate exactly. */
const FEATURE_EPS = 1e-6;

/**
 * After a segment changed shape: keep its features that still satisfy the end clearance and spacing
 * rules (in t order, ties by id) and remove the others — the same rules validateFeature applies.
 */
function pruneFeatures(doc: CityDoc, segId: SegmentId, tx: Tx): void {
  const seg = doc.segments[segId];
  if (!seg) return;
  const len = segmentLength(doc, seg);
  const c = LIMITS.featureEndClearance - FEATURE_EPS;
  const list = Object.values(doc.features)
    .filter((f) => f.segmentId === segId)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  let last = -Infinity;
  for (const f of list) {
    const s = f.t * len;
    if (s < c || len - s < c || s - last < LIMITS.featureSpacing - FEATURE_EPS) {
      tx.set(doc.features, f.id, undefined);
      continue;
    }
    last = s;
  }
}

function removeStop(doc: CityDoc, stopId: string, tx: Tx): void {
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

function removeSegment(doc: CityDoc, s: RoadSegment, tx: Tx): void {
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

function splitSegment(
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
  const closure = doc.closures[s.id];
  if (closure) {
    tx.set(doc.closures, s.id, undefined);
    tx.set(doc.closures, first.id, { ...closure, segmentId: first.id });
    tx.set(doc.closures, second.id, { ...closure, segmentId: second.id });
  }
  replaceApproach(doc, s.a, s.id, [first.id], tx);
  replaceApproach(doc, s.b, s.id, [second.id], tx);
}
