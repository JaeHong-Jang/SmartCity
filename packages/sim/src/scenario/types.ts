// Public contract of the simulator-mode experiment inputs (ADR 0010 §2). Scenario inputs never touch the
// CityDoc: they change only the running simulation, through `applyScenarioInput` at a tick boundary.

import type { CityDoc } from '@smartcity/shared';
import { reservedError } from '../control/policy.js';

/**
 * Bumped whenever a change alters what a ScenarioRecord replays to, or what a record may contain. 2 =
 * detection model (ADR 0013 §1–§3: `policy.detection`, the delay / miss constants of scenario/detection.ts).
 * 3 = policy normalization (ADR 0015 §3): the reserved factor keys `adaptive` / `drone` / `precheck` /
 * `onboard` (0 only) are allowed in `policy.set`; the replayed behaviour is unchanged. Records of engine 1
 * replay as `detection: 'legacy'` (exactly the engine-1 behaviour); engine 1 and 2 records replay unchanged
 * and may not carry the reserved keys.
 */
export const ENGINE_VERSION = 3;
/** Engine versions simulationFromRecord accepts. */
export const ENGINE_VERSIONS: readonly number[] = [1, 2, 3];
export const SCENARIO_VERSION = 1;

/** `policy.set` = a response-policy change; `Simulation.setPolicy` records one, so replays stay exact. */
export type ScenarioInputKind =
  | 'closure.start'
  | 'closure.end'
  | 'accident.start'
  | 'accident.end'
  | 'surge.start'
  | 'fire.start'
  | 'fire.end'
  | 'medical.start'
  | 'medical.end'
  | 'blackout.start'
  | 'blackout.end'
  | 'policy.set';

export interface ScenarioTarget {
  segmentId?: string;
  /** Index into the segment's lanes, forward lanes first (`CompiledSegment.lanes`). Omitted = every lane, both directions (closures). */
  lane?: number;
  /** Accidents: rear end (upstream side) of the obstacle along the lane's travel direction, meters. Default: mid-lane. */
  s?: number;
  buildingId?: string;
  /**
   * `*.end` only: end exactly the event started by this input; segmentId / lane / buildingId may then be
   * omitted. Accepted whenever well-formed; if that event is not active when the end applies (unknown, other
   * kind, not started yet, already ended) the end is a logged no-op — the same live and on replay. Without it:
   * the earliest-started active event of that kind on segmentId + lane (fire / medical: on buildingId).
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
   * fire.start: burnTicks (0 → 100 %, default 2400 = 20 game min), suppressTicks (default 600 = 5 game min).
   * medical.start: treatTicks (on-scene treatment, default 360 = 3 game min).
   * blackout.start: target.buildingId (a substation: its coverage area) or x, z, radius (a disc, m);
   *   durationTicks (default 3600 = 30 game min).
   * *.end: none; ends the earliest-started active event of that kind with the same segmentId and lane
   *   (fire / medical / blackout: buildingId).
   * policy.set: reroute (0 | 1), informedShare (0..1), preempt (optional 0 | 1), battery (optional 0 | 1),
   *   detection (optional 0 = legacy | 1 = reports | 2 = sensors, `DETECTION_MODES` index; omitted = legacy),
   *   adaptive / drone / precheck / onboard (optional, 0 only: reserved, ignored — ADR 0015 §3); target {}.
   */
  params: Record<string, number>;
}

/**
 * "스마트 대응" (smart response). The UI has one toggle: `reroute` switches re-routing and, unless `preempt`
 * is given, emergency signal pre-emption with it. Records without `preempt` (every 4c1 record) therefore
 * pre-empt exactly when they re-route; an explicit `preempt` decouples the two (tests, experiments).
 */
export interface ResponsePolicy {
  /** Informed vehicles re-route when an event starts or ends. */
  reroute: boolean;
  /** Share of vehicles that are informed (vehicle id hash < share), 0..1. */
  informedShare: number;
  /** Emergency vehicles pre-empt signals (ADR 0010 §4). Omitted = same as `reroute`. */
  preempt?: boolean;
  /** Signal batteries keep unpowered signals on for a while in a blackout (4c2-②). Omitted = same as `reroute`. */
  battery?: boolean;
  /**
   * When the city learns of an accident or fire (ADR 0013 §1), fixed per event when it starts. Omitted =
   * `legacy`: at once, exactly as before (old records, goldens). `reports`: at the citizen report.
   * `sensors`: at min(report, every valid sensor detection). Other events are always known at once.
   */
  detection?: DetectionMode;
  /**
   * Reserved factors (ADR 0015 §3, control/policy.ts): fixed OFF until their agents exist. Omitted or false is
   * accepted and ignored (not recorded); true is rejected.
   */
  adaptive?: false;
  drone?: false;
  precheck?: false;
  onboard?: false;
}

export const DETECTION_MODES = ['legacy', 'reports', 'sensors'] as const;
export type DetectionMode = (typeof DETECTION_MODES)[number];

