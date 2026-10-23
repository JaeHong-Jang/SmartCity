// Bus passengers (ADR 0009 §2): stop queues (FIFO by arrival tick, then person id), dwell and capacity
// rules, per-line travel-time estimates for mode choice and the queue placement drawn in snapshots.
// Citizen state transitions (boarding, alighting, cleanup) live in citizens.ts.

import type { VehicleType } from '@smartcity/shared';
import { groupKey } from '../network/net.js';
import { ROUTE_SPEED } from '../network/pedGraph.js';
import { laneSAtT } from '../traffic/demand.js';
import { resolveGoal } from '../traffic/ops.js';
import type { World } from '../traffic/world.js';
import { routeLength } from './peds.js';

/** Game minutes a citizen waits at a stop before walking instead. */
export const WAIT_MINUTES = 30;
/** At most this many passengers board per stop arrival (matches the 40 s dwell cap). */
export const MAX_BOARD = 20;
const DWELL_BASE = 10;
const DWELL_MAX = 40;
const ALIGHT_SECONDS = 1;
const BOARD_SECONDS = 1.5;
/** Mode-choice estimates: bus (and car) cruising speed, m/s, and the cost of every intermediate stop, s. */
export const EST_SPEED = 8;
const STOP_PENALTY = 15;
/** Stops within this straight-line distance and walking-route length of a door are candidates, m. */
const STOP_RADIUS = 600;

export interface Waiter {
  slot: number;
  pid: number;
  tick: number;
}

export interface StopQueue {
  stop: string;
  line: string;
  list: Waiter[];
}

/** Per-line estimate: stop ids, directed route length from stop i to stop i + 1, loop length, buses. */
interface LineInfo {
  stops: string[];
  legs: number[];
  loop: number;
  buses: number;
}

export interface BusOption {
  line: string;
  board: string;
  alight: string;
  /** Estimated door-to-door time, s. */
  time: number;
}

export interface TransitState {
  /** Key `${stopId}|${lineId}`. Empty queues are deleted. */
  queues: Map<string, StopQueue>;
  /** Mode-choice caches; cleared on every recompile and derived refresh. */
  lines: Map<string, LineInfo | null>;
  near: Map<string, Map<string, number>>;
  options: Map<string, BusOption | null>;
  zeroQueue: Int32Array;
  /** Snapshot scratch per pedestrian slot: rank in the queue at its stop. */
  rank: Int32Array;
}

export function newTransit(): TransitState {
  return { queues: new Map(), lines: new Map(), near: new Map(), options: new Map(), zeroQueue: new Int32Array(0), rank: new Int32Array(0) };
}

export const capacityOf = (t: VehicleType | undefined): number => t?.capacity ?? (t?.kind === 'bus' ? 40 : 4);

/** Dwell in seconds for a stop arrival: exactly 10 s with nobody getting on or off. */
export const dwellSeconds = (alight: number, board: number): number =>
  Math.max(DWELL_BASE, Math.min(DWELL_MAX, DWELL_BASE + Math.max(alight * ALIGHT_SECONDS, board * BOARD_SECONDS)));

const qKey = (stop: string, line: string): string => `${stop}|${line}`;

export function queueOf(w: World, stop: string, line: string): Waiter[] | undefined {
  return w.transit.queues.get(qKey(stop, line))?.list;
}

/** Insert keeping (arrival tick, person id) order. */
export function enqueue(w: World, stop: string, line: string, wt: Waiter): void {
  const key = qKey(stop, line);
  let q = w.transit.queues.get(key);
  if (!q) w.transit.queues.set(key, (q = { stop, line, list: [] }));
  const list = q.list;
  let i = list.length;
  while (i > 0 && (list[i - 1]!.tick > wt.tick || (list[i - 1]!.tick === wt.tick && list[i - 1]!.pid > wt.pid))) i--;
  list.splice(i, 0, wt);
}

/** Remove a citizen slot from a queue; true when it was there. */
export function dequeue(w: World, stop: string, line: string, slot: number): boolean {
  const key = qKey(stop, line);
  const q = w.transit.queues.get(key);
  if (!q) return false;
  const k = q.list.findIndex((x) => x.slot === slot);
  if (k < 0) return false;
  q.list.splice(k, 1);
  if (q.list.length === 0) w.transit.queues.delete(key);
  return true;
}

/** Take the first `n` waiters of a queue. */
export function takeFront(w: World, stop: string, line: string, n: number): Waiter[] {
  const key = qKey(stop, line);
  const q = w.transit.queues.get(key);
  if (!q || n <= 0) return [];
  const out = q.list.splice(0, n);
  if (q.list.length === 0) w.transit.queues.delete(key);
  return out;
}

/** Queues in key order (deterministic iteration). */
export function sortedQueues(w: World): StopQueue[] {
  const qs = w.transit.queues;
  if (qs.size === 0) return [];
  return [...qs.keys()].sort().map((k) => qs.get(k)!);
}

export function clearTransitCaches(w: World): void {
  const t = w.transit;
  t.lines.clear();
  t.near.clear();
  t.options.clear();
}

