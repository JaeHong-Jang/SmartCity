// Public contract of the simulator-mode experiment inputs (ADR 0010 §2). Scenario inputs never touch the
// CityDoc: they change only the running simulation, through `applyScenarioInput` at a tick boundary.

import type { CityDoc } from '@smartcity/shared';

/** Bumped whenever a change alters what a ScenarioRecord replays to. */
export const ENGINE_VERSION = 1;
export const SCENARIO_VERSION = 1;

/** `policy.set` = a response-policy change; `Simulation.setPolicy` records one, so replays stay exact. */
export type ScenarioInputKind = 'closure.start' | 'closure.end' | 'accident.start' | 'accident.end' | 'surge.start' | 'policy.set';

export interface ScenarioTarget {
  segmentId?: string;
  /** Index into the segment's lanes, forward lanes first (`CompiledSegment.lanes`). Omitted = every lane, both directions (closures). */
  lane?: number;
  /** Accidents: rear end (upstream side) of the obstacle along the lane's travel direction, meters. Default: mid-lane. */
  s?: number;
  buildingId?: string;
  /**
   * `closure.end` / `accident.end` only: end exactly the event started by this input; segmentId / lane may then
   * be omitted. Accepted whenever well-formed; if that event is not active when the end applies (unknown, other
   * kind, not started yet, already ended) the end is a logged no-op — the same live and on replay. Without it:
   * the earliest-started active event of that kind on segmentId + lane.
   */
  eventId?: string;
}

export interface ScenarioInput {
  /** Unique over the whole run. */
  eventId: string;
  /** Sim tick (integer) whose step applies it, before anything else of that tick. Past ticks are rejected. */
  tick: number;
  /** Order among inputs of the same tick; ties by eventId. */
  order: number;
  kind: ScenarioInputKind;
  target: ScenarioTarget;
  /**
   * closure.start: durationTicks (optional, no auto end without it).
   * accident.start: durationTicks (default 2400 = 2 min sim = 20 game min), length (default 9 m).
   * surge.start: extraTrips (required), inflowTicks (default 1200), stayTicks (default 2400), outflowTicks (default = inflowTicks).
   * *.end: none; ends the earliest-started active event of that kind with the same segmentId and lane.
   * policy.set: reroute (0 | 1), informedShare (0..1); target {}.
   */
  params: Record<string, number>;
}

export interface ResponsePolicy {
  /** Informed vehicles re-route when an event starts or ends. */
  reroute: boolean;
  /** Share of vehicles that are informed (vehicle id hash < share), 0..1. */
  informedShare: number;
}

export const DEFAULT_POLICY: ResponsePolicy = { reroute: false, informedShare: 0.7 };

/** The only keys a ScenarioInput may carry (anything else is rejected, so every accepted input is plain JSON). */
export const SCENARIO_INPUT_KEYS = ['eventId', 'tick', 'order', 'kind', 'target', 'params'] as const;
export const SCENARIO_TARGET_KEYS = ['segmentId', 'lane', 's', 'buildingId', 'eventId'] as const;
/** Allowed `params` keys per kind. */
export const SCENARIO_PARAM_KEYS: Record<ScenarioInputKind, readonly string[]> = {
  'closure.start': ['durationTicks'],
  'closure.end': [],
  'accident.start': ['durationTicks', 'length'],
  'accident.end': [],
  'surge.start': ['extraTrips', 'inflowTicks', 'stayTicks', 'outflowTicks'],
  'policy.set': ['reroute', 'informedShare'],
};

/** Strict policy check shared by setPolicy, records and the worker (no type coercion). Null = valid. */
export function policyError(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return 'policy는 객체여야 합니다';
  const { reroute, informedShare } = p as Record<string, unknown>;
  if (typeof reroute !== 'boolean') return 'policy.reroute는 boolean이어야 합니다';
  if (typeof informedShare !== 'number' || !Number.isFinite(informedShare) || informedShare < 0 || informedShare > 1) return 'policy.informedShare는 0..1 수여야 합니다';
  return null;
}

