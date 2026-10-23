// Conflict-zone runtime (ADR 0008 §3). Per crossing: vehicle holders, pedestrian holders (granted or on
// the crossing), pedestrians eligible to enter this tick, and the unsignalized 12 s gate. Vehicles reserve
// every zone on a connector together with its grant (intersections.ts) and request mid-block stop lines
// here; they are refused while a pedestrian holds the zone or may enter it.

import type { Passage } from '../network/crossings.js';
import { PedSignal } from '../types.js';
import { requestDistance } from './vehicles.js';
import type { Vehicle, World } from './world.js';

/** Unsignalized crossings: with vehicles waiting, pedestrians may keep a zone for at most this long… */
export const GATE_PED_LIMIT = 12;
/** …then no new pedestrian enters until one vehicle has passed or the zone has been clear this long. */
export const GATE_HOLD = 5;
/** Full stop: within this distance of the line… */
export const STOP_DIST = 1.5;
/** …below this speed… */
export const STOP_SPEED_MAX = 0.15;
/** …for this many consecutive ticks. */
export const STOP_TICKS = 10;
const EXIT_GAP = 2;

export interface ZoneState {
  /** Vehicles holding the zone. */
  veh: Int32Array;
  /** Pedestrians holding the zone (granted or walking on the crossing). */
  ped: Int32Array;
  /** Pedestrians waiting at the curb who may enter now (computed every tick). */
  elig: Int32Array;
  /** Last tick a vehicle was refused because of pedestrians. */
  vehWait: Int32Array;
  /** Vehicles that have cleared the zone (monotonic). */
  passed: Int32Array;
  blockStart: Int32Array;
  gate: Uint8Array;
  gateBase: Int32Array;
  gateClear: Int32Array;
  /** PedSignal per crossing. */
  pedSig: Uint8Array;
  /** Mid-block vehicle color: 0 red, 1 yellow, 2 green (2 for crossings without a signal). */
  midColor: Uint8Array;
}

export function newZoneState(n: number): ZoneState {
  return {
    veh: new Int32Array(n),
    ped: new Int32Array(n),
    elig: new Int32Array(n),
    vehWait: new Int32Array(n).fill(-2),
    passed: new Int32Array(n),
    blockStart: new Int32Array(n).fill(-1),
    gate: new Uint8Array(n),
    gateBase: new Int32Array(n),
    gateClear: new Int32Array(n).fill(-1),
    pedSig: new Uint8Array(n).fill(PedSignal.none),
    midColor: new Uint8Array(n).fill(2),
  };
}

/** Pedestrians hold or may enter the zone: vehicles must not get it. */
export const pedBlocks = (w: World, z: number): boolean => w.zs.ped[z]! > 0 || w.zs.elig[z]! > 0;

export function holdsZone(v: Vehicle, z: number, edge: number): boolean {
  for (const h of v.zones) if (h.z === z && h.edge === edge) return true;
  return false;
}

/** Reserve a passage for a vehicle. The release odometer is fixed once the front is on `edge`. */
export function reservePassage(w: World, v: Vehicle, p: Passage, edge: number): void {
  const rel = v.edge === edge ? v.odo - v.s + p.exitS + v.len : Infinity;
  v.zones.push({ z: p.z, edge, exitS: p.exitS, rel });
  w.zs.veh[p.z]!++;
}

/** Count ticks of a full stop near the line; sets `stopTick` once complete. */
export function updateStop(w: World, v: Vehicle, d: number): void {
  if (d <= STOP_DIST && v.v < STOP_SPEED_MAX) {
    if (++v.stopCnt >= STOP_TICKS && v.stopTick < 0) v.stopTick = w.tick;
  } else v.stopCnt = 0;
}

/** Mid-block crossings that make every vehicle stop: unsignalized in a school zone. */
export const mustStopAt = (w: World, z: number): boolean => w.graph.crossings[z]!.schoolZone && w.zs.pedSig[z] === PedSignal.none;