/** Route length of a line from stop i to stop i + 1 for every i; null when a leg has no route (closures). */
function lineInfo(w: World, id: string): LineInfo | null {
  const t = w.transit;
  const hit = t.lines.get(id);
  if (hit !== undefined) return hit;
  let info: LineInfo | null = null;
  const line = w.doc.busLines[id];
  if (line && line.buses > 0 && w.types.has(line.vehicleTypeId)) {
    if (t.zeroQueue.length !== w.net.nLanes) t.zeroQueue = new Int32Array(w.net.nLanes);
    const n = line.stopIds.length;
    const legs: number[] = [];
    for (let i = 0; i < n && legs.length === i; i++) {
      const a = w.doc.busStops[line.stopIds[i]!];
      const b = w.doc.busStops[line.stopIds[(i + 1) % n]!];
      const la = a ? w.net.groups.get(groupKey(a.segmentId, a.dir)) : undefined;
      const lb = b ? w.net.groups.get(groupKey(b.segmentId, b.dir)) : undefined;
      if (!a || !b || !la || !lb) break;
      const lane = la[la.length - 1]!;
      const s = laneSAtT(w.net, lane, a.t);
      const goals = resolveGoal(w, { segId: b.segmentId, dir: b.dir, anyDir: false, laneIndex: lb.length - 1, mode: 't', t: b.t }, true);
      const res = w.router.find(lane, s, goals, true, t.zeroQueue);
      if (!res) break;
      let len = -s - (w.net.len[res.path[res.path.length - 1]!]! - res.destS);
      for (const e of res.path) len += w.net.len[e]!;
      legs.push(Math.max(0, len));
    }
    if (legs.length === n) info = { stops: line.stopIds.slice(), legs, loop: legs.reduce((x, y) => x + y, 0), buses: line.buses };
  }
  t.lines.set(id, info);
  return info;
}

/** Served stops whose walking route to (`toStop`) or from a door is at most STOP_RADIUS: stop id → route length. */
function nearStops(w: World, door: number, toStop: boolean): Map<string, number> {
  const key = `${toStop ? 'o' : 'd'}${door}`;
  const hit = w.transit.near.get(key);
  if (hit) return hit;
  const pg = w.ped.pg;
  const out = new Map<string, number>();
  for (let k = 0; k < pg.stopIds.length; k++) {
    const node = pg.stopNode[k]!;
    if (Math.hypot(pg.x[node]! - pg.x[door]!, pg.z[node]! - pg.z[door]!) > STOP_RADIUS) continue;
    const r = toStop ? routeLength(w, door, node) : routeLength(w, node, door);
    if (r && r.length <= STOP_RADIUS) out.set(pg.stopIds[k]!, r.length);
  }
  w.transit.near.set(key, out);
  return out;
}

/**
 * Best direct bus option between two doors, or null when there is no candidate (no served stop near both
 * ends on one usable line). Time = walk to the stop / 1.3 + half the headway (loop / 8 / buses / 2) +
 * directed ride / 8 + 15 s per intermediate stop + walk from the stop / 1.3. Ties: line id, then stop order.
 */
export function busOption(w: World, fromDoor: number, toDoor: number): BusOption | null {
  if (w.ped.pg.stopIds.length === 0) return null;
  const key = `${fromDoor}>${toDoor}`;
  const hit = w.transit.options.get(key);
  if (hit !== undefined) return hit;
  let best: BusOption | null = null;
  const from = nearStops(w, fromDoor, true);
  const to = from.size > 0 ? nearStops(w, toDoor, false) : from;
  if (from.size > 0 && to.size > 0) {
    for (const id of Object.keys(w.doc.busLines).sort()) {
      const info = lineInfo(w, id);
      if (!info) continue;
      const n = info.stops.length;
      const wait = info.loop / EST_SPEED / info.buses / 2;
      for (let i = 0; i < n; i++) {
        const wa = from.get(info.stops[i]!);
        if (wa === undefined) continue;
        for (let j = 0; j < n; j++) {
          const wb = to.get(info.stops[j]!);
          if (j === i || wb === undefined || info.stops[j] === info.stops[i]) continue;
          let ride = 0;
          for (let k = i; k !== j; k = (k + 1) % n) ride += info.legs[k]!;
          const between = (j - i - 1 + n) % n;
          const time = wa / ROUTE_SPEED + wait + ride / EST_SPEED + between * STOP_PENALTY + wb / ROUTE_SPEED;
          if (!best || time < best.time) best = { line: id, board: info.stops[i]!, alight: info.stops[j]!, time };
        }
      }
    }
  }
  w.transit.options.set(key, best);
  return best;
}

/** Snapshot: rank of every waiting pedestrian at its stop (all lines of the stop share one queue picture). */
export function fillQueueRanks(w: World): void {
  const t = w.transit;
  if (t.queues.size === 0) return;
  if (t.rank.length < w.peds.cap) t.rank = new Int32Array(w.peds.cap);
  const perStop = new Map<string, number>();
  for (const q of sortedQueues(w)) {
    let r = perStop.get(q.stop) ?? 0;
    for (const wt of q.list) {
      const c = w.cz.slots[wt.slot];
      if (c && c.ped >= 0) t.rank[c.ped] = r++;
    }
    perStop.set(q.stop, r);
  }
}
