// Vehicle creation and (re)routing against the current network.

import { idmParams, insertOnEdge, type BusInfo, type Goal, type Vehicle, type World } from './world.js';
import { groupKey } from '../network/net.js';
import type { RouteGoal } from '../network/route.js';
import { laneSAtT } from './demand.js';

const HISTORY = 4;

export function resolveGoal(w: World, goal: Goal, bus: boolean): RouteGoal[] {
  const out: RouteGoal[] = [];
  const dirs = goal.anyDir ? [goal.dir, goal.dir === 'forward' ? 'backward' : 'forward'] as const : [goal.dir];
  for (const dir of dirs) {
    for (const l of w.net.groups.get(groupKey(goal.segId, dir)) ?? []) {
      if (goal.laneIndex >= 0 && w.graph.lanes[l]!.laneIndex !== goal.laneIndex) continue;
      if (!bus && w.net.busOnly[l]) continue;
      out.push({ lane: l, destS: goal.mode === 'end' ? w.net.len[l]! : laneSAtT(w.net, l, goal.t) });
    }
  }
  return out;
}

/**
 * Replace the route from the current position (or from the granted connector). Keeps a little history.
 * `stopped` = queue costs (default: the ones observed now; scenario re-routes pass zeros = free flow).
 */
export function routeVehicle(w: World, v: Vehicle, stopped: Int32Array = w.stopped): boolean {
  const nLanes = w.net.nLanes;
  const prefix = v.route.slice(Math.max(0, v.ri - HISTORY), v.ri);
  let start = v.edge;
  let s = v.s;
  const granted = v.edge < nLanes && v.grant >= 0;
  if (granted) {
    prefix.push(v.edge);
    start = nLanes + v.grant;
    s = 0;
  }
  const res = w.router.find(start, s, resolveGoal(w, v.goal, v.kind === 'bus'), v.kind === 'bus', stopped);
  if (!res) return false;
  v.ri = granted ? prefix.length - 1 : prefix.length;
  v.route = prefix.concat(res.path);
  v.destS = res.destS;
  return true;
}

/** Route first, then place. Returns null when no route exists. The caller checks free space. */
export function createVehicle(w: World, typeId: string, lane: number, s: number, goal: Goal, bus: BusInfo | null): Vehicle | null {
  const type = w.types.get(typeId);
  if (!type) return null;
  const isBus = type.kind === 'bus';
  // A lane closed by a scenario event takes no new vehicles (ADR 0010 §3).
  if (w.sc !== null && w.sc.ban !== null && w.sc.ban[lane]) return null;
  const res = w.router.find(lane, s, resolveGoal(w, goal, isBus), isBus, w.stopped);
  if (!res) return null;
  const p = idmParams(type.kind);
  const v: Vehicle = {
    id: w.nextId++,
    typeId,
    typeIdx: w.typeIds.indexOf(typeId),
    kind: type.kind,
    len: type.length,
    a: type.maxAccel,
    b: type.comfortDecel,
    s0: p.s0,
    T: p.T,
    maxSpeed: type.maxSpeed,
    edge: lane,
    s,
    v: 0,
    acc: 0,
    gapHard: 0,
    route: res.path,
    ri: 0,
    destS: res.destS,
    goal,
    grant: -1,
    reqTick: -1,
    held: [],
    zones: [],
    stopCnt: 0,
    stopTick: -1,
    person: -1,
    resLane: -1,
    resNeed: 0,
    odo: 0,
    stopTime: 0,
    rerouted: false,
    queued: false,
    alive: true,
    bus,
    t0: w.tick,
    scWait: 0,
    scQueued: false,
    scRerouted: false,
  };
  w.vehicles.push(v);
  insertOnEdge(w.onEdge[lane]!, v);
  w.spawned++;
  return v;
}
