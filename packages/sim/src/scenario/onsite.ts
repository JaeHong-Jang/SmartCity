// On-site recovery (ADR 0013 §2): a vehicle that sees an accident obstacle with its own eyes may get around it
// without the city knowing — like `bannedRequest` for closures, but local to that vehicle. Applies to accidents
// started under reports / sensors (`AccidentEffect.onSite`), before and after they are known; legacy accidents
// keep the old behaviour (nothing here runs).
// - On the blocked lane, stopped behind the obstacle within OBSERVE_DIST: step sideways onto a neighbour lane of
//   the same road and direction (right first) when the lane is clear at that spot and past the obstacle and a
//   route from there exists; otherwise wait and try again next tick (a route that failed is not retried).
// - About to enter the blocked lane (next connector, obstacle within OBSERVE_DIST along the route): one re-route
//   with the accident penalty on that lane for this search only. The shared router (`Router.obsRear`) never
//   gets the observation, so no other vehicle or search learns of the accident.
// Order: accidents by eventId, vehicles leader first (blocked lane) then connector / lane order; at most
// ONSITE_BUDGET route searches per tick.

import { groupKey } from '../network/net.js';
import { routeVehicle } from '../traffic/ops.js';
import { canPlace, insertOnEdge, removeFromEdge, STOP_SPEED, type Vehicle, type World } from '../traffic/world.js';
import { obstacleAhead, type AccidentEffect, type Obstacle } from './state.js';

/** How far ahead a driver sees an obstacle, m (along its own route). */
export const OBSERVE_DIST = 40;
/** On-site route searches per tick, on top of the scenario re-route budget. */
export const ONSITE_BUDGET = 5;
/** Clearance kept to vehicles on the neighbour lane when stepping across, m. */
const MOVE_MARGIN = 1;
/** The neighbour lane must be free of obstacles up to this far past the blocked stretch, m. */
const PAST_OBSTACLE = 5;

export const hasOnSite = (w: World): boolean => w.sc!.effects.some((e) => e.kind === 'accident' && e.onSite);

function intoLane(w: World, lane: number): number[] {
  const det = w.sc!.det;
  if (det.into === null || det.into.graph !== w.graph) {
    const list: number[][] = w.graph.lanes.map(() => []);
    for (const c of w.graph.connectors) list[c.toLane]!.push(c.index);
    det.into = { graph: w.graph, list };
  }
  return det.into.list[lane]!;
}

/** Route search with the accident penalty on `lane` for this one search (vehicle-local knowledge). */
function localRoute(w: World, v: Vehicle, lane: number, rear: number): boolean {
  const router = w.router;
  const shared = router.obsRear;
  const local = shared !== null ? Float64Array.from(shared) : new Float64Array(w.net.nLanes).fill(Infinity);
  local[lane] = Math.min(local[lane]!, rear);
  router.obsRear = local;
  try {
    return routeVehicle(w, v, w.sc!.zero);
  } finally {
    router.obsRear = shared;
  }
}

/** Step `v` from blocked lane `l` onto a neighbour lane past obstacle `o`. Null = no try (no room or no lane); else whether it moved. */
function sideStep(w: World, v: Vehicle, l: number, o: Obstacle): boolean | null {
  const sc = w.sc!;
  const net = w.net;
  const lane = w.graph.lanes[l]!;
  const group = net.groups.get(groupKey(lane.segmentId, lane.dir)) ?? [];
  for (const idx of [lane.laneIndex + 1, lane.laneIndex - 1]) {
    const t = group.find((x) => w.graph.lanes[x]!.laneIndex === idx);
    if (t === undefined || net.closed[t] || (net.busOnly[t] && v.kind !== 'bus') || (sc.ban !== null && sc.ban[t])) continue;
    const scale = net.len[t]! / net.len[l]!;
    const s2 = v.s * scale;
    if (s2 < v.len) continue;
    if (sc.obs !== null && obstacleAhead(sc.obs, t, s2 - v.len) <= (o.rear + o.len) * scale + PAST_OBSTACLE) continue;
    if (!canPlace(w, t, s2, v.len, MOVE_MARGIN)) continue;
    const back = { s: v.s, route: v.route, ri: v.ri, destS: v.destS };
    removeFromEdge(w.onEdge[l]!, v);
    v.edge = t;
    v.s = s2;
    insertOnEdge(w.onEdge[t]!, v);
    if (routeVehicle(w, v, sc.zero)) return true;
    removeFromEdge(w.onEdge[t]!, v);
    v.edge = l;
    v.s = back.s;
    v.route = back.route;
    v.ri = back.ri;
    v.destS = back.destS;
    insertOnEdge(w.onEdge[l]!, v);
    return false;
  }
  return null;
}

/** Per tick (route-search phase, before the scenario re-route queue), while an on-site accident is active. */
export function processOnSite(w: World): void {
  const sc = w.sc!;
  const det = sc.det;
  const nLanes = w.net.nLanes;
  let budget = ONSITE_BUDGET;
  const list = sc.effects.filter((e): e is AccidentEffect => e.kind === 'accident' && e.onSite).sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  for (const e of list) {
    const l = w.graph.laneById.get(e.laneId);
    const o = l === undefined || sc.obs === null ? undefined : sc.obs[l]!.find((x) => x.eventId === e.eventId);
    if (l === undefined || o === undefined) continue;
    // On the blocked lane, stopped behind this obstacle (not behind a nearer one).
    for (const v of w.onEdge[l]!.slice()) {
      if (budget <= 0) return;
      if (v.s > o.rear + 1e-6 || o.rear - v.s > OBSERVE_DIST || v.v >= STOP_SPEED || e.stuck.has(v.id)) continue;
      if (v.bus !== null || v.grant >= 0 || v.resLane >= 0 || v.zones.length > 0) continue;
      if (obstacleAhead(sc.obs!, l, v.s) !== o.rear) continue;
      const r = sideStep(w, v, l, o);
      if (r === null) continue;
      budget--;
      if (r) det.onSiteMoves++;
      else e.stuck.add(v.id);
    }
    // About to enter it: the lane before, with the next connector into the blocked lane.
    for (const c of intoLane(w, l)) {
      const conn = w.graph.connectors[c]!;
      const ahead = w.net.len[nLanes + c]! + o.rear;
      for (const v of w.onEdge[conn.fromLane]!) {
        if (budget <= 0) return;
        if (v.route[v.ri + 1] !== nLanes + c || v.grant === c || e.seen.has(v.id)) continue;
        if (w.net.len[conn.fromLane]! - v.s + ahead > OBSERVE_DIST) continue;
        e.seen.add(v.id);
        budget--;
        if (localRoute(w, v, l, o.rear) && !v.route.slice(v.ri + 1).includes(l)) det.onSiteReroutes++;
      }
    }
  }
}
