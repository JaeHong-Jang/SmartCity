// Public contract of @smartcity/sim. apps/web renders from these types, apps/server may run the
// simulation later (Phase 3). Change only with the Lead's approval (see AGENTS.md).

import type { NodeId, RoadType, SegmentId, TravelDir, Vec2 } from '@smartcity/shared';
import type { ScenarioView } from './scenario/types.js';
import type { ControlView } from './control/types.js';

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
  /**
   * Arc length (from each end, ≥ setback) where the lanes start: the setback plus the junction
   * crosswalk zone when that end has a crosswalk. Stop lines are drawn here.
   */
  laneStartA: number;
  laneStartB: number;
  /** Arc lengths (from node a) of speed bumps on this segment. */
  speedBumps: number[];
  /** 어린이보호구역: lanes are limited to SCHOOL_ZONE_SPEED. */
  schoolZone: boolean;
}

/** Pedestrian crossing (횡단보도), automatic at junctions or placed mid-block as a road feature. */
export interface Crossing {
  index: number;
  /** `${nodeId}|${segmentId}` for junction crossings, the feature id for mid-block ones. */
  id: string;
  kind: 'junction' | 'midblock';
  segmentId: SegmentId;
  /** Junction crossings: the node they guard. */
  nodeId?: NodeId;
  /** Arc length along the segment centerline (from node a) of the crossing's center line. */
  s: number;
  /** Curb points of the walking line, a = right side of the segment (in a → b direction), b = left. */
  a: Vec2;
  b: Vec2;
  /** Zebra width along the road, meters. */
  width: number;
  /** 4 corners on the carriageway (for rendering). */
  polygon: Vec2[];
  /** Has a pedestrian signal (signalized junction, or a mid-block crosswalk with signal). */
  signal: boolean;
  /** In a school zone: vehicles always stop before an unsignalized crossing. */
  schoolZone: boolean;
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
  crossings: Crossing[];
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
  /** Game clock: seconds since midnight of the current day, and the day number (1-based). */
  clock: { dayTime: number; day: number };
  citizens: CitizenStats;
  pedestrians: number;
}

export const VEHICLE_STRIDE = 6;
/** Signal head: x, z, heading, color (0 red, 1 yellow, 2 green, 3 dark = power cut, unlit). */
export const SIGNAL_STRIDE = 4;
/** Per pedestrian: x, z, heading, speed (m/s), gaitPhase (radians, from walked distance), style (0..15), state (PedState), elevation (m). */
export const PED_STRIDE = 8;
/** Per crossing (RoadGraph.crossings order): pedSignal (PedSignal), pedestrians on it, vehicles holding it. */
export const CROSSING_STRIDE = 3;

/** Outdoor pedestrian state in snapshots. */
export const PedState = { walking: 0, waiting: 1, door: 2, busStop: 3 } as const;
/** Pedestrian signal of a crossing: 3 = no signal (unsignalized crossing). */
export const PedSignal = { red: 0, clearance: 1, walk: 2, none: 3 } as const;

/** 1 real (simulated physics) second = CLOCK_SCALE game seconds of the day/night clock (ADR 0008). */
export const CLOCK_SCALE = 10;
/** Day time (seconds since midnight) at tick 0. */
export const CLOCK_START = 6.5 * 3600;
export const SCHOOL_ZONE_SPEED = 30 / 3.6;
export const SPEED_BUMP_SPEED = 20 / 3.6;

