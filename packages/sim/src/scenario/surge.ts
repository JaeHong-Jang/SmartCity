// Demand surge (ADR 0010 §3): `extraTrips` visitors to a building, generated in full when `surge.start`
// applies, from an RNG seeded by (eventId, doc seed) — the demand RNG (`w.rng`) and the citizen streams are
// never touched. Inflow departures spread evenly over `inflowTicks`; after `stayTicks` each visitor drives
// back to its origin, spread over `outflowTicks`. Origins follow the demand model's residential weights
// (the target itself excluded); without homes, random demand lanes. Mode: every surge trip is a car trip
// (simplification). Due trips wait (counted as waiting to depart) until their origin has room.

import { Rng } from '@smartcity/shared';
import { canPlace, type Goal, type World } from '../traffic/world.js';
import { laneSAtT, originLane, type Access } from '../traffic/demand.js';
import { createVehicle } from '../traffic/ops.js';
import type { SurgeTrip } from './state.js';
import type { ScenarioInput } from './types.js';

export const SURGE_INFLOW_TICKS = 1200;
export const SURGE_STAY_TICKS = 2400;
/** Surge vehicles placed (route searches) per tick at most. */
export const SURGE_SPAWN_BUDGET = 8;
const SPAWN_MARGIN = 2.5;

/** 32-bit FNV-1a of a string. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function surgeSeed(eventId: string, seed: number): number {
  return (fnv(eventId) ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
}

/** Pre-generate the surge trips; returns how many were scheduled (inflow + outflow). */
export function generateSurge(w: World, input: ScenarioInput): number {
  const sc = w.sc!;
  const m = w.demand;
  const id = input.target.buildingId!;
  const dest = m.access.get(id);
  if (!dest || m.typeIds.length === 0) return 0;
  const n = input.params.extraTrips!;
  const inflow = input.params.inflowTicks ?? SURGE_INFLOW_TICKS;
  const stay = input.params.stayTicks ?? SURGE_STAY_TICKS;
  const outflow = input.params.outflowTicks ?? inflow;
  const rng = new Rng(surgeSeed(input.eventId, w.doc.meta.seed));
  const homeW = m.homeIds.map((h, k) => (h === id ? 0 : m.homeW[k]!));
  const useHomes = homeW.some((x) => x > 0);
  if (!useHomes && m.lanes.length === 0) return 0;
  const t0 = w.tick;
  const out: SurgeTrip[] = [];
  for (let i = 0; i < n; i++) {
    const typeId = m.typeIds[rng.weighted(m.typeW)]!;
    let from: Access;
    if (useHomes) from = m.homes[rng.weighted(homeW)]!;
    else {
      const l = w.graph.lanes[m.lanes[rng.int(m.lanes.length)]!]!;
      from = { segId: l.segmentId, dir: l.dir, t: rng.next() };
    }
    const base = { eventId: input.eventId, i, typeId, spawnTick: -1, vehicleId: -1, dropped: false };
    out.push({ ...base, dir: 0, depart: t0 + Math.floor((i * inflow) / n), from, to: dest });
    out.push({ ...base, dir: 1, depart: t0 + inflow + stay + Math.floor((i * outflow) / n), from: dest, to: from });
  }
  let last = t0;
  for (const t of out) last = Math.max(last, t.depart);
  sc.surges.set(input.eventId, { startTick: t0, endTick: last });
  for (const t of out) sc.surgeTrips.push(t);
  for (const t of out) sc.surgeQueue.push(t);
  sc.surgeQueue.sort((a, b) => a.depart - b.depart || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0) || a.dir - b.dir || a.i - b.i);
  return out.length;
}

/** Place due surge trips (departure order), at most SURGE_SPAWN_BUDGET route searches per tick. */
export function processSurge(w: World): void {
  const sc = w.sc!;
  const q = sc.surgeQueue;
  const ban = sc.ban;
  let budget = SURGE_SPAWN_BUDGET;
  let done = false;
  for (let k = 0; k < q.length && q[k]!.depart <= w.tick && budget > 0; k++) {
    if (w.vehicles.length >= w.maxVehicles) break;
    const t = q[k]!;
    const type = w.types.get(t.typeId);
    const lane = originLane(w.net, t.from.segId, t.from.dir);
    const L = lane >= 0 ? w.net.len[lane]! : 0;
    if (!type || lane < 0 || L < type.length + 3) {
      t.dropped = true;
      sc.dropped++;
      done = true;
      continue;
    }
    // A closed origin lane: wait for it to reopen.
    if (ban && ban[lane]) continue;
    const s = Math.max(type.length + 3, Math.min(L, laneSAtT(w.net, lane, t.from.t)));
    if (!canPlace(w, lane, s, type.length, SPAWN_MARGIN)) continue;
    budget--;
    const goal: Goal = { segId: t.to.segId, dir: t.to.dir, anyDir: true, laneIndex: -1, mode: 't', t: t.to.t };
    const v = createVehicle(w, t.typeId, lane, s, goal, null);
    done = true;
    if (!v) {
      t.dropped = true;
      sc.dropped++;
      continue;
    }
    t.spawnTick = w.tick;
    t.vehicleId = v.id;
  }
  if (done) sc.surgeQueue = q.filter((t) => t.spawnTick < 0 && !t.dropped);
}

/** Due surge trips not placed yet. */
export function surgeWaiting(w: World): number {
  let n = 0;
  for (const t of w.sc!.surgeQueue) {
    if (t.depart > w.tick) break;
    n++;
  }
  return n;
}
