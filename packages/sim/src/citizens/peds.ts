// Outdoor pedestrians (ADR 0008 §4, Sol 06 §3): route following on the pedestrian graph, one walking band
// per edge direction (offset to the right of travel), 0.7 m minimum spacing inside a band, an entry-space
// check on every edge transition, and crossing entry only with a zone grant. State lives in typed arrays
// (SoA) indexed by slot; slots are reused through a free list, so iteration order is deterministic.

import { pointAtLength, rightNormal, tangentAtLength } from '@smartcity/shared';
import { writePose } from '../network/net.js';
import { nearestEdge, nearestNode, PedEdgeKind, PedRouter, type PedGraph } from '../network/pedGraph.js';
import { PedSignal, PedState } from '../types.js';
import type { World } from '../traffic/world.js';

/** Minimum center distance of two pedestrians in one band. */
export const PED_SPACING = 0.7;
/** Lateral offset of a band from the edge centerline (to the right of travel). */
export const BAND_OFFSET = 0.65;
/** A pedestrian asks for a crossing this far before the curb. */
const REQUEST_DIST = 2;
export const DOOR_SECONDS = 1;
/** Pedestrian route searches per tick (ADR 0008 §4). */
export const PED_ROUTE_BUDGET = 150;
/** Re-projection radius after a network or building edit. */
export const REPROJECT_RADIUS = 20;
const STRIDE_LENGTH = 1.4;
const CACHE_LIMIT = 100_000;
/** Pedestrian ids of test/bench walkers (no citizen) start here. */
export const WALKER_ID_BASE = 0x80000000;

export class PedPool {
  cap = 0;
  /** Slots in use are < hi. */
  hi = 0;
  count = 0;
  free: number[] = [];
  alive = new Uint8Array(0);
  gen = new Uint32Array(0);
  pid = new Uint32Array(0);
  /** Citizen slot, −1 = walker. */
  owner = new Int32Array(0);
  /** Current edge, −1 = standing at `node`. */
  edge = new Int32Array(0);
  dir = new Uint8Array(0);
  pos = new Float64Array(0);
  node = new Int32Array(0);
  vPref = new Float32Array(0);
  vCur = new Float32Array(0);
  walked = new Float64Array(0);
  heading = new Float32Array(0);
  style = new Uint8Array(0);
  state = new Uint8Array(0);
  /** Door dwell ticks left. */
  timer = new Int32Array(0);
  /** 1 = the door dwell is the arrival (event when it ends). */
  arriving = new Uint8Array(0);
  /** 1 = dwell at the door on arrival; 0 = report arrival on reaching the last node. */
  doorOnArrive = new Uint8Array(0);
  /** Crossing granted to (zone held), −1 = none. */
  grant = new Int32Array(0);
  /** Band beyond the granted crossing where a place is reserved (signed edge), −1 = none. */
  resBand = new Int32Array(0);
  /** route[ri] = current edge (signed), route[ri + 1] = next; off-band pedestrians have ri = −1. */
  ri = new Int32Array(0);
  /** 1 = waiting for a route or parked by its owner: does not move. */
  pending = new Uint8Array(0);
  /** Destination node of the current route (re-resolved by the owner after edits). */
  goal = new Int32Array(0);
  goalX = new Float64Array(0);
  goalZ = new Float64Array(0);
  moved = new Uint32Array(0);
  route: Int32Array[] = [];
  /** Per signed edge (edge·2 + dir): pedestrians ordered by position, leader first. */
  bands: number[][] = [];
  /** Per signed edge: places reserved by pedestrians granted the crossing before it. */
  bandRes = new Int32Array(0);

