// Power coverage and blackouts (ADR 0010 §3, §4, §8): DARK signals run as all-way stops, batteries, safe
// restore, DARK over PREEMPT, building state, KPIs, validation, replay and the per-tick safety checks.

import { describe, expect, it } from 'vitest';
import { cloneJson, Rng, type CityDoc, type Command } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkIncidentInvariants, checkInvariants, checkZoneInvariants, crossDoc, internals, randomPlanEdit, SignalWatch } from '../testkit.js';
import { PedSignal } from '../types.js';
import { BATTERY_TICKS, COVERAGE_RADIUS } from './blackout.js';
import { simulationFromRecord } from './record.js';
import { ENGINE_VERSION, type ScenarioInput, type ScenarioOutcome } from './types.js';

declare const console: { log(...args: unknown[]): void };

const place = (id: string, typeId: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
const input = (eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}): ScenarioInput => ({
  eventId,
  tick,
  order: 0,
  kind,
  target,
  params,
});
const rngState = (r: unknown): number => (r as { s: number }).s;

/** Four-arm junction `c` with a substation next to it, a mid-block signal crosswalk on N, homes and a fire station. */
function powerCity(): CityDoc {
  const doc = apply(crossDoc(260), [
    place('sub', 'svc-substation', 60, 60),
    place('home', 'house', -20, 180),
    place('fs', 'svc-fire-station', -40, -200),
    { type: 'feature.upsert', feature: { id: 'cw', segmentId: 'N', kind: 'crosswalk', t: 0.5, signal: true } },
  ]);
  doc.meta.trafficDensity = 1;
  return doc;
}

function run(sim: Simulation, ticks: number, each?: (t: number) => void): ScenarioOutcome[] {
  const out: ScenarioOutcome[] = [];
  for (let t = 0; t < ticks; t++) {
    sim.step();
    out.push(...sim.drainScenarioOutcomes());
    each?.(t);
  }
  return out;
}

describe('power coverage', () => {
  it('each junction, mid-block signal and building → the closest substation within 400 m (ties: id); power plants listed; read-only', () => {
    const doc = apply(crossDoc(600), [
      place('subB', 'svc-substation', 100, 100),
      place('subA', 'svc-substation', -100, -100),
      place('far', 'house', 30, 560),
      place('pp', 'svc-power-plant', 400, -300),
    ]);
    const sim = new Simulation(doc, { citizens: false, demand: false });
    const cov = sim.powerCoverage();
    expect(cov.substations).toEqual(['subA', 'subB']);
    expect(cov.powerPlants).toEqual(['pp']);
    // The junction at the origin is equally far from both: the smaller id.
    expect(cov.junctions).toEqual({ c: 'subA' });
    expect(cov.buildings['far']).toBeUndefined();
    expect(cov.buildings['subB']).toBe('subB');
    expect(Math.hypot(100, 100)).toBeLessThan(COVERAGE_RADIUS);
    expect(internals(sim).sc).toBeNull();
  });
});

