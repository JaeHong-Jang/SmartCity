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
  NodeId,
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
  | { type: 'roadType.upsert'; roadType: RoadType }
  | { type: 'building.place'; building: Building }
  | { type: 'building.remove'; id: string }
  | { type: 'buildingType.upsert'; buildingType: BuildingType }
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
  | { type: 'meta.update'; name?: string; trafficDensity?: number }
  /** Applied atomically: if any command fails, none take effect. Not nestable. */
  | { type: 'batch'; commands: Command[] };

export type CommandType = Command['type'];
