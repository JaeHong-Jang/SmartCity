// Structural check of a stored city (after normalizeDoc): every collection is a keyed object, every
// entity has its id under its own key and the fields the code relies on, and the core references
// resolve. Loaders refuse a doc that fails instead of starting from it (ADR 0011): a doc whose
// `nodes` is an array, say, accepts edits that the next save silently drops.

import type { CityDoc } from './model.js';
import { medianShapeError } from './roads.js';
import { sensorShapeError } from './sensors.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): boolean => typeof v === 'string';
const vec = (v: unknown): boolean => isObj(v) && num(v.x) && num(v.z);

export const DOC_COLLECTIONS = [
  'nodes',
  'segments',
  'roadTypes',
  'buildingTypes',
  'buildings',
  'vehicleTypes',
  'intersections',
  'busStops',
  'busLines',
  'closures',
  'parcels',
  'features',
  'sensors',
] as const;

/**
 * A rounded volume (v7) is well formed: radius 0 ≤ round ≤ min(width, depth)/2 on a rectangle with a flat
 * roof — the same shape rules as `buildingType.upsert`, without its placement policy (null is dropped
 * by normalizeDoc). The radius feeds every outline (collision, area, mesh), so a bad one refuses the doc.
 */
function roundOk(p: unknown): boolean {
  if (!isObj(p) || p.round === undefined) return true;
  const r = p.round;
  if (!num(r) || !num(p.width) || !num(p.depth) || (r as number) < 0 || (r as number) > Math.min(p.width as number, p.depth as number) / 2) return false;
  return r === 0 || (p.footprint === undefined && p.roof === 'flat');
}

/** First structural problem of `doc`, or null when it is a usable city. */
export function docProblem(doc: unknown): string | null {
  if (!isObj(doc)) return 'doc is not an object';
  if (!num(doc.version)) return 'doc.version is not a number';
  const m = doc.meta;
  if (!isObj(m) || !str(m.name) || !num(m.seed) || !num(m.halfSize) || !num(m.trafficDensity)) return 'doc.meta is malformed';
  for (const k of DOC_COLLECTIONS) if (!isObj(doc[k])) return `doc.${k} is not a keyed collection`;
  const d = doc as unknown as Record<(typeof DOC_COLLECTIONS)[number], Obj>;
  const has = (k: (typeof DOC_COLLECTIONS)[number], id: unknown) => str(id) && Object.hasOwn(d[k], id as string);
  const rules: [(typeof DOC_COLLECTIONS)[number], string, (e: Obj) => boolean][] = [
    ['nodes', 'id', (e) => vec(e.pos)],
    ['segments', 'id', (e) => has('nodes', e.a) && has('nodes', e.b) && has('roadTypes', e.roadTypeId)],
    // The median (v9) feeds every lane offset and road width: the same rule as roadType.upsert.
    ['roadTypes', 'id', (e) => str(e.name) && num(e.lanesForward) && num(e.lanesBackward) && num(e.laneWidth) && num(e.speedLimit) && medianShapeError(e) === null],
    ['buildingTypes', 'id', (e) => str(e.name) && Array.isArray(e.parts) && e.parts.every(roundOk)],
    ['buildings', 'id', (e) => has('buildingTypes', e.typeId) && vec(e.pos) && num(e.rotation)],
    ['vehicleTypes', 'id', (e) => str(e.name) && num(e.length) && Array.isArray(e.parts)],
    ['intersections', 'nodeId', (e) => has('nodes', e.nodeId) && str(e.kind)],
    ['busStops', 'id', (e) => has('segments', e.segmentId) && num(e.t)],
    ['busLines', 'id', (e) => Array.isArray(e.stopIds) && str(e.vehicleTypeId)],
    ['closures', 'segmentId', (e) => has('segments', e.segmentId)],
    ['parcels', 'id', (e) => Array.isArray(e.polygon) && isObj(e.regulation)],
    ['features', 'id', (e) => has('segments', e.segmentId) && num(e.t)],
    // The same field rules as sensor.place (one validator): a bad kind or range must not reach the sim.
    ['sensors', 'id', (e) => has('segments', e.segmentId) && sensorShapeError(e) === null],
  ];
  for (const [k, idField, ok] of rules) {
    for (const [key, e] of Object.entries(d[k])) {
      if (!isObj(e) || e[idField] !== key || !ok(e)) return `doc.${k}["${key}"] is malformed`;
    }
  }
  return null;
}

/** Type guard form of docProblem. */
export const isUsableDoc = (doc: unknown): doc is CityDoc => docProblem(doc) === null;