describe('blackout inputs: validation', () => {
  it('a substation or a disc (x, z, radius), not both; whitelisted params; ends that find nothing are no-ops; strict battery policy', () => {
    const sim = new Simulation(powerCity(), { scenario: true, citizens: false });
    const bad: [ScenarioInput, RegExp][] = [
      [input('a', 5, 'blackout.start', { buildingId: 'home' }), /변전소/],
      [input('a', 5, 'blackout.start', { buildingId: 'nope' }), /변전소/],
      [input('a', 5, 'blackout.start', {}, { x: 0, z: 0 }), /radius/],
      [input('a', 5, 'blackout.start', { buildingId: 'sub' }, { x: 0, z: 0, radius: 50 }), /하나만/],
      [input('a', 5, 'blackout.start', {}, { x: 0, z: 0, radius: 0 }), /radius/],
      [input('a', 5, 'blackout.start', {}, { x: 0, z: 0, radius: 50, burnTicks: 3 }), /params/],
      [input('a', 5, 'blackout.start', { buildingId: 'sub' }, { durationTicks: 0 }), /durationTicks/],
      [input('a', 5, 'blackout.end', {}), /없는 건물/],
    ];
    for (const [i, re] of bad) {
      const r = sim.scenarioInput(i);
      expect(r.ok, JSON.stringify(i)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(re);
    }
    expect(sim.scenarioInput(input('e', 5, 'blackout.end', { eventId: 'ghost' })).ok).toBe(true);
    expect(sim.scenarioInput(input('d', 6, 'blackout.start', {}, { x: 0, z: 0, radius: 50, durationTicks: 10 })).ok).toBe(true);
    const out = run(sim, 30);
    expect(out.filter((o) => o.eventId === 'e' || o.eventId === 'd').map((o) => `${o.eventId}:${o.kind}:${o.applied}:${o.reason ?? ''}`)).toEqual([
      'e:blackout.end:false:event ghost not active (unknown, not started yet or already ended)',
      'd:blackout.start:true:',
      'd:signal.dark:true:c',
      'd:blackout.end:true:duration',
      'd:signal.restored:true:c',
    ]);
    expect(() => sim.setPolicy({ reroute: true, informedShare: 0.5, battery: 1 as unknown as boolean })).toThrow(/battery/);
    expect(sim.setPolicy({ reroute: true, informedShare: 0.5, battery: false }).params).toEqual({ reroute: 1, informedShare: 0.5, battery: 0 });
  });
});

describe('blackout: dark signals, batteries, restore', () => {
  const blackoutRun = (battery: boolean, ticks = 4600) => {
    const sim = new Simulation(powerCity(), { scenario: true });
    const w = internals(sim);
    sim.setPolicy({ reroute: false, informedShare: 0.7, battery });
    expect(sim.scenarioInput(input('b', 400, 'blackout.start', { buildingId: 'sub' }, { durationTicks: 3000 })).ok).toBe(true);
    const watch = new SignalWatch(sim);
    const problems: string[] = [];
    const rng: number[] = [];
    let enteredWithoutStop = 0;
    let darkEntries = 0;
    const onConn = new Set<number>();
    // Per vehicle on its approach lane: consecutive ticks stopped (< 0.15 m/s) within 1.5 m of the line, and the most seen.
    const stopped = new Map<number, { edge: number; run: number; best: number }>();
    const out = run(sim, ticks, (t) => {
      watch.observe();
      rng.push(rngState(w.rng));
      if (t % 3 === 0) problems.push(...checkInvariants(sim), ...checkZoneInvariants(sim));
      // At a dark junction every vehicle enters only after a complete stop.
      for (const v of w.vehicles) {
        if (v.edge < w.net.nLanes) {
          let st = stopped.get(v.id);
          if (!st || st.edge !== v.edge) stopped.set(v.id, (st = { edge: v.edge, run: 0, best: 0 }));
          st.run = w.net.len[v.edge]! - v.s <= 1.5 && v.v < 0.15 ? st.run + 1 : 0;
          st.best = Math.max(st.best, st.run);
          onConn.delete(v.id);
          continue;
        }
        if (onConn.has(v.id)) continue;
        onConn.add(v.id);
        if (w.dark?.junctions.has('c') && w.net.connNode[v.edge - w.net.nLanes] === w.net.nodeIds.indexOf('c') && t > 500) {
          darkEntries++;
          // A full stop = 10 ticks; the 10th is the grant step itself, so at least 9 are seen before it moves.
          if ((stopped.get(v.id)?.best ?? 0) < 9) enteredWithoutStop++;
        }
      }
    });
    return { sim, w, out, watch, problems, rng, darkEntries, enteredWithoutStop };
  };

  it('no battery: dark at once — all-way stop (full stop before entry), crosswalks unsignalized after a full clearance; restored through all red, then the plan from its first phase', () => {
    const r = blackoutRun(false);
    const kinds = r.out.filter((o) => o.eventId === 'b').map((o) => `${o.tick}:${o.kind}:${o.reason ?? ''}`);
    expect(kinds).toEqual(['400:blackout.start:', '400:signal.dark:cw', '400:signal.dark:c', '3400:blackout.end:duration', '3400:signal.restored:cw', '3400:signal.restored:c']);
    expect([...r.watch.problems, ...r.problems].slice(0, 10)).toEqual([]);
    expect(r.darkEntries).toBeGreaterThan(10);
    expect(r.enteredWithoutStop).toBe(0);
    const k = r.sim.kpi();
    expect(k.darkJunctionMinutes).toBeCloseTo((3000 / 20) * (10 / 60), 6);
    expect(k.batteryJunctionMinutes).toBe(0);
    expect(k.darkQueueVehicleMinutes).toBeGreaterThan(0);
    expect(k).toMatchObject({ darkSignals: 0, unpoweredSignals: 0, unpoweredBuildings: 0 });
    expect(r.w.dark).toBeNull();
    expect(r.w.signalClearing.size).toBe(0);
  }, 120_000);

  it('battery: the signals stay on for 15 game min (battery.depleted), then dark; KPIs; the demand RNG is the same as without battery', () => {
    const off = blackoutRun(false);
    const on = blackoutRun(true);
    const kinds = on.out.filter((o) => o.eventId === 'b').map((o) => `${o.tick}:${o.kind}:${o.reason ?? ''}`);
    expect(kinds).toEqual([
      '400:blackout.start:',
      `${400 + BATTERY_TICKS - 1}:battery.depleted:cw`,
      `${400 + BATTERY_TICKS - 1}:battery.depleted:c`,
      `${400 + BATTERY_TICKS}:signal.dark:cw`,
      `${400 + BATTERY_TICKS}:signal.dark:c`,
      '3400:blackout.end:duration',
      '3400:signal.restored:cw',
      '3400:signal.restored:c',
    ]);
    expect([...on.watch.problems, ...on.problems].slice(0, 10)).toEqual([]);
    expect(on.sim.kpi().batteryJunctionMinutes).toBeCloseTo((BATTERY_TICKS / 20) * (10 / 60), 6);
    expect(on.sim.kpi().darkJunctionMinutes).toBeCloseTo(((3000 - BATTERY_TICKS) / 20) * (10 / 60), 6);
    expect(on.rng).toEqual(off.rng);
    // Queueing at the dark junction: less with the battery (shorter dark time).
    console.log(`blackout 150 s (25 game min): dark-junction queue OFF ${off.sim.kpi().darkQueueVehicleMinutes.toFixed(1)} vs battery ON ${on.sim.kpi().darkQueueVehicleMinutes.toFixed(1)} vehicle-min; trips done OFF ${off.sim.kpi().completed} / ON ${on.sim.kpi().completed}`);
  }, 120_000);

  it('the view lists the blackout, dark signals, batteries and unpowered buildings; plain data; dark heads code 3', () => {
    const sim = new Simulation(powerCity(), { scenario: true, citizens: false });
    sim.setPolicy({ reroute: true, informedShare: 0.7, battery: true });
    expect(sim.scenarioInput(input('b', 10, 'blackout.start', { buildingId: 'sub' })).ok).toBe(true);
    expect(sim.scenarioInput(input('d', 10, 'blackout.start', {}, { x: 0, z: -130, radius: 30 })).ok).toBe(true);
    run(sim, 20);
    let s = sim.snapshot().scenario!;
    expect(s.blackouts.map((b) => [b.eventId, b.substationId, b.radius])).toEqual([
      ['b', 'sub', COVERAGE_RADIUS],
      ['d', null, 30],
    ]);
    expect(s.battery.map((b) => b.signalId)).toEqual(['c:cw', 'n:c']);
    expect(s.unpoweredBuildings).toEqual(['fs', 'home', 'sub'].filter((id) => sim.powerCoverage().buildings[id] === 'sub'));
    expect(s.kpi).toMatchObject({ unpoweredSignals: 2, darkSignals: 0 });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    sim.setPolicy({ reroute: true, informedShare: 0.7, battery: false });
    run(sim, 2);
    const snap = sim.snapshot();
    s = snap.scenario!;
    expect(s.darkJunctions).toEqual(['c']);
    expect(s.darkCrossings).toEqual(['cw']);
    expect(s.battery).toEqual([]);
    expect(s.activeEvents.filter((e) => e.kind === 'blackout').length).toBe(2);
    for (let h = 0; h < snap.signalCount; h++) expect(snap.signals[h * 4 + 3]).toBe(3);
    expect(sim.signals()[0]).toMatchObject({ nodeId: 'c', dark: true, color: 'red', greenApproaches: [] });
  });

  it('DARK over PREEMPT: a pre-empted junction that loses power drops its controller; no request is served at a dark junction', () => {
    const sim = new Simulation(powerCity(), { scenario: true, citizens: false });
    const w = internals(sim);
    sim.setPolicy({ reroute: true, informedShare: 0.7, battery: false });
    expect(sim.scenarioInput(input('f', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000 })).ok).toBe(true);
    const watch = new SignalWatch(sim);
    let cut = -1;
    let ctlWhileDark = 0;
    const problems: string[] = [];
    const out = run(sim, 2500, (t) => {
      watch.observe();
      if (cut < 0 && w.sc!.ctl.has('c')) {
        cut = t + 1;
        expect(sim.scenarioInput(input('b', w.tick, 'blackout.start', { buildingId: 'sub' }, { durationTicks: 1200 })).ok).toBe(true);
      }
      if (w.dark?.junctions.has('c') && (w.sc!.ctl.has('c') || sim.snapshot().scenario!.preempted.length > 0)) ctlWhileDark++;
      problems.push(...checkIncidentInvariants(sim));
      if (t % 3 === 0) problems.push(...checkInvariants(sim));
    });
    expect(cut).toBeGreaterThan(0);
    expect(ctlWhileDark).toBe(0);
    expect(out.some((o) => o.kind === 'dispatch.arrive')).toBe(true);
    expect([...watch.problems, ...problems].slice(0, 10)).toEqual([]);
  }, 120_000);

  it('a WALK on display when the power goes is served in full (junction and mid-block crosswalk)', () => {
    const sim = new Simulation(powerCity(), { scenario: true, citizens: false });
    const w = internals(sim);
    // Find a tick where both the junction and the mid-block crosswalk show WALK somewhere.
    let at = -1;
    for (let t = 0; t < 4000 && at < 0; t++) {
      sim.step();
      const junctionWalk = w.graph.crossings.some((c) => c.nodeId === 'c' && w.zs.pedSig[c.index] === PedSignal.walk);
      const midWalk = w.zs.pedSig[w.graph.crossings.find((c) => c.id === 'cw')!.index] === PedSignal.walk;
      if (junctionWalk && midWalk) at = w.tick;
    }
    expect(at).toBeGreaterThan(0);
    expect(sim.scenarioInput(input('b', at, 'blackout.start', { buildingId: 'sub' }, { durationTicks: 2000 })).ok).toBe(true);
    const watch = new SignalWatch(sim);
    sim.step();
    watch.observe();
    const cw = w.graph.crossings.find((c) => c.id === 'cw')!.index;
    expect(w.zs.pedSig[cw]).toBe(PedSignal.clearance);
    expect(w.zs.midColor[cw]).toBe(0);
    expect(w.graph.crossings.filter((c) => c.nodeId === 'c').some((c) => w.zs.pedSig[c.index] === PedSignal.clearance)).toBe(true);
    for (let t = 0; t < 400; t++) {
      sim.step();
      watch.observe();
    }
    expect(w.zs.pedSig[cw]).toBe(PedSignal.none);
    expect(w.zs.midColor[cw]).toBe(2);
    expect(watch.problems).toEqual([]);
  });
});

