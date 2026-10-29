// Rebuild a city as a command list, e.g. to import a saved JSON into a fresh room.
// Order matters: types first, then nodes before segments, segments before things on them.

import type { Command } from '../commands.js';
import type { CityDoc, IntersectionControl, Parcel } from '../model.js';

const sortedValues = <T>(rec: Record<string, T>): T[] =>
  Object.keys(rec)
    .sort()
    .map((k) => rec[k]!);

/**
 * Fields a document may legally keep after later edits but that creation-time validation refuses: a lot
 * whose frontage road is gone (growth skips it) and a scramble phase the junction no longer qualifies for
 * (the sim ignores it). Dropping them on export keeps the rest of the object importable (ADR 0009).
 */
function restorableParcel(doc: CityDoc, p: Parcel): Parcel {
  if (!p.frontage || doc.segments[p.frontage.segmentId]) return p;
  const { frontage: _gone, ...rest } = p;
  return rest;
}

function restorableControl(doc: CityDoc, c: IntersectionControl): IntersectionControl {
  if (!c.scramble) return c;
  const legs = Object.values(doc.segments).filter((s) => s.a === c.nodeId || s.b === c.nodeId);
  const walked = legs.filter((s) => doc.roadTypes[s.roadTypeId]?.sidewalk && (!c.crosswalkLegs || c.crosswalkLegs.includes(s.id)));
  if (c.kind === 'signal' && legs.length >= 3 && legs.length <= 4 && walked.length >= 2) return c;
  const { scramble: _off, ...rest } = c;
  return rest;
}

export function docToCommands(doc: CityDoc): Command[] {
  const out: Command[] = [
    { type: 'meta.update', name: doc.meta.name, trafficDensity: doc.meta.trafficDensity, ...(doc.meta.growth !== undefined ? { growth: doc.meta.growth } : {}) },
  ];
  for (const roadType of sortedValues(doc.roadTypes)) out.push({ type: 'roadType.upsert', roadType });
  for (const buildingType of sortedValues(doc.buildingTypes)) out.push({ type: 'buildingType.upsert', buildingType });
  for (const vehicleType of sortedValues(doc.vehicleTypes)) out.push({ type: 'vehicleType.upsert', vehicleType });
  for (const node of sortedValues(doc.nodes)) out.push({ type: 'node.add', node });
  for (const segment of sortedValues(doc.segments)) out.push({ type: 'segment.add', segment });
  for (const building of sortedValues(doc.buildings)) out.push({ type: 'building.place', building });
  for (const control of sortedValues(doc.intersections)) out.push({ type: 'intersection.set', control: restorableControl(doc, control) });
  for (const stop of sortedValues(doc.busStops)) out.push({ type: 'busStop.add', stop });
  for (const line of sortedValues(doc.busLines)) out.push({ type: 'busLine.upsert', line });
  for (const closure of sortedValues(doc.closures)) out.push({ type: 'closure.set', closure });
  for (const parcel of sortedValues(doc.parcels ?? {})) out.push({ type: 'parcel.upsert', parcel: restorableParcel(doc, parcel) });
  for (const feature of sortedValues(doc.features ?? {})) out.push({ type: 'feature.upsert', feature });
  for (const sensor of sortedValues(doc.sensors ?? {})) out.push({ type: 'sensor.place', sensor });
  return out;
}