  grow(): void {
    const cap = Math.max(64, this.cap * 2);
    const g = <T extends { length: number; set(a: ArrayLike<number>): void }>(a: T, C: new (n: number) => T): T => {
      const b = new C(cap);
      b.set(a as unknown as ArrayLike<number>);
      return b;
    };
    this.alive = g(this.alive, Uint8Array);
    this.gen = g(this.gen, Uint32Array);
    this.pid = g(this.pid, Uint32Array);
    this.owner = g(this.owner, Int32Array);
    this.edge = g(this.edge, Int32Array);
    this.dir = g(this.dir, Uint8Array);
    this.pos = g(this.pos, Float64Array);
    this.node = g(this.node, Int32Array);
    this.vPref = g(this.vPref, Float32Array);
    this.vCur = g(this.vCur, Float32Array);
    this.walked = g(this.walked, Float64Array);
    this.heading = g(this.heading, Float32Array);
    this.style = g(this.style, Uint8Array);
    this.state = g(this.state, Uint8Array);
    this.timer = g(this.timer, Int32Array);
    this.arriving = g(this.arriving, Uint8Array);
    this.doorOnArrive = g(this.doorOnArrive, Uint8Array);
    this.grant = g(this.grant, Int32Array);
    this.resBand = g(this.resBand, Int32Array);
    this.ri = g(this.ri, Int32Array);
    this.pending = g(this.pending, Uint8Array);
    this.goal = g(this.goal, Int32Array);
    this.goalX = g(this.goalX, Float64Array);
    this.goalZ = g(this.goalZ, Float64Array);
    this.moved = g(this.moved, Uint32Array);
    this.cap = cap;
  }
}

export interface PedWorld {
  pg: PedGraph;
  router: PedRouter;
  queue: { slot: number; gen: number; from: number; to: number }[];
  cache: Map<number, { path: Int32Array; length: number } | null>;
  /** Owned pedestrians that reached the end of their route / could not be routed this tick. */
  arrived: number[];
  failed: number[];
  moveStamp: number;
  nextWalker: number;
}

export function newPedWorld(pg: PedGraph): PedWorld {
  return { pg, router: new PedRouter(pg), queue: [], cache: new Map(), arrived: [], failed: [], moveStamp: 0, nextWalker: 0 };
}

const nodeOf = (pg: PedGraph, se: number, end: boolean): number => {
  const e = se >> 1;
  const fwd = (se & 1) === 0;
  return end === fwd ? pg.to[e]! : pg.from[e]!;
};

export function resetBands(w: World): void {
  const p = w.peds;
  p.bands = [];
  for (let i = 0; i < 2 * w.ped.pg.nEdges; i++) p.bands.push([]);
  p.bandRes = new Int32Array(2 * w.ped.pg.nEdges);
  for (let i = 0; i < p.hi; i++) p.resBand[i] = -1;
}

/** Pedestrians a band holds at the 0.7 m spacing (one more can always step on when it is compacted). */
const bandCapacity = (pg: PedGraph, se: number): number => Math.floor(pg.len[se >> 1]! / PED_SPACING) + 1;

/** Places left in a band after its pedestrians and reservations. */
const bandRoom = (w: World, se: number): number => bandCapacity(w.ped.pg, se) - w.peds.bands[se]!.length - w.peds.bandRes[se]!;

function releaseRes(w: World, i: number): void {
  const p = w.peds;
  if (p.resBand[i]! >= 0) {
    p.bandRes[p.resBand[i]!]!--;
    p.resBand[i] = -1;
  }
}

/** New pedestrian standing at `node` (door dwell first when `doorTicks` > 0). */
export function spawnPed(w: World, node: number, pid: number, owner: number, vPref: number, style: number, doorTicks: number): number {
  const p = w.peds;
  let i = p.free.pop();
  if (i === undefined) {
    if (p.hi >= p.cap) p.grow();
    i = p.hi++;
  }
  p.alive[i] = 1;
  p.gen[i]!++;
  p.pid[i] = pid;
  p.owner[i] = owner;
  p.edge[i] = -1;
  p.dir[i] = 0;
  p.pos[i] = 0;
  p.node[i] = node;
  p.vPref[i] = vPref;
  p.vCur[i] = 0;
  p.walked[i] = 0;
  p.heading[i] = 0;
  p.style[i] = style;
  p.state[i] = doorTicks > 0 ? PedState.door : PedState.waiting;
  p.timer[i] = doorTicks;
  p.arriving[i] = 0;
  p.doorOnArrive[i] = 1;
  p.grant[i] = -1;
  p.resBand[i] = -1;
  p.ri[i] = -1;
  p.pending[i] = 0;
  p.goal[i] = node;
  p.goalX[i] = w.ped.pg.x[node]!;
  p.goalZ[i] = w.ped.pg.z[node]!;
  p.route[i] = new Int32Array(0);
  p.count++;
  return i;
}

function leaveBand(w: World, i: number): void {
  const p = w.peds;
  const e = p.edge[i]!;
  if (e < 0) return;
  const list = p.bands[e * 2 + p.dir[i]!]!;
  const k = list.indexOf(i);
  if (k >= 0) list.splice(k, 1);
  p.edge[i] = -1;
}

