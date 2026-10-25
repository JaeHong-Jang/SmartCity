// Builds ScenarioInputs (unique eventId, tick, order) and accumulates the ScenarioRecord (ADR 0010 §2).

import { cloneJson, type CityDoc } from '@smartcity/shared';
import { ENGINE_VERSION, SCENARIO_VERSION, type ResponsePolicy, type ScenarioInput, type ScenarioInputKind, type ScenarioRecord, type ScenarioTarget } from '@smartcity/sim';
import { TICK_HZ } from '../sim/protocol';
import { gameMinToTicks } from './time';

export interface RecordBase {
  baseSeq: number;
  doc: CityDoc;
  seed: number;
  warmupTicks: number;
  policy: ResponsePolicy;
  tickRate?: number;
}

export class ScenarioRecorder {
  private counter = 0;
  private readonly inputs = new Map<string, ScenarioInput>();

  /** `runId` keeps eventIds unique across restarts of the same page session. */
  constructor(private readonly base: RecordBase, private readonly runId = 'sm') {}

  /** Build the next input; ids and orders are strictly increasing, so ties on a tick keep creation order. */
  make(kind: ScenarioInputKind, tick: number, target: ScenarioTarget, params: Record<string, number> = {}): ScenarioInput {
    const n = ++this.counter;
    return { eventId: `${this.runId}-${n}`, tick, order: n, kind, target, params };
  }

  /** Record an input (call when it is sent to the sim). */
  add(input: ScenarioInput): void {
    if (this.inputs.has(input.eventId)) throw new Error(`중복 eventId ${input.eventId}`);
    this.inputs.set(input.eventId, input);
  }

  /** The sim rejected it: it never happened, so it must not be replayed. */
  reject(eventId: string): void {
    this.inputs.delete(eventId);
  }

  get size(): number {
    return this.inputs.size;
  }

  toRecord(): ScenarioRecord {
    const inputs = [...this.inputs.values()].sort((a, b) => a.tick - b.tick || a.order - b.order || (a.eventId < b.eventId ? -1 : 1));
    return {
      engineVersion: ENGINE_VERSION,
      scenarioVersion: SCENARIO_VERSION,
      baseSeq: this.base.baseSeq,
      doc: cloneJson(this.base.doc),
      seed: this.base.seed,
      tickRate: this.base.tickRate ?? TICK_HZ,
      warmupTicks: this.base.warmupTicks,
      inputs: inputs.map((i) => cloneJson(i)),
      policy: { ...this.base.policy },
      activatedAtTick: 0,
    };
  }
}

// ---------- input parameter builders (game minutes → ticks) ----------

export function closureParams(minutes: number): Record<string, number> {
  return { durationTicks: Math.max(1, gameMinToTicks(minutes)) };
}

export function accidentParams(minutes: number): Record<string, number> {
  return { durationTicks: Math.max(1, gameMinToTicks(minutes)) };
}

export interface SurgeMinutes {
  people: number;
  inflowMin: number;
  stayMin: number;
  outflowMin: number;
}

export function surgeParams(s: SurgeMinutes): Record<string, number> {
  return {
    extraTrips: Math.max(1, Math.round(s.people)),
    inflowTicks: gameMinToTicks(s.inflowMin),
    stayTicks: gameMinToTicks(s.stayMin),
    outflowTicks: gameMinToTicks(s.outflowMin),
  };
}

/** Tick at which an event with these params stops acting (null = until an explicit end input). */
export function eventEndTick(kind: ScenarioInputKind, startTick: number, params: Record<string, number>): number | null {
  if (kind === 'closure.start' || kind === 'accident.start') return params.durationTicks === undefined ? null : startTick + params.durationTicks;
  if (kind === 'surge.start') {
    const inflow = params.inflowTicks ?? 1200;
    return startTick + inflow + (params.stayTicks ?? 2400) + (params.outflowTicks ?? inflow);
  }
  return null;
}