/** Detection mode of a policy (`detection` omitted = legacy). */
export const detectionOf = (p: ResponsePolicy): DetectionMode => p.detection ?? 'legacy';

export const DEFAULT_POLICY: ResponsePolicy = { reroute: false, informedShare: 0.7 };

/** Whether signal pre-emption is on under a policy (`preempt` omitted = `reroute`). */
export const preemptOn = (p: ResponsePolicy): boolean => p.preempt ?? p.reroute;

/** Whether signal batteries are on under a policy (`battery` omitted = `reroute`). */
export const batteryOn = (p: ResponsePolicy): boolean => p.battery ?? p.reroute;

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
  'fire.start': ['burnTicks', 'suppressTicks'],
  'fire.end': [],
  'medical.start': ['treatTicks'],
  'medical.end': [],
  'blackout.start': ['x', 'z', 'radius', 'durationTicks'],
  'blackout.end': [],
  'policy.set': ['reroute', 'informedShare', 'preempt', 'battery', 'detection', 'adaptive', 'drone', 'precheck', 'onboard'],
};

/** Strict policy check shared by setPolicy, records and the worker (no type coercion). Null = valid. */
export function policyError(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return 'policy는 객체여야 합니다';
  const { reroute, informedShare, preempt, battery, detection } = p as Record<string, unknown>;
  if (typeof reroute !== 'boolean') return 'policy.reroute는 boolean이어야 합니다';
  if (typeof informedShare !== 'number' || !Number.isFinite(informedShare) || informedShare < 0 || informedShare > 1) return 'policy.informedShare는 0..1 수여야 합니다';
  if (preempt !== undefined && typeof preempt !== 'boolean') return 'policy.preempt는 boolean이어야 합니다';
  if (battery !== undefined && typeof battery !== 'boolean') return 'policy.battery는 boolean이어야 합니다';
  if (detection !== undefined && !(DETECTION_MODES as readonly unknown[]).includes(detection)) return 'policy.detection은 legacy | reports | sensors여야 합니다';
  return reservedError((k) => (p as Record<string, unknown>)[k], false);
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
  /** Closures, accidents, fires and medical calls in effect, plus surges with trips still to depart. */
  activeEvents: number;
  // Emergency KPIs (4c2-①).
  /** Emergency responses (fire / medical): call → arrival at the scene, game minutes. 0 when none arrived yet. */
  avgResponseTime: number;
  maxResponseTime: number;
  /** Emergency vehicles that reached an active incident. */
  responses: number;
  /** Fires put out before reaching 100 %, and buildings damaged (fire reached 100 %). */
  extinguished: number;
  damaged: number;
  /** Patients treated on scene and delivered to the hospital. */
  medicalCompleted: number;
  /** Incidents no vehicle could be sent to (no facility, no route, no emergency vehicle type). */
  dispatchFailed: number;
  /**
   * Responses still under way NOW (instantaneous, not cumulative): dispatches of active incidents that have not
   * reached the scene yet (on the road, or waiting for room to leave), and the sum / maximum of their elapsed
   * game minutes since the call. With them a mean response time can count the late ones (no survivorship bias):
   * (avgResponseTime × responses + respondingElapsedSum) / (responses + respondingNow).
   */
  respondingNow: number;
  respondingElapsedSum: number;
  oldestPendingMinutes: number;
  // Blackout KPIs (4c2-②). Instantaneous: signals without grid power (dark or on battery), signals dark now
  // (junctions + mid-block crosswalks), buildings without power. Cumulative since `since`, game minutes:
  // junction-minutes dark, junction-minutes kept on by batteries, vehicle-minutes stopped at the lanes into
  // dark junctions (the all-way-stop delay).
  unpoweredSignals: number;
  darkSignals: number;
  unpoweredBuildings: number;
  darkJunctionMinutes: number;
  batteryJunctionMinutes: number;
  darkQueueVehicleMinutes: number;
  /** Detection KPIs (ADR 0013 §5). Always set by the simulation; optional for older consumers. */
  detection?: DetectionKpi;
  /** Emergency response time split into its stages (ADR 0013 §5). Always set by the simulation. */
  response?: ResponseBreakdown;
}

/**
 * Accidents and fires that started under `reports` / `sensors` ("tracked"; legacy-mode events are known at
 * once and not counted). Game minutes; model values, not calibrated.
 */
export interface DetectionKpi {
  tracked: number;
  /** Tracked events at least one sensor able to notice that kind covered when it started. */
  covered: number;
  /** Tracked events the city learned of, and how many of those a sensor reported first. */
  detected: number;
  bySensor: number;
  /** Detection delay (start → known) of the detected ones; 0 when none. */
  avgDelay: number;
  maxDelay: number;
  /** Not known yet NOW (instantaneous), their elapsed minutes summed and the oldest. */
  undetectedNow: number;
  undetectedElapsedSum: number;
  oldestUndetectedMinutes: number;
  /** Over before the city learned of them (ended, cleared, target gone, burned down), and of those the fires that burned down (damage). */
  missed: number;
  missedDamaged: number;
  /** Distinct vehicles that drove on an accident lane while the accident was not known yet (summed over accidents). */
  exposedVehicles: number;
  /** On-site recoveries of vehicles that saw an accident (side steps + re-routes before its lane), any time. */
  onSiteRecoveries: number;
}

