// Replay of a ScenarioRecord (ADR 0010 §2): same record → same state at every tick.

import { cloneJson } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import type { World } from '../traffic/world.js';
import type { SimOptions } from '../types.js';
import { ensureScenario } from './apply.js';
import { ENGINE_VERSION, policyError, SCENARIO_VERSION, type ScenarioRecord } from './types.js';

export interface ReplayOptions {
  /** Run the record's warm-up before returning (default true). False: returned at tick 0, ready to step / runTo. */
  warmup?: boolean;
  /**
   * ON/OFF comparison of the smart response: replace `reroute` in the initial policy and in every recorded
   * `policy.set` input and drop any explicit `preempt` / `battery` (so they follow it), keeping everything else
   * (inputs, informed share, ticks) identical.
   */
  reroute?: boolean;
}

/**
 * A simulation set up from a record: the doc copy with the record's seed and tick rate, scenario activation
 * at exactly `activatedAtTick` (0 when omitted) with the record's initial policy (state, not an input), every
 * input queued at activation — runtime `policy.set` changes included — (validated; a rejected input throws),
 * then the warm-up run. Step it further to replay.
 */
export function simulationFromRecord(record: ScenarioRecord, opts: Omit<SimOptions, 'tickRate' | 'scenario'> = {}, how: ReplayOptions = {}): Simulation {
  if (record.engineVersion !== ENGINE_VERSION) throw new Error(`engineVersion ${record.engineVersion} ≠ ${ENGINE_VERSION}`);
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
  const doc = cloneJson(record.doc);
  doc.meta.seed = record.seed;
  const sim = new Simulation(doc, { ...opts, tickRate: record.tickRate, scenario: at === 0 });
  const reroute = how.reroute;
  const activate = (): void => {
    // The initial policy is state, not an input: `record.inputs` may already hold the `policy.set` inputs of
    // the recorded run (ids `policy@…`), and a second recorded one would collide with them.
    const policy = reroute === undefined ? record.policy : { reroute, informedShare: record.policy.informedShare };
    ensureScenario((sim as unknown as { w: World }).w).policy = { reroute: policy.reroute, informedShare: policy.informedShare, ...(policy.preempt !== undefined ? { preempt: policy.preempt } : {}), ...(policy.battery !== undefined ? { battery: policy.battery } : {}) };
    for (const input of record.inputs) {
      let copy = input;
      if (input.kind === 'policy.set' && reroute !== undefined) {
        const params: Record<string, number> = { ...input.params, reroute: reroute ? 1 : 0 };
        delete params.preempt;
        delete params.battery;
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
