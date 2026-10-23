// Network recompile with vehicle carry-over (packages/sim/AGENTS.md "재컴파일").

import { buildZones, crossingSignature } from '../network/crossings.js';
import { compileNetwork } from '../network/compile.js';
import { buildNet, type Net } from '../network/net.js';
import { Router } from '../network/route.js';
import { streetTables } from './calming.js';
import { exitNeed } from './intersections.js';
import { newZoneState } from './zones.js';
import { insertOnEdge, type Held, type Vehicle, type World, type ZoneHold } from './world.js';

const KEEP_LENGTH_DELTA = 0.5;

export function edgeArrays(net: Net): Vehicle[][] {
  const out: Vehicle[][] = [];
  for (let e = 0; e < net.nEdges; e++) out.push([]);
  return out;
}

function mapEdge(w: World, old: Net, e: number): number {
  const net = w.net;
  if (e < old.nLanes) return net.graph.laneById.get(old.graph.lanes[e]!.id) ?? -1;
  const c = net.connById.get(old.graph.connectors[e - old.nLanes]!.id);
  return c === undefined ? -1 : net.nLanes + c;
}

/** Old edge → new edge (−1 when it vanished), computed lazily once per recompile. */
function edgeMapper(w: World, old: Net): (e: number) => number {
  const memo = new Int32Array(old.nEdges).fill(-2);
  return (e) => {
    let m = memo[e]!;
    if (m === -2) memo[e] = m = mapEdge(w, old, e);
    return m;
  };
}

/** Street-feature tables of the current graph (zones, bumps, stop-required lanes). */
export function installStreet(w: World): void {
  w.zones = buildZones(w.net);
  w.zs = newZoneState(w.graph.crossings.length);
  w.crossingSig = crossingSignature(w.graph.crossings.map((c) => c.id));
  const t = streetTables(w.doc, w.graph);
  w.bumps = t.bumps;
  w.hasBumps = t.hasBumps;
  w.laneStopReq = t.laneStopReq;
}

/**
 * Edges under the vehicle body on the new graph, oldest first, ending with the current edge (`body` walks
 * the old route back until the tail is covered). Null when one of them vanished or changed length: the
 * body position would no longer be meaningful.
 */
function bodyEdges(w: World, old: Net, map: (e: number) => number, v: Vehicle): number[] | null {
  const out: number[] = [];
  let over = v.len - v.s;
  for (let j = v.ri; j >= 0; j--) {
    const oe = v.route[j]!;
    if (j < v.ri) {
      if (over <= 1e-6) break;
      over -= old.len[oe]!;
    }
    const ne = map(oe);
    if (ne < 0 || Math.abs(w.net.len[ne]! - old.len[oe]!) >= KEEP_LENGTH_DELTA) return null;
    out.push(ne);
  }
  return out.reverse();
}

/**
 * Zone reservations on the new graph (ADR 0008 §3: occupancy is restored from real bodies): (1) every
 * reservation the vehicle already had whose tail has not yet cleared it (odometer-based, independent of
 * the route), mapped by crossing id; (2) every zone the body overlaps now; (3) on the current connector,
 * every zone not yet cleared (the vehicle can no longer stop before it). Pending reservations are dropped.
 */
function restoreZones(w: World, old: Net, map: (e: number) => number, byId: ReadonlyMap<string, number>, v: Vehicle, body: number[]): ZoneHold[] {
  const net = w.net;
  const out: ZoneHold[] = [];
  const add = (z: number, edge: number, exitS: number, rel: number): void => {
    const h = out.find((x) => x.z === z && x.edge === edge);
    if (h) h.rel = Math.max(h.rel, rel);
    else out.push({ z, edge, exitS, rel });
  };
  for (const h of v.zones) {
    if (h.rel === Infinity || h.rel <= v.odo + 1e-9) continue;
    const z = byId.get(old.graph.crossings[h.z]!.id);
    const edge = map(h.edge);
    if (z === undefined || edge < 0) continue;
    const list = edge < net.nLanes ? w.zones.lane[edge]! : w.zones.conn[edge - net.nLanes]!;
    add(z, edge, list.find((p) => p.z === z)?.exitS ?? h.exitS, h.rel);
  }
  let front = v.s;
  for (let k = body.length - 1; k >= 0; k--) {
    const e = body[k]!;
    if (k < body.length - 1) front += net.len[e]!;
    const list = e < net.nLanes ? w.zones.lane[e]! : w.zones.conn[e - net.nLanes]!;
    for (const p of list) {
      const entered = front > p.enterS || (k === body.length - 1 && e >= net.nLanes);
      if (!entered || front - v.len >= p.exitS) continue;
      add(p.z, e, p.exitS, v.odo + (p.exitS - front) + v.len);
    }
  }
  return out;
}