/** Give the crossing zone back (and the far-side place if it was never used). */
function releaseGrant(w: World, i: number): void {
  const p = w.peds;
  if (p.grant[i]! >= 0) {
    w.zs.ped[p.grant[i]!]!--;
    p.grant[i] = -1;
  }
  releaseRes(w, i);
}

export function removePed(w: World, i: number): void {
  const p = w.peds;
  if (!p.alive[i]) return;
  leaveBand(w, i);
  releaseGrant(w, i);
  p.alive[i] = 0;
  p.gen[i]!++;
  p.count--;
  p.route[i] = new Int32Array(0);
  p.free.push(i);
}

/** Node where the pedestrian's next route leg starts. */
export const routeStart = (w: World, i: number): number => {
  const p = w.peds;
  return p.edge[i]! >= 0 ? nodeOf(w.ped.pg, p.edge[i]! * 2 + p.dir[i]!, true) : p.node[i]!;
};

/** Queue a route to `to`; the pedestrian keeps walking its current edge and waits at its end meanwhile. */
export function requestRoute(w: World, i: number, to: number): void {
  const p = w.peds;
  p.pending[i] = 1;
  p.goal[i] = to;
  p.goalX[i] = w.ped.pg.x[to]!;
  p.goalZ[i] = w.ped.pg.z[to]!;
  w.ped.queue.push({ slot: i, gen: p.gen[i]!, from: routeStart(w, i), to });
}

/** Replace the route (from the end of the current edge, or from the node the pedestrian stands at). */
export function setRoute(w: World, i: number, path: Int32Array): void {
  const p = w.peds;
  if (p.edge[i]! >= 0) {
    const r = new Int32Array(path.length + 1);
    r[0] = p.edge[i]! * 2 + p.dir[i]!;
    r.set(path, 1);
    p.route[i] = r;
    p.ri[i] = 0;
  } else {
    p.route[i] = path;
    p.ri[i] = -1;
  }
  p.pending[i] = 0;
  // A grant for a crossing that is no longer next (and not under foot) is given back; so is a far-side
  // place in a band the new route does not enter right after the crossing.
  const g = p.grant[i]!;
  if (g >= 0) {
    const cur = p.edge[i]!;
    const r = p.route[i]!;
    const nxt = r[p.ri[i]! + 1];
    const onIt = cur >= 0 && w.ped.pg.crossing[cur] === g;
    const nextIt = nxt !== undefined && w.ped.pg.crossing[nxt >> 1] === g;
    if (!onIt && !nextIt) releaseGrant(w, i);
    else if (p.resBand[i] !== (onIt ? nxt : r[p.ri[i]! + 2])) releaseRes(w, i);
    // Already on the crossing without a place beyond it (after a rebuild): take it back first, even
    // over capacity — nobody else may enter that band until this pedestrian has stepped off.
    if (onIt && p.resBand[i]! < 0 && nxt !== undefined) {
      p.resBand[i] = nxt;
      p.bandRes[nxt]!++;
    }
  }
}

function routeFailed(w: World, i: number): void {
  if (w.peds.owner[i]! >= 0) w.ped.failed.push(i);
  else removePed(w, i);
}

export function processPedQueue(w: World): void {
  const pw = w.ped;
  const p = w.peds;
  let budget = PED_ROUTE_BUDGET;
  let k = 0;
  const n = pw.pg.nNodes;
  while (k < pw.queue.length && budget > 0) {
    const q = pw.queue[k++]!;
    if (!p.alive[q.slot] || p.gen[q.slot] !== q.gen) continue;
    const key = q.from * n + q.to;
    let res = pw.cache.get(key);
    if (res === undefined) {
      budget--;
      res = pw.router.find(q.from, q.to);
      if (pw.cache.size >= CACHE_LIMIT) pw.cache.clear();
      pw.cache.set(key, res);
    }
    if (res) setRoute(w, q.slot, res.path);
    else routeFailed(w, q.slot);
  }
  pw.queue.splice(0, k);
}

/** Length of the cached or freshly searched route (for mode choice); null when unreachable. */
export function routeLength(w: World, from: number, to: number): { path: Int32Array; length: number } | null {
  const pw = w.ped;
  const key = from * pw.pg.nNodes + to;
  let res = pw.cache.get(key);
  if (res === undefined) {
    res = pw.router.find(from, to);
    pw.cache.set(key, res);
  }
  return res;
}