describe('blackout ends before the battery is empty (Sol 4c2-② R1)', () => {
  for (const how of ['duration', 'end input'] as const) {
    it(`${how}: power state, KPIs and batteries are restored; the next blackout starts with a full battery`, () => {
      const doc = apply(crossDoc(260), [place('sub', 'svc-substation', 60, 60)]);
      const sim = new Simulation(doc, { scenario: true, citizens: false, demand: false });
      const w = internals(sim);
      sim.setPolicy({ reroute: true, informedShare: 0.7 });
      expect(sim.scenarioInput(input('b1', 0, 'blackout.start', { buildingId: 'sub' }, { durationTicks: how === 'duration' ? 10 : 1000 })).ok).toBe(true);
      if (how === 'end input') expect(sim.scenarioInput(input('e1', 5, 'blackout.end', { eventId: 'b1' })).ok).toBe(true);
      run(sim, 20);
      const s = sim.snapshot().scenario!;
      expect(s.activeEvents).toEqual([]);
      expect(s.kpi).toMatchObject({ unpoweredSignals: 0, unpoweredBuildings: 0, darkSignals: 0 });
      expect(s.unpoweredBuildings).toEqual([]);
      expect(s.battery).toEqual([]);
      expect(w.sc!.battery.size).toBe(0);
      expect(sim.scenarioInput(input('b2', 20, 'blackout.start', { buildingId: 'sub' })).ok).toBe(true);
      run(sim, 1);
      // Before the fix: the first blackout's leftover (1790 / 1795 − 1) instead of a full battery − 1.
      expect(w.sc!.battery.get('n:c')).toBe(BATTERY_TICKS - 1);
      expect(sim.snapshot().scenario!.kpi.unpoweredSignals).toBe(1);
    });
  }
});

