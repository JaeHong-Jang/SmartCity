// Sol's P8a review (harness/runs/p8/sol-p8a-review.md): the per-tick stage budget across every submit (and
// the instant-known inputs through A0), agents that see only the ObservationView and declared queries,
// reserved factors kept out of records, `dispatch.lost` in the audit log, and snapshots that do not share
// objects with the audit log.

import { describe, expect, it } from 'vitest';
import { type CityDoc, type Command, type Sensor } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkIncidentInvariants, gridDoc, internals } from '../testkit.js';
import { simulationFromRecord } from '../scenario/record.js';
import { dispatchQueries, rerouteQueries, signalQueries } from '../scenario/controlAdapter.js';
import { policyError, type ResponsePolicy, type ScenarioInput, type ScenarioOutcome, type ScenarioRecord } from '../scenario/types.js';
import { proposeDispatch, proposeSignals } from './a4Emergency.js';
import { proposeReroute } from './a5Reroute.js';
import { STAGE_CAP } from './arbiter.js';
import { knownEvent, observationView } from './observation.js';
import { policyFactors, POLICY_TABLE, RESERVED_FACTORS } from './policy.js';
import type { Decision } from './types.js';

const place = (id: string, typeId: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
const cam = (id: string, segmentId: string, t: number, over: Partial<Sensor> = {}): Sensor => ({ id, kind: 'cctv', segmentId, t, side: 'right', heading: 0, fov: Math.PI / 2, range: 120, ...over });
const input = (eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}): ScenarioInput => ({ eventId, tick, order: 0, kind, target, params });

/** 4 × 4 grid: fire station, hospital, homes; traffic on v_2_1. */
function town(extra: Command[] = []): CityDoc {
  const doc = apply(gridDoc(4, 150, 'road-4', 4), [
    place('fs', 'svc-fire-station', -150, -150),
    place('h', 'svc-hospital', 150, -150),
    place('home', 'house', -150, 20),
    place('flat', 'house', 0, 170),
    place('apt', 'apartment', 150, 150),
    place('office', 'office-tower', 0, -150),
    ...extra,
  ]);
  doc.meta.trafficDensity = 4;
  return doc;
}

function sim(policy: ResponsePolicy, inputs: ScenarioInput[], opts: { demand?: boolean; doc?: CityDoc } = {}): Simulation {
  const s = new Simulation(opts.doc ?? town(), { scenario: true, citizens: false, demand: opts.demand ?? true });
  s.setPolicy(policy);
  for (const i of inputs) expect(s.scenarioInput(i), i.eventId).toEqual({ ok: true });
  return s;
}

function step(s: Simulation, n = 1): ScenarioOutcome[] {
  const out: ScenarioOutcome[] = [];
  for (let k = 0; k < n; k++) {
    s.step();
    const p = checkIncidentInvariants(s);
    if (p.length > 0) throw new Error(`tick ${internals(s).tick - 1}: ${p.join('; ')}`);
    out.push(...s.drainScenarioOutcomes());
  }
  return out;
}

const audit = (s: Simulation): Decision[] => internals(s).sc!.control.audit;

