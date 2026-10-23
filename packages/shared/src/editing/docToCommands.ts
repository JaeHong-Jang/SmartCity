// Rebuild a city as a command list, e.g. to import a saved JSON into a fresh room.
// Order matters: types first, then nodes before segments, segments before things on them.

import type { Command } from '../commands.js';
import type { CityDoc } from '../model.js';

const sortedValues = <T>(rec: Record<string, T>): T[] =>
  Object.keys(rec)
    .sort()
    .map((k) => rec[k]!);

export function docToCommands(doc: CityDoc): Command[] {
  const out: Command[] = [{ type: 'meta.update', name: doc.meta.name, trafficDensity: doc.meta.trafficDensity }];
  for (const roadType of sortedValues(doc.roadTypes)) out.push({ type: 'roadType.upsert', roadType });
  for (const buildingType of sortedValues(doc.buildingTypes)) out.push({ type: 'buildingType.upsert', buildingType });
  for (const vehicleType of sortedValues(doc.vehicleTypes)) out.push({ type: 'vehicleType.upsert', vehicleType });
  for (const node of sortedValues(doc.nodes)) out.push({ type: 'node.add', node });
  for (const segment of sortedValues(doc.segments)) out.push({ type: 'segment.add', segment });
  for (const building of sortedValues(doc.buildings)) out.push({ type: 'building.place', building });
  for (const control of sortedValues(doc.intersections)) out.push({ type: 'intersection.set', control });
  for (const stop of sortedValues(doc.busStops)) out.push({ type: 'busStop.add', stop });
  for (const line of sortedValues(doc.busLines)) out.push({ type: 'busLine.upsert', line });
  for (const closure of sortedValues(doc.closures)) out.push({ type: 'closure.set', closure });
  return out;
}
