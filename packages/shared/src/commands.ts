// Every change to a CityDoc is one of these commands. They are plain JSON so they can be
// sent over the network, logged, replayed and (later) scripted for incident scenarios.

import type { Vec2 } from './geometry.js';
import type {
  Building,
  BuildingType,
  BusLine,
  BusStop,
  Closure,
  IntersectionControl,
  Parcel,
  NodeId,
  RoadFeature,
  RoadNode,
  RoadSegment,
  RoadType,
  SegmentId,
  VehicleType,
} from './model.js';

export type Command =
  | { type: 'node.add'; node: RoadNode }
  | { type: 'node.move'; id: NodeId; pos: Vec2 }
  | { type: 'segment.add'; segment: RoadSegment }
  /** Removes the segment, anything attached to it, and nodes left without segments. */
  | { type: 'segment.remove'; id: SegmentId }
  /** Inserts node `nodeId` at parameter t; `segmentIds` = [a→node, node→b]. */
  | { type: 'segment.split'; id: SegmentId; t: number; nodeId: NodeId; segmentIds: [SegmentId, SegmentId] }
  | { type: 'segment.setType'; id: SegmentId; roadTypeId: string }
  | { type: 'segment.setSchoolZone'; id: SegmentId; schoolZone: boolean }
  | { type: 'roadType.upsert'; roadType: RoadType }
  /** `ifClear`: also refused when it would overlap another building (AI proposals, growth: ADR 0009 §5). */
  | { type: 'building.place'; building: Building; ifClear?: true }
  | { type: 'building.remove'; id: string }
  | { type: 'building.move'; id: string; pos: Vec2; rotation: number }
  /** With `expectedRev`, rejected unless the stored design still has that revision (0 = must be new). */
  | { type: 'buildingType.upsert'; buildingType: BuildingType; expectedRev?: number }
  /** Rejected while buildings of this type exist. */
  | { type: 'buildingType.remove'; id: string }
  | { type: 'vehicleType.upsert'; vehicleType: VehicleType }
  /** Rejected while a bus line uses this type. */
  | { type: 'vehicleType.remove'; id: string }
  | { type: 'intersection.set'; control: IntersectionControl }
  /** Return the node to automatic control. */
  | { type: 'intersection.reset'; nodeId: NodeId }
  | { type: 'busStop.add'; stop: BusStop }
  | { type: 'busStop.remove'; id: string }
  | { type: 'busLine.upsert'; line: BusLine }
  | { type: 'busLine.remove'; id: string }
  | { type: 'closure.set'; closure: Closure }
  | { type: 'closure.remove'; segmentId: SegmentId }
  /** `ifAbsent`: refused when the id exists, so a stale proposal never overwrites someone's parcel. */
  | { type: 'parcel.upsert'; parcel: Parcel; ifAbsent?: true }
  | { type: 'parcel.remove'; id: string }
  | { type: 'feature.upsert'; feature: RoadFeature }
  | { type: 'feature.remove'; id: string }
  | { type: 'meta.update'; name?: string; trafficDensity?: number; growth?: boolean }
  /** Applied atomically: if any command fails, none take effect. Not nestable. */
  | { type: 'batch'; commands: Command[] };

export type CommandType = Command['type'];
