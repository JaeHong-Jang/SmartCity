// Public contract of @smartcity/sim. apps/web renders from these types, apps/server may run the
// simulation later (Phase 3). Change only with the Lead's approval (see AGENTS.md).

import type { NodeId, RoadType, SegmentId, TravelDir, Vec2 } from '@smartcity/shared';

// ---------- compiled road network (derived from CityDoc, never edited directly) ----------

export interface Lane {
  /** Dense index into RoadGraph.lanes. */
  index: number;
  /** Stable id `${segmentId}|${'f'|'b'}|${laneIndex}` — survives recompiles while the segment exists. */
  id: string;
  segmentId: SegmentId;
  dir: TravelDir;
  /** 0 = leftmost lane in travel direction (see shared laneOffset). */
  laneIndex: number;
  fromNode: NodeId;
  toNode: NodeId;
  /** Centerline in travel direction, trimmed by the node setbacks at both ends. */
  points: Vec2[];
  cum: number[];
  length: number;
  speedLimit: number;
  busOnly: boolean;
  /** Indexes into RoadGraph.connectors leaving the end of this lane. */
  out: number[];
}

export type Turn = 'left' | 'straight' | 'right' | 'uturn';

export interface Connector {
  index: number;
  /** `${fromLane.id}>${toLane.id}` */
  id: string;
  nodeId: NodeId;
  fromLane: number;
  toLane: number;
  turn: Turn;
  points: Vec2[];
  cum: number[];
  length: number;
  speedLimit: number;
  /** Indexes of connectors at the same node whose paths cross or that merge into the same lane. */
  conflicts: number[];
}

export interface CompiledSegment {
  id: SegmentId;
  roadType: RoadType;
  /** Full centerline node a → node b (untrimmed). */
  centerline: Vec2[];
  /** Arc length cut away at each end for the intersection area. */
  setbackA: number;
  setbackB: number;
  length: number;
  halfWidth: number;
  closed: boolean;
  /** Lane indexes, forward lanes first. */
  lanes: number[];
}

export interface CompiledNode {
  id: NodeId;
  pos: Vec2;
  segments: SegmentId[];
  /** Polygon covering the junction area (for rendering), empty for degree ≤ 1 with no area. */
  polygon: Vec2[];
  signalized: boolean;
}

export interface RoadGraph {
  lanes: Lane[];
  connectors: Connector[];
  segments: Map<SegmentId, CompiledSegment>;
  nodes: Map<NodeId, CompiledNode>;
  laneById: Map<string, number>;
}

// ---------- runtime state exposed to renderers ----------

export type SignalColor = 'red' | 'yellow' | 'green';

export interface SimStats {
  tick: number;
  /** Simulated seconds since start. */
  time: number;
  vehicles: number;
  spawned: number;
  arrived: number;
  /** Removed because no route existed or they were stuck too long. */
  removed: number;
  /** Mean speed of active vehicles, m/s. */
  avgSpeed: number;
  /** Vehicles below 0.5 m/s. */
  stopped: number;
  pendingRoutes: number;
  graphRevision: number;
}

export const VEHICLE_STRIDE = 6;
export const SIGNAL_STRIDE = 4;

export interface SimSnapshot {
  tick: number;
  time: number;
  /** Increments every time the road network is recompiled; renderers drop interpolation across revisions. */
  graphRevision: number;
  /** Per vehicle: x, z, heading (atan2(z,x) of travel), typeIndex, speed (m/s), vehicleId. */
  vehicles: Float32Array;
  vehicleCount: number;
  /** typeIndex → vehicleTypeId, in sorted id order. */
  vehicleTypeIds: string[];
  /** Per signal head (one per incoming lane at a signalized node): x, z, heading, color (0 red, 1 yellow, 2 green). */
  signals: Float32Array;
  signalCount: number;
  /** Per lane (RoadGraph.lanes order): mean speed / speed limit in [0,1], or -1 when empty. For the flow overlay. */
  laneFlow: Float32Array;
  stats: SimStats;
}

/** Buffers handed back by the consumer so the next snapshot can reuse them (no per-tick allocation). */
export interface SnapshotBuffers {
  vehicles?: Float32Array;
  signals?: Float32Array;
  laneFlow?: Float32Array;
}

export interface SimOptions {
  /** Ticks per simulated second. Default 20. */
  tickRate?: number;
  /** Max route searches per tick. Default 200. */
  routeBudget?: number;
  /** Hard cap on simultaneous vehicles. Default 10000. */
  maxVehicles?: number;
  /** Disable automatic demand (tests spawn vehicles manually). Default true. */
  demand?: boolean;
}

/** Read-only view of a vehicle, for tests and the inspector. */
export interface VehicleView {
  id: number;
  typeId: string;
  /** Current edge: lane or connector. */
  edge: { kind: 'lane' | 'connector'; index: number };
  s: number;
  v: number;
  pos: Vec2;
  heading: number;
  busLineId?: string;
  state: 'driving' | 'waiting' | 'dwelling';
}

export interface SignalView {
  nodeId: NodeId;
  phaseIndex: number;
  color: SignalColor;
  /** Seconds left in the current interval. */
  remaining: number;
  /** Approach segments currently allowed to enter. */
  greenApproaches: SegmentId[];
}