/** Unsignalized 12 s gate (ADR 0008 §3). Runs before pedestrian requests, on last tick's counts. */
export function updateGates(w: World): void {
  const zs = w.zs;
  const tick = w.tick;
  const limit = Math.round(GATE_PED_LIMIT * w.tickRate);
  const hold = Math.round(GATE_HOLD * w.tickRate);
  for (let z = 0; z < zs.veh.length; z++) {
    if (zs.pedSig[z] !== PedSignal.none) continue;
    if (zs.gate[z]) {
      let open = zs.passed[z]! > zs.gateBase[z]!;
      if (zs.ped[z] === 0) {
        if (zs.gateClear[z]! < 0) zs.gateClear[z] = tick;
        else if (tick - zs.gateClear[z]! >= hold) open = true;
      } else zs.gateClear[z] = -1;
      if (open) {
        zs.gate[z] = 0;
        zs.blockStart[z] = -1;
      }
      continue;
    }
    if (zs.vehWait[z]! >= tick - 1 && (zs.ped[z]! > 0 || zs.elig[z]! > 0)) {
      if (zs.blockStart[z]! < 0) zs.blockStart[z] = tick;
      else if (tick - zs.blockStart[z]! >= limit) {
        zs.gate[z] = 1;
        zs.gateBase[z] = zs.passed[z]!;
        zs.gateClear[z] = -1;
        zs.blockStart[z] = -1;
      }
    } else zs.blockStart[z] = -1;
  }
}

/** First mid-block stop on `stops` at or ahead of `from` that the vehicle has not been granted. */
export function nextGate(v: Vehicle, stops: readonly Passage[], edge: number, from: number): Passage | null {
  for (const p of stops) {
    if (p.enterS <= from - 1e-6) continue;
    if (!holdsZone(v, p.z, edge)) return p;
  }
  return null;
}

/** Space behind the zone so a granted vehicle never has to stop on the crossing. */
function roomAfter(w: World, u: Vehicle, l: number, p: Passage): boolean {
  let tail = Infinity;
  let need = u.len + EXIT_GAP;
  for (const x of w.onEdge[l]!) {
    if (x === u) continue;
    if (x.s > p.enterS + 1e-6) tail = Math.min(tail, x.s - x.len);
    else if (holdsZone(x, p.z, l)) need += x.len + EXIT_GAP;
  }
  if (tail === Infinity) {
    // Nobody ahead: the lane end bounds the queue unless the vehicle leaves the lane (granted onward) or ends its trip here.
    const last = u.route[u.route.length - 1] === l;
    const onward = u.edge === l && u.grant >= 0;
    if (last || onward) return true;
    tail = w.net.len[l]!;
  }
  return tail - p.exitS >= need - 1e-9;
}

function tryPass(w: World, u: Vehicle, l: number, p: Passage, d: number): void {
  // Ask as soon as the line enters the IDM horizon, so an empty crosswalk costs no braking.
  if (d > requestDistance(u) + u.v * u.T) return;
  const zs = w.zs;
  if (zs.midColor[p.z] !== 2) return;
  if (mustStopAt(w, p.z)) {
    if (u.edge !== l) return;
    updateStop(w, u, d);
    if (u.stopTick < 0) return;
  }
  if (w.noGrantTick === w.tick) return;
  if (pedBlocks(w, p.z)) {
    zs.vehWait[p.z] = w.tick;
    return;
  }
  if (!roomAfter(w, u, l, p)) return;
  reservePassage(w, u, p, l);
  u.stopTick = -1;
  u.stopCnt = 0;
}

/**
 * Mid-block stop lines: the first vehicle without a pass in front of each line asks for it within its
 * request distance — from the lane itself, or for the first line of a lane, from the connector feeding
 * it (or the granted lead vehicle before that connector).
 */
export function processInnerRequests(w: World): void {
  const net = w.net;
  const nLanes = net.nLanes;
  for (const l of w.zones.stopLanes) {
    const stops = w.zones.lane[l]!;
    const list = w.onEdge[l]!;
    for (let j = 0; j < stops.length; j++) {
      const p = stops[j]!;
      let cand: Vehicle | null = null;
      for (const u of list) {
        if (u.s > p.enterS + 1e-6 || holdsZone(u, p.z, l)) continue;
        cand = u;
        break;
      }
      if (cand) {
        // Its next ungranted line must be this one (earlier lines are requested first).
        if (nextGate(cand, stops, l, cand.s) === p) tryPass(w, cand, l, p, p.enterS - cand.s);
        continue;
      }
      if (j > 0) continue;
      for (const c of w.zones.incoming[l]!) {
        const e = nLanes + c;
        const cl = w.onEdge[e]!;
        if (cl.length > 0) {
          for (const u of cl) {
            if (holdsZone(u, p.z, l)) continue;
            if (u.route[u.ri + 1] === l) tryPass(w, u, l, p, net.len[e]! - u.s + p.enterS);
            break;
          }
          continue;
        }
        const from = w.graph.connectors[c]!.fromLane;
        const u = w.onEdge[from]![0];
        if (u && u.grant === c && !holdsZone(u, p.z, l)) tryPass(w, u, l, p, net.len[from]! - u.s + net.len[e]! + p.enterS);
      }
    }
  }
}
