// Replay of a ScenarioRecord (ADR 0010 §2): same record → same state at every tick.

import { cloneJson } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import type { World } from '../traffic/world.js';
import type { SimOptions } from '../types.js';
import { ensureScenario } from './apply.js';
import { RESERVED_FACTORS } from '../control/policy.js';
import { DETECTION_MODES, ENGINE_VERSIONS, policyError, SCENARIO_VERSION, type DetectionMode, type ResponsePolicy, type ScenarioRecord } from './types.js';

export interface ReplayOptions {
  /** Run the record's warm-up before returning (default true). False: returned at tick 0, ready to step / runTo. */
  warmup?: boolean;
  /**
   * ON/OFF comparison of the smart response: replace `reroute` in the initial policy and in every recorded
   * `policy.set` input and drop any explicit `preempt` / `battery` (so they follow it), keeping everything else
   * (inputs, informed share, ticks) identical.
   */
  reroute?: boolean;
  /**
   * Detection comparison (ADR 0013 §1, preset ②): replace `detection` in the initial policy and in every
   * recorded `policy.set` input, keeping everything else identical (seed, inputs, report draws, re-route…).
   */
  detection?: DetectionMode;
}

/** The two-run comparisons (A vs B, one condition at a time): ① smart response OFF vs ON, ② citizen reports vs sensors + reports. */
export const COMPARISON_PRESETS: Record<'smartResponse' | 'detection', readonly [ReplayOptions, ReplayOptions]> = {
  smartResponse: [{ reroute: false }, { reroute: true }],
  detection: [{ detection: 'reports' }, { detection: 'sensors' }],
};

/**
 * A simulation set up from a record: the doc copy with the record's seed and tick rate, scenario activation
 * at exactly `activatedAtTick` (0 when omitted) with the record's initial policy (state, not an input), every
 * input queued at activation — runtime `policy.set` changes included — (validated; a rejected input throws),
 * then the warm-up run. Step it further to replay.
 */
export function simulationFromRecord(record: ScenarioRecord, opts: Omit<SimOptions, 'tickRate' | 'scenario'> = {}, how: ReplayOptions = {}): Simulation {
  if (!ENGINE_VERSIONS.includes(record.engineVersion)) throw new Error(`engineVersion ${record.engineVersion} ∉ ${ENGINE_VERSIONS.join(', ')}`);
  // Engine 1 had no detection model: its records replay as legacy (ADR 0013 §4).
  const legacy = record.engineVersion === 1;
  if (how.detection !== undefined && !(DETECTION_MODES as readonly string[]).includes(how.detection)) throw new Error(`detection ${String(how.detection)}`);
  if (record.scenarioVersion !== SCENARIO_VERSION) throw new Error(`scenarioVersion ${record.scenarioVersion} ≠ ${SCENARIO_VERSION}`);
  const at = record.activatedAtTick ?? 0;
  if (!Number.isInteger(at) || at < 0) throw new Error(`activatedAtTick ${String(record.activatedAtTick)}`);
  // The same static rules as live input (scenarioInput below validates every input with the live function).
  if (!Number.isFinite(record.seed)) throw new Error(`seed ${String(record.seed)}`);
  if (!(Number.isFinite(record.tickRate) && record.tickRate > 0)) throw new Error(`tickRate ${String(record.tickRate)}`);
  if (!Number.isInteger(record.warmupTicks) || record.warmupTicks < 0) throw new Error(`warmupTicks ${String(record.warmupTicks)}`);
  const bad = policyError(record.policy);
  if (bad) throw new Error(bad);
  if (!Array.isArray(record.inputs)) throw new Error('inputs는 배열이어야 합니다');
  if (legacy && record.inputs.some((i) => i?.kind === 'policy.set' && i.params?.detection !== undefined)) throw new Error('engineVersion 1 기록에는 detection 입력이 없어야 합니다');
  // Reserved factor keys exist from engine 3 on (ADR 0015 §3).
  const reservedIn = (o: unknown): boolean => typeof o === 'object' && o !== null && RESERVED_FACTORS.some((k) => (o as Record<string, unknown>)[k] !== undefined);
  if (record.engineVersion < 3 && (reservedIn(record.policy) || record.inputs.some((i) => i?.kind === 'policy.set' && reservedIn(i.params))))
    throw new Error(`engineVersion ${record.engineVersion} 기록에는 예약 요인(${RESERVED_FACTORS.join(', ')}) 입력이 없어야 합니다`);
  const doc = cloneJson(record.doc);
  doc.meta.seed = record.seed;
  const sim = new Simulation(doc, { ...opts, tickRate: record.tickRate, scenario: at === 0 });
  const reroute = how.reroute;
  const detection = how.detection ?? (legacy ? undefined : record.policy.detection);
  const activate = (): void => {
    // The initial policy is state, not an input: `record.inputs` may already hold the `policy.set` inputs of
    // the recorded run (ids `policy@…`), and a second recorded one would collide with them.
    const policy: ResponsePolicy = reroute === undefined ? record.policy : { reroute, informedShare: record.policy.informedShare };
    ensureScenario((sim as unknown as { w: World }).w).policy = {
      reroute: policy.reroute,
      informedShare: policy.informedShare,
      ...(policy.preempt !== undefined ? { preempt: policy.preempt } : {}),
      ...(policy.battery !== undefined ? { battery: policy.battery } : {}),
      ...(detection !== undefined ? { detection } : {}),
    };
    for (const input of record.inputs) {
      let copy = input;
      if (input.kind === 'policy.set' && (reroute !== undefined || how.detection !== undefined)) {
        const params: Record<string, number> = { ...input.params };
        if (reroute !== undefined) {
          params.reroute = reroute ? 1 : 0;
          delete params.preempt;
          delete params.battery;
        }
        if (how.detection !== undefined) params.detection = DETECTION_MODES.indexOf(how.detection);
        copy = { ...input, params };
      }
      const r = sim.scenarioInput(copy);
      if (!r.ok) throw new Error(`${input.eventId}: ${r.error}`);
    }
  };
  if (at === 0) activate();
  else sim.atTickBoundary(at, activate);
  if (how.warmup ?? true) for (let t = 0; t < record.warmupTicks; t++) sim.step();
  return sim;
}