/**
 * Crossing requests, before vehicle grants (ADR 0008 §3). A band leader near the curb (or a pedestrian
 * standing at the node) whose next edge is a crossing is eligible on WALK (signalized) or while the
 * unsignalized gate is open; it gets the zone (and the far-side space) only when no vehicle holds it.
 */
export function pedRequests(w: World): void {
  const p = w.peds;
  const pg = w.ped.pg;
  const zs = w.zs;
  for (let i = 0; i < p.hi; i++) {
    if (!p.alive[i] || p.pending[i] || p.timer[i]! > 0) continue;
    const route = p.route[i]!;
    const ri = p.ri[i]!;
    const next = route[ri + 1];
    if (next === undefined) continue;
    const ne = next >> 1;
    if (pg.kind[ne] !== PedEdgeKind.crossing) continue;
    const z = pg.crossing[ne]!;
    if (p.grant[i] === z) continue;
    const e = p.edge[i]!;
    if (e >= 0) {
      if (p.pos[i]! < pg.len[e]! - REQUEST_DIST) continue;
      if (p.bands[e * 2 + p.dir[i]!]![0] !== i) continue;
    }
    const sig = zs.pedSig[z]!;
    const eligible = sig === PedSignal.none ? zs.gate[z] === 0 : sig === PedSignal.walk;
    if (!eligible) continue;
    if (w.noGrantTick === w.tick || zs.veh[z]! > 0) {
      zs.elig[z]!++;
      continue;
    }
    // The zone and a place in the band beyond it are taken together (never stuck on the carriageway).
    const after = route[ri + 2];
    if (after !== undefined && bandRoom(w, after) < 1) continue;
    releaseGrant(w, i);
    p.grant[i] = z;
    zs.ped[z]!++;
    if (after !== undefined) {
      p.resBand[i] = after;
      p.bandRes[after]!++;
    }
  }
}

/** Move onto the next route edge if allowed; `over` = distance already walked past the node. */
function enterNext(w: World, i: number, over: number): boolean {
  const p = w.peds;
  const pg = w.ped.pg;
  const next = p.route[i]![p.ri[i]! + 1]!;
  const ne = next >> 1;
  if (pg.kind[ne] === PedEdgeKind.crossing && p.grant[i] !== pg.crossing[ne]) return false;
  const tb = p.bands[next]!;
  if (tb.length && p.pos[tb[tb.length - 1]!]! < over + PED_SPACING) return false;
  // Places reserved by crossing pedestrians are not for anyone else.
  const reserved = p.resBand[i] === next;
  if (!reserved && bandRoom(w, next) < 1) return false;
  if (reserved) releaseRes(w, i);
  const cur = p.edge[i]!;
  if (cur >= 0) {
    p.bands[cur * 2 + p.dir[i]!]!.shift();
    // Leaving a crossing gives its zone back, unless the route turns around onto the same crossing.
    if (pg.kind[cur] === PedEdgeKind.crossing && ne !== cur) releaseGrant(w, i);
  }
  p.heading[i] = endHeading(pg, next ^ 1) + Math.PI;
  p.edge[i] = ne;
  p.dir[i] = next & 1;
  p.pos[i] = Math.min(over, pg.len[ne]!);
  p.ri[i]!++;
  tb.push(i);
  return true;
}

/** Travel heading at the end of a signed edge. */
function endHeading(pg: PedGraph, se: number): number {
  const e = se >> 1;
  const pts = pg.pts[e]!;
  const fwd = (se & 1) === 0;
  const a = fwd ? pts[pts.length - 2]! : pts[1]!;
  const b = fwd ? pts[pts.length - 1]! : pts[0]!;
  return Math.atan2(b.z - a.z, b.x - a.x);
}

/** Reached the last node of the route: door dwell (then arrival) or immediate arrival. */
function finishRoute(w: World, i: number): void {
  const p = w.peds;
  const e = p.edge[i]!;
  if (e >= 0) {
    p.heading[i] = endHeading(w.ped.pg, e * 2 + p.dir[i]!);
    p.node[i] = nodeOf(w.ped.pg, e * 2 + p.dir[i]!, true);
    p.bands[e * 2 + p.dir[i]!]!.shift();
    if (w.ped.pg.kind[e] === PedEdgeKind.crossing) releaseGrant(w, i);
    p.edge[i] = -1;
  }
  p.ri[i] = -1;
  p.route[i] = new Int32Array(0);
  p.vCur[i] = 0;
  if (p.doorOnArrive[i]) {
    p.state[i] = PedState.door;
    p.timer[i] = Math.max(1, Math.round(DOOR_SECONDS * w.tickRate));
    p.arriving[i] = 1;
  } else arrive(w, i);
}