describe('blackout: replay and randomized safety', () => {
  it('property: random blackouts (substation / disc), ends, battery toggles and calls replay identically (acceptance order, JSON)', () => {
    const doc = powerCity();
    const hash = (sim: Simulation): string => {
      const s = sim.snapshot();
      return Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + Array.from(s.signals.subarray(0, s.signalCount * 4)).join(',') + JSON.stringify(s.stats) + JSON.stringify(s.scenario);
    };
    for (let seed = 1; seed <= 4; seed++) {
      const rng = new Rng(seed);
      const live = new Simulation(cloneJson(doc), { scenario: true, citizens: false });
      const w = internals(live);
      const ids: string[] = [];
      const hashes: string[] = [];
      for (let t = 0; t < 3000; t++) {
        if (rng.next() < 0.01) {
          const id = `e${seed}-${t}`;
          const r = rng.next();
          let inp: ScenarioInput | null = null;
          if (r < 0.3) inp = input(id, w.tick + rng.int(3), 'blackout.start', { buildingId: 'sub' }, { durationTicks: 200 + rng.int(1500) });
          else if (r < 0.5) inp = input(id, w.tick, 'blackout.start', {}, { x: rng.int(200) - 100, z: rng.int(200) - 100, radius: 50 + rng.int(200) });
          else if (r < 0.7 && ids.length) inp = input(id, w.tick, 'blackout.end', { eventId: ids[rng.int(ids.length)]! });
          else if (r < 0.8) inp = input(id, w.tick, 'fire.start', { buildingId: 'home' }, { burnTicks: 400 });
          else live.setPolicy({ reroute: rng.next() < 0.5, informedShare: 0.7, ...(rng.next() < 0.5 ? { battery: rng.next() < 0.5 } : {}) });
          if (inp) {
            expect(live.scenarioInput(inp).ok).toBe(true);
            if (inp.kind === 'blackout.start') ids.push(id);
          }
        }
        live.step();
        if (t % 100 === 99) hashes.push(hash(live));
      }
      const replay = (list: ScenarioInput[]): void => {
        const sim = simulationFromRecord({ engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: list, policy: { reroute: false, informedShare: 0.7 } }, { citizens: false });
        const got: string[] = [];
        for (let t = 0; t < 3000; t++) {
          sim.step();
          if (t % 100 === 99) got.push(hash(sim));
        }
        expect(got).toEqual(hashes);
      };
      const inputs = live.scenarioInputs();
      replay(inputs);
      replay(JSON.parse(JSON.stringify(inputs)) as ScenarioInput[]);
      expect(w.sc!.log.some((e) => e.kind === 'signal.dark')).toBe(true);
    }
  }, 300_000);

  const SEEDS = 200;
  it(`randomized (${SEEDS} seeds): blackouts × batteries × pre-emption × plan / mid-block edits — signal, zone, incident and physical checks all 0`, () => {
    let violations = 0;
    let edits = 0;
    let darkTicks = 0;
    let clearing = 0;
    let darkEvents = 0;
    let checks = 0;
    const first: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = new Rng(1000 + seed);
      const doc = powerCity();
      if (seed % 3 === 0) apply(doc, [{ type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: true } }]);
      const sim = new Simulation(doc, { scenario: true, citizens: seed % 2 === 0 });
      const w = internals(sim);
      sim.setPolicy({ reroute: true, informedShare: 0.7, battery: seed % 4 === 0 });
      const watch = new SignalWatch(sim);
      const state = { deleted: false, n: 0 };
      const problems: string[] = [];
      for (let t = 0; t < 3500; t++) {
        const r = rng.next();
        if (r < 0.004) {
          const dur = { durationTicks: 100 + rng.int(1500) };
          const inp =
            rng.next() < 0.6
              ? input(`b${t}`, w.tick, 'blackout.start', { buildingId: 'sub' }, dur)
              : input(`b${t}`, w.tick, 'blackout.start', {}, { x: rng.int(300) - 150, z: rng.int(300) - 150, radius: 50 + rng.int(250), ...dur });
          expect(sim.scenarioInput(inp).ok).toBe(true);
        } else if (r < 0.0045) sim.scenarioInput(input(`x${t}`, w.tick, 'blackout.end', { buildingId: 'sub' }));
        else if (r < 0.006) sim.scenarioInput(input(`f${t}`, w.tick, rng.next() < 0.5 ? 'fire.start' : 'medical.start', { buildingId: 'home' }, {}));
        else if (r < 0.009) {
          const e = randomPlanEdit(w, rng, 'c', 'E', 'N', state);
          if (sim.applyCommand(e[1]).ok) {
            edits++;
            watch.edited('c');
            watch.edited('mx');
          }
        } else if (r < 0.010) sim.setPolicy({ reroute: true, informedShare: 0.7, battery: rng.next() < 0.5 });
        sim.step();
        watch.observe();
        problems.push(...checkIncidentInvariants(sim));
        if (t % 4 === 0) problems.push(...checkInvariants(sim), ...checkZoneInvariants(sim));
      }
      darkEvents += w.sc!.log.filter((e) => e.kind === 'signal.dark').length;
      problems.push(...watch.problems);
      violations += problems.length;
      darkTicks += watch.darkTicks;
      clearing += watch.clearingTicks;
      checks += watch.clearanceChecks;
      if (first.length < 5) first.push(...problems.slice(0, 5 - first.length).map((x) => `seed ${seed}: ${x}`));
    }
    console.log(`blackout fuzz (${SEEDS} seeds): ${darkEvents} signal.dark, ${edits} edits, ${darkTicks} dark signal-ticks, ${clearing} clearing ticks, ${checks} WALK exits checked for clearance sufficiency, violations ${violations}`);
    expect(first).toEqual([]);
    expect(violations).toBe(0);
    expect(darkEvents).toBeGreaterThan(400);
  }, 600_000);
});
