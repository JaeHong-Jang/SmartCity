// Signal control state machine (ADR 0010 §4): safety invariants every tick under emergency pre-emption,
// and the response-time effect of pre-emption on a congested grid.

import { describe, expect, it } from 'vitest';
import { cloneJson, Rng, type CityDoc, type Command } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkIncidentInvariants, checkInvariants, crossDoc, gridDoc, internals, randomPlanEdit, SignalWatch } from '../testkit.js';
import { PedSignal } from '../types.js';
import type { ScenarioInput } from './types.js';

declare const console: { log(...args: unknown[]): void };

const place = (id: string, typeId: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
const call = (eventId: string, tick: number, kind: 'fire.start' | 'medical.start', buildingId: string, params: Record<string, number> = {}): ScenarioInput => ({
  eventId,
  tick,
  order: 0,
  kind,
  target: { buildingId },
  params,
});

/**
 * Four-arm junction: fire station on arm N, hospital on arm W (both on the side whose lane leads to the
 * junction), the call building on arm S (on the side of the lane leading away from it).
 */
function crossCity(scramble: boolean): CityDoc {
  const doc = apply(crossDoc(260), [
    place('fs', 'svc-fire-station', -40, -200),
    place('hosp', 'svc-hospital', -200, 45),
    place('home', 'house', -20, 180),
    ...(scramble ? [{ type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: true } } as Command] : []),
  ]);
  doc.meta.trafficDensity = 1.2;
  return doc;
}

/** Ticks the first `dispatch.arrive` of each event needed (call → arrival), from the outcome stream. */
function arrivals(sim: Simulation, out: Map<string, number>, starts: Map<string, number>): void {
  for (const o of sim.drainScenarioOutcomes()) {
    if (o.kind === 'fire.start' || o.kind === 'medical.start') starts.set(o.eventId, o.tick);
    if (o.kind === 'dispatch.arrive') out.set(o.eventId, o.tick + 1 - starts.get(o.eventId)!);
  }
}

