// Trip generation. With buildings: residential ↔ non-residential trips weighted by floor area, each
// building attached to its nearest open segment (≤ 80 m). Without buildings: random lane-to-lane trips.

import { buildingMetrics, closestPointOnPolyline, cross, cumulativeLengths, sub, tangentAtLength, type CityDoc, type TravelDir } from '@smartcity/shared';
import { groupKey, type Net } from '../network/net.js';
import { canPlace, type Goal, type World } from './world.js';

const ACCESS_RADIUS = 80;
const SPAWN_CLEARANCE = 5;

interface Access {
  segId: string;
  dir: TravelDir;
  /** Fraction of the segment from node a. */
  t: number;
}

export interface DemandModel {
  homes: Access[];
  homeW: number[];
  works: Access[];
  workW: number[];
  /** Lanes usable as random origins/destinations when the city has no buildings. */
  lanes: number[];
  totalLen: number;
  typeIds: string[];
  typeW: number[];
}

export function buildDemand(doc: CityDoc, net: Net): DemandModel {
  const g = net.graph;
  const m: DemandModel = { homes: [], homeW: [], works: [], workW: [], lanes: [], totalLen: 0, typeIds: [], typeW: [] };
  for (const l of g.lanes) {
    m.totalLen += l.length;
    if (!net.closed[l.index] && !l.busOnly && l.length >= 10) m.lanes.push(l.index);
  }
  for (const id of Object.keys(doc.vehicleTypes).sort()) {
    const vt = doc.vehicleTypes[id]!;
    if (vt.kind === 'bus' || vt.spawnWeight <= 0) continue;
    m.typeIds.push(id);
    m.typeW.push(vt.spawnWeight);
  }
  const open = [...g.segments.values()].filter((s) => !s.closed);
  for (const id of Object.keys(doc.buildings).sort()) {
    const b = doc.buildings[id]!;
    const type = doc.buildingTypes[b.typeId];
    if (!type) continue;
    let best: { segId: string; s: number; d: number; len: number; side: number } | null = null;
    for (const cs of open) {
      const cp = closestPointOnPolyline(cs.centerline, b.pos);
      if (cp.distance > ACCESS_RADIUS || (best && cp.distance >= best.d)) continue;
      const tan = tangentAtLength(cs.centerline, cumulativeLengths(cs.centerline), cp.s);
      best = { segId: cs.id, s: cp.s, d: cp.distance, len: cs.length, side: cross(tan, sub(b.pos, cp.point)) };
    }
    if (!best) continue;
    const cs = g.segments.get(best.segId)!;
    const dir: TravelDir = best.side < 0 && cs.roadType.lanesBackward > 0 ? 'backward' : 'forward';
    const acc: Access = { segId: best.segId, dir, t: best.len > 0 ? best.s / best.len : 0.5 };
    // Mixed-use buildings are both an origin (homes) and a destination (workplaces, shops).
    const byUse = buildingMetrics(type).areaByUse;
    const home = byUse.residential;
    const work = byUse.commercial + byUse.office + byUse.industrial + byUse.public;
    if (home > 0) {
      m.homes.push(acc);
      m.homeW.push(home);
    }
    if (work > 0) {
      m.works.push(acc);
      m.workW.push(work);
    }
  }
  return m;
}

/** Position on a lane for a segment fraction t (from node a). */
export function laneSAtT(net: Net, lane: number, t: number): number {
  const l = net.graph.lanes[lane]!;
  const k = l.dir === 'forward' ? t : 1 - t;
  return Math.max(0, Math.min(l.length, k * l.length));
}

/** Rightmost lane of a segment direction that the vehicle may use. */
function originLane(net: Net, segId: string, dir: TravelDir): number {
  const lanes = net.groups.get(groupKey(segId, dir));
  if (!lanes) return -1;
  for (let i = lanes.length - 1; i >= 0; i--) if (!net.busOnly[lanes[i]!]) return lanes[i]!;
  return -1;
}

export function generateTrips(w: World): void {
  const m = w.demand;
  if (m.typeIds.length === 0) return;
  // With citizens their own trips replace home ↔ work demand; what remains is background traffic
  // between random lanes at 0.3 × the rate (ADR 0008 §4).
  const citizens = w.cz.count > 0;
  const rate = ((citizens ? 0.3 : 1) * (w.doc.meta.trafficDensity * Math.min(m.totalLen / 60, 2000))) / 30;
  const lam = rate * w.dt;
  const base = Math.floor(lam);
  const n = base + (w.rng.next() < lam - base ? 1 : 0);
  const useBuildings = !citizens && m.homes.length > 0 && m.works.length > 0;
  for (let i = 0; i < n; i++) {
    if (w.vehicles.length + w.queue.length >= w.maxVehicles) return;
    const typeId = m.typeIds[w.rng.weighted(m.typeW)]!;
    const len = w.types.get(typeId)!.length;
    let lane: number;
    let s: number;
    let goal: Goal;
    if (useBuildings) {
      const h = m.homes[w.rng.weighted(m.homeW)]!;
      const k = m.works[w.rng.weighted(m.workW)]!;
      const [o, d] = w.rng.next() < 0.5 ? [h, k] : [k, h];
      lane = originLane(w.net, o.segId, o.dir);
      if (lane < 0) continue;
      s = laneSAtT(w.net, lane, o.t);
      goal = { segId: d.segId, dir: d.dir, anyDir: true, laneIndex: -1, mode: 't', t: d.t };
    } else {
      if (m.lanes.length === 0) return;
      lane = m.lanes[w.rng.int(m.lanes.length)]!;
      s = w.rng.next() * w.net.len[lane]!;
      const dl = w.graph.lanes[m.lanes[w.rng.int(m.lanes.length)]!]!;
      goal = { segId: dl.segmentId, dir: dl.dir, anyDir: true, laneIndex: -1, mode: 't', t: w.rng.next() };
    }
    const L = w.net.len[lane]!;
    if (L < len + 3) continue;
    s = Math.max(len + 3, Math.min(L, s));
    if (!canPlace(w, lane, s, len, SPAWN_CLEARANCE / 2)) continue;
    w.queue.push({ trip: { typeId, lane, s, goal } });
  }
}
