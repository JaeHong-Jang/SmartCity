// Mutable simulation state shared by the traffic modules. Never handed to consumers directly.

import type { CityDoc, Rng, TravelDir, VehicleKind, VehicleType } from '@smartcity/shared';
import type { CitizenWorld } from '../citizens/citizens.js';
import type { PedPool, PedWorld } from '../citizens/peds.js';
import type { TransitState } from '../citizens/transit.js';
import type { ZoneIndex } from '../network/crossings.js';
import type { CompileCache } from '../network/compile.js';
import type { Net } from '../network/net.js';
import type { Router } from '../network/route.js';
import type { Mission, ScenarioState } from '../scenario/state.js';
import type { RoadGraph } from '../types.js';
import type { DemandModel } from './demand.js';
import type { BusLineState } from './buses.js';
import type { MidClearing, SignalClearing } from './signalClearing.js';
import type { DarkState } from './signalDark.js';
import type { SignalSet } from './signals.js';
import type { ZoneState } from './zones.js';

/** Destination: lanes of one segment direction; `laneIndex` −1 = any usable lane. */
export interface Goal {
  segId: string;
  dir: TravelDir;
  /** Accept either direction of the segment (demand trips); `dir` is then only a preference. */
  anyDir: boolean;
  laneIndex: number;
  /** 'end' = lane end; 't' = fraction of the segment measured from node a. */
  mode: 'end' | 't';
  t: number;
}

/** A connector reservation. `rel` = odometer value at which the tail clears it (Infinity until the front leaves). */
export interface Held {
  c: number;
  rel: number;
}

/** A conflict-zone reservation; `rel` = odometer value at which the tail clears the zone (Infinity until the front reaches `edge`). */
export interface ZoneHold {
  z: number;
  edge: number;
  exitS: number;
  rel: number;
}

export interface BusInfo {
  lineId: string;
  slot: number;
  stopIdx: number;
  /** Ticks of dwell left; 0 = driving. */
  dwell: number;
  /** Passengers aboard (citizen slot, stop to get off at), in boarding order (ADR 0009 §2). */
  riders: { slot: number; alight: string }[];
  /** Citizen slots getting off at the current stop; they step onto the sidewalk when the dwell ends. */
  alighting: number[];
  /** Stop of the current dwell (served for passengers), null otherwise. */
  atStop: string | null;
}

export interface Vehicle {
  id: number;
  typeId: string;
  typeIdx: number;
  kind: VehicleKind;
  len: number;
  a: number;
  b: number;
  s0: number;
  T: number;
  maxSpeed: number;
  edge: number;
  /** Front position along the edge. */
  s: number;
  v: number;
  acc: number;
  /** Distance the front may advance this tick without touching any obstacle. */
  gapHard: number;
  /** Edge ids; route[ri] is the current edge, earlier entries are recent history. */
  route: number[];
  ri: number;
  destS: number;
  goal: Goal;
  /** Granted connector index, −1 if none. */
  grant: number;
  reqTick: number;
  held: Held[];
  /** Conflict zones (crossings) reserved by this vehicle. */
  zones: ZoneHold[];
  /** Full-stop detection at a stop-required line (allStop, school-zone crossings). */
  stopCnt: number;
  /** Tick the full stop was completed for the current approach, −1 = not yet. */
  stopTick: number;
  /** Citizen driving this car (citizen slot), −1 = none. */
  person: number;
  resLane: number;
  resNeed: number;
  odo: number;
  stopTime: number;
  rerouted: boolean;
  queued: boolean;
  alive: boolean;
  bus: BusInfo | null;
  /** Spawn tick (scenario travel-time KPI). */
  t0: number;
  /** Scenario route state: 0 none, 1 recovery search queued, 2 waiting with no route (scenario/reroute.ts). */
  scWait: number;
  /** In the scenario re-route queue. */
  scQueued: boolean;
  /** Re-routed by the response policy at least once. */
  scRerouted: boolean;
  /** Emergency mission this vehicle drives for (scenario/emergency.ts); null for every other vehicle. */
  em: Mission | null;
}

export interface Trip {
  typeId: string;
  lane: number;
  s: number;
  goal: Goal;
}

export type QueueItem = { v: Vehicle; reason: 'replan' | 'stuck' } | { trip: Trip };

