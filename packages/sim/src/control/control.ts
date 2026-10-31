// A0 central control (ADR 0015 §2, §6): the observation boundary (which events the city knows of), stage
// queues arbitrated by `arbitrate`, and the bounded audit log of confirmed decisions, rejections and
// cancellations. Nothing here is read back by the simulation: the physical code paths, their order and every
// RNG stay exactly as before; the frame only routes decisions through one place and writes them down.

import { cumulativeLengths, pointAtLength } from '@smartcity/shared';
import type { World } from '../traffic/world.js';
import { detectionOf } from '../scenario/types.js';
import { arbitrate, STAGE_CAP, type Arbitration } from './arbiter.js';
import type { AgentId, AgentState, ControlAction, ControlStage, ControlView, Decision, MapTarget, ObservedEvent, Proposal, ProposalDraft, Verdict } from './types.js';

/** Stored audit entries; past it the oldest are dropped (counted in `dropped`). Bounds memory for any run length. */
export const AUDIT_MAX = 2000;
/** Decisions in the snapshot's control view (the UI shows a limited recent list). */
export const RECENT_DECISIONS = 30;
/** An agent counts as 동작 for this many ticks after its last decision (10 sim s = 100 game s). */
export const ACTIVE_TICKS = 200;

export interface ControlState {
  /** Events the city has learned of (ever, ended ones included): the observation boundary. */
  known: Map<string, ObservedEvent>;
  audit: Decision[];
  seq: number;
  dropped: number;
  repeated: number;
  proposals: number;
  lastTick: Partial<Record<AgentId, number>>;
  /** Signal stage: the vehicle whose request A0 accepted per junction (logged once per change). */
  served: Map<string, number>;
  /** Proposals each stage may consider per tick (STAGE_CAP; tests lower it), and what each used this tick. */
  stageCap: Record<ControlStage, number>;
  budgetTick: number;
  used: Record<ControlStage, number>;
  /** Input-time observations past the observe budget, retried first at the next tick's observe stage (FIFO). */
  deferred: DeferredObservation[];
}

/** An event known at its input whose observation A0 could not accept within this tick's budget. */
export interface DeferredObservation {
  ev: Omit<ObservedEvent, 'knownTick' | 'source'>;
  target: MapTarget | null;
  text: string;
  reason: string;
}

export function newControlState(): ControlState {
  return { known: new Map(), audit: [], seq: 0, dropped: 0, repeated: 0, proposals: 0, lastTick: {}, served: new Map(), stageCap: { observe: STAGE_CAP, dispatch: STAGE_CAP, signal: STAGE_CAP, route: STAGE_CAP }, budgetTick: -1, used: { observe: 0, dispatch: 0, signal: 0, route: 0 }, deferred: [] };
}

const ctl = (w: World): ControlState => w.sc!.control;

export const isKnown = (w: World, eventId: string): boolean => ctl(w).known.has(eventId);
export const knownKind = (w: World, eventId: string): ObservedEvent['kind'] | null => ctl(w).known.get(eventId)?.kind ?? null;

/** Append one audit entry (bounded). */
export function record(w: World, d: Omit<Decision, 'seq' | 'tick'>): void {
  const c = ctl(w);
  c.audit.push({ ...d, seq: ++c.seq, tick: w.tick });
  c.lastTick[d.agent] = w.tick;
  if (c.audit.length > AUDIT_MAX) {
    c.audit.shift();
    c.dropped++;
  }
}

/** A rejection that repeats every tick (a junction request waiting behind another): counted, not listed. */
export function repeated(w: World): void {
  ctl(w).repeated++;
}

/**
 * Arbitrate one queue of a stage at the current tick against the observation boundary and what is left of the
 * stage's per-tick budget (summed over every submit of that stage in the tick, so per-event submits keep the
 * existing interleaving and still share one cap). A0 gives each draft its deterministic id here.
 */
export function submit(w: World, stage: ControlStage, drafts: readonly ProposalDraft[]): Arbitration {
  const c = ctl(w);
  if (c.budgetTick !== w.tick) {
    c.budgetTick = w.tick;
    c.used = { observe: 0, dispatch: 0, signal: 0, route: 0 };
  }
  const queue: Proposal[] = drafts.map((d) => ({ ...d, id: `${d.agent}:${stage}:${w.tick}:${c.proposals++}` }));
  const r = arbitrate(queue, w.tick, (id) => c.known.has(id), Math.max(0, c.stageCap[stage] - c.used[stage]));
  c.used[stage] += r.considered;
  return r;
}

