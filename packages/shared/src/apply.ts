// applyCommand: the only way a CityDoc changes. Deterministic, validates everything (the server
// runs it on untrusted input), and leaves the doc untouched when a command fails.

import type { Command } from './commands.js';
import type { CityDoc, RoadFeature, RoadSegment } from './model.js';
import { LIMITS } from './apply/limits.js';
import { roadHalfWidth } from './roads.js';
import { ApplyError, Tx, fail, policy } from './apply/tx.js';
import {
  checkBuildingClear,
  checkCapacity,
  checkId,
  checkInt,
  checkName,
  checkNoNewCrossings,
  checkNum,
  checkPos,
  checkSegmentShape,
  cleanControl,
  cleanVehicleType,
  get,
  has,
  segmentsAtNode,
  validateBuildingType,
  validateControl,
  validateFeature,
  validateLine,
  validateParcel,
  validateRoadType,
  validateStop,
  validateVehicleType,
} from './apply/validate.js';
import { buildingOverlapsBuildings } from './editing/buildings.js';
import { checkRoadClear, dropCrosswalks, pruneAutoLots, pruneFeatures, removeSegment, removeStop, splitSegment } from './apply/roads.js';

export { LIMITS } from './apply/limits.js';
export { segmentLength, segmentsAtNode } from './apply/validate.js';

export type ApplyResult = { ok: true } | { ok: false; error: string };

export type TryApplyResult = { ok: true; rollback: () => void } | { ok: false; error: string };

export interface ApplyOptions {
  /**
   * The command was already accepted by the authoritative server (live `applied` messages, log
   * replay). Skips design-policy checks (road clearance, overlaps, crossings, footprint map bounds,
   * revisions), which may have been different when it was accepted. Structural validation still runs.
   */
  trusted?: boolean;
}


/** Like applyCommand, but the caller can still undo a successful command (e.g. when persisting it fails). */
export function tryApplyCommand(doc: CityDoc, cmd: Command, opts: ApplyOptions = {}): TryApplyResult {
  const tx = new Tx();
  policy.enforce = !opts.trusted;
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
    policy.enforce = true;
  }
}

export function applyCommand(doc: CityDoc, cmd: Command, opts: ApplyOptions = {}): ApplyResult {
  const r = tryApplyCommand(doc, cmd, opts);
  return r.ok ? { ok: true } : r;
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
      pruneAutoLots(doc, segmentsAtNode(doc, n.id).map((s) => s.id), tx);
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
      if (cmd.ifClear !== undefined && cmd.ifClear !== true) fail('invalid ifClear flag');
      if (cmd.ifClear) checkRoadClear(doc, seg);
      tx.set(doc.segments, seg.id, seg);
      pruneAutoLots(doc, [seg.id], tx);
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
      const wider = roadHalfWidth(rt) > roadHalfWidth(doc.roadTypes[s.roadTypeId]!);
      tx.set(doc.segments, s.id, { ...s, roadTypeId: rt.id });
      if (wider) pruneAutoLots(doc, [s.id], tx);
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
      const old = get(doc.roadTypes, rt.id);
      const wider = !!old && roadHalfWidth(rt) > roadHalfWidth(old);
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
      if (wider) pruneAutoLots(doc, Object.values(doc.segments).filter((s) => s.roadTypeId === rt.id).map((s) => s.id), tx);
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
      if (b.auto !== undefined && b.auto !== true) fail('invalid auto flag');
      if (cmd.ifClear !== undefined && cmd.ifClear !== true) fail('invalid ifClear flag');
      if (cmd.ifClear && buildingOverlapsBuildings(doc, b, doc.buildingTypes[b.typeId]!)) fail('overlaps another building');
      tx.set(doc.buildings, b.id, { id: b.id, typeId: b.typeId, pos: { x: b.pos.x, z: b.pos.z }, rotation: b.rotation, ...(b.auto ? { auto: true as const } : {}) });
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
      // A user move takes the building out of automatic management (auto is dropped).
      tx.set(doc.buildings, b.id, { id: b.id, typeId: b.typeId, pos: { x: cmd.pos.x, z: cmd.pos.z }, rotation: cmd.rotation });
      return;
    }
    case 'parcel.upsert': {
      if (cmd.ifAbsent !== undefined && cmd.ifAbsent !== true) fail('invalid ifAbsent flag');
      if (cmd.ifAbsent && has(doc.parcels, cmd.parcel?.id)) fail('parcel exists');
      validateParcel(doc, cmd.parcel);
      checkCapacity(doc.parcels, cmd.parcel.id, LIMITS.parcels, 'parcels');
      const pc = cmd.parcel;
      tx.set(doc.parcels, pc.id, {
        id: pc.id,
        polygon: pc.polygon.map((v) => ({ x: v.x, z: v.z })),
        zone: pc.zone,
        regulation: { coverage: pc.regulation.coverage, far: pc.regulation.far, maxHeight: pc.regulation.maxHeight, setback: pc.regulation.setback },
        ...(pc.auto ? { auto: true as const } : {}),
        ...(pc.frontage ? { frontage: { segmentId: pc.frontage.segmentId, side: pc.frontage.side } } : {}),
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
      if (cmd.expectedRev !== undefined && policy.enforce) {
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
        ...(bt.growth ? { growth: { level: bt.growth.level } } : {}),
        ...(bt.origin ? { origin: bt.origin } : {}),
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
      if (cmd.growth !== undefined) {
        if (typeof cmd.growth !== 'boolean') fail('invalid growth flag');
        tx.field(doc.meta, 'growth', cmd.growth);
      }
      return;
    default:
      fail(`unknown command type: ${String((cmd as { type?: unknown })?.type)}`);
  }
}
