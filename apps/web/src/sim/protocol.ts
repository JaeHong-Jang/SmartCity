// Messages between the main thread and sim.worker.ts.

import type { CityDoc, Command } from '@smartcity/shared';
import { SCENARIO_INPUT_KEYS, SCENARIO_PARAM_KEYS, SCENARIO_TARGET_KEYS } from '@smartcity/sim';
import type { ResponsePolicy, ScenarioInput, ScenarioKpi, ScenarioOutcome, ScenarioRecord, ScenarioResult, Simulation, SimSnapshot, SnapshotBuffers } from '@smartcity/sim';

export type WorkerSpeed = 0 | 1 | 2 | 4;

/** Simulator-mode messages (ADR 0010): experiment inputs, response policy, KPI request. */
export type ScenarioToWorker = { t: 'scenario'; inputs: ScenarioInput[] } | { t: 'policy'; policy: ResponsePolicy } | { t: 'kpi' };

export type ToWorker =
  /**
   * `seed` replaces the doc's seed (experiment copies, ScenarioRecord.seed). `scenario: true` = simulator mode
   * from tick 0 (SimOptions.scenario): warm-up and experiment run under scenario rules, records replay exactly.
   */
  | { t: 'init'; doc: CityDoc; seed?: number; scenario?: boolean }
  /** Replay a record from tick 0 (no warm-up run; use runTo). `reroute` overrides the policy's reroute everywhere (ON/OFF compare). */
  | { t: 'initRecord'; record: ScenarioRecord; reroute?: boolean }
  | { t: 'command'; cmd: Command }
  | { t: 'setSpeed'; speed: WorkerSpeed }
  | { t: 'returnBuffers'; buffers: SnapshotBuffers }
  /**
   * Fast-forward to `tick` as fast as possible (no per-tick snapshots), yielding between ~16 ms chunks.
   * Progress every `progressEvery` ticks (default 600); a KPI point at every multiple of `kpiEvery` (default 60)
   * while the scenario is active. The real-time loop is paused meanwhile.
   */
  | { t: 'runTo'; tick: number; progressEvery?: number; kpiEvery?: number }
  /** Stop a runTo in progress (answered with `{ t: 'runTo', cancelled }`). */
  | { t: 'cancel' }
  | ScenarioToWorker;

export type FromWorker =
  | { t: 'status'; status: 'ready' | 'error'; error?: string }
  | { t: 'snapshot'; snapshot: SimSnapshot }
  /** `results[i]` answers `inputs[i]`; `error` = the message itself was malformed (no input queued). */
  | { t: 'scenario'; results: ({ eventId: string } & ScenarioResult)[]; error?: string }
  /** `input` = the tick-aligned `policy.set` input the change was recorded as (put it in ScenarioRecord.inputs). */
  | { t: 'policy'; result: ScenarioResult; input?: ScenarioInput }
  | { t: 'kpi'; kpi: ScenarioKpi }
  | { t: 'runTo'; progress: number }
  /** Reached `done`; a snapshot (with `scenario.kpi`) was posted just before. `kpi` = the grid points (ticks ascending). */
  | { t: 'runTo'; done: number; kpi: ScenarioKpi[] }
  | { t: 'runTo'; cancelled: number; kpi: ScenarioKpi[] }
  | { t: 'runTo'; error: string }
  /**
   * Every apply-time scenario outcome since the previous one (lossless, apply order): posted after each step
   * batch / runTo chunk that produced any, always before the snapshot of the same tick.
   */
  | { t: 'outcomes'; outcomes: ScenarioOutcome[] }
  /** A message the worker could not use (malformed, unknown `t`, or its handler failed); the simulation keeps running. */
  | { t: 'error'; error: string; for?: string };

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;

/** Distinct ArrayBuffers behind a snapshot's arrays, for postMessage transfer lists. */
export function snapshotTransferables(b: SnapshotBuffers): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const a of [b.vehicles, b.signals, b.laneFlow, b.pedestrians, b.pedestrianIds, b.crossings, b.occupancy, b.busLoad, b.stopWaiting]) {
    if (a && a.buffer instanceof ArrayBuffer && a.buffer.byteLength > 0 && !out.includes(a.buffer)) out.push(a.buffer);
  }
  return out;
}

/** Typed array type of every SnapshotBuffers field. */
const BUFFER_TYPES = {
  vehicles: Float32Array,
  signals: Float32Array,
  laneFlow: Float32Array,
  pedestrians: Float32Array,
  pedestrianIds: Uint32Array,
  crossings: Float32Array,
  occupancy: Float32Array,
  busLoad: Uint16Array,
  stopWaiting: Uint16Array,
} as const;

/**
 * Buffers handed back by the main thread, keeping only fields of the exact typed array type with a live
 * (not transferred away) non-empty buffer; anything else is dropped (the snapshot then allocates it fresh).
 */