/** Report the arrival; the owner decides what happens next (the pedestrian stays parked until then). */
function arrive(w: World, i: number): void {
  const p = w.peds;
  p.arriving[i] = 0;
  p.state[i] = PedState.waiting;
  p.pending[i] = 1;
  if (p.owner[i]! >= 0) w.ped.arrived.push(i);
  else removePed(w, i);
}

export function movePeds(w: World): void {
  const p = w.peds;
  const pg = w.ped.pg;
  const dt = w.dt;
  const stamp = ++w.ped.moveStamp;
  for (let b = 0; b < p.bands.length; b++) {
    const list = p.bands[b]!;
    if (list.length === 0) continue;
    const e = b >> 1;
    const L = pg.len[e]!;
    let k = 0;
    while (k < list.length) {
      const i = list[k]!;
      if (p.moved[i] === stamp) {
        k++;
        continue;
      }
      p.moved[i] = stamp;
      const old = p.pos[i]!;
      let target = old + p.vPref[i]! * dt;
      if (k > 0) target = Math.min(target, p.pos[list[k - 1]!]! - PED_SPACING);
      if (target >= L && k === 0 && !p.pending[i]) {
        const over = target - L;
        const done = p.route[i]![p.ri[i]! + 1] === undefined;
        if (done) {
          p.walked[i]! += L - old;
          finishRoute(w, i);
          continue;
        }
        if (enterNext(w, i, over)) {
          p.walked[i]! += L - old + over;
          p.vCur[i] = (L - old + over) / dt;
          p.state[i] = PedState.walking;
          continue;
        }
      }
      const np = Math.max(old, Math.min(target, L));
      p.pos[i] = np;
      p.vCur[i] = (np - old) / dt;
      p.walked[i]! += np - old;
      p.state[i] = np - old < 1e-6 && np >= L - 1e-6 ? PedState.waiting : PedState.walking;
      k++;
    }
  }
  // Pedestrians standing at a node: door dwell, then step onto the first edge when there is room.
  for (let i = 0; i < p.hi; i++) {
    if (!p.alive[i] || p.edge[i]! >= 0 || p.moved[i] === stamp) continue;
    p.vCur[i] = 0;
    if (p.timer[i]! > 0) {
      if (--p.timer[i]! === 0 && p.arriving[i]) arrive(w, i);
      continue;
    }
    if (p.arriving[i] || p.pending[i]) continue;
    const next = p.route[i]![p.ri[i]! + 1];
    if (next === undefined) finishRoute(w, i);
    else p.state[i] = enterNext(w, i, 0) ? PedState.walking : PedState.waiting;
  }
}

/** World position and heading (band offset applied). */
/** Height of the walking surface (m): raised sidewalk, road surface on crossings, ground on building access paths. */
export const SIDEWALK_Y = 0.2;
export const ROAD_Y = 0.06;

export function pedElevation(w: World, i: number): number {
  const e = w.peds.edge[i]!;
  if (e < 0) return SIDEWALK_Y;
  const k = w.ped.pg.kind[e];
  return k === PedEdgeKind.crossing ? ROAD_Y : k === PedEdgeKind.access ? 0 : SIDEWALK_Y;
}

export function pedPose(w: World, i: number): { x: number; z: number; heading: number } {
  const p = w.peds;
  const pg = w.ped.pg;
  const e = p.edge[i]!;
  if (e < 0) {
    const n = p.node[i]!;
    return { x: pg.x[n]!, z: pg.z[n]!, heading: p.heading[i]! };
  }
  const L = pg.len[e]!;
  const fwd = p.dir[i] === 0;
  const s = fwd ? p.pos[i]! : L - p.pos[i]!;
  const pt = pointAtLength(pg.pts[e]!, pg.cum[e]!, s);
  let t = tangentAtLength(pg.pts[e]!, pg.cum[e]!, Math.max(1e-6, Math.min(L, s)));
  if (!fwd) t = { x: -t.x, z: -t.z };
  const n = rightNormal(t);
  return { x: pt.x + n.x * BAND_OFFSET, z: pt.z + n.z * BAND_OFFSET, heading: Math.atan2(t.z, t.x) };
}