export interface ScenarioRecord {
  engineVersion: number;
  scenarioVersion: 1;
  /** Server seq the document copy was taken at (shown to the user; not used by the sim). */
  baseSeq: number;
  doc: CityDoc;
  seed: number;
  tickRate: number;
  warmupTicks: number;
  /** Every accepted input, including the `policy.set` inputs recorded by runtime `setPolicy` calls. */
  inputs: ScenarioInput[];
  /** Policy in effect from activation (before any `policy.set` input). */
  policy: ResponsePolicy;
  /**
   * Tick boundary the scenario state was activated at (`Simulation.scenarioActivatedAt()`); replay activates
   * exactly there. Omitted = 0 (an experiment created with `SimOptions.scenario` / worker `init` `scenario: true`).
   */
  activatedAtTick?: number;
}

export type ScenarioResult = { ok: true } | { ok: false; error: string };

/**
 * KPIs counted from the tick the scenario state was activated (`since`: SimOptions.scenario, the first
 * scenarioInput / setPolicy, or a replay's activatedAtTick). Game model values, not calibrated.
 */
export interface ScenarioKpi {
  tick: number;
  /** Activation tick; −1 = scenario state not active yet (counters are 0; asking never activates it). */
  since: number;
  /** Non-bus vehicles that reached their destination since `since`. */
  completed: number;
  /** Mean travel time of those, simulated seconds (spawn → arrival); 0 when none. */
  avgTravelTime: number;
  /** Non-bus vehicles on the network now. */
  inProgress: number;
  /** Vehicles now waiting because no route avoids a closure (their next connector is banned). */
  noRoute: number;
  /**
   * Trips that could not start since `since`: surge trips without a route or origin, demand trips without a
   * route or with a closed origin lane, and demand trips drawn while the vehicle cap was reached.
   */
  droppedTrips: number;
  /** Departures waiting now: demand trips in the spawn queue plus due surge trips not yet placed. */
  waitingToDepart: number;
  /** Vehicles removed (stuck too long, edits) since `since`. */
  removed: number;
  /**
   * Meters of lane where at least one vehicle (dwelling buses excluded) drives slower than 0.3 × the lane's
   * speed limit; each such lane counts its full length once.
   */
  congestionLength: number;
  /** Distinct vehicles re-routed by the response policy (informed, policy ON). */
  rerouted: number;
  /** Policy re-routes that actually changed the remaining route. */
  detoured: number;
  /** Invalid-route recoveries that found a route (policy independent). */
  recovered: number;
  /** Closures and accidents in effect, plus surges with trips still to depart. */
  activeEvents: number;
}

/** Render data of the scenario overlay (only present in snapshots once a scenario state exists). */
export interface ScenarioView {
  graphRevision: number;
  /** Accident obstacles: center position, travel heading (atan2(z, x)), length; lane = RoadGraph.lanes index. */
  obstacles: { eventId: string; lane: number; x: number; z: number; heading: number; length: number }[];
  /** Lanes (RoadGraph.lanes indexes, ascending) closed to new entry. */
  closedLanes: number[];
  kpi: ScenarioKpi;
  /**
   * Events in effect now, sorted by eventId. `endTick` = scheduled automatic end (null = until an end input);
   * for a surge, the departure tick of its last trip (it stays listed while trips are still to depart).
   */
  activeEvents: { eventId: string; kind: 'closure' | 'accident' | 'surge'; startTick: number; endTick: number | null }[];
  /**
   * The last RECENT_LOG_SIZE (20) scenario log entries, oldest first: every applied input, automatic end and
   * edit-time move or drop. `applied: false` = a no-op, with the `reason` (e.g. an end whose event is not active).
   */
  recentLog: ScenarioOutcome[];
}

/** One apply-time scenario outcome (`Simulation.drainScenarioOutcomes`, `ScenarioView.recentLog`). */
export interface ScenarioOutcome {
  eventId: string;
  tick: number;
  /** Input kind, or `closure.end` / `accident.end` for automatic ends, `accident.move` after an edit. */
  kind: string;
  applied: boolean;
  reason?: string;
}

export const RECENT_LOG_SIZE = 20;
