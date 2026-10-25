// Re-routing (ADR 0010 §6). When an event starts or ends, informed vehicles (policy ON) whose remaining
// route uses an affected lane join a queue in (enqueue tick, vehicle id) order; a fixed number is processed per tick (next
// to the regular `routeBudget` queue; no wall clock). Re-routes keep the current lane (and a granted
// connector) and replace the route from the next decision point, with free-flow costs.
// Invalid routes (policy independent): a lead vehicle whose next connector is closed asks for a recovery
// search at once (no cooldown); with no route it waits as "no route" until an event ends.

import { routeVehicle } from '../traffic/ops.js';
import type { Vehicle, World } from '../traffic/world.js';
import { isInformed } from './state.js';

/**
 * Scenario route searches per tick (re-routes + recoveries), on top of the regular `routeBudget`. On the
 * 15×15 bench grid with 3000 vehicles one search costs roughly 0.3–0.9 ms (it dominates an event start), so 5
 * keeps an event start within the 8 ms tick budget; ~100 affected vehicles are served within one simulated second.
 */
export const REROUTE_BUDGET = 5;

/** scWait: 0 = none, 1 = recovery search queued, 2 = waiting with no route. */
export const NO_ROUTE = 2;

/**
 * Add vehicles (sorted by id) to the queue, ordered by (enqueue tick, vehicle id): requests of the current
 * tick — several events, recoveries between them — are merged in id order after every older batch, so an
 * older request is never overtaken (no starvation). No duplicates (`scQueued`).
 */
function enqueue(w: World, sorted: readonly Vehicle[]): void {
  const add: Vehicle[] = [];
  for (const v of sorted) {
    if (v.scQueued) continue;
    v.scQueued = true;
    add.push(v);
  }
  if (add.length === 0) return;
  const sc = w.sc!;
  if (sc.rqTick !== w.tick) {
    sc.rqTick = w.tick;
    sc.rqTickStart = sc.rq.length;
  }
  const rq = sc.rq;
  const start = sc.rqTickStart;
  if (rq.length === start || rq[rq.length - 1]!.id < add[0]!.id) {
    for (const v of add) rq.push(v);
    return;
  }
  const out = rq.slice(0, start);
  let i = start;
  let j = 0;
  while (i < rq.length || j < add.length) {
    if (j >= add.length || (i < rq.length && rq[i]!.id < add[j]!.id)) out.push(rq[i++]!);
    else out.push(add[j++]!);
  }
  sc.rq = out;
}

/** Queue the vehicles an event start/end concerns. `ended`: also retry every vehicle waiting with no route. */
export function enqueueAffected(w: World, lanes: readonly number[], ended: boolean): void {
  const sc = w.sc!;
  const nLanes = w.net.nLanes;
  const batch: Vehicle[] = [];
  if (sc.policy.reroute && lanes.length > 0) {
    const mark = new Uint8Array(nLanes);
    for (const l of lanes) mark[l] = 1;
    for (const v of w.vehicles) {
      if (!v.alive || v.scQueued || !isInformed(w, v, sc.policy.informedShare)) continue;
      for (let j = v.ri + 1; j < v.route.length; j++) {
        const e = v.route[j]!;
        if (e < nLanes && mark[e]) {
          batch.push(v);
          break;
        }
      }
    }
  }
  if (ended) {
    for (const v of w.vehicles) {
      if (!v.alive || v.scWait !== NO_ROUTE) continue;
      v.scWait = 1;
      if (!v.scQueued) batch.push(v);
    }
  }
  batch.sort((a, b) => a.id - b.id);
  enqueue(w, batch);
}

/** Grant path: the lead vehicle's next connector is closed. */
export function bannedRequest(w: World, v: Vehicle): void {
  if (v.scWait !== 0) return;
  v.scWait = 1;
  enqueue(w, [v]);
}

const sameTail = (a: readonly number[], b: readonly number[], from: number): boolean => {
  if (a.length - from !== b.length) return false;
  for (let k = 0; k < b.length; k++) if (a[from + k] !== b[k]) return false;
  return true;
};

export function processReroutes(w: World): void {
  const sc = w.sc!;
  const rq = sc.rq;
  let budget = REROUTE_BUDGET;
  let i = 0;
  while (i < rq.length && budget > 0) {
    const v = rq[i++]!;
    v.scQueued = false;
    if (!v.alive) continue;
    if (v.scWait === 1) {
      budget--;
      if (routeVehicle(w, v, sc.zero)) {
        v.scWait = 0;
        sc.recovered++;
      } else v.scWait = NO_ROUTE;
      continue;
    }
    if (!sc.policy.reroute) continue;
    budget--;
    const before = v.route.slice(v.ri + 1);
    if (!routeVehicle(w, v, sc.zero)) continue;
    if (!v.scRerouted) {
      v.scRerouted = true;
      sc.rerouted++;
    }
    if (!sameTail(v.route, before, v.ri + 1)) sc.detoured++;
  }
  rq.splice(0, i);
  sc.rqTickStart = Math.max(0, sc.rqTickStart - i);
}
