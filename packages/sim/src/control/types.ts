// Public contract of the central control frame (ADR 0015 §2): observation → proposal → arbitration → safety
// execution → result. Agents read only an ObservationView (events the city knows of), never the physical
// scenario state; they propose, A0 arbitrates, and only accepted proposals reach an executor. The frame is
// an adapter around the existing tick (same calls, same order): it adds no state the simulation reads back.

import type { DetectionMode } from '../scenario/types.js';

export type AgentId = 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8';
/** Eye (sensing), brain (deciding), body (acting) — the report's AI City structure (보고서 2.1). */
export type AgentRole = 'eye' | 'brain' | 'body';
/** 대기 (on, nothing to do), 동작 (deciding or carrying out a decision now), OFF (factor off or not built yet). */
export type AgentState = 'idle' | 'active' | 'off';

/**
 * Independent response factors (ADR 0015 §3), normalized from a ResponsePolicy by `policyFactors`.
 * `adaptive` / `drone` / `precheck` / `onboard` are reserved: always false in P8a (an explicit ON is rejected).
 */
export interface PolicyFactors {
  /** A4: emergency signal pre-emption (dispatch itself is always on). Omitted = `reroute`. */
  preempt: boolean;
  /** A5: informed vehicles re-route when an event the city knows of starts or ends. */
  reroute: boolean;
  /** Signal batteries in a blackout (infrastructure, no agent). Omitted = `reroute`. */
  battery: boolean;
  /** When the city learns of accidents and fires: legacy = at once, reports, sensors (A1). Omitted = legacy. */
  detection: DetectionMode;
  /** Share of informed vehicles (A5 audience). */
  informedShare: number;
  adaptive: false;
  drone: false;
  precheck: false;
  onboard: false;
}

/** Arbitration classes, highest first: life safety > spread prevention > flow efficiency (ADR 0015 §2). */
export const PRIORITY = { life: 0, spread: 1, efficiency: 2 } as const;
export type PriorityClass = keyof typeof PRIORITY;

/**
 * Stages in tick order (packages/sim/AGENTS.md "1틱 순서"): `observe` (input apply, detections), `signal`
 * (after the fixed-time signals), `route` and `dispatch` (input apply, detections, the emergency clock, edits).
 * Each stage has its own queue; a queue is arbitrated and executed where the stage runs in the tick.
 */
export type ControlStage = 'observe' | 'dispatch' | 'signal' | 'route';

/** Where a decision shows on the map (positions from the document / graph; deterministic). */
export interface MapTarget {
  /** `point`: a position only (a blackout disc's center; id = the event id). */
  kind: 'building' | 'node' | 'segment' | 'point';
  id: string;
  /** Readable name: building design, road type, 교차로, 구역. */
  name: string;
  x: number;
  z: number;
}

export type ControlAction =
  /** The city learns of an event: an input known at once, a citizen report, or a sensor (A1). */
  | { type: 'observe'; eventId: string; source: 'input' | 'report' | 'sensor'; sensorId: string | null }
  /** A4: send the emergency vehicle of `typeId` from `facilityId` to the incident. */
  | { type: 'dispatch'; eventId: string; facilityId: string; typeId: string }
  /** A4: target phase for an emergency vehicle at a junction. The safety executor decides every transition. */
  | { type: 'signal'; nodeId: string; phase: number; vehicleId: number; eta: number }
  /** A5: tell these informed vehicles (ascending id) to search a new route. */
  | { type: 'reroute'; eventId: string; vehicleIds: number[] };

export interface Proposal {
  /** Unique, deterministic: `${agent}:${stage}:${tick}:${n}`. */
  id: string;
  agent: AgentId;
  stage: ControlStage;
  priority: PriorityClass;
  /** Conflict scope: at most one accepted proposal per key per arbitration (e.g. `node:c`, `incident:f1`). */
  key: string;
  /** Tie-break inside the same priority and key, compared lexicographically (smaller wins), then `id`. */
  rank: readonly number[];
  issuedTick: number;
  /** Last tick it may be accepted at (inclusive); later = rejected `expired`. */
  expiresTick: number;
  /** The known event it reacts to; null for requests about the city's own fleet. Unknown → rejected. */
  eventId: string | null;
  action: ControlAction;
  /** Why the agent proposes it (shown in the decision log). */
  reason: string;
}