describe('signal pre-emption: safety every tick', () => {
  for (const scramble of [false, true]) {
    it(`${scramble ? 'scramble' : 'plain'} junction: entry from every plan state, conflicting requests from two approaches, exit back to the plan`, () => {
      const doc = crossCity(scramble);
      let controlled = 0;
      let greens = 0;
      const tally = { lone: [0, 0, 0], pair: [0, 0, 0], loneSum: [0, 0], pairSum: [0, 0], worstLone: 0 };
      const problems: string[] = [];
      // Calls at start ticks spread over two signal cycles: the junction is taken over in green, yellow, all
      // red and (scramble) the pedestrian phase. A lone fire truck (N), then the truck and an ambulance (W)
      // arriving close together (conflicting requests, served one after the other).
      for (let k = 0; k < 10; k++) {
        const t0 = 400 + k * 97;
        for (const pair of [false, true]) {
          const res: Record<string, Map<string, number>> = {};
          for (const preempt of [false, true]) {
            const sim = new Simulation(cloneJson(doc), { scenario: true, citizens: !scramble });
            sim.setPolicy({ reroute: false, informedShare: 0.7, preempt });
            expect(sim.scenarioInput(call('f', t0, 'fire.start', 'home')).ok).toBe(true);
            if (pair) expect(sim.scenarioInput(call('m', t0 + 5, 'medical.start', 'home')).ok).toBe(true);
            const watch = new SignalWatch(sim);
            const arr = new Map<string, number>();
            const starts = new Map<string, number>();
            for (let t = 0; t < t0 + 4000; t++) {
              sim.step();
              watch.observe();
              if (t % 2 === 0) problems.push(...checkInvariants(sim).map((p) => `tick ${t}: ${p}`));
              arrivals(sim, arr, starts);
            }
            problems.push(...watch.problems);
            if (preempt) {
              controlled += watch.controlledTicks;
              greens += watch.controlledGreens;
            } else expect(watch.controlledTicks).toBe(0);
            res[String(preempt)] = arr;
          }
          for (const id of pair ? ['f', 'm'] : ['f']) {
            const off = res['false']!.get(id);
            const on = res['true']!.get(id);
            expect(off, `${k} ${id} off`).toBeDefined();
            expect(on, `${k} ${id} on`).toBeDefined();
            const row = pair ? tally.pair : tally.lone;
            row[on! < off! ? 0 : on! > off! ? 2 : 1]!++;
            const sum = pair ? tally.pairSum : tally.loneSum;
            sum[0]! += off!;
            sum[1]! += on!;
            if (!pair) tally.worstLone = Math.max(tally.worstLone, on! - off!);
          }
        }
      }
      expect(problems.slice(0, 10)).toEqual([]);
      // The controller really drove the junction and switched greens for the requests.
      expect(controlled).toBeGreaterThan(1000);
      expect(greens).toBeGreaterThan(5);
      // Pre-emption shortens the summed response; a lone truck is at most 1 s later (traffic ahead after the junction differs).
      expect(tally.loneSum[1]).toBeLessThan(tally.loneSum[0]!);
      expect(tally.pairSum[1]).toBeLessThan(tally.pairSum[0]!);
      expect(tally.worstLone).toBeLessThanOrEqual(20);
      console.log(
        `${scramble ? 'scramble' : 'plain'} cross: controlled ${controlled} junction-ticks, ${greens} controlled greens; lone truck ON faster/equal/slower ${tally.lone.join('/')}, ` +
          `summed ${tally.loneSum[0]} → ${tally.loneSum[1]} ticks (worst +${tally.worstLone}); truck + ambulance ${tally.pair.join('/')}, summed ${tally.pairSum[0]} → ${tally.pairSum[1]} ticks`,
      );
    }, 240_000);
  }

  it('grid with many calls, scramble junctions and citizens: invariants every tick; OFF never drives a junction', () => {
    const base = gridDoc(5, 150, 'road-4', 5);
    const doc = apply(base, [
      place('fs1', 'svc-fire-station', -225, -225),
      place('fs2', 'svc-fire-station', 225, 75),
      place('h1', 'svc-hospital', 225, -225),
      place('h2', 'svc-hospital', -75, 225),
      ...['n_1_1', 'n_2_3', 'n_3_2'].map((nodeId) => ({ type: 'intersection.set', control: { nodeId, kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: true } }) as Command),
      ...[-225, -75, 75, 225].flatMap((x) => [place(`b${x}a`, 'house', x + 20, -75 - 20), place(`b${x}b`, 'house', x - 20, 75 + 20)]),
    ]);
    doc.meta.trafficDensity = 1;
    const ids = Object.keys(doc.buildings).filter((id) => id.startsWith('b'));
    for (const preempt of [true, false]) {
      const sim = new Simulation(cloneJson(doc), { scenario: true });
      sim.setPolicy({ reroute: true, informedShare: 0.7, preempt });
      ids.forEach((id, k) => {
        expect(sim.scenarioInput(call(`m${k}`, 300 + k * 211, 'medical.start', id, { treatTicks: 100 })).ok).toBe(true);
        if (k % 3 === 0) expect(sim.scenarioInput(call(`f${k}`, 350 + k * 211, 'fire.start', id)).ok).toBe(true);
      });
      const watch = new SignalWatch(sim);
      const problems: string[] = [];
      let maxCtl = 0;
      for (let t = 0; t < 5000; t++) {
        sim.step();
        watch.observe();
        maxCtl = Math.max(maxCtl, internals(sim).sc!.ctl.size);
        problems.push(...checkIncidentInvariants(sim).map((p) => `tick ${t}: ${p}`));
        if (t % 5 === 0) problems.push(...checkInvariants(sim).map((p) => `tick ${t}: ${p}`));
      }
      problems.push(...watch.problems);
      expect(problems.slice(0, 10)).toEqual([]);
      const kpi = sim.kpi();
      if (preempt) {
        expect(maxCtl).toBeGreaterThan(1);
        expect(watch.controlledGreens).toBeGreaterThan(10);
      } else expect(watch.controlledTicks).toBe(0);
      expect(kpi.responses).toBeGreaterThan(5);
      console.log(`grid preempt=${preempt}: ${watch.controlledTicks} controlled junction-ticks, max ${maxCtl} at once, responses ${kpi.responses}, avg ${kpi.avgResponseTime!.toFixed(2)} game min, medical done ${kpi.medicalCompleted}`);
    }
  }, 240_000);
});