describe('#1 one observe / dispatch budget per tick across every submit', () => {
  it(`${STAGE_CAP + 4} medical calls in one tick: ${STAGE_CAP} known and dispatched, 4 deferred (logged) and known + dispatched the next tick`, () => {
    const n = STAGE_CAP + 4;
    const s = sim({ reroute: false, informedShare: 0.7 }, Array.from({ length: n }, (_, k) => input(`m${String(k).padStart(5, '0')}`, 3, 'medical.start', { buildingId: 'flat' })), { demand: false });
    const w = internals(s);
    step(s, 3);
    expect(w.sc!.incidents.length).toBe(0);
    step(s); // tick 3: the inputs apply
    const c = w.sc!.control;
    expect(c.known.size).toBe(STAGE_CAP);
    expect(c.deferred.map((d) => d.ev.eventId)).toEqual([`m0${STAGE_CAP}`, `m0${STAGE_CAP + 1}`, `m0${STAGE_CAP + 2}`, `m0${STAGE_CAP + 3}`]);
    expect(w.sc!.missions.length).toBe(STAGE_CAP);
    const rejected = audit(s).filter((d) => d.verdict === 'rejected' && d.action === 'observe');
    expect(rejected.map((d) => d.eventId)).toEqual(c.deferred.map((d) => d.ev.eventId));
    for (const d of rejected) expect(d.reason).toMatch(/처리 상한 초과 → 다음 tick 인지/);
    for (const id of c.deferred.map((d) => d.ev.eventId)) expect(w.sc!.incidents.find((i) => i.eventId === id)!.knownTick).toBe(-1);
    const out = step(s); // tick 4: the deferred four first
    expect(c.known.size).toBe(n);
    expect(c.deferred).toEqual([]);
    expect(w.sc!.missions.length).toBe(n);
    for (let k = STAGE_CAP; k < n; k++) expect(w.sc!.incidents.find((i) => i.eventId === `m0${k}`)!.knownTick).toBe(4);
    expect(out.some((o) => o.kind === 'dispatch.failed')).toBe(false);
    expect(s.kpi().dispatchFailed).toBe(0);
  }, 120_000);

  it('dispatch over budget: retried next tick, never counted as a failed dispatch', () => {
    const s = sim({ reroute: false, informedShare: 0.7 }, ['a', 'b', 'c'].map((id) => input(id, 3, 'medical.start', { buildingId: 'flat' })), { demand: false });
    const w = internals(s);
    w.sc!.control.stageCap.dispatch = 1;
    step(s, 4);
    expect(w.sc!.missions.map((m) => m.incident.eventId)).toEqual(['a']);
    const over = audit(s).filter((d) => d.action === 'dispatch' && d.verdict === 'rejected');
    expect(over.map((d) => d.eventId)).toEqual(['b', 'c']);
    for (const d of over) expect(d.reason).toMatch(/처리 상한 초과 → 다음 tick 재시도/);
    step(s);
    expect(w.sc!.missions.map((m) => m.incident.eventId)).toEqual(['a', 'b']);
    step(s);
    expect(w.sc!.missions.map((m) => m.incident.eventId)).toEqual(['a', 'b', 'c']);
    expect(s.kpi().dispatchFailed).toBe(0);
  });

  it('observe over budget (legacy accident): physical at once, unknown to the router and to A5 until the next tick', () => {
    const s = sim({ reroute: true, informedShare: 1 }, [input('clo', 200, 'closure.start', { segmentId: 'h_2_2' }), input('zacc', 200, 'accident.start', { segmentId: 'v_2_1', lane: 0 }, { durationTicks: 3000 })]);
    const w = internals(s);
    w.sc!.control.stageCap.observe = 1;
    step(s, 201);
    const acc = w.sc!.effects.find((e) => e.eventId === 'zacc')!;
    expect(acc.kind === 'accident' && acc.known).toBe(false);
    expect(w.sc!.obs).not.toBeNull(); // the obstacle is there
    expect(w.router.obsRear).toBeNull(); // the router does not know it
    expect(s.observation()!.events.map((e) => e.eventId)).toEqual(['clo']);
    step(s);
    expect(acc.kind === 'accident' && acc.known).toBe(true);
    expect(w.router.obsRear).not.toBeNull();
    expect(s.observation()!.events.map((e) => e.eventId)).toEqual(['clo', 'zacc']);
    const accLog = audit(s).filter((d) => d.eventId === 'zacc');
    expect(accLog.map((d) => [d.tick, d.verdict, d.action])).toEqual(expect.arrayContaining([[200, 'rejected', 'observe'], [201, 'accepted', 'observe']]));
    expect(accLog.find((d) => d.agent === 'A5')?.tick ?? 201).toBe(201);
  });

  it('a deferred observation whose event ended first is cancelled (logged), never known', () => {
    const s = sim({ reroute: false, informedShare: 1 }, [input('m1', 5, 'medical.start', { buildingId: 'flat' }), input('m2', 5, 'medical.start', { buildingId: 'home' }), input('m2-end', 5, 'medical.end', { eventId: 'm2' }, {}, )]);
    const w = internals(s);
    w.sc!.control.stageCap.observe = 1;
    step(s, 7);
    expect(w.sc!.control.known.has('m2')).toBe(false);
    expect(audit(s).filter((d) => d.eventId === 'm2').map((d) => d.verdict)).toEqual(['rejected', 'cancelled']);
  });

  it('report over budget: the candidate stays due and is reported the next tick', () => {
    const s = sim({ reroute: true, informedShare: 1, detection: 'reports' }, [input('acc', 100, 'accident.start', { segmentId: 'v_2_1', lane: 0 }, { durationTicks: 3000 })]);
    const w = internals(s);
    step(s, 101);
    const due = w.sc!.det.pending[0]!.cand[0]!.tick;
    step(s, due - w.tick);
    w.sc!.control.stageCap.observe = 0;
    step(s);
    expect(w.sc!.det.pending.length).toBe(1);
    expect(w.sc!.control.known.has('acc')).toBe(false);
    w.sc!.control.stageCap.observe = STAGE_CAP;
    const out = step(s);
    expect(out.find((o) => o.kind === 'detection.known')?.tick).toBe(due + 1);
    expect(w.sc!.control.known.get('acc')!.knownTick).toBe(due + 1);
    expect(audit(s).filter((d) => d.eventId === 'acc' && d.action === 'observe').map((d) => [d.tick, d.verdict])).toEqual([
      [due, 'rejected'],
      [due + 1, 'accepted'],
    ]);
  });

  it('signal over budget: no junction served, requests made again (logged); route over budget: the notice is dropped (logged)', () => {
    const s = sim({ reroute: true, informedShare: 1 }, [input('f', 50, 'fire.start', { buildingId: 'apt' }, { burnTicks: 40000 }), input('acc', 50, 'accident.start', { segmentId: 'v_2_1', lane: 0 }, { durationTicks: 3000 })]);
    const w = internals(s);
    w.sc!.control.stageCap.signal = 0;
    w.sc!.control.stageCap.route = 0;
    let served = 0;
    for (let t = 0; t < 900; t++) {
      step(s);
      for (const c of w.sc!.ctl.values()) if (c.vehicleId >= 0) served++;
    }
    expect(served).toBe(0);
    expect(audit(s).some((d) => d.action === 'signal' && d.verdict === 'rejected' && d.text.includes('처리 상한 초과'))).toBe(true);
    const route = audit(s).filter((d) => d.agent === 'A5');
    expect(route.length).toBeGreaterThan(0);
    for (const d of route) expect([d.verdict, d.reason]).toEqual(['rejected', expect.stringMatching(/처리 상한 초과 → 안내 취소/)]);
    expect(s.kpi().rerouted).toBe(0);
  }, 60_000);
});