/** Snapshot pose (x, z, heading) into out[o..o+2] without allocating (same placement as pedPose). */
export function writePedPose(w: World, i: number, out: Float32Array, o: number): void {
  const p = w.peds;
  const pg = w.ped.pg;
  const e = p.edge[i]!;
  if (e < 0) {
    const n = p.node[i]!;
    out[o] = pg.x[n]!;
    out[o + 1] = pg.z[n]!;
    out[o + 2] = p.heading[i]!;
    return;
  }
  const fwd = p.dir[i] === 0;
  writePose(pg.pts[e]!, pg.cum[e]!, fwd ? p.pos[i]! : pg.len[e]! - p.pos[i]!, !fwd, BAND_OFFSET, out, o);
}

export const gaitPhase = (w: World, i: number): number => ((w.peds.walked[i]! / STRIDE_LENGTH) * 2 * Math.PI) % (2 * Math.PI);

/**
 * After a rebuild of the pedestrian graph (ADR 0008 §4): every pedestrian is placed within 20 m of where it
 * was, in the walkable component that contains its goal (`goalOf`, a node of the new graph, −1 = none).
 * Pedestrians on a crossing that still exists stay on it (or step to its curb if vehicles now hold the
 * zone); walking pedestrians go to the closest sidewalk/corner point (heading kept), standing ones to the
 * closest node; anyone that would land closer than the spacing to the pedestrian ahead goes to the band's
 * start node instead — again only within 20 m. Everyone else is returned as lost (the owner sends citizens
 * home, counted). Routes are dropped: placed pedestrians are left pending with `goal` set to the new node.
 */
export function reprojectPeds(w: World, oldPg: PedGraph, oldCrossingIds: string[], goalOf: (i: number) => number): number[] {
  const p = w.peds;
  const pg = w.ped.pg;
  const lost: number[] = [];
  const poses: { x: number; z: number; heading: number }[] = [];
  const oldEdge: number[] = [];
  const cur = w.ped.pg;
  w.ped.pg = oldPg;
  for (let i = 0; i < p.hi; i++) {
    poses.push(p.alive[i] ? pedPose(w, i) : { x: 0, z: 0, heading: 0 });
    oldEdge.push(p.alive[i] ? p.edge[i]! : -1);
  }
  w.ped.pg = cur;
  // Goals first (owners resolve them on the new graph).
  const goals: number[] = [];
  for (let i = 0; i < p.hi; i++) goals.push(p.alive[i] ? goalOf(i) : -1);
  resetBands(w);
  w.zs.ped.fill(0);
  for (let i = 0; i < p.hi; i++) p.resBand[i] = -1;
  const crossingByOldId = new Map(w.graph.crossings.map((c) => [c.id, c.index]));
  const within = (n: number, pose: { x: number; z: number }): boolean => Math.hypot(pg.x[n]! - pose.x, pg.z[n]! - pose.z) <= REPROJECT_RADIUS;
  // Insert in slot order; bands are re-sorted afterwards.
  for (let i = 0; i < p.hi; i++) {
    if (!p.alive[i]) continue;
    p.grant[i] = -1;
    p.pending[i] = 1;
    p.ri[i] = -1;
    p.route[i] = new Int32Array(0);
    p.edge[i] = -1;
    const pose = poses[i]!;
    const oe = oldEdge[i]!;
    const goal = goals[i]!;
    if (goal < 0) {
      lost.push(i);
      continue;
    }
    p.goal[i] = goal;
    p.goalX[i] = pg.x[goal]!;
    p.goalZ[i] = pg.z[goal]!;
    const comp = pg.comp[goal]!;
    let placed = false;
    if (oe >= 0 && oldPg.crossing[oe]! >= 0) {
      const z = crossingByOldId.get(oldCrossingIds[oldPg.crossing[oe]!]!);
      const ne = z === undefined ? -1 : pg.crossingEdge[z]!;
      if (ne >= 0 && pg.comp[pg.from[ne]!] === comp) {
        if (w.zs.veh[z!]! === 0) {
          // Same crossing id, but it may have moved: stay on it only within 20 m of where we were.
          p.edge[i] = ne;
          p.pos[i] = Math.min(p.pos[i]!, pg.len[ne]!);
          const np = pedPose(w, i);
          if (Math.hypot(np.x - pose.x, np.z - pose.z) <= REPROJECT_RADIUS) {
            p.grant[i] = z!;
            w.zs.ped[z!]!++;
            p.bands[ne * 2 + p.dir[i]!]!.push(i);
            placed = true;
          } else p.edge[i] = -1;
        } else {
          const curb = p.dir[i] === 0 ? pg.from[ne]! : pg.to[ne]!;
          if (within(curb, pose)) {
            p.node[i] = curb;
            placed = true;
          }
        }
      }
    }
    if (!placed && oe >= 0) {
      const near = nearestEdge(pg, pose, REPROJECT_RADIUS, comp);
      if (near) {
        const e = near.edge;
        const t = tangentAtLength(pg.pts[e]!, pg.cum[e]!, Math.max(1e-6, near.s));
        const fwd = t.x * Math.cos(pose.heading) + t.z * Math.sin(pose.heading) >= 0;
        p.edge[i] = e;
        p.dir[i] = fwd ? 0 : 1;
        p.pos[i] = fwd ? near.s : pg.len[e]! - near.s;
        p.bands[e * 2 + p.dir[i]!]!.push(i);
        placed = true;
      }
    }
    if (!placed) {
      const n = nearestNode(pg, pose, REPROJECT_RADIUS, comp);
      if (n >= 0) {
        p.node[i] = n;
        placed = true;
      }
    }
    if (!placed) lost.push(i);
  }
  // Order bands by position; anyone closer than the spacing to the one ahead steps off to the start node.
  for (let b = 0; b < p.bands.length; b++) {
    const list = p.bands[b]!;
    if (list.length < 2) continue;
    list.sort((x, y) => p.pos[y]! - p.pos[x]! || x - y);
    for (let k = 1; k < list.length; k++) {
      const i = list[k]!;
      if (p.pos[list[k - 1]!]! - p.pos[i]! >= PED_SPACING - 1e-9) continue;
      list.splice(k--, 1);
      if (p.grant[i]! >= 0) releaseGrant(w, i);
      const e = b >> 1;
      const start = (b & 1) === 0 ? pg.from[e]! : pg.to[e]!;
      p.edge[i] = -1;
      if (within(start, poses[i]!)) p.node[i] = start;
      else lost.push(i);
    }
  }
  return lost;
}

