// Scenario runtime state (ADR 0010 §2, §3): per-event effect records and the per-edge overrides composed
// from them. Composition: entry ban = OR over closures; obstacles are a separate per-lane list. Ending one
// event recomposes from the remaining records, so it never clears another event's effect. The overrides are
// arrays over the current network (no recompile); `w.sc` is null until the first scenario call, so a
// simulation without scenarios runs exactly the pre-scenario code paths.

import { hash01 } from '../citizens/schedule.js';
import type { Access } from '../traffic/demand.js';
import type { Goal, Vehicle, World } from '../traffic/world.js';
import type { SignalClearing, SignalCtl } from './preempt.js';
import { DEFAULT_POLICY, type ResponsePolicy, type ScenarioInput } from './types.js';

/** Obstacle on a lane, lane coordinates: occupies [rear, rear + len]. */
export interface Obstacle {
  eventId: string;
  rear: number;
  len: number;
}

export interface ClosureEffect {
  kind: 'closure';
  eventId: string;
  segmentId: string;
  /** Segment lane position (forward first); −1 = all lanes. */
  lane: number;
  startTick: number;
  endTick: number;
}

export interface AccidentEffect {
  kind: 'accident';
  eventId: string;
  segmentId: string;
  lane: number;
  /** Stable lane id the obstacle sits on (survives recompiles while the lane exists). */
  laneId: string;
  rear: number;
  len: number;
  startTick: number;
  endTick: number;
}

export type Effect = ClosureEffect | AccidentEffect;

export interface SurgeTrip {
  eventId: string;
  i: number;
  /** 0 = inflow (to the building), 1 = outflow (back to the origin). */
  dir: 0 | 1;
  depart: number;
  typeId: string;
  from: Access;
  to: Access;
  /** Tick it was placed, −1 while pending; vehicle id once placed. */
  spawnTick: number;
  vehicleId: number;
  dropped: boolean;
}

/** A fire or medical call (ADR 0010 §3), from its start input until it is over. */
export interface Incident {
  kind: 'fire' | 'medical';
  eventId: string;
  buildingId: string;
  startTick: number;
  /** Fire: ticks from 0 to 100 %. Medical: unused (0). */
  burnTicks: number;
  /** Fire: suppression ticks once a fire truck is there. Medical: treatment ticks once an ambulance is there. */
  workTicks: number;
  state: 'burning' | 'suppressing' | 'waiting' | 'treating' | 'transport';
  /** Tick the suppression / treatment ends, −1 before it started. */
  workEnd: number;
  mission: Mission | null;
  /**
   * No vehicle on the way (dispatch failed, or the vehicle was lost before arriving): the next dispatch
   * attempt is at this tick (−1 = a mission is out). `failed` = a `dispatch.failed` was logged and counted.
   */
  retryAt: number;
  failed: boolean;
}

/** One emergency vehicle's trip chain: facility → scene → work → back (fire) or to the hospital (medical). */
export interface Mission {
  incident: Incident;
  /**
   * Dispatching facility (building id): where a fire truck returns and an ambulance takes the patient.
   * Replaced by the closest remaining facility of the same service if an edit removes it.
   */
  facilityId: string;
  /** The incident building's access point at dispatch (the vehicle leaves the scene from here). */
  scene: Access;
  typeId: string;
  stage: 'enroute' | 'working' | 'transport' | 'returning';
  /** On the network; null while waiting for room (`spawn`) or parked at the scene. */
  v: Vehicle | null;
  /** Waiting to enter the network at this access point, towards `goal` (retried every tick). */
  spawn: { from: Access; goal: Goal } | null;
}

export interface ScenarioLogEntry {
  eventId: string;
  tick: number;
  kind: string;
  applied: boolean;
  note?: string;
}