describe('#2 agents see only the ObservationView and the declared queries', () => {
  it('tampering with state the observation does not expose changes no proposal; a declared input does', () => {
    const doc = town([{ type: 'sensor.place', sensor: cam('cam', 'v_2_1', 0.15) }]);
    const s = sim({ reroute: true, informedShare: 1, detection: 'sensors' }, [input('acc', 100, 'accident.start', { segmentId: 'v_2_1', lane: 0 }, { durationTicks: 3000 }), input('fire', 120, 'fire.start', { buildingId: 'apt' }, { burnTicks: 40000 }), input('later', 5000, 'closure.start', { segmentId: 'h_2_2' })], { doc });
    const w = internals(s);
    // Run until both are known and a truck is on its way with a signal request.
    let t = 0;
    while (t++ < 3000 && !(w.sc!.control.known.has('fire') && w.sc!.control.known.has('acc') && proposeSignals(observationView(w), signalQueries(w)).length > 0)) step(s);
    expect(t).toBeLessThan(3000);
    const accLanes = [w.graph.laneById.get((w.sc!.effects.find((e) => e.eventId === 'acc') as { laneId: string }).laneId)!];
    const proposals = (): string => {
      const fireEv = knownEvent(w, 'fire')!;
      const accEv = knownEvent(w, 'acc')!;
      return JSON.stringify([
        proposeDispatch(fireEv, dispatchQueries(w), w.tick),
        proposeSignals(observationView(w), signalQueries(w)),
        proposeReroute(accEv, accLanes, false, { tick: w.tick, factors: policyFactors(w.sc!.policy) }, rerouteQueries(w)),
      ]);
    };
    const before = proposals();
    // Sol's injection: the real incident's building, plus everything else the view leaves out.
    const inc = w.sc!.incidents.find((i) => i.eventId === 'fire')!;
    inc.buildingId = 'no-such-building';
    inc.startTick = -999;
    inc.burnTicks = 1;
    inc.state = 'waiting';
    const acc = w.sc!.effects.find((e) => e.eventId === 'acc')!;
    acc.startTick = -5;
    acc.endTick = 1;
    if (acc.kind === 'accident') acc.rear = 0;
    w.sc!.pending.length = 0; // future inputs
    w.sc!.det.pending.length = 0; // undetected events
    w.sc!.completed = 12345; // KPIs
    w.sc!.responses = 99;
    w.sc!.log.length = 0;
    w.sc!.damaged.push('office');
    expect(proposals()).toBe(before);
    // A declared input does change them: the factors in the view (pre-emption off → no signal request).
    w.sc!.policy = { ...w.sc!.policy, preempt: false };
    expect(proposeSignals(observationView(w), signalQueries(w))).toEqual([]);
  }, 60_000);
});