export function sanitizeBuffers(b: unknown): SnapshotBuffers {
  const out: SnapshotBuffers = {};
  if (!isObj(b)) return out;
  for (const key of Object.keys(BUFFER_TYPES) as (keyof typeof BUFFER_TYPES)[]) {
    const a = b[key];
    if (a instanceof BUFFER_TYPES[key] && a.length > 0 && a.buffer instanceof ArrayBuffer && a.buffer.byteLength > 0) (out as Record<string, unknown>)[key] = a;
  }
  return out;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Shape check of an input from another thread (values are validated by the simulation). Null = well-formed. */
export function inputShapeError(x: unknown): string | null {
  if (!isObj(x)) return '입력은 객체여야 합니다';
  if (typeof x.eventId !== 'string') return 'eventId는 문자열이어야 합니다';
  if (typeof x.kind !== 'string') return 'kind는 문자열이어야 합니다';
  // Numbers must survive a JSON round trip (NaN / ±Infinity become null), as the simulation also requires.
  if (typeof x.tick !== 'number' || !Number.isInteger(x.tick) || x.tick < 0) return 'tick은 0 이상의 정수여야 합니다';
  if (typeof x.order !== 'number' || !Number.isSafeInteger(x.order)) return 'order는 정수여야 합니다';
  if (!isObj(x.target)) return 'target은 객체여야 합니다';
  if (!isObj(x.params)) return 'params는 객체여야 합니다';
  // Whitelisted keys only (the simulation's lists): accepted inputs stay plain JSON.
  for (const k of Object.keys(x)) if (!(SCENARIO_INPUT_KEYS as readonly string[]).includes(k)) return `알 수 없는 입력 필드 ${k}`;
  for (const k of Object.keys(x.target)) if (!(SCENARIO_TARGET_KEYS as readonly string[]).includes(k)) return `알 수 없는 target 필드 ${k}`;
  const allowed = (SCENARIO_PARAM_KEYS as Record<string, readonly string[] | undefined>)[x.kind];
  if (allowed) for (const k of Object.keys(x.params)) if (!allowed.includes(k)) return `${x.kind}에 없는 params 필드 ${k}`;
  for (const k of ['segmentId', 'buildingId', 'eventId'] as const) if (x.target[k] !== undefined && typeof x.target[k] !== 'string') return `target.${k}는 문자열이어야 합니다`;
  const lane = x.target.lane;
  if (lane !== undefined && !(typeof lane === 'number' && Number.isInteger(lane) && lane >= 0)) return 'target.lane은 0 이상의 정수여야 합니다';
  const s = x.target.s;
  if (s !== undefined && !(typeof s === 'number' && Number.isFinite(s) && s >= 0)) return 'target.s는 0 이상의 유한한 수여야 합니다';
  for (const [k, v] of Object.entries(x.params)) if (typeof v !== 'number' || !Number.isFinite(v)) return `params.${k}는 유한한 수여야 합니다`;
  if (x.kind === 'policy.set') {
    if (x.params.reroute !== 0 && x.params.reroute !== 1) return 'reroute는 0 또는 1이어야 합니다';
    const share = x.params.informedShare;
    if (!(typeof share === 'number' && share >= 0 && share <= 1)) return 'informedShare는 0..1이어야 합니다';
  }
  return null;
}

const SPEEDS = new Set([0, 1, 2, 4]);
const optNumber = (x: unknown): boolean => x === undefined || (typeof x === 'number' && Number.isFinite(x));
const optBool = (x: unknown): boolean => x === undefined || typeof x === 'boolean';

/** Top-level shape check of anything posted to the worker. Null = usable; else why not (answered, never fatal). */
export function toWorkerError(m: unknown): string | null {
  if (!isObj(m)) return '메시지는 객체여야 합니다';
  switch (m.t) {
    case 'init':
      return isObj(m.doc) && optNumber(m.seed) && optBool(m.scenario) ? null : 'init: doc 객체, seed 수, scenario boolean';
    case 'initRecord':
      return isObj(m.record) && isObj(m.record.doc) && optBool(m.reroute) ? null : 'initRecord: record 객체(doc 포함), reroute boolean';
    case 'command':
      return isObj(m.cmd) && typeof m.cmd.type === 'string' ? null : 'command: cmd 객체';
    case 'setSpeed':
      return SPEEDS.has(m.speed as number) ? null : 'setSpeed: speed는 0, 1, 2, 4';
    case 'returnBuffers':
      return isObj(m.buffers) ? null : 'returnBuffers: buffers 객체';
    case 'runTo':
      return typeof m.tick === 'number' && Number.isInteger(m.tick) && optNumber(m.progressEvery) && optNumber(m.kpiEvery) ? null : 'runTo: tick 정수';
    case 'scenario':
    case 'policy':
      // Contents are checked by handleScenarioMessage (per-input / policy results).
      return null;
    case 'kpi':
    case 'cancel':
      return null;
    default:
      return `알 수 없는 메시지 ${typeof m.t === 'string' ? m.t : String(m.t)}`;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Worker side of the simulator-mode messages: inputs are validated and queued by the simulation (applied
 * at their tick boundary, never on message arrival), the policy is set, KPIs are returned. Never throws for a
 * malformed message (the worker's catch-all would stop the simulation): errors come back in the reply.
 */
export function handleScenarioMessage(sim: Simulation, msg: ScenarioToWorker): FromWorker {
  switch (msg.t) {
    case 'scenario': {
      const inputs: unknown = msg.inputs;
      if (!Array.isArray(inputs)) return { t: 'scenario', results: [], error: 'inputs는 배열이어야 합니다' };
      const results = inputs.map((x: unknown): { eventId: string } & ScenarioResult => {
        const eventId = isObj(x) && typeof x.eventId === 'string' ? x.eventId : '';
        const shape = inputShapeError(x);
        if (shape) return { eventId, ok: false, error: shape };
        try {
          return { eventId, ...sim.scenarioInput(x as unknown as ScenarioInput) };
        } catch (e) {
          return { eventId, ok: false, error: message(e) };
        }
      });
      return { t: 'scenario', results };
    }
    case 'policy':
      try {
        return { t: 'policy', result: { ok: true }, input: sim.setPolicy(msg.policy) };
      } catch (e) {
        return { t: 'policy', result: { ok: false, error: message(e) } };
      }
    case 'kpi':
      return { t: 'kpi', kpi: sim.kpi() };
  }
}
