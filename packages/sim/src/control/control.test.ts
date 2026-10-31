// Central control frame (ADR 0015 §2, §3, §6): the observation boundary, arbitration (deterministic, order
// independent, capped, priority classes), signals only through the safety executor, policy normalization,
// the bounded audit log and live = replay of the decisions.

import { describe, expect, it } from 'vitest';
import { cloneJson, Rng, type CityDoc, type Command, type Sensor } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, crossDoc, gridDoc, internals, SignalWatch } from '../testkit.js';
import { simulationFromRecord } from '../scenario/record.js';
import { ENGINE_VERSION, policyError, type ResponsePolicy, type ScenarioInput, type ScenarioRecord } from '../scenario/types.js';
import { dispatchDecision } from '../scenario/controlAdapter.js';
import { arbitrate, REJECT_CAP, REJECT_CONFLICT, REJECT_EXPIRED, REJECT_UNOBSERVED } from './arbiter.js';
import { AUDIT_MAX, record, RECENT_DECISIONS } from './control.js';
import { AGENTS } from './catalog.js';
import { POLICY_TABLE, policyFactors, RESERVED_FACTORS } from './policy.js';
import type { Decision, PolicyFactors, PriorityClass, Proposal } from './types.js';

const place = (id: string, typeId: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
const cam = (id: string, segmentId: string, t: number, over: Partial<Sensor> = {}): Sensor => ({ id, kind: 'cctv', segmentId, t, side: 'right', heading: 0, fov: Math.PI / 2, range: 120, ...over });
const input = (eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}): ScenarioInput => ({ eventId, tick, order: 0, kind, target, params });

/** 4 × 4 grid with a fire station, a hospital and homes; a CCTV on v_2_1 (a busy road) and one looking at `home`. */
function town(sensors = true): CityDoc {
  const doc = apply(gridDoc(4, 150, 'road-4', 4), [
    place('fs', 'svc-fire-station', -150, -150),
    place('h', 'svc-hospital', 150, -150),
    place('home', 'house', -150, 20),
    place('flat', 'house', 0, 170),
    place('apt', 'apartment', 150, 150),
    place('office', 'office-tower', 0, -150),
    ...(sensors ? [cam('cam', 'v_2_1', 0.15), cam('house-cam', 'v_1_1', 0.5, { heading: Math.PI / 2, range: 150 })].map((s): Command => ({ type: 'sensor.place', sensor: s })) : []),
  ]);
  doc.meta.trafficDensity = 4;
  return doc;
}
const SCRIPT: ScenarioInput[] = [
  input('acc', 100, 'accident.start', { segmentId: 'v_2_1', lane: 0 }, { durationTicks: 3000 }),
  input('acc2', 100, 'accident.start', { segmentId: 'v_2_1', lane: 1 }, { durationTicks: 3000 }),
  input('fire', 300, 'fire.start', { buildingId: 'home' }, { burnTicks: 40000 }),
  input('later', 2500, 'closure.start', { segmentId: 'h_2_2' }),
];

function townSim(policy: ResponsePolicy, sensors = true): Simulation {
  const sim = new Simulation(town(sensors), { scenario: true, citizens: false });
  sim.setPolicy(policy);
  for (const i of SCRIPT) expect(sim.scenarioInput(i), i.eventId).toEqual({ ok: true });
  return sim;
}

const decisions = (sim: Simulation): Decision[] => internals(sim).sc!.control.audit;

