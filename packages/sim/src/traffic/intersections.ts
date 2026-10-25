// Intersection manager (ADR 0004): the lead vehicle of each lane near the stop line requests its next
// connector; grants need green, no held conflicting connector, and exit space that is reserved atomically.
// ADR 0008: the grant also needs every crossing zone on the connector free of pedestrians (held, or
// eligible to enter) and reserves those zones with it. allStop approaches (and school-zone crossings at
// unsignalized junctions) first need a full stop; they are served in stop-completion order.

import { bannedRequest } from '../scenario/reroute.js';
import { requestDistance } from './vehicles.js';
import { pedBlocks, reservePassage, updateStop } from './zones.js';
import type { Vehicle, World } from './world.js';

const EXIT_MARGIN = 2;

interface Req {
  v: Vehicle;
  c: number;
  node: number;
  pri: number;
  /** Arrival order: request tick, or the full-stop tick at stop-required lines. */
  order: number;
}

// Scratch marks for "blocked by a conflict this tick"; stamps never repeat, so instances cannot interfere.
let blockedMark = new Uint32Array(0);
let blockedStamp = 0;
// Request records reused across ticks (processRequests is synchronous, so instances cannot interfere).
const reqPool: Req[] = [];
const reqs: Req[] = [];

function byOrder(a: Req, b: Req): number {
  return a.node - b.node || a.pri - b.pri || a.order - b.order || a.v.id - b.v.id;
}

export function exitNeed(w: World, v: Vehicle, lane: number): number {
  return Math.min(v.len + EXIT_MARGIN, w.net.len[lane]!);
}

/** Free length at the start of a lane, up to the tail of its last vehicle (or a scenario obstacle). */
function freeSpace(w: World, lane: number): number {
  const list = w.onEdge[lane]!;
  let free = w.net.len[lane]!;
  if (list.length > 0) {
    const last = list[list.length - 1]!;
    free = last.s - last.len;
  }
  const obs = w.sc !== null ? w.sc.obs : null;
  if (obs !== null && obs[lane]!.length > 0) free = Math.min(free, obs[lane]![0]!.rear);
  return free;
}

export function processRequests(w: World): void {
  try {
    grantRequests(w);
  } finally {
    // Drop vehicle references so the scratch does not keep removed vehicles alive.
    for (const r of reqs) r.v = undefined as unknown as Vehicle;
    reqs.length = 0;
  }
}

function grantRequests(w: World): void {
  const net = w.net;
  const nLanes = net.nLanes;
  const conns = w.graph.connectors;
  const ban = w.sc !== null ? w.sc.ban : null;
  // Dark (unpowered) signals run as an all-way stop: first come, first served, no turn priority.
  const dark = w.dark !== null ? w.dark.nodeDark : null;
  let n = 0;
  for (let l = 0; l < nLanes; l++) {
    const list = w.onEdge[l]!;
    if (list.length === 0) continue;
    const v = list[0]!;
    if (v.grant >= 0 || (v.bus && v.bus.dwell > 0)) continue;
    const nxt = v.route[v.ri + 1];
    if (nxt === undefined || nxt < nLanes) continue;
    const d = net.len[l]! - v.s;
    if (d > requestDistance(v)) continue;
    // Scenario closure (ADR 0010 §3, §6): no new entry; the vehicle asks for a recovery route.
    if (ban !== null) {
      if (ban[nxt]) {
        bannedRequest(w, v);
        continue;
      }
      // Its route was fixed meanwhile (stuck re-route, or that connector reopened): no longer waiting.
      if (v.scWait === 2) v.scWait = 0;
    }
    if (v.reqTick < 0) v.reqTick = w.tick;
    const stopReq = w.laneStopReq[l] === 1;
    if (stopReq) {
      updateStop(w, v, d);
      if (v.stopTick < 0) continue;
    }
    const c = nxt - nLanes;
    const node = net.connNode[c]!;
    // Turn priority only applies at signals; uncontrolled junctions are first come, first served.
    let r = reqPool[n];
    if (!r) reqPool.push((r = { v, c: 0, node: 0, pri: 0, order: 0 }));
    r.v = v;
    r.c = c;
    r.node = node;
    r.pri = net.nodeSignalized[node] && (dark === null || !dark[node]) ? net.connPri[c]! : 0;
    r.order = stopReq ? v.stopTick : v.reqTick;
    reqs[n++] = r;
  }
  reqs.length = n;
  if (n === 0 || w.noGrantTick === w.tick) return;
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
    // Yielding to pedestrians does not count as a vehicle conflict (it must not starve other movements).
    const zones = w.zones.conn[c]!;
    let peds = false;
    for (const p of zones)
      if (pedBlocks(w, p.z)) {
        peds = true;
        w.zs.vehWait[p.z] = w.tick;
      }
    if (peds) continue;
    const need = exitNeed(w, v, conn.toLane);
    if (freeSpace(w, conn.toLane) - w.reserved[conn.toLane]! < need - 1e-9) continue;
    v.grant = c;
    v.reqTick = -1;
    v.stopTick = -1;
    v.stopCnt = 0;
    for (const p of zones) reservePassage(w, v, p, net.nLanes + c);
    v.held.push({ c, rel: Infinity });
    w.holders[c]!++;
    w.reserved[conn.toLane]! += need;
    v.resLane = conn.toLane;
    v.resNeed = need;
  }
}