/**
 * After a rebuild, pedestrians standing on a crossing get their route (and with it the place beyond the
 * crossing) right away, before anyone else moves; their queued request is invalidated.
 */
export function routeCrossers(w: World): void {
  const p = w.peds;
  const pg = w.ped.pg;
  for (let i = 0; i < p.hi; i++) {
    const e = p.edge[i]!;
    if (!p.alive[i] || !p.pending[i] || e < 0 || pg.kind[e] !== PedEdgeKind.crossing) continue;
    const res = routeLength(w, routeStart(w, i), p.goal[i]!);
    if (!res) continue;
    p.gen[i]!++;
    setRoute(w, i, res.path);
  }
}

/** Goal of a walker (no citizen) on a rebuilt graph: the node nearest its old goal, −1 = none within 20 m. */
export function walkerGoal(w: World, i: number): number {
  return nearestNode(w.ped.pg, { x: w.peds.goalX[i]!, z: w.peds.goalZ[i]! }, REPROJECT_RADIUS);
}

/** Test/bench helper: a walker without a citizen from node to node (routed immediately). */
export function spawnWalker(w: World, from: number, to: number, vPref = 1.3): number {
  const res = routeLength(w, from, to);
  if (!res || res.path.length === 0) return -1;
  const i = spawnPed(w, from, WALKER_ID_BASE + w.ped.nextWalker++, -1, vPref, w.ped.nextWalker % 16, 0);
  const p = w.peds;
  p.goal[i] = to;
  p.goalX[i] = w.ped.pg.x[to]!;
  p.goalZ[i] = w.ped.pg.z[to]!;
  setRoute(w, i, res.path);
  return i;
}

/** After a rebuild: re-placed walkers head for their (re-resolved) goal node. */
export function retargetWalkers(w: World, slots: Iterable<number>): void {
  for (const i of slots) requestRoute(w, i, w.peds.goal[i]!);
}