export interface ScenarioState {
  policy: ResponsePolicy;
  /** Accepted inputs not applied yet, sorted by (tick, order, eventId) before each use. */
  pending: ScenarioInput[];
  pendingSorted: boolean;
  /** Every accepted input in acceptance order (for the ScenarioRecord), `policy.set` included. */
  accepted: ScenarioInput[];
  /** `policy.set` inputs recorded so far (unique ids and same-tick order). */
  policyInputs: number;
  seen: Set<string>;
  log: ScenarioLogEntry[];
  /** Log entries since the last `drainScenarioOutcomes()` (lossless outcome stream for the UI). */
  outcomes: ScenarioLogEntry[];
  /** Active effects in application order. */
  effects: Effect[];
  /** Every surge trip, in generation order (kept for inspection), and the not-yet-placed ones sorted by depart. */
  surgeTrips: SurgeTrip[];
  surgeQueue: SurgeTrip[];
  /** Per surge event: the tick it applied and the departure tick of its last trip. */
  surges: Map<string, { startTick: number; endTick: number }>;
  /** Fires and medical calls not over yet (application order), and the emergency missions out (creation order). */
  incidents: Incident[];
  missions: Mission[];
  /** Buildings a fire reached 100 % on, ascending id. */
  damaged: string[];
  /**
   * Signal controllers driving a junction now and edit-time clearances (by node id, never both for one
   * node), and plan offsets re-phased by a hand-back (kept while the plan's identity key is unchanged).
   */
  ctl: Map<string, SignalCtl>;
  clearing: Map<string, SignalClearing>;
  offsets: Map<string, { key: string; offset: number }>;
  // ----- composed over the current network -----
  /** Per edge: new entry forbidden (closed lanes and every connector into them). Null = no closure. */
  ban: Uint8Array | null;
  /** Per lane: obstacles sorted by rear. Null = no obstacle. */
  obs: Obstacle[][] | null;
  /** Per lane: rear of the first obstacle (Infinity when none), for the router penalty. */
  obsRear: Float64Array | null;
  closedLanes: number[];
  /** Zero queue costs: scenario re-routes use free-flow costs only (ADR 0010 §6). */
  zero: Int32Array;
  // ----- re-route queue (stable order, fixed budget per tick) -----
  /** Ordered by (enqueue tick, vehicle id): each tick's batch is merged in id order after the older ones. */
  rq: Vehicle[];
  /** Tick of the newest batch in `rq`, and the index where that batch starts. */
  rqTick: number;
  rqTickStart: number;
  // ----- KPI accumulators -----
  since: number;
  removedBase: number;
  completed: number;
  ttTicks: number;
  dropped: number;
  rerouted: number;
  detoured: number;
  recovered: number;
  responses: number;
  responseTicks: number;
  maxResponseTicks: number;
  extinguished: number;
  medicalCompleted: number;
  dispatchFailed: number;
}

export function newScenarioState(w: World): ScenarioState {
  return {
    policy: { ...DEFAULT_POLICY },
    pending: [],
    pendingSorted: true,
    accepted: [],
    policyInputs: 0,
    seen: new Set(),
    log: [],
    outcomes: [],
    effects: [],
    surgeTrips: [],
    surgeQueue: [],
    surges: new Map(),
    incidents: [],
    missions: [],
    damaged: [],
    ctl: new Map(),
    clearing: new Map(),
    offsets: new Map(),
    ban: null,
    obs: null,
    obsRear: null,
    closedLanes: [],
    zero: new Int32Array(w.net.nLanes),
    rq: [],
    rqTick: -1,
    rqTickStart: 0,
    since: w.tick,
    removedBase: w.removed,
    completed: 0,
    ttTicks: 0,
    dropped: 0,
    rerouted: 0,
    detoured: 0,
    recovered: 0,
    responses: 0,
    responseTicks: 0,
    maxResponseTicks: 0,
    extinguished: 0,
    medicalCompleted: 0,
    dispatchFailed: 0,
  };
}