describe('observation boundary (ADR 0015 §2)', () => {
  for (const detection of ['reports', 'sensors'] as const) {
    it(`${detection}: an event the city does not know of is in no ObservationView and in no decision until it is reported`, () => {
      const sim = townSim({ reroute: true, informedShare: 1, detection });
      const w = internals(sim);
      const knownAt = new Map<string, number>();
      for (let t = 0; t < 2400; t++) {
        sim.step();
        const view = sim.observation()!;
        const pending = new Set(w.sc!.det.pending.map((p) => p.eventId));
        // Never both: an undetected event is not observed, and the future closure is not observed either.
        for (const e of view.events) expect(pending.has(e.eventId), `tick ${t}: ${e.eventId}`).toBe(false);
        expect(view.events.some((e) => e.eventId === 'later')).toBe(false);
        for (const id of pending) expect(w.sc!.control.known.has(id), `tick ${t}: ${id} known while pending`).toBe(false);
        // The view carries no evaluation state.
        expect(Object.keys(view).sort()).toEqual(['events', 'factors', 'fleet', 'stoppedPerLane', 'tick', 'tickRate']);
        for (const e of view.events) if (!knownAt.has(e.eventId)) knownAt.set(e.eventId, w.tick);
      }
      const log = decisions(sim);
      // Every decision about an event comes at or after the tick the city learned of it, and after its observe entry.
      for (const d of log) {
        if (d.eventId === null || d.action === 'observe') continue;
        const obs = log.find((x) => x.action === 'observe' && x.eventId === d.eventId && x.verdict === 'accepted');
        expect(obs, `${d.agent} ${d.text}`).toBeDefined();
        expect(obs!.seq).toBeLessThan(d.seq);
      }
      // The two tracked events were reported (A1 for a sensor, A0 for a citizen report) and then acted on.
      const seen = (id: string) => log.find((x) => x.eventId === id && x.action === 'observe')!;
      expect(seen('acc').agent).toBe(detection === 'sensors' ? 'A1' : 'A0');
      expect(log.some((d) => (d.eventId === 'acc' || d.eventId === 'acc2') && d.agent === 'A5' && d.action === 'reroute')).toBe(true);
      expect(log.some((d) => d.eventId === 'fire' && d.agent === 'A4' && d.action === 'dispatch' && d.verdict === 'accepted')).toBe(true);
      expect(seen('fire').tick).toBeGreaterThan(300);
    }, 60_000);
  }

  it('legacy: known when the input applies; queued (future) inputs are never observed', () => {
    const sim = townSim({ reroute: true, informedShare: 1 });
    for (let t = 0; t < 320; t++) sim.step();
    const ids = sim.observation()!.events.map((e) => e.eventId);
    expect(ids).toEqual(['acc', 'acc2', 'fire']);
    expect(sim.observation()!.events.find((e) => e.eventId === 'acc')).toMatchObject({ kind: 'accident', source: 'input', knownTick: 100, segmentId: 'v_2_1', lane: 0 });
  });

  it('A0 rejects any proposal about an unknown event; A4 does nothing for an unobserved incident', () => {
    const sim = townSim({ reroute: true, informedShare: 1, detection: 'reports' });
    for (let t = 0; t < 305; t++) sim.step();
    const w = internals(sim);
    const inc = w.sc!.incidents.find((i) => i.eventId === 'fire')!;
    expect(w.sc!.control.known.has('fire')).toBe(false);
    const missions = w.sc!.missions.length;
    expect(dispatchDecision(w, inc)).toMatchObject({ ok: false, boundary: true });
    expect(w.sc!.missions.length).toBe(missions);
    const p = proposal({ eventId: 'fire', expiresTick: w.tick });
    expect(arbitrate([p], w.tick, (id) => w.sc!.control.known.has(id)).rejected).toEqual([{ proposal: p, reason: REJECT_UNOBSERVED }]);
  });
});

let n = 0;
function proposal(over: Partial<Proposal> = {}): Proposal {
  return { id: `p${n++}`, agent: 'A4', stage: 'signal', priority: 'life', key: 'node:a', rank: [], issuedTick: 0, expiresTick: 10, eventId: null, action: { type: 'signal', nodeId: 'a', phase: 0, vehicleId: 1, eta: 1 }, reason: '', ...over };
}

describe('arbitration (ADR 0015 §2)', () => {
  it('deterministic and independent of the queue order: 50 shuffles of 60 proposals give one result', () => {
    const rng = new Rng(5);
    const prios: PriorityClass[] = ['life', 'spread', 'efficiency'];
    const queue = Array.from({ length: 60 }, (_, i) =>
      proposal({ id: `q${String(i).padStart(2, '0')}`, priority: prios[rng.int(3)]!, key: `k${rng.int(8)}`, rank: [rng.int(3), rng.int(3)], expiresTick: rng.int(10) === 0 ? 2 : 10, eventId: rng.int(6) === 0 ? 'ghost' : null }),
    );
    const sig = (q: Proposal[]) => {
      const r = arbitrate(q, 5, (id) => id !== 'ghost', 20);
      return JSON.stringify([r.accepted.map((p) => p.id), r.rejected.map((x) => [x.proposal.id, x.reason])]);
    };
    const ref = sig(queue);
    for (let k = 0; k < 50; k++) {
      const q = [...queue];
      for (let i = q.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [q[i], q[j]] = [q[j]!, q[i]!];
      }
      expect(sig(q)).toBe(ref);
    }
    const r = arbitrate(queue, 5, (id) => id !== 'ghost', 20);
    // At most one per key, never more than the cap considered, every proposal answered exactly once.
    expect(new Set(r.accepted.map((p) => p.key)).size).toBe(r.accepted.length);
    expect(r.accepted.length + r.rejected.filter((x) => x.reason === REJECT_CONFLICT).length).toBeLessThanOrEqual(20);
    expect(r.accepted.length + r.rejected.length).toBe(60);
    expect(r.rejected.some((x) => x.reason === REJECT_CAP)).toBe(true);
    expect(r.rejected.some((x) => x.reason === REJECT_EXPIRED)).toBe(true);
  });

  it('life > spread > efficiency on one key; then rank, agent, id', () => {
    const eff = proposal({ priority: 'efficiency', agent: 'A0' });
    const spread = proposal({ priority: 'spread' });
    const life = proposal({ priority: 'life', rank: [9] });
    expect(arbitrate([eff, spread, life], 0, () => true).accepted).toEqual([life]);
    const a = proposal({ rank: [1, 5] });
    const b = proposal({ rank: [1, 4, 9] });
    expect(arbitrate([a, b], 0, () => true).accepted).toEqual([b]);
    const c = proposal({ agent: 'A5', rank: [] });
    const d = proposal({ agent: 'A4', rank: [] });
    expect(arbitrate([c, d], 0, () => true).accepted).toEqual([d]);
  });
});

