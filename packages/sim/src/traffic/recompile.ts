// Network recompile with vehicle carry-over (packages/sim/AGENTS.md "재컴파일").

import { compileNetwork } from '../network/compile.js';
import { buildNet, type Net } from '../network/net.js';
import { Router } from '../network/route.js';
import { exitNeed } from './intersections.js';
import { insertOnEdge, type Held, type Vehicle, type World } from './world.js';

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

/**
 * Recompile the network in place and carry vehicles over: a vehicle stays when its lane or connector id
 * survives with (almost) the same length; it is then rerouted. Grants are dropped, physical connector
 * occupancy and exit reservations are rebuilt. Derived state (signals, demand, buses) is the caller's job.
 */
export function recompileWorld(w: World): void {
  const old = w.net;
  w.graph = compileNetwork(w.doc);
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
  const occupied = new Uint8Array(w.graph.connectors.length);
  for (const v of w.vehicles) {
    if (!v.alive) continue;
    const ne = mapEdge(w, old, v.edge);
    // Same id and (almost) the same length: lanes and connectors alike, so positions stay valid.
    let keep = ne >= 0 && Math.abs(net.len[ne]! - old.len[v.edge]!) < KEEP_LENGTH_DELTA;
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
      continue;
    }
    v.edge = ne;
    v.s = Math.min(v.s, net.len[ne]!);
    v.route = ne >= net.nLanes ? [ne, net.next[ne]![0]!] : [ne];
    v.ri = 0;
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