describe('#3 reserved factors: never recorded; engine 1 / 2 records refuse them in the policy and the inputs', () => {
  const doc = town();
  const rec = (engineVersion: number, policy: ResponsePolicy, inputs: ScenarioInput[]): ScenarioRecord => ({ engineVersion, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs, policy });
  for (const k of RESERVED_FACTORS) {
    it(`${k}: ${POLICY_TABLE.find((r) => r.factor === k)!.explicit}`, () => {
      const row = POLICY_TABLE.find((r) => r.factor === k)!;
      expect(row.omitted).toBe('OFF');
      expect(policyFactors({ reroute: true, informedShare: 0.7 })[k]).toBe(false);
      expect(policyError({ reroute: true, informedShare: 0.7, [k]: true })).toMatch(k);
      expect(policyError({ reroute: true, informedShare: 0.7, [k]: false })).toBeNull();
      const s = new Simulation(doc, { scenario: true, citizens: false });
      expect(s.scenarioInput(input('p1', 5, 'policy.set', {}, { reroute: 1, informedShare: 0.5, [k]: 1 })).ok).toBe(false);
      expect(s.scenarioInput(input('p0', 5, 'policy.set', {}, { reroute: 1, informedShare: 0.5, [k]: 0 }))).toEqual({ ok: true });
      expect(s.setPolicy({ reroute: true, informedShare: 0.5, [k]: false }).params).toEqual({ reroute: 1, informedShare: 0.5 });
      // Not recorded: neither the direct policy.set nor setPolicy.
      for (const i of s.scenarioInputs()) expect(Object.keys(i.params)).not.toContain(k);
      for (const v of [1, 2]) {
        expect(() => simulationFromRecord(rec(v, { reroute: true, informedShare: 0.7, [k]: false }, []), { citizens: false })).toThrow(/예약 요인/);
        expect(() => simulationFromRecord(rec(v, { reroute: true, informedShare: 0.7 }, [input('p', 0, 'policy.set', {}, { reroute: 1, informedShare: 0.7, [k]: 0 })]), { citizens: false })).toThrow(/예약 요인/);
      }
      expect(() => simulationFromRecord(rec(3, { reroute: true, informedShare: 0.7, [k]: false }, [input('p', 0, 'policy.set', {}, { reroute: 1, informedShare: 0.7, [k]: 0 })]), { citizens: false })).not.toThrow();
      expect(() => simulationFromRecord(rec(2, { reroute: true, informedShare: 0.7 }, s.scenarioInputs()), { citizens: false })).not.toThrow();
    });
  }
});