describe('signals only through the single safety executor (ADR 0015 §2)', () => {
  it('every junction a controller serves for a vehicle had that request accepted by A0 first; safety checks clean; OFF = no signal decision', () => {
    const doc = apply(crossDoc(260), [place('fs', 'svc-fire-station', -40, -200), place('hosp', 'svc-hospital', -200, 45), place('home', 'house', -20, 180)]);
    doc.meta.trafficDensity = 1.2;
    for (const preempt of [true, false]) {
      const sim = new Simulation(cloneJson(doc), { scenario: true, citizens: false });
      sim.setPolicy({ reroute: false, informedShare: 0.7, preempt });
      expect(sim.scenarioInput(input('f', 400, 'fire.start', { buildingId: 'home' })).ok).toBe(true);
      expect(sim.scenarioInput(input('m', 405, 'medical.start', { buildingId: 'home' })).ok).toBe(true);
      const watch = new SignalWatch(sim);
      const w = internals(sim);
      let served = 0;
      for (let t = 0; t < 2600; t++) {
        sim.step();
        watch.observe();
        for (const c of w.sc!.ctl.values()) {
          if (c.vehicleId < 0) continue;
          served++;
          const ok = decisions(sim).some((d) => d.agent === 'A4' && d.action === 'signal' && d.verdict === 'accepted' && d.target?.id === c.nodeId && d.text.endsWith(`차량 ${c.vehicleId}`));
          expect(ok, `tick ${w.tick}: ${c.nodeId} serves ${c.vehicleId} without an accepted request`).toBe(true);
        }
      }
      expect(watch.problems).toEqual([]);
      const signalDecisions = decisions(sim).filter((d) => d.action === 'signal');
      if (preempt) {
        expect(served).toBeGreaterThan(0);
        expect(signalDecisions.length).toBeGreaterThan(0);
        // Logged on change only: far fewer entries than served ticks.
        expect(signalDecisions.length).toBeLessThan(served / 10);
      } else {
        expect(served).toBe(0);
        expect(signalDecisions).toEqual([]);
      }
    }
  }, 60_000);
});