/** Every apply-time outcome goes to the full log and to the drainable outcome stream. */
export function logOutcome(sc: ScenarioState, e: ScenarioLogEntry): void {
  sc.log.push(e);
  sc.outcomes.push(e);
}

const INFORMED_SALT = 0x1f0d;

/** Informed vehicle: a fixed hash of (vehicle id, seed), independent of every RNG stream. */
export const isInformed = (w: World, v: Vehicle, share: number): boolean => hash01(v.id, w.doc.meta.seed, INFORMED_SALT) < share;

/** Lanes (RoadGraph indexes) of a closure on the current graph. */
export function closureLanes(w: World, e: ClosureEffect): number[] {
  const seg = w.graph.segments.get(e.segmentId);
  if (!seg) return [];
  if (e.lane < 0) return seg.lanes;
  const l = seg.lanes[e.lane];
  return l === undefined ? [] : [l];
}

/** Rebuild the per-edge overrides from the effect records (event start/end, recompile). */
export function compose(w: World): void {
  const sc = w.sc!;
  const net = w.net;
  const nLanes = net.nLanes;
  if (sc.zero.length !== nLanes) sc.zero = new Int32Array(nLanes);
  let ban: Uint8Array | null = null;
  let obs: Obstacle[][] | null = null;
  for (const e of sc.effects) {
    if (e.kind === 'closure') {
      for (const l of closureLanes(w, e)) {
        ban ??= new Uint8Array(net.nEdges);
        ban[l] = 1;
      }
      continue;
    }
    const l = w.graph.laneById.get(e.laneId);
    if (l === undefined) continue;
    if (!obs) {
      obs = [];
      for (let k = 0; k < nLanes; k++) obs.push([]);
    }
    const L = net.len[l]!;
    const len = Math.min(e.len, L);
    obs[l]!.push({ eventId: e.eventId, rear: Math.max(0, Math.min(e.rear, L - len)), len });
  }
  const closed: number[] = [];
  if (ban) {
    for (const c of w.graph.connectors) if (ban[c.toLane]) ban[nLanes + c.index] = 1;
    for (let l = 0; l < nLanes; l++) if (ban[l]) closed.push(l);
  }
  let rear: Float64Array | null = null;
  if (obs) {
    rear = new Float64Array(nLanes).fill(Infinity);
    for (let l = 0; l < nLanes; l++) {
      const list = obs[l]!;
      if (list.length === 0) continue;
      list.sort((a, b) => a.rear - b.rear || (a.eventId < b.eventId ? -1 : 1));
      rear[l] = list[0]!.rear;
    }
  }
  sc.ban = ban;
  sc.obs = obs;
  sc.obsRear = rear;
  sc.closedLanes = closed;
  w.router.ban = ban;
  w.router.obsRear = rear;
}

/** Rear of the nearest obstacle at or ahead of `s` on `lane`, Infinity when none. */
export function obstacleAhead(obs: Obstacle[][], lane: number, s: number): number {
  for (const o of obs[lane]!) if (o.rear >= s - 1e-6) return o.rear;
  return Infinity;
}

/**
 * Vehicles waiting because of a scenario event are exempt from the 90 s stuck removal: they wait for the
 * closure to lift or the accident to clear (or are counted as "no route").
 */
export function scenarioHolds(w: World, v: Vehicle): boolean {
  const sc = w.sc!;
  // Emergency vehicles are never removed as stuck: their incident depends on them.
  if (v.scWait !== 0 || v.em !== null) return true;
  const nxt = v.route[v.ri + 1];
  if (sc.ban && nxt !== undefined && sc.ban[nxt]) return true;
  return sc.obs !== null && v.edge < w.net.nLanes && obstacleAhead(sc.obs, v.edge, v.s) < Infinity;
}

/** Every effect, incident and surge still running. */
export function activeEvents(sc: ScenarioState): number {
  const surges = new Set<string>();
  for (const t of sc.surgeQueue) surges.add(t.eventId);
  return sc.effects.length + sc.incidents.length + surges.size;
}