/** What an agent returns: A0 gives it its id when the stage queue is submitted (control.ts `submit`). */
export type ProposalDraft = Omit<Proposal, 'id'>;

/**
 * The read-only queries agents may make besides their ObservationView (ADR 0015 §2): infrastructure (the
 * document, the road network with the costs the city knows) and the city's own fleet — never the physical
 * scenario state. Answered by scenario/controlAdapter.ts.
 */
export interface DispatchQueries {
  /** Emergency vehicle type for an incident kind (`fire-truck` / `ambulance`, else the first emergency type), null = none. */
  vehicleType(kind: 'fire' | 'medical'): string | null;
  /** Facilities serving that kind (fire station / hospital), id order. */
  facilities(kind: 'fire' | 'medical'): string[];
  /** The building has a road access point. */
  hasAccess(buildingId: string): boolean;
  /**
   * Free-flow route cost (closures banned, accidents the city knows of penalized) for a `typeId` vehicle from
   * the facility's access point to the building's; null = no access, no room to enter, entry closed or no route.
   */
  routeCost(facilityId: string, buildingId: string, typeId: string): number | null;
}

export interface SignalQueries {
  /**
   * The first signalized junction on the own vehicle's route within `reach` m of its position, the phase of
   * its approach and the distance; null when the next one is farther, dark (unpowered), has no such phase or
   * there is none.
   */
  nextSignal(vehicleId: number, reach: number): { nodeId: string; phase: number; distance: number } | null;
  /** The vehicle whose request the junction's signal controller serves now, −1 = none. */
  servedVehicle(nodeId: string): number;
}

export interface RerouteQueries {
  /** Informed vehicles (`hash01(id, seed) < share`) not already queued whose remaining route uses one of `lanes`, ascending id. */
  informedUsing(lanes: readonly number[], share: number): number[];
}

export type Verdict = 'accepted' | 'rejected' | 'cancelled';

/** One audit-log entry: confirmed decisions, rejections and cancellations only (ADR 0015 §6). */
export interface Decision {
  /** Running number over the run (selection key in the UI). */
  seq: number;
  tick: number;
  agent: AgentId;
  verdict: Verdict;
  action: ControlAction['type'];
  /** What was decided, Korean, short. */
  text: string;
  reason: string;
  eventId: string | null;
  target: MapTarget | null;
}

/** An event the city knows of (ObservationView). No physical progress, no undetected event, no future input. */
export interface ObservedEvent {
  eventId: string;
  kind: 'closure' | 'accident' | 'fire' | 'medical' | 'blackout' | 'surge';
  /** Tick the city learned of it and how. */
  knownTick: number;
  source: 'input' | 'report' | 'sensor';
  segmentId: string | null;
  /** Segment lane position (accidents, closures of one lane), −1 = every lane / none. */
  lane: number;
  buildingId: string | null;
}

/**
 * The only input of agents and A0 (ADR 0015 §2). Events the city knows of now (eventId order); general
 * real-time congestion (stopped vehicles per lane, allowed like ADR 0013's live traffic information); the
 * city's own emergency fleet; the normalized policy. Excluded: undetected events, queued (future) inputs,
 * evaluation state (KPIs, fire progress, the true obstacle list).
 */
export interface ObservationView {
  tick: number;
  factors: PolicyFactors;
  events: ObservedEvent[];
  /** Stopped vehicles per lane index at the end of the last tick (a copy). */
  stoppedPerLane: Int32Array;
  /** Ticks per simulated second. */
  tickRate: number;
  /** The city's own emergency vehicles out (incident order): vehicle id and speed (m/s) while on the network. */
  fleet: { eventId: string; kind: 'fire' | 'medical'; vehicleId: number | null; speed: number; stage: 'enroute' | 'working' | 'transport' | 'returning'; facilityId: string }[];
}

export const KIND_LABEL: Record<ObservedEvent['kind'], string> = { closure: '도로 통제', accident: '사고', fire: '화재', medical: '응급 환자', blackout: '정전', surge: '수요 급증' };

/** Control-room data in the snapshot (ScenarioView.control). */
export interface ControlView {
  agents: { id: AgentId; state: AgentState }[];
  /** The last RECENT_DECISIONS decisions, oldest first. */
  decisions: Decision[];
  /** Decisions so far, entries dropped by the audit cap, and repeated rejections only counted (not listed). */
  total: number;
  dropped: number;
  repeated: number;
}