describe('policy normalization (ADR 0015 §3)', () => {
  const F = (p: ResponsePolicy): Partial<PolicyFactors> => {
    const f = policyFactors(p);
    return { preempt: f.preempt, reroute: f.reroute, battery: f.battery, detection: f.detection };
  };
  it('omitted = existing behaviour; explicit wins; reserved factors fixed OFF', () => {
    expect(F({ reroute: true, informedShare: 0.7 })).toEqual({ preempt: true, reroute: true, battery: true, detection: 'legacy' });
    expect(F({ reroute: false, informedShare: 0.7 })).toEqual({ preempt: false, reroute: false, battery: false, detection: 'legacy' });
    expect(F({ reroute: false, informedShare: 0.7, preempt: true })).toEqual({ preempt: true, reroute: false, battery: false, detection: 'legacy' });
    expect(F({ reroute: true, informedShare: 0.7, battery: false, detection: 'sensors' })).toEqual({ preempt: true, reroute: true, battery: false, detection: 'sensors' });
    const f = policyFactors({ reroute: true, informedShare: 0.7 });
    for (const k of RESERVED_FACTORS) expect(f[k]).toBe(false);
    // One table row per factor.
    expect(POLICY_TABLE.map((r) => r.factor).sort()).toEqual(Object.keys(f).sort());
  });

  it('reserved: false / 0 accepted and ignored (not recorded, same run), true / 1 rejected everywhere', () => {
    for (const k of RESERVED_FACTORS) {
      expect(policyError({ reroute: true, informedShare: 0.5, [k]: true })).toMatch(k);
      expect(policyError({ reroute: true, informedShare: 0.5, [k]: false })).toBeNull();
    }
    const run = (extra: Record<string, number>, viaPolicy: boolean): string => {
      const sim = townSim({ reroute: true, informedShare: 1 }, false);
      if (viaPolicy) expect(sim.setPolicy({ reroute: true, informedShare: 1, adaptive: false, drone: false }).params).toEqual({ reroute: 1, informedShare: 1 });
      const r = sim.scenarioInput(input('pol', 50, 'policy.set', {}, { reroute: 1, informedShare: 1, ...extra }));
      expect(r).toEqual({ ok: true });
      for (let t = 0; t < 600; t++) sim.step();
      const s = sim.snapshot();
      return Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.scenario!.kpi);
    };
    expect(run({ adaptive: 0, drone: 0, precheck: 0, onboard: 0 }, true)).toBe(run({}, false));
    const sim = townSim({ reroute: true, informedShare: 1 }, false);
    for (const k of RESERVED_FACTORS) expect(sim.scenarioInput(input(`x${k}`, 60, 'policy.set', {}, { reroute: 1, informedShare: 1, [k]: 1 })).ok).toBe(false);
  });

  it('records: engine 3 may carry reserved 0s; engine 1 and 2 records may not; both replay', () => {
    const doc = town(false);
    const base = (engineVersion: number, inputs: ScenarioInput[]): ScenarioRecord => ({ engineVersion, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs, policy: { reroute: true, informedShare: 0.7 } });
    const withReserved = [input('policy@0#0', 0, 'policy.set', {}, { reroute: 1, informedShare: 0.7, adaptive: 0 })];
    expect(ENGINE_VERSION).toBe(3);
    expect(() => simulationFromRecord(base(3, withReserved), { citizens: false })).not.toThrow();
    for (const v of [1, 2]) expect(() => simulationFromRecord(base(v, withReserved), { citizens: false })).toThrow(/예약 요인/);
    expect(() => simulationFromRecord(base(2, SCRIPT), { citizens: false })).not.toThrow();
  });
});

describe('audit log and control view (ADR 0015 §6)', () => {
  it('bounded: past AUDIT_MAX the oldest entries drop (counted); the view lists the last RECENT_DECISIONS', () => {
    const sim = townSim({ reroute: true, informedShare: 1 });
    sim.step();
    const w = internals(sim);
    const before = w.sc!.control.seq;
    for (let k = 0; k < AUDIT_MAX + 500; k++) record(w, { agent: 'A0', verdict: 'accepted', action: 'observe', text: `t${k}`, reason: '', eventId: null, target: null });
    expect(w.sc!.control.audit.length).toBe(AUDIT_MAX);
    expect(w.sc!.control.seq).toBe(before + AUDIT_MAX + 500);
    expect(w.sc!.control.dropped).toBe(before + 500);
    const view = sim.snapshot().control!;
    expect(view.decisions.length).toBe(RECENT_DECISIONS);
    expect(view.decisions.at(-1)!.text).toBe(`t${AUDIT_MAX + 499}`);
    expect(view.total).toBe(w.sc!.control.seq);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it('agents: every catalog agent listed; OFF follows the factors; reserved agents always OFF', () => {
    const states = (p: ResponsePolicy) => {
      const sim = new Simulation(town(), { scenario: true, citizens: false });
      sim.setPolicy(p);
      sim.step();
      return Object.fromEntries(sim.snapshot().control!.agents.map((a) => [a.id, a.state]));
    };
    const on = states({ reroute: true, informedShare: 1, detection: 'sensors' });
    const off = states({ reroute: false, informedShare: 1 });
    expect(Object.keys(on)).toEqual(AGENTS.map((a) => a.id));
    expect(on).toMatchObject({ A1: 'idle', A4: 'idle', A5: 'idle', A2: 'off', A3: 'off', A6: 'off', A7: 'off', A8: 'off' });
    expect(off).toMatchObject({ A1: 'off', A4: 'idle', A5: 'off' });
    expect(new Simulation(town()).snapshot().control).toBeUndefined();
  });

  it('live = replay of its record: the same decisions (sensors, accident, fire, closure)', () => {
    const policy: ResponsePolicy = { reroute: true, informedShare: 0.8, detection: 'sensors' };
    const live = townSim(policy);
    for (let t = 0; t < 2800; t++) live.step();
    const doc = town();
    const rec: ScenarioRecord = { engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: live.scenarioInputs(), policy: { reroute: false, informedShare: 0.7 } };
    const replay = simulationFromRecord(rec, { citizens: false });
    for (let t = 0; t < 2800; t++) replay.step();
    const strip = (d: Decision[]) => d.map((x) => [x.tick, x.agent, x.verdict, x.action, x.text, x.reason, x.eventId]);
    expect(strip(decisions(replay))).toEqual(strip(decisions(live)));
    expect(decisions(live).length).toBeGreaterThan(5);
  }, 60_000);
});
