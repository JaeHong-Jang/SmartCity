// City document: the single editable, synchronized state of a city.
// World units are meters on the XZ plane (Y is up). Traffic drives on the right.

import type { Vec2 } from './geometry.js';

export type NodeId = string;
export type SegmentId = string;
export type RoadTypeId = string;
export type BuildingId = string;
export type BuildingTypeId = string;
export type VehicleTypeId = string;
export type BusStopId = string;
export type BusLineId = string;

export interface RoadNode {
  id: NodeId;
  pos: Vec2;
}

/** Forward direction is a → b. `control` makes it a quadratic Bezier curve. */
export interface RoadSegment {
  id: SegmentId;
  a: NodeId;
  b: NodeId;
  roadTypeId: RoadTypeId;
  control?: Vec2;
}

export interface RoadType {
  id: RoadTypeId;
  name: string;
  lanesForward: number;
  /** 0 = one-way road. */
  lanesBackward: number;
  laneWidth: number;
  /** m/s */
  speedLimit: number;
  sidewalk: boolean;
  /** Rightmost lane in each direction is reserved for buses. */
  busOnlyRightLane: boolean;
}

export type Zone = 'residential' | 'commercial' | 'office' | 'industrial' | 'public';
export type RoofShape = 'flat' | 'gable' | 'pyramid';

/** One mass block of a building, in the building's local frame (x = width axis, z = depth axis). */
export interface BuildingPart {
  offset: Vec2;
  width: number;
  depth: number;
  floors: number;
  floorHeight: number;
  /** Height above ground where this block starts (for towers on podiums). */
  baseHeight: number;
  roof: RoofShape;
  color: string;
  roofColor: string;
}

export interface BuildingType {
  id: BuildingTypeId;
  name: string;
  zone: Zone;
  parts: BuildingPart[];
}

export interface Building {
  id: BuildingId;
  typeId: BuildingTypeId;
  pos: Vec2;
  /** Radians; same convention as Three.js rotation.y (see geometry.rotateY). */
  rotation: number;
}

export type VehicleKind = 'car' | 'bus' | 'truck' | 'emergency';

/**
 * One box of a vehicle body in the vehicle frame: x = forward (0 at the vehicle center),
 * y = height of the box bottom above the road, z = to the right.
 */
export interface VehiclePart {
  offset: { x: number; y: number; z: number };
  length: number;
  width: number;
  height: number;
  color: string;
}

export interface VehicleType {
  id: VehicleTypeId;
  name: string;
  kind: VehicleKind;
  length: number;
  width: number;
  height: number;
  /** m/s */
  maxSpeed: number;
  /** m/s² (IDM a) */
  maxAccel: number;
  /** m/s² (IDM b) */
  comfortDecel: number;
  color: string;
  /** Relative share among generated private traffic. 0 = never spawned by demand. */
  spawnWeight: number;
  /** Visual structure. `length`/`width`/`height` stay the physical envelope used by the simulation. */
  parts: VehiclePart[];
}

export interface SignalPhase {
  /** Approach segments that get green together. */
  approaches: SegmentId[];
  /** seconds */
  green: number;
}

export interface IntersectionControl {
  nodeId: NodeId;
  kind: 'signal' | 'uncontrolled';
  /** Omitted = phases are derived automatically from geometry. */
  phases?: SignalPhase[];
  yellow: number;
  allRed: number;
  /** Cycle offset in seconds, for green-wave coordination. */
  offset: number;
}

export type TravelDir = 'forward' | 'backward';

export interface BusStop {
  id: BusStopId;
  segmentId: SegmentId;
  /** Fraction (0..1) of the segment's arc length, measured from node a. */
  t: number;
  dir: TravelDir;
}

export interface BusLine {
  id: BusLineId;
  name: string;
  color: string;
  stopIds: BusStopId[];
  vehicleTypeId: VehicleTypeId;
  buses: number;
}

/** A closed road. First hook for incident simulation. */
export interface Closure {
  segmentId: SegmentId;
  reason: string;
}

export interface CityMeta {
  name: string;
  seed: number;
  /** Half extent of the buildable square, meters. */
  halfSize: number;
  /** Global traffic demand multiplier, 0..3. */
  trafficDensity: number;
}

export interface CityDoc {
  version: 1;
  meta: CityMeta;
  nodes: Record<NodeId, RoadNode>;
  segments: Record<SegmentId, RoadSegment>;
  roadTypes: Record<RoadTypeId, RoadType>;
  buildingTypes: Record<BuildingTypeId, BuildingType>;
  buildings: Record<BuildingId, Building>;
  vehicleTypes: Record<VehicleTypeId, VehicleType>;
  intersections: Record<NodeId, IntersectionControl>;
  busStops: Record<BusStopId, BusStop>;
  busLines: Record<BusLineId, BusLine>;
  closures: Record<SegmentId, Closure>;
}

/** Deep copy of plain JSON data (docs and commands are always plain JSON). */
export const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
