// Scenario KPIs (ADR 0010 §5), all in sim ticks. Compare ON/OFF runs at the same tick.

import { CLOCK_SCALE } from '../types.js';
import type { World } from '../traffic/world.js';
import { NO_ROUTE } from './reroute.js';
import { activeEvents } from './state.js';
import { surgeWaiting } from './surge.js';
import type { ScenarioKpi } from './types.js';

/** A lane is congested while a vehicle on it drives below this share of the lane's speed limit. */
export const CONGESTION_SPEED_SHARE = 0.3;
/** Default KPI series period: 30 game seconds. */
export const KPI_GAME_SECONDS = 30;

/** Sum of the lengths of lanes holding at least one vehicle below 0.3 × speed limit (dwelling buses excluded). */
export function congestionLength(w: World): number {
  const net = w.net;
  const nLanes = net.nLanes;
  const hit = new Uint8Array(nLanes);
  let total = 0;
  for (const v of w.vehicles) {
    if (!v.alive || v.edge >= nLanes || hit[v.edge] || (v.bus && v.bus.dwell > 0)) continue;
    if (v.v < CONGESTION_SPEED_SHARE * net.speed[v.edge]!) {
      hit[v.edge] = 1;
      total += net.len[v.edge]!;
    }
  }
  return total;
}

export function scenarioKpi(w: World): ScenarioKpi {
  const sc = w.sc!;
  let inProgress = 0;
  let noRoute = 0;
  for (const v of w.vehicles) {
    if (!v.alive || v.bus) continue;
    inProgress++;
    if (v.scWait === NO_ROUTE) {
      const nxt = v.route[v.ri + 1];
      if (sc.ban && nxt !== undefined && sc.ban[nxt]) noRoute++;
    }
  }
  let queued = 0;
  for (const item of w.queue) if ('trip' in item) queued++;
  return {
    tick: w.tick,
    since: sc.since,
    completed: sc.completed,
    avgTravelTime: sc.completed > 0 ? sc.ttTicks / sc.completed / w.tickRate : 0,
    inProgress,
    noRoute,
    droppedTrips: sc.dropped,
    waitingToDepart: queued + surgeWaiting(w),
    removed: w.removed - sc.removedBase,
    congestionLength: congestionLength(w),
    rerouted: sc.rerouted,
    detoured: sc.detoured,
    recovered: sc.recovered,
    activeEvents: activeEvents(sc),
  };
}

/** KPI of a simulation whose scenario state is not active (nothing is created): counters 0, `since` −1. */
export function inactiveKpi(w: World): ScenarioKpi {
  let inProgress = 0;
  for (const v of w.vehicles) if (v.alive && !v.bus) inProgress++;
  let queued = 0;
  for (const item of w.queue) if ('trip' in item) queued++;
  return {
    tick: w.tick,
    since: -1,
    completed: 0,
    avgTravelTime: 0,
    inProgress,
    noRoute: 0,
    droppedTrips: 0,
    waitingToDepart: queued,
    removed: 0,
    congestionLength: congestionLength(w),
    rerouted: 0,
    detoured: 0,
    recovered: 0,
    activeEvents: 0,
  };
}

/** Ticks per KPI point for a period in game seconds (1 sim second = CLOCK_SCALE game seconds). */
export const kpiEveryTicks = (tickRate: number, gameSeconds = KPI_GAME_SECONDS): number => Math.max(1, Math.round((gameSeconds / CLOCK_SCALE) * tickRate));

/** Accumulates a KPI point whenever the sim tick is a multiple of `every`. Call after each step with the current tick. */
export class KpiSeries {
  readonly points: ScenarioKpi[] = [];
  constructor(readonly every: number) {}

  record(tick: number, sim: { kpi(): ScenarioKpi }): boolean {
    if (tick % this.every !== 0) return false;
    const last = this.points[this.points.length - 1];
    if (last && last.tick === tick) return false;
    this.points.push(sim.kpi());
    return true;
  }
}