export interface CitizenStats {
  /** Simulated citizens (agents); each represents `scale` residents. */
  total: number;
  scale: number;
  home: number;
  atWork: number;
  walking: number;
  driving: number;
  waitingBus: number;
  riding: number;
}

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
  /** Per signal head (one per incoming lane at a signalized node): x, z, heading, color (0 red, 1 yellow, 2 green, 3 dark: power cut, unlit). */
  signals: Float32Array;
  signalCount: number;
  /** Per lane (RoadGraph.lanes order): mean speed / speed limit in [0,1], or -1 when empty. For the flow overlay. */
  laneFlow: Float32Array;
  /** Outdoor pedestrians, PED_STRIDE floats each. */
  pedestrians: Float32Array;
  /** Citizen id of each pedestrian (stable while the citizen exists). */
  pedestrianIds: Uint32Array;
  pedestrianCount: number;
  /** CROSSING_STRIDE floats per RoadGraph.crossings entry. */
  crossings: Float32Array;
  crossingCount: number;
  /**
   * `crossingSignature()` of the crossing ids this snapshot's `crossings` are indexed by. Read `crossings`
   * by index only when it equals the signature of the graph whose geometry is drawn.
   */
  crossingSig: number;
  /** People inside each building, in `buildingIds` order (sorted ids). */
  occupancy: Float32Array;
  buildingIds: string[];
  /** Passengers aboard each vehicle, in `vehicles` order (0 for non-buses). ADR 0009 §2. */
  busLoad: Uint16Array;
  /** Citizens waiting at each bus stop, in `busStopIds` order (sorted ids). */
  stopWaiting: Uint16Array;
  busStopIds: string[];
  stats: SimStats;
  /** Simulator mode (ADR 0010): obstacles, closed lanes and KPIs; absent unless the scenario API was used. */
  scenario?: ScenarioView;
  /** AI control room (ADR 0015 §6): agent states and recent decisions; present exactly when `scenario` is. */
  control?: ControlView;
}

/** Buffers handed back by the consumer so the next snapshot can reuse them (no per-tick allocation). */
export interface SnapshotBuffers {
  vehicles?: Float32Array;
  signals?: Float32Array;
  laneFlow?: Float32Array;
  pedestrians?: Float32Array;
  pedestrianIds?: Uint32Array;
  crossings?: Float32Array;
  occupancy?: Float32Array;
  busLoad?: Uint16Array;
  stopWaiting?: Uint16Array;
}

export interface SimOptions {
  /** Ticks per simulated second. Default 20. */
  tickRate?: number;
  /** Max vehicle route searches per tick. Default 100 (pedestrians have their own budget of 150, ADR 0008). */
  routeBudget?: number;
  /** Hard cap on simultaneous vehicles. Default 10000. */
  maxVehicles?: number;
  /** Disable automatic demand (tests spawn vehicles manually). Default true. */
  demand?: boolean;
  /** Simulate citizens (pedestrians and their trips). Default true. */
  citizens?: boolean;
  /** Hard cap on citizen agents. Default 8000. */
  maxCitizens?: number;
  /**
   * Simulator mode from tick 0 (ADR 0010): the scenario state exists from construction, so warm-up and
   * experiment both run with scenario rules (citizen decision hashes, cap draws) and replays match. Default false
   * (activated by the first scenarioInput / setPolicy / kpi call instead).
   */
  scenario?: boolean;
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
  /** Citizen driving this car (same id as in SimSnapshot.pedestrianIds). */
  personId?: number;
  state: 'driving' | 'waiting' | 'dwelling';
  /** Buses: passengers aboard and capacity. */
  passengers?: number;
  capacity?: number;
}

export interface SignalView {
  nodeId: NodeId;
  phaseIndex: number;
  color: SignalColor;
  /** Seconds left in the current interval. */
  remaining: number;
  /** Approach segments currently allowed to enter. */
  greenApproaches: SegmentId[];
  /** Full cycle length, seconds (vehicle phases plus the pedestrian-only phase when active). */
  cycle: number;
  /** The pedestrian-only phase (`IntersectionControl.scramble`) is active; false when ignored (ADR 0009 §3). */
  scramble: boolean;
  /** Signal dark (power cut, ADR 0010 §4): heads unlit, the junction runs as all-way stop; `color` is then 'red'. */
  dark?: true;
}