/** Log a proposal's verdict with its own text. */
export function recordProposal(w: World, p: Proposal, verdict: Verdict, text: string, reason: string, target: MapTarget | null): void {
  record(w, { agent: p.agent, verdict, action: p.action.type, text, reason, eventId: p.eventId ?? actionEvent(p.action), target });
}

const actionEvent = (a: ControlAction): string | null => ('eventId' in a ? a.eventId : null);

export { KIND_LABEL } from './types.js';

/**
 * The single point where the city learns of an event (every mode, every kind). `source` input = known when
 * its input applied (closures, medical calls, blackouts, surges; accidents and fires under legacy).
 */
export function observe(w: World, ev: Omit<ObservedEvent, 'knownTick' | 'source'>, source: ObservedEvent['source'], target: MapTarget | null, agent: AgentId, text: string, reason: string): void {
  const c = ctl(w);
  if (c.known.has(ev.eventId)) return;
  c.known.set(ev.eventId, { ...ev, knownTick: w.tick, source });
  record(w, { agent, verdict: 'accepted', action: 'observe', text, reason, eventId: ev.eventId, target });
}

// ---------- map targets (document / graph positions) ----------

export function buildingTarget(w: World, id: string): MapTarget | null {
  const b = w.doc.buildings[id];
  return b ? { kind: 'building', id, name: w.doc.buildingTypes[b.typeId]?.name ?? '건물', x: b.pos.x, z: b.pos.z } : null;
}

export function nodeTarget(w: World, id: string): MapTarget | null {
  const n = w.doc.nodes[id];
  return n ? { kind: 'node', id, name: '교차로', x: n.pos.x, z: n.pos.z } : null;
}

export function segmentTarget(w: World, id: string): MapTarget | null {
  const seg = w.graph.segments.get(id);
  if (!seg || seg.centerline.length < 2) return null;
  const cum = cumulativeLengths(seg.centerline);
  const p = pointAtLength(seg.centerline, cum, cum[cum.length - 1]! / 2);
  return { kind: 'segment', id, name: seg.roadType.name, x: p.x, z: p.z };
}

/** "단독주택 (96, 129)"; the id when there is no target. */
export const placeText = (t: MapTarget | null, id: string): string => (t ? `${t.name} (${Math.round(t.x)}, ${Math.round(t.z)})` : id);

// ---------- view ----------

/**
 * Agent states for the control room. OFF: the factor is off or the agent is not built yet (A2, A3, A6–A8).
 * 동작: a decision within ACTIVE_TICKS, or work under way (A4: emergency vehicles out or junctions driven;
 * A5: only its decisions — its re-route notices). Otherwise 대기.
 */
export function agentStates(w: World): ControlView['agents'] {
  const sc = w.sc!;
  const c = sc.control;
  const recent = (a: AgentId): boolean => c.lastTick[a] !== undefined && w.tick - c.lastTick[a]! <= ACTIVE_TICKS;
  const state = (a: AgentId, on: boolean, busy = false): AgentState => (!on ? 'off' : busy || recent(a) ? 'active' : 'idle');
  const p = sc.policy;
  return [
    { id: 'A0', state: state('A0', true, recent('A1') || recent('A4') || recent('A5')) },
    { id: 'A1', state: state('A1', detectionOf(p) === 'sensors') },
    { id: 'A2', state: 'off' },
    { id: 'A3', state: 'off' },
    { id: 'A4', state: state('A4', true, sc.missions.length > 0 || sc.ctl.size > 0) },
    { id: 'A5', state: state('A5', p.reroute) },
    { id: 'A6', state: 'off' },
    { id: 'A7', state: 'off' },
    { id: 'A8', state: 'off' },
  ];
}

/** A copy: nothing in a snapshot points into the audit log. */
export function controlView(w: World): ControlView {
  const c = w.sc!.control;
  const decisions = c.audit.slice(-RECENT_DECISIONS).map((d) => ({ ...d, target: d.target !== null ? { ...d.target } : null }));
  return { agents: agentStates(w), decisions, total: c.seq, dropped: c.dropped, repeated: c.repeated };
}