/**
 * Emergency responses that reached the scene (`responses`), averaged per stage in game minutes: detection
 * (start → known; 0 for legacy events and medical calls), waiting to dispatch (known → the vehicle entered the
 * network, retries included), travel (→ arrival). detect + dispatchWait + travel = avgResponseTime. `work`:
 * on-scene suppression / treatment time of the `workDone` jobs that finished it.
 */
export interface ResponseBreakdown {
  arrivals: number;
  detect: number;
  dispatchWait: number;
  travel: number;
  workDone: number;
  work: number;
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
  activeEvents: { eventId: string; kind: 'closure' | 'accident' | 'surge' | 'fire' | 'medical' | 'blackout'; startTick: number; endTick: number | null }[];
  /**
   * The last RECENT_LOG_SIZE (20) scenario log entries, oldest first: every applied input, automatic end and
   * edit-time move or drop. `applied: false` = a no-op, with the `reason` (e.g. an end whose event is not active).
   */
  recentLog: ScenarioOutcome[];
  /** Active fires and medical calls (eventId order); `progress` = fire progress 0..100 (medical: 0). */
  incidents: { eventId: string; kind: 'fire' | 'medical'; buildingId: string; state: 'burning' | 'suppressing' | 'waiting' | 'treating' | 'transport'; progress: number }[];
  /** Buildings a fire reached 100 % on (id order). Scenario state only: the document is never changed. */
  damagedBuildings: string[];
  /**
   * Emergency vehicles out (incident eventId order): `vehicleId` = the vehicle on the network, null while it
   * waits for room at its origin or is parked at the scene (`working`). `facilityId` = the dispatching building.
   */
  dispatches: { eventId: string; kind: 'fire' | 'medical'; vehicleId: number | null; stage: 'enroute' | 'working' | 'transport' | 'returning'; facilityId: string; buildingId: string }[];
  /** Junctions the signal controller drives (nodeId order): serving `vehicleId`, or −1 while handing back to the plan. */
  preempted: { nodeId: string; vehicleId: number; phase: number; color: 'green' | 'yellow' | 'red' }[];
  /** Active blackouts (eventId order): a substation's area (`substationId`, its position, the coverage radius) or a disc. */
  blackouts: { eventId: string; substationId: string | null; x: number; z: number; radius: number; startTick: number; endTick: number }[];
  /** Dark (unpowered) junctions and mid-block signal crosswalks, id order. */
  darkJunctions: string[];
  darkCrossings: string[];
  /** Unpowered signals kept on by their battery: `n:`nodeId / `c:`crosswalk id, game minutes left. */
  battery: { signalId: string; remainingMinutes: number }[];
  /** Buildings without power (render: windows dark), id order. Scenario state only. */
  unpoweredBuildings: string[];
  /** Accidents and fires the city does not know of yet (ADR 0013), eventId order. */
  undetected: { eventId: string; kind: 'accident' | 'fire'; startTick: number }[];
}

/** One apply-time scenario outcome (`Simulation.drainScenarioOutcomes`, `ScenarioView.recentLog`). */
export interface ScenarioOutcome {
  eventId: string;
  tick: number;
  /**
   * Input kind, or `closure.end` / `accident.end` for automatic ends, `accident.move` after an edit. Emergency
   * outcomes (eventId = the fire / medical event): `dispatch.start` (vehicle left its facility), `dispatch.arrive`
   * (at the scene; reason = response time), `fire.extinguished`, `fire.damaged`, `medical.complete` (patient
   * at the hospital), `dispatch.return` (back at the facility), `dispatch.cancel` (incident over before the
   * vehicle could leave), `dispatch.failed` (출동 불가: 시설 없음 / 경로 없음 / 긴급 차종 없음 — the incident
   * still runs), `dispatch.lost` (vehicle removed by an edit, or no way back / to the hospital).
   * Blackout outcomes (eventId = the blackout): `blackout.end` (reason `duration` / `by <input>`),
   * `signal.dark` / `signal.restored` / `battery.depleted` (reason = the junction node id or crosswalk id).
   * Detection outcomes (ADR 0013, eventId = the accident / fire): `detection.known` (reason `report` or
   * `sensor <id>`, then the delay), `detection.missed` (reason `ended before detection` / `burned before
   * detection` / `target gone`), `detection.unpowered` (reason = the sensor id whose detection a blackout voided).
   */
  kind: string;
  applied: boolean;
  reason?: string;
}

export const RECENT_LOG_SIZE = 20;
