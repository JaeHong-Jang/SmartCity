// Which parts of the scene a command can change. One table for the renderer's layers and the
// overlays, so a new command type is a compile error until it is classified.

import type { Command, CommandType } from '@smartcity/shared';

export const D_ROADS = 1;
export const D_BUILDINGS = 2;
export const D_VEHICLE_TYPES = 4;
export const D_BUS_STOPS = 8;
export const D_BUS_LINES = 16;
export const D_PARCELS = 32;
export const D_ALL = D_ROADS | D_BUILDINGS | D_VEHICLE_TYPES | D_BUS_STOPS | D_BUS_LINES | D_PARCELS;

/**
 * Road edits that also remove automatic lots and their grown buildings in the same transaction, or remap
 * lot frontages (shared `pruneAutoLots`, ADR 0009 §4).
 */
const D_ROAD_PRUNE = D_ROADS | D_BUILDINGS | D_PARCELS;

/** `batch` is resolved from its children. `meta.update` changes nothing drawn. */
const DOMAINS: Record<Exclude<CommandType, 'batch'>, number> = {
  'node.add': D_ROADS,
  'node.move': D_ROAD_PRUNE,
  'segment.add': D_ROAD_PRUNE,
  'segment.remove': D_ROADS,
  'segment.split': D_ROAD_PRUNE,
  'road.fillet': D_ROAD_PRUNE,
  'segment.setType': D_ROAD_PRUNE,
  'segment.setSchoolZone': D_ROADS,
  'roadType.upsert': D_ROAD_PRUNE,
  'closure.set': D_ROADS,
  'closure.remove': D_ROADS,
  'intersection.set': D_ROADS,
  'intersection.reset': D_ROADS,
  'feature.upsert': D_ROADS,
  'feature.remove': D_ROADS,
  'building.place': D_BUILDINGS,
  'building.remove': D_BUILDINGS,
  'building.move': D_BUILDINGS,
  'buildingType.upsert': D_BUILDINGS,
  'buildingType.remove': D_BUILDINGS,
  'vehicleType.upsert': D_VEHICLE_TYPES,
  'vehicleType.remove': D_VEHICLE_TYPES,
  'busStop.add': D_BUS_STOPS,
  'busStop.remove': D_BUS_STOPS,
  'busLine.upsert': D_BUS_LINES,
  'busLine.remove': D_BUS_LINES,
  'parcel.upsert': D_PARCELS,
  'parcel.remove': D_PARCELS,
  'meta.update': 0,
  // Sensors are not drawn yet (P6b-2 adds their layer).
  'sensor.place': 0,
  'sensor.update': 0,
  'sensor.remove': 0,
};

/** Union of the domains a command (or every command of a batch) can change. */
export function commandDomains(cmd: Command): number {
  if (cmd.type !== 'batch') return DOMAINS[cmd.type];
  let d = 0;
  for (const c of cmd.commands) d |= DOMAINS[c.type as Exclude<CommandType, 'batch'>];
  return d;
}

/** Id of the entity a command creates/changes/removes directly (null: not keyed by one id). */
function directId(cmd: Command): string | null {
  switch (cmd.type) {
    case 'building.place':
      return cmd.building.id;
    case 'building.remove':
    case 'building.move':
    case 'busStop.remove':
    case 'parcel.remove':
      return cmd.id;
    case 'busStop.add':
      return cmd.stop.id;
    case 'parcel.upsert':
      return cmd.parcel.id;
    default:
      return null;
  }
}

/**
 * Whether a command can change how the selected entity is drawn. Road geometry is shared (moving a
 * node reshapes its segments), so any road command counts for road-bound selections.
 */
export function touchesSelection(cmd: Command, sel: { kind: string; id: string }): boolean {
  if (cmd.type === 'batch') return cmd.commands.some((c) => touchesSelection(c, sel));
  const d = DOMAINS[cmd.type];
  switch (sel.kind) {
    case 'segment':
    case 'node':
      return (d & D_ROADS) !== 0;
    case 'busStop':
      return (d & D_ROADS) !== 0 || ((d & D_BUS_STOPS) !== 0 && directId(cmd) === sel.id);
    case 'building':
      // A road edit may remove the selected (grown) building: d === D_ROAD_PRUNE.
      return cmd.type === 'buildingType.upsert' || cmd.type === 'buildingType.remove' || d === D_ROAD_PRUNE || ((d & D_BUILDINGS) !== 0 && directId(cmd) === sel.id);
    case 'parcel':
      return d === D_ROAD_PRUNE || ((d & D_PARCELS) !== 0 && directId(cmd) === sel.id);
    default:
      return true;
  }
}