/**
 * Recompile the network in place and carry vehicles over: a vehicle stays when its lane or connector id
 * survives with (almost) the same length; it is then rerouted. Grants are dropped, physical connector
 * occupancy, zone occupancy and exit reservations are rebuilt, and nothing new is granted this tick.
 * Derived state (signals, demand, buses, pedestrians) is the caller's job.
 */
export function recompileWorld(w: World): void {
  const old = w.net;
  w.graph = compileNetwork(w.doc, w.compileCache);
  w.net = buildNet(w.graph);
  const net = w.net;
  w.router = new Router(net);
  w.graphRevision++;
  w.onEdge = edgeArrays(net);
  w.holders = new Int32Array(w.graph.connectors.length);
  w.reserved = new Float64Array(net.nLanes);
  w.laneGreen = new Uint8Array(net.nLanes).fill(1);
  w.stopped = new Int32Array(net.nLanes);
  w.queue = [];
  installStreet(w);
  w.noGrantTick = w.tick;
  const occupied = new Uint8Array(w.graph.connectors.length);
  const map = edgeMapper(w, old);
  const crossingById = new Map(w.graph.crossings.map((c) => [c.id, c.index]));
  for (const v of w.vehicles) {
    if (!v.alive) continue;
    const ne = map(v.edge);
    // Same id and (almost) the same length for every edge under the body, so positions stay valid.
    const body = bodyEdges(w, old, map, v);
    let keep = ne >= 0 && body !== null;
    const held: Held[] = [];
    if (keep) {
      for (const h of v.held) {
        // Pending grants are dropped (re-requested); physical occupancy is kept.
        if (h.rel === Infinity && v.edge !== old.nLanes + h.c) continue;
        const c = net.connById.get(old.graph.connectors[h.c]!.id);
        if (c !== undefined) held.push({ c, rel: h.rel });
      }
      for (const h of held) for (const k of w.graph.connectors[h.c]!.conflicts) if (occupied[k]) keep = false;
    }
    if (!keep) {
      v.alive = false;
      w.removed++;
      if (v.person >= 0) w.lostDrivers.push(v.person);
      v.person = -1;
      continue;
    }
    v.zones = restoreZones(w, old, map, crossingById, v, body!);
    for (const h of v.zones) w.zs.veh[h.z]!++;
    v.stopCnt = 0;
    v.stopTick = -1;
    v.edge = ne;
    v.s = Math.min(v.s, net.len[ne]!);
    // The body history stays in the route (remapped) until the tail has left it.
    v.route = ne >= net.nLanes ? [...body!, net.next[ne]![0]!] : body!;
    v.ri = body!.length - 1;
    v.grant = -1;
    v.reqTick = -1;
    v.destS = Infinity;
    v.held = held;
    for (const h of held) {
      w.holders[h.c]!++;
      occupied[h.c] = 1;
    }
    v.resLane = -1;
    if (ne >= net.nLanes) {
      const lane = w.graph.connectors[ne - net.nLanes]!.toLane;
      v.resLane = lane;
      v.resNeed = exitNeed(w, v, lane);
      w.reserved[lane]! += v.resNeed;
    }
    insertOnEdge(w.onEdge[ne]!, v);
    v.queued = true;
    w.queue.push({ v, reason: 'replan' });
  }
  w.vehicles = w.vehicles.filter((v) => v.alive);
}