describe('#4 dispatch.lost in the audit log, once', () => {
  it('a truck lost on its way: one cancellation (차량 소멸, 즉시 다시 출동), then the new dispatch', () => {
    const s = sim({ reroute: false, informedShare: 0.7 }, [input('f', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000 })], { demand: false });
    const w = internals(s);
    let cut = false;
    const out: ScenarioOutcome[] = [];
    for (let t = 0; t < 4000; t++) {
      out.push(...step(s));
      const v = w.sc!.missions[0]?.v;
      if (!cut && v && v.edge < w.net.nLanes && v.s > 5) {
        expect(s.applyCommand({ type: 'segment.remove', id: w.graph.lanes[v.edge]!.segmentId }).ok).toBe(true);
        cut = true;
      }
    }
    expect(out.filter((o) => o.eventId === 'f').map((o) => o.kind).slice(0, 4)).toEqual(['fire.start', 'dispatch.start', 'dispatch.lost', 'dispatch.start']);
    const log = audit(s).filter((d) => d.eventId === 'f' && d.action === 'dispatch');
    expect(log.map((d) => [d.verdict, d.text.split(':')[0]])).toEqual([
      ['accepted', '소방차 출동'],
      ['cancelled', '출동 차량 소멸'],
      ['accepted', '소방차 출동'],
    ]);
    expect(log[1]!.reason).toMatch(/차량 소멸 · 즉시 다시 출동/);
  });

  it('an ambulance lost during the transport: one cancellation (이송 차량 소멸, 환자 이송 실패로 종료)', () => {
    const doc = apply(gridDoc(4, 150, 'road-4', 4), [place('h', 'svc-hospital', 150, -150), place('flat', 'house', 0, 170)]);
    const s = sim({ reroute: false, informedShare: 0.7 }, [input('m', 5, 'medical.start', { buildingId: 'flat' }, { treatTicks: 10 })], { demand: false, doc });
    const w = internals(s);
    let cut = false;
    for (let t = 0; t < 4000; t++) {
      step(s);
      const v = w.sc!.missions[0]?.v;
      if (!cut && w.sc!.missions[0]?.stage === 'transport' && v && v.edge < w.net.nLanes && v.s > 5) {
        expect(s.applyCommand({ type: 'segment.remove', id: w.graph.lanes[v.edge]!.segmentId }).ok).toBe(true);
        cut = true;
      }
    }
    expect(cut).toBe(true);
    const lost = audit(s).filter((d) => d.eventId === 'm' && d.verdict === 'cancelled');
    expect(lost.map((d) => d.text.split(':')[0])).toEqual(['이송 차량 소멸']);
    expect(lost[0]!.reason).toMatch(/차량 소멸 · 환자 이송 실패로 종료/);
    expect(w.sc!.incidents).toEqual([]);
  });
});

describe('#5 snapshots do not share objects with the audit log', () => {
  it('mutating a snapshot changes neither the next snapshot nor the audit log', () => {
    const s = sim({ reroute: true, informedShare: 1 }, [input('m', 5, 'medical.start', { buildingId: 'flat' }), input('clo', 5, 'closure.start', { segmentId: 'h_2_2' })]);
    step(s, 10);
    const a = s.snapshot().control!;
    const ref = JSON.stringify(a);
    expect(a.decisions.length).toBeGreaterThan(0);
    for (const d of a.decisions) {
      d.text = 'CORRUPTED';
      if (d.target) d.target.x = 1e9;
    }
    a.decisions.length = 0;
    a.agents[0]!.state = 'off';
    expect(JSON.stringify(s.snapshot().control)).toBe(ref);
    expect(audit(s).some((d) => d.text === 'CORRUPTED' || d.target?.x === 1e9)).toBe(false);
  });
});