describe('signal pre-emption: plan edits and recompiles (review #1)', () => {
  /** Sol's setup: the fire truck from N is served (N/S green) when the plan is edited. */
  function solSim(): Simulation {
    const doc = apply(crossDoc(260), [place('fs', 'svc-fire-station', -40, -200), place('home', 'house', -20, 180)]);
    doc.meta.trafficDensity = 0;
    const sim = new Simulation(doc, { scenario: true, citizens: false, demand: false });
    sim.setPolicy({ reroute: true, informedShare: 0.7 });
    expect(sim.scenarioInput(call('f', 0, 'fire.start', 'home', { burnTicks: 20000 })).ok).toBe(true);
    return sim;
  }

  it("repro A: reversing the phase order under pre-emption → N/S yellow, all red, WALK cleared, then the new plan; never E/W green early", () => {
    const sim = solSim();
    const w = internals(sim);
    const watch = new SignalWatch(sim);
    for (let t = 0; t < 117; t++) {
      sim.step();
      watch.observe();
    }
    expect(w.sc!.ctl.has('c')).toBe(true);
    expect(sim.signals()[0]!.greenApproaches.sort()).toEqual(['N', 'S']);
    const walking = w.graph.crossings.filter((cr, ci) => cr.nodeId === 'c' && w.zs.pedSig[ci] === PedSignal.walk).map((cr) => cr.segmentId).sort();
    expect(walking).toEqual(['E', 'W']);
    const phases = w.signals.plans[0]!.phases.slice().reverse().map((ph) => ({ approaches: ph.approaches.slice(), green: ph.green }));
    expect(sim.applyCommand({ type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', phases, yellow: 3, allRed: 2, offset: 0 } }).ok).toBe(true);
    watch.edited('c');
    const seq: string[] = [];
    for (let t = 117; t < 600; t++) {
      sim.step();
      watch.observe();
      const v = sim.signals()[0]!;
      const ped = w.graph.crossings
        .map((cr, ci) => [cr, w.zs.pedSig[ci]!] as const)
        .filter(([cr, sig]) => cr.nodeId === 'c' && sig !== PedSignal.red)
        .map(([cr, sig]) => `${cr.segmentId}${sig === PedSignal.walk ? 'W' : 'C'}`)
        .sort()
        .join('');
      const st = `${v.color}:${v.greenApproaches.sort().join('')}${v.color === 'yellow' ? 'NS' : ''}|${ped}`;
      if (seq[seq.length - 1]?.split('@')[0] !== st) seq.push(`${st}@${t}`);
    }
    expect(watch.problems).toEqual([]);
    // Tick 117 (the step after the edit): yellow N/S, E and W crosswalks in their flashing clearance.
    expect(seq[0]).toBe('yellow:NS|ECWC@117');
    // Yellow 3 s, all red 2 s; the crosswalks clear in full; only then a green — the served truck's N/S
    // (the request resumes on the new plan's phases), never E/W before it.
    const greens = seq.filter((x) => x.startsWith('green'));
    expect(greens[0]).toMatch(/^green:NS\|/);
    const firstGreen = Number(greens[0]!.split('@')[1]);
    expect(firstGreen - 117).toBeGreaterThanOrEqual(60 + 40);
  });

  const SEEDS = 16;
  it('randomized: reversed / added / removed phases, scramble toggled, control type changed, approach deleted, unrelated recompiles — 0 violations', () => {
    let violations = 0;
    let edits = 0;
    let baseEdits = 0;
    let clearing = 0;
    let controlled = 0;
    const kinds = new Map<string, number>();
    const firstProblems: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = new Rng(seed);
      const doc = crossCity(seed % 3 === 0);
      doc.meta.trafficDensity = 0.8;
      const sim = new Simulation(cloneJson(doc), { scenario: true, citizens: seed % 2 === 0 });
      const w = internals(sim);
      sim.setPolicy({ reroute: true, informedShare: 0.7 });
      const t0 = 150 + rng.int(600);
      expect(sim.scenarioInput(call('f', t0, 'fire.start', 'home', { burnTicks: 30000 })).ok).toBe(true);
      expect(sim.scenarioInput(call('m', t0 + rng.int(300), 'medical.start', 'home')).ok).toBe(true);
      expect(sim.scenarioInput(call('m2', t0 + 900 + rng.int(300), 'medical.start', 'home')).ok).toBe(true);
      const watch = new SignalWatch(sim);
      const problems: string[] = [];
      const state = { deleted: false, n: 0 };
      for (let t = 0; t < t0 + 3200; t++) {
        const driven = w.sc !== null && (w.sc.ctl.has('c') || w.signalClearing.has('c'));
        // Mostly while a controller drives the junction; sometimes not (then the base plan change is cleared the same way).
        if (t > t0 && rng.next() < (driven ? 0.012 : 0.002)) {
          const e = randomPlanEdit(w, rng, 'c', 'E', 'N', state);
          if (sim.applyCommand(e[1]).ok) {
            kinds.set(e[0], (kinds.get(e[0]) ?? 0) + 1);
            if (driven) edits++;
            else baseEdits++;
            watch.edited('c');
          }
        }
        sim.step();
        watch.observe();
        problems.push(...checkIncidentInvariants(sim).map((x) => `tick ${t}: ${x}`));
        if (t % 3 === 0) problems.push(...checkInvariants(sim).map((x) => `tick ${t}: ${x}`));
      }
      problems.push(...watch.problems);
      violations += problems.length;
      if (firstProblems.length < 5) firstProblems.push(...problems.slice(0, 5 - firstProblems.length).map((x) => `seed ${seed}: ${x}`));
      clearing += watch.clearingTicks;
      controlled += watch.controlledTicks;
    }
    console.log(
      `edit fuzz (${SEEDS} seeds): ${edits} edits under control (${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')} — all edits), ${baseEdits} edits while no controller drove it (checked too), ` +
        `${controlled} controlled + ${clearing} clearing junction-ticks, violations ${violations}`,
    );
    expect(firstProblems).toEqual([]);
    expect(violations).toBe(0);
    expect(edits).toBeGreaterThan(20);
    expect(clearing).toBeGreaterThan(500);
  }, 600_000);
});

describe('signal pre-emption: response time', () => {
  it('congested grid: pre-emption ON vs OFF on the same calls (reported; ON must not be slower on average)', () => {
    const doc = apply(gridDoc(6, 150, 'road-4', 9), [
      place('fs', 'svc-fire-station', -300, -300),
      place('h', 'svc-hospital', 300, -300),
      ...[-300, -150, 0, 150, 300].map((x, k) => place(`t${k}`, 'house', x + 20, 225 + 20)),
      ...[-300, 0, 300].map((z, k) => place(`u${k}`, 'house', 225 + 20, z - 20)),
    ]);
    doc.meta.trafficDensity = 1.4;
    const targets = Object.keys(doc.buildings).filter((id) => /^[tu]/.test(id));
    const run = (preempt: boolean) => {
      const sim = new Simulation(cloneJson(doc), { scenario: true, citizens: false });
      sim.setPolicy({ reroute: false, informedShare: 0.7, preempt });
      targets.forEach((id, k) => {
        sim.scenarioInput(call(`m${k}`, 1200 + k * 600, 'medical.start', id, { treatTicks: 60 }));
        sim.scenarioInput(call(`f${k}`, 1500 + k * 600, 'fire.start', id, { burnTicks: 20000 }));
      });
      const arr = new Map<string, number>();
      const starts = new Map<string, number>();
      for (let t = 0; t < 1200 + targets.length * 600 + 3000; t++) {
        sim.step();
        arrivals(sim, arr, starts);
      }
      return { arr, kpi: sim.kpi() };
    };
    const off = run(false);
    const on = run(true);
    let wins = 0;
    let losses = 0;
    for (const [id, a] of on.arr) {
      const b = off.arr.get(id);
      if (b === undefined) continue;
      if (a < b) wins++;
      else if (a > b) losses++;
    }
    console.log(
      `response ON avg ${on.kpi.avgResponseTime!.toFixed(2)} / max ${on.kpi.maxResponseTime!.toFixed(2)} game min (${on.kpi.responses} arrivals) vs OFF avg ${off.kpi.avgResponseTime!.toFixed(2)} / max ${off.kpi.maxResponseTime!.toFixed(2)} (${off.kpi.responses}); per call: ON faster ${wins}, slower ${losses}`,
    );
    expect(on.kpi.responses).toBeGreaterThanOrEqual(off.kpi.responses!);
    expect(on.kpi.avgResponseTime).toBeLessThan(off.kpi.avgResponseTime!);
  }, 240_000);
});
