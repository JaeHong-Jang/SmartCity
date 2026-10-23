// Intersection manager (ADR 0004): the lead vehicle of each lane near the stop line requests its next
// connector; grants need green, no held conflicting connector, and exit space that is reserved atomically.

import { requestDistance } from './vehicles.js';
import type { Vehicle, World } from './world.js';

const EXIT_MARGIN = 2;

interface Req {
  v: Vehicle;
  c: number;
  node: number;
  pri: number;
}

// Scratch marks for "blocked by a conflict this tick"; stamps never repeat, so instances cannot interfere.
let blockedMark = new Uint32Array(0);
let blockedStamp = 0;

function byOrder(a: Req, b: Req): number {
  return a.node - b.node || a.pri - b.pri || a.v.reqTick - b.v.reqTick || a.v.id - b.v.id;
}

export function exitNeed(w: World, v: Vehicle, lane: number): number {
  return Math.min(v.len + EXIT_MARGIN, w.net.len[lane]!);
}

/** Free length at the start of a lane, up to the tail of its last vehicle. */
function freeSpace(w: World, lane: number): number {
  const list = w.onEdge[lane]!;
  if (list.length === 0) return w.net.len[lane]!;
  const last = list[list.length - 1]!;
  return last.s - last.len;
}

export function processRequests(w: World): void {
  const net = w.net;
  const nLanes = net.nLanes;
  const conns = w.graph.connectors;
  const reqs: Req[] = [];
  for (let l = 0; l < nLanes; l++) {
    const list = w.onEdge[l]!;
    if (list.length === 0) continue;
    const v = list[0]!;
    if (v.grant >= 0 || (v.bus && v.bus.dwell > 0)) continue;
    const nxt = v.route[v.ri + 1];
    if (nxt === undefined || nxt < nLanes) continue;
    const d = net.len[l]! - v.s;
    if (d > requestDistance(v)) continue;
    if (v.reqTick < 0) v.reqTick = w.tick;
    const c = nxt - nLanes;
    const node = net.connNode[c]!;
    // Turn priority only applies at signals; uncontrolled junctions are first come, first served.
    reqs.push({ v, c, node, pri: net.nodeSignalized[node] ? net.connPri[c]! : 0 });
  }
  if (reqs.length === 0) return;
  reqs.sort(byOrder);

  if (blockedMark.length < conns.length) blockedMark = new Uint32Array(conns.length * 2);
  let node = -1;
  for (const r of reqs) {
    if (r.node !== node) {
      node = r.node;
      blockedStamp++;
    }
    const st = blockedStamp;
    const { v, c } = r;
    const conn = conns[c]!;
    if (!w.laneGreen[conn.fromLane]) continue;
    let conflict = false;
    let unfair = false;
    for (const k of conn.conflicts) {
      if (w.holders[k]! > 0) conflict = true;
      else if (blockedMark[k] === st) unfair = true;
    }
    if (conflict || unfair) {
      // A blocked request keeps later conflicting requests (e.g. yielding left turns) from jumping ahead.
      blockedMark[c] = st;
      continue;
    }
    const need = exitNeed(w, v, conn.toLane);
    if (freeSpace(w, conn.toLane) - w.reserved[conn.toLane]! < need - 1e-9) continue;
    v.grant = c;
    v.reqTick = -1;
    v.held.push({ c, rel: Infinity });
    w.holders[c]!++;
    w.reserved[conn.toLane]! += need;
    v.resLane = conn.toLane;
    v.resNeed = need;
  }
}