export interface World {
  doc: CityDoc;
  tickRate: number;
  dt: number;
  tick: number;
  routeBudget: number;
  maxVehicles: number;
  demandOn: boolean;
  rng: Rng;
  graph: RoadGraph;
  /** Reused between recompiles (per-node conflict tables). */
  compileCache: CompileCache;
  net: Net;
  router: Router;
  graphRevision: number;
  vehicles: Vehicle[];
  onEdge: Vehicle[][];
  /** Per connector: vehicles holding a reservation (granted, on it, or tail still on it). */
  holders: Int32Array;
  /** Per lane: exit space promised to granted vehicles that have not reached the lane yet. */
  reserved: Float64Array;
  laneGreen: Uint8Array;
  zones: ZoneIndex;
  zs: ZoneState;
  /** crossingSignature of graph.crossings. */
  crossingSig: number;
  /** Per lane: speed bumps in lane coordinates, ascending. */
  bumps: number[][];
  hasBumps: boolean;
  /** Per lane: vehicles must come to a full stop at the lane end before a grant (allStop, school-zone crossing). */
  laneStopReq: Uint8Array;
  /** No new zone/connector grants on this tick (the tick right after a recompile). */
  noGrantTick: number;
  /** Pedestrian graph, router and route queue. */
  ped: PedWorld;
  peds: PedPool;
  cz: CitizenWorld;
  /** Bus stop queues and mode-choice caches. */
  transit: TransitState;
  /** Citizens whose car vanished this tick (removed, not arrived). */
  lostDrivers: number[];
  /** Citizens whose car arrived this tick, with the lane it stopped on. */
  arrivedDrivers: { person: number; lane: number }[];
  stopped: Int32Array;
  queue: QueueItem[];
  typeIds: string[];
  types: Map<string, VehicleType>;
  signals: SignalSet;
  /** Edit-time clearances of junctions whose signal plan changed (traffic/signalClearing.ts), by node id. */
  signalClearing: Map<string, SignalClearing>;
  /** Mid-block signal crosswalks finishing a pedestrian clearance before a switch (by crosswalk id). */
  midClearing: Map<string, MidClearing>;
  /** Plan (and `mid:` crosswalk signal) offsets re-phased after a clearance or a hand-back, kept while the identity is unchanged. */
  signalOffsets: Map<string, { key: string; offset: number }>;
  /** Dark (unpowered) junctions and crosswalk signals (traffic/signalDark.ts); null while none. */
  dark: DarkState | null;
  demand: DemandModel;
  lines: BusLineState[];
  nextId: number;
  spawned: number;
  arrived: number;
  removed: number;
  /** Simulator-mode experiment state (ADR 0010); null until the first scenario call. */
  sc: ScenarioState | null;
}

export const STOP_SPEED = 0.5;

export function idmParams(kind: VehicleKind): { s0: number; T: number } {
  return kind === 'truck' || kind === 'bus' ? { s0: 3, T: 1.5 } : { s0: 2, T: 1.2 };
}

/** Insert keeping the list ordered by s descending (leader first). */
export function insertOnEdge(list: Vehicle[], v: Vehicle): void {
  let i = list.length;
  while (i > 0 && list[i - 1]!.s < v.s) i--;
  list.splice(i, 0, v);
}

export function removeFromEdge(list: Vehicle[], v: Vehicle): void {
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
}

/** Drop every reservation of a vehicle and take it off the network. Compaction happens at the end of the tick. */
export function despawn(w: World, v: Vehicle): void {
  if (!v.alive) return;
  v.alive = false;
  removeFromEdge(w.onEdge[v.edge]!, v);
  for (const h of v.held) w.holders[h.c]!--;
  v.held = [];
  for (const h of v.zones) w.zs.veh[h.z]!--;
  v.zones = [];
  if (v.person >= 0) w.lostDrivers.push(v.person);
  v.person = -1;
  if (v.resLane >= 0) w.reserved[v.resLane]! -= v.resNeed;
  v.resLane = -1;
  v.grant = -1;
}

const TAIL_DEPTH = 2;
const TAIL_REACH = 30;

export interface Obstacle {
  gap: number;
  v: number;
}

/** Closest tail of a vehicle that has left `edge` (onto any successor) but still overhangs it. */
export function tailOverhang(w: World, edge: number, d: number, depth: number, best: Obstacle): void {
  for (const n of w.net.next[edge]!) {
    const list = w.onEdge[n]!;
    if (list.length > 0) {
      const last = list[list.length - 1]!;
      const g = d + last.s - last.len;
      if (g < d && g < best.gap) {
        best.gap = g;
        best.v = last.v;
      }
    } else if (depth < TAIL_DEPTH && w.net.len[n]! < TAIL_REACH) {
      tailOverhang(w, n, d + w.net.len[n]!, depth + 1, best);
    }
  }
}

/**
 * Can a vehicle of length `len` be placed with its front at `s` on `lane`? Requires clearance to the
 * vehicles ahead and behind (scaled by the follower's speed), of tails still overhanging the lane end,
 * and of exit space promised to granted vehicles at the lane start.
 */
export function canPlace(w: World, lane: number, s: number, len: number, margin: number): boolean {
  const list = w.onEdge[lane]!;
  let last = true;
  for (const u of list) {
    if (u.s - u.len >= s + margin) continue;
    if (u.s <= s - len - margin - u.v * 1.2) {
      last = false;
      continue;
    }
    return false;
  }
  if (last && s - len - margin < w.reserved[lane]!) return false;
  // Never inside a mid-block conflict zone.
  for (const p of w.zones.lane[lane]!) if (s + margin > p.enterS && s - len - margin < p.exitS) return false;
  // Nor on a scenario obstacle (ADR 0010 §3).
  const obs = w.sc !== null ? w.sc.obs : null;
  if (obs !== null) for (const o of obs[lane]!) if (s + margin > o.rear && s - len - margin < o.rear + o.len) return false;
  const ob: Obstacle = { gap: Infinity, v: 0 };
  tailOverhang(w, lane, w.net.len[lane]! - s, 0, ob);
  return ob.gap >= margin;
}
