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
  /** 어린이보호구역: 30 km/h, and vehicles stop before every unsignalized crosswalk on it. */
  schoolZone?: boolean;
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
export type FacadeStyle = 'grid' | 'ribbon' | 'curtain' | 'none';
export type GroundFloor = 'none' | 'shop' | 'lobby' | 'pilotis';

export interface Facade {
  style: FacadeStyle;
  /** Share of the wall that is glazing, 0.1..0.95. */
  windowRatio: number;
  ground: GroundFloor;
}

/**
 * One mass block (volume) of a building, in the building's local frame (x = width axis, z = depth axis).
 * Designed on a grid in the building studio; stored as geometry, never as cells.
 */
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
  /**
   * Orthogonal outline in the building frame (counter-clockwise, no holes). When present it replaces
   * the offset/width/depth rectangle, which then only describes the bounding box.
   */
  footprint?: Vec2[];
  /** Use of this volume; defaults to the building type's zone (mixed-use buildings set it per volume). */
  use?: Zone;
  facade?: Facade;
}

/** Smart-city equipment of a building. Roof-mounted items share one roof-area budget. */
export interface SmartFeatures {
  /** Share of the roof covered by solar panels, 0..1. */
  solarRoof: number;
  /** Share of the roof that is planted, 0..1. */
  greenRoof: number;
  evChargers: number;
  sensors: boolean;
  /** Rooftop delivery-drone pad (takes a fixed roof area). */
  dronePort: boolean;
}

/** Decorations snapped onto a design in the building studio (closed set; rendered from primitives). */
export const PROP_KINDS = [
  'balcony',
  'awning',
  'sign',
  'ac',
  'antenna',
  'waterTank',
  'chimney',
  'planter',
  'tree',
  'flag',
  'solarPanel',
  'helipad',
  'canopy',
  'bench',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export interface BuildingProp {
  kind: PropKind;
  /** Building frame, meters; y = height of the prop's base. */
  pos: { x: number; y: number; z: number };
  /** Quarter turns 0..3; wall props face away from the wall they are attached to. */
  rot: number;
  /** Width multiplier, 0.5..4. */
  size: number;
  color: string;
}

export interface BuildingType {
  id: BuildingTypeId;
  name: string;
  zone: Zone;
  parts: BuildingPart[];
  smart?: SmartFeatures;
  props?: BuildingProp[];
  /** Revision, incremented by applyCommand on every upsert (clients send `expectedRev` to avoid lost updates). */
  rev?: number;
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
  /** allStop = every approach stops at the line before entering (모든 방향 일시정지). */
  kind: 'signal' | 'uncontrolled' | 'allStop';
  /**
   * Legs (approach segments) that get an automatic crosswalk. Omitted = every leg with a sidewalk at a
   * junction of degree ≥ 3; [] = none.
   */
  crosswalkLegs?: SegmentId[];
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

export type ParcelZone = Zone | 'green';
export type ParcelId = string;

/** Simplified Korean land-use rules (국토계획법 용도지역 기준을 게임용으로 단순화). */
export interface Regulation {
  /** 건폐율: max building footprint / parcel area, 0..1. */
  coverage: number;
  /** 용적률: max gross floor area / parcel area (e.g. 2.5 = 250 %). */
  far: number;
  /** meters */
  maxHeight: number;
  /** Required clearance between buildings and the parcel edge, meters. */
  setback: number;
}

/** A land lot drawn by users: the unit of urban design and of regulation checks. */
export interface Parcel {
  id: ParcelId;
  /** Counter-clockwise or clockwise simple polygon, world coordinates. */
  polygon: Vec2[];
  zone: ParcelZone;
  regulation: Regulation;
}

export type RoadFeatureKind = 'crosswalk' | 'speedBump';
export type RoadFeatureId = string;

/** Point equipment placed on a segment (횡단보도, 과속방지턱). */
export interface RoadFeature {
  id: RoadFeatureId;
  segmentId: SegmentId;
  kind: RoadFeatureKind;
  /** Fraction (0..1) of the segment's arc length from node a (not the Bezier parameter of segment.split). */
  t: number;
  /** crosswalk only: has its own pedestrian signal. */
  signal?: boolean;
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

/** Bumped when the doc layout changes; normalizeDoc migrates older docs forward. */
export const DOC_VERSION = 3;

export interface CityDoc {
  version: number;
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
  parcels: Record<ParcelId, Parcel>;
  features: Record<RoadFeatureId, RoadFeature>;
}

/**
 * Migrate a doc saved by an older version (in place). v1 → v2: parcels collection, design
 * revisions, and the v1 city-hall preset whose wings overlapped by 1 m (v2 forbids overlapping volumes).
 * v2 → v3: road features collection.
 */
export function normalizeDoc(doc: CityDoc): CityDoc {
  // A missing collection is always safe to add; data rewrites happen only for real v1 docs.
  doc.parcels ??= {};
  doc.features ??= {};
  if (doc.version < 2) {
    for (const t of Object.values(doc.buildingTypes)) {
      t.rev ??= 1;
      // Only the v1 preset is rewritten; a v2 design that happens to look like it is user data.
      const wing = t.id === 'city-hall' ? t.parts[1] : undefined;
      if (wing && wing.offset.x === -12 && wing.offset.z === 14 && wing.width === 16 && wing.depth === 14) wing.offset.z = 15;
    }
    doc.version = 2;
  }
  if (doc.version < 3) doc.version = 3;
  return doc;
}

/** Deep copy of plain JSON data (docs and commands are always plain JSON). */
export const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
