// applyCommand: the only way a CityDoc changes. Deterministic, validates everything (the server
// runs it on untrusted input), and leaves the doc untouched when a command fails.

import type { Command } from './commands.js';
import { sampleSegmentCurve, polylineLength, splitQuadBezier, type Vec2 } from './geometry.js';
import type {
  BuildingType,
  BusLine,
  BusStop,
  CityDoc,
  IntersectionControl,
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
  buildingParts: 16,
  vehicleParts: 24,
  vehicleTypes: 500,
  roadTypes: 200,
  busStops: 10_000,
  busLines: 1_000,
  stopsPerLine: 100,
  busesPerLine: 50,
  minSegmentLength: 8,
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

/** Like applyCommand, but the caller can still undo a successful command (e.g. when persisting it fails). */
export function tryApplyCommand(doc: CityDoc, cmd: Command): TryApplyResult {
  const tx = new Tx();
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
  }
}

export function applyCommand(doc: CityDoc, cmd: Command): ApplyResult {
  const r = tryApplyCommand(doc, cmd);
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

function validateBuildingType(bt: BuildingType): void {
  checkId(bt.id, 'building type');
  checkName(bt.name, 'building type');
  if (!['residential', 'commercial', 'office', 'industrial', 'public'].includes(bt.zone)) fail('invalid zone');
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
  }
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
  if (c.kind !== 'signal' && c.kind !== 'uncontrolled') fail('invalid intersection kind');
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
      for (const stop of Object.values(doc.busStops)) {
        if (stop.segmentId === s.id && stop.dir === 'backward' && rt.lanesBackward === 0) removeStop(doc, stop.id, tx);
      }
      return;
    }
    case 'roadType.upsert': {
      validateRoadType(cmd.roadType);
      checkCapacity(doc.roadTypes, cmd.roadType.id, LIMITS.roadTypes, 'road types');
      const rt = cmd.roadType;
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
      tx.set(doc.buildings, b.id, { id: b.id, typeId: b.typeId, pos: { x: b.pos.x, z: b.pos.z }, rotation: b.rotation });
      return;
    }
    case 'building.remove':
      if (!has(doc.buildings, cmd.id)) fail('unknown building');
      tx.set(doc.buildings, cmd.id, undefined);
      return;
    case 'buildingType.upsert': {
      validateBuildingType(cmd.buildingType);
      checkCapacity(doc.buildingTypes, cmd.buildingType.id, LIMITS.buildingTypes, 'building types');
      const bt = cmd.buildingType;
      tx.set(doc.buildingTypes, bt.id, {
        id: bt.id,
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
        })),
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
  const c = doc.intersections[nodeId];
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
  const closure = doc.closures[s.id];
  if (closure) {
    tx.set(doc.closures, s.id, undefined);
    tx.set(doc.closures, first.id, { ...closure, segmentId: first.id });
    tx.set(doc.closures, second.id, { ...closure, segmentId: second.id });
  }
  replaceApproach(doc, s.a, s.id, [first.id], tx);
  replaceApproach(doc, s.b, s.id, [second.id], tx);
}
