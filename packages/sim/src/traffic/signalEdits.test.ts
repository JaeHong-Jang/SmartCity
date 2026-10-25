// Safe signal plan changes in every mode (ADR 0010 §4, traffic/signalClearing.ts): a rebuilt plan with
// another identity is entered through yellow, all red and full pedestrian clearance; an unchanged identity
// keeps today's behaviour exactly.

import { describe, expect, it } from 'vitest';
import { cloneJson, Rng, type Command } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkInvariants, checkZoneInvariants, crossDoc, gridDoc, internals, lineDoc, randomPlanEdit, SignalWatch } from '../testkit.js';
import { PedSignal } from '../types.js';

declare const console: { log(...args: unknown[]): void };

describe('main mode: signal plan edits', () => {
  it('repro: reversing the phases at tick 117 → N/S yellow, all red, E/W crosswalks cleared, then the new plan from its first phase', () => {
    const sim = new Simulation(crossDoc(260), { citizens: false, demand: false });
    const w = internals(sim);
    expect(w.sc).toBeNull();
    const watch = new SignalWatch(sim);
    for (let t = 0; t < 117; t++) {
      sim.step();
      watch.observe();
    }
    expect(sim.signals()[0]!.greenApproaches.sort()).toEqual(['N', 'S']);
    const clearance = Math.max(...w.signals.plans[0]!.peds.filter((ph) => w.zs.pedSig[ph.ci] === PedSignal.walk).map((ph) => ph.clearance));
    const phases = w.signals.plans[0]!.phases.slice().reverse().map((ph) => ({ approaches: ph.approaches.slice(), green: ph.green }));
    expect(sim.applyCommand({ type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', phases, yellow: 3, allRed: 2, offset: 0 } }).ok).toBe(true);
    watch.edited('c');
    const seq: string[] = [];
    for (let t = 117; t < 700; t++) {
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
    // Before the fix: 'green:EW|NW' here. Now yellow for N/S, the E and W crosswalks flash their clearance.
    expect(seq[0]).toBe('yellow:NS|ECWC@117');
    expect(seq[1]).toBe('red:|ECWC@177');
    // The new plan starts at its first phase (E/W, the reversed order) only after yellow 3 s + all red 2 s and
    // the full crosswalk clearance; it then runs its own cycle.
    const first = seq.find((x) => x.startsWith('green'))!;
    expect(first.startsWith('green:EW|')).toBe(true);
    expect(clearance).toBeGreaterThan(100);
    expect(Number(first.split('@')[1])).toBe(117 + clearance);
    expect(w.signalClearing.size).toBe(0);
  });

  it('rebuilds that keep every plan identity (far buildings and roads, mid-block crosswalks, closures, school zones) change no signal output and start no clearance', () => {
    const doc = apply(gridDoc(4, 150, 'road-4', 6), [{ type: 'building.place', building: { id: 'h0', typeId: 'house', pos: { x: -150, z: 20 }, rotation: 0 } }]);
    doc.meta.trafficDensity = 1;
    const script: Record<number, Command[]> = {
      200: [{ type: 'building.place', building: { id: 'far1', typeId: 'house', pos: { x: 1500, z: 1500 }, rotation: 0 } }],
      450: [
        {
          type: 'batch',
          commands: [
            { type: 'node.add', node: { id: 'fa', pos: { x: -1500, z: -1500 } } },
            { type: 'node.add', node: { id: 'fz', pos: { x: -1300, z: -1500 } } },
            { type: 'segment.add', segment: { id: 'fr', a: 'fa', b: 'fz', roadTypeId: 'road-2' } },
          ],
        },
      ],
      700: [{ type: 'feature.upsert', feature: { id: 'mid', segmentId: 'h_1_1', kind: 'crosswalk', t: 0.5 } }],
      950: [{ type: 'closure.set', closure: { segmentId: 'v_2_1', reason: 'test' } }],
      1200: [{ type: 'segment.setSchoolZone', id: 'h_0_2', schoolZone: true }],
      1450: [{ type: 'building.remove', id: 'h0' }],
    };
    const signalsOf = (sim: Simulation): string => {
      const s = sim.snapshot();
      const w = internals(sim);
      // Junction signal heads (mid-block heads come after them) and junction crosswalk signals.
      let heads = 0;
      for (const p of w.signals.plans) heads += p.heads.length;
      const junctionPeds = w.graph.crossings.filter((c) => c.kind === 'junction').map((c) => `${c.id}:${w.zs.pedSig[c.index]}`);
      return Array.from(s.signals.subarray(0, heads * 4)).join(',') + junctionPeds.join(',');
    };
    const run = (edits: boolean): string[] => {
      const sim = new Simulation(cloneJson(doc));
      const w = internals(sim);
      const out: string[] = [];
      for (let t = 0; t < 1800; t++) {
        if (edits) for (const c of script[t] ?? []) expect(sim.applyCommand(c).ok).toBe(true);
        sim.step();
        expect(w.signalClearing.size).toBe(0);
        expect(w.signalOffsets.size).toBe(0);
        out.push(signalsOf(sim));
      }
      return out;
    };
    expect(run(true)).toEqual(run(false));
  });

  it('the golden dense-grid script: its plan-changing edits (node move: phase order and clearances; split: approach ids) are entered safely', () => {
    const doc = gridDoc(7, 120, 'road-4', 11);
    doc.meta.trafficDensity = 3;
    const sim = new Simulation(doc, { maxVehicles: 1500 });
    const w = internals(sim);
    const watch = new SignalWatch(sim);
    const script: Record<number, Command[]> = {
      400: [{ type: 'feature.upsert', feature: { id: 'f1', segmentId: 'h_2_3', kind: 'crosswalk', t: 0.5, signal: true } }],
      900: [{ type: 'node.move', id: 'n_3_3', pos: { x: 5, z: -4 } }],
      1300: [{ type: 'segment.split', id: 'v_4_2', t: 0.5, nodeId: 'mid', segmentIds: ['v_4_2a', 'v_4_2b'] }],
      1700: [{ type: 'closure.set', closure: { segmentId: 'h_1_1', reason: 'golden' } }],
      2000: [{ type: 'segment.remove', id: 'v_5_5' }],
    };
    const cleared: Record<number, string[]> = {};
    const problems: string[] = [];
    for (let t = 0; t < 2400; t++) {
      for (const c of script[t] ?? []) {
        expect(sim.applyCommand(c)).toEqual({ ok: true });
        for (const p of w.signals.plans) watch.edited(p.nodeId);
      }
      sim.step();
      watch.observe();
      if (script[t]) cleared[t] = [...w.signalClearing.keys()].sort();
      if (t % 5 === 0) problems.push(...checkInvariants(sim).map((x) => `tick ${t}: ${x}`));
    }
    expect([...problems, ...watch.problems].slice(0, 10)).toEqual([]);
    expect(cleared).toEqual({
      400: [],
      // Moving n_3_3 swaps the automatic phase order at it and its neighbours and lengthens two crosswalks.
      900: ['n_2_3', 'n_3_2', 'n_3_3', 'n_3_4', 'n_4_3'],
      // Split: the approach v_4_2 becomes v_4_2a / v_4_2b at its two ends.
      1300: ['n_4_2', 'n_4_3'],
      1700: [],
      // n_5_5 and n_5_6 change too, but their old plans were in the last all-red tick of the cycle: nothing to clear.
      2000: [],
    });
    expect(watch.clearingTicks).toBeGreaterThan(5 * 100);
  }, 120_000);

  const SEEDS = 200;
  it(`randomized plan edits without any scenario (${SEEDS} seeds): 0 violations`, () => {
    let violations = 0;
    let edits = 0;
    let clearing = 0;
    let checks = 0;
    const kinds = new Map<string, number>();
    const firstProblems: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = new Rng(seed);
      const doc = crossDoc(260);
      doc.meta.trafficDensity = 0.8;
      if (seed % 3 === 0) apply(doc, [{ type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: true } }]);
      const sim = new Simulation(doc, { citizens: seed % 4 === 0 });
      const w = internals(sim);
      const watch = new SignalWatch(sim);
      const state = { deleted: false, n: 0 };
      const problems: string[] = [];
      for (let t = 0; t < 3000; t++) {
        if (t > 100 && rng.next() < 0.006) {
          const e = randomPlanEdit(w, rng, 'c', 'E', 'N', state);
          if (sim.applyCommand(e[1]).ok) {
            edits++;
            kinds.set(e[0], (kinds.get(e[0]) ?? 0) + 1);
            watch.edited('c');
          }
        }
        sim.step();
        watch.observe();
        if (t % 3 === 0) problems.push(...checkInvariants(sim).map((x) => `tick ${t}: ${x}`));
      }
      expect(w.sc).toBeNull();
      problems.push(...watch.problems);
      violations += problems.length;
      clearing += watch.clearingTicks;
      checks += watch.clearanceChecks;
      if (firstProblems.length < 5) firstProblems.push(...problems.slice(0, 5 - firstProblems.length).map((x) => `seed ${seed}: ${x}`));
    }
    console.log(`main-mode edit fuzz (${SEEDS} seeds): ${edits} edits (${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}), ${clearing} clearing junction-ticks, ${checks} WALK exits checked for clearance sufficiency, violations ${violations}`);
    expect(firstProblems).toEqual([]);
    expect(violations).toBe(0);
    expect(clearing).toBeGreaterThan(1000);
  }, 600_000);

  describe('mid-block signal crosswalks (Sol R1)', () => {
    const cw = (signal: boolean): Command => ({ type: 'feature.upsert', feature: { id: 'cw', segmentId: 'ab', kind: 'crosswalk', t: 0.5, signal } });
    const state = (sim: Simulation): string => {
      const w = internals(sim);
      const ci = w.graph.crossings.find((c) => c.id === 'cw')!.index;
      const sig = w.zs.pedSig[ci]!;
      return `${['red', 'yellow', 'green'][w.zs.midColor[ci]!]}/${sig === PedSignal.walk ? 'WALK' : sig === PedSignal.clearance ? 'CLR' : sig === PedSignal.none ? 'none' : 'red'}`;
    };
    const runSeq = (sim: Simulation, from: number, to: number, watch: SignalWatch): string[] => {
      const seq: string[] = [];
      for (let t = from; t < to; t++) {
        sim.step();
        watch.observe();
        const st = state(sim);
        if (seq[seq.length - 1]?.split('@')[0] !== st) seq.push(`${st}@${t}`);
      }
      return seq;
    };

    it("Sol's repro: switched off during WALK → vehicles stay red while the crosswalk flashes its full clearance, then unsignalized", () => {
      const sim = new Simulation(lineDoc(500, 'road-2', [cw(true)]), { citizens: false, demand: false });
      const watch = new SignalWatch(sim);
      for (let t = 0; t < 700; t++) {
        sim.step();
        watch.observe();
      }
      expect(state(sim)).toBe('red/WALK');
      const clearance = internals(sim).signals.mids[0]!.clearance;
      expect(sim.applyCommand(cw(false)).ok).toBe(true);
      watch.edited('cw');
      const seq = runSeq(sim, 700, 1100, watch);
      // Before the fix: 'green/none@700' at once.
      expect(seq[0]).toBe('red/CLR@700');
      expect(seq[1]).toMatch(/^green\/none@/);
      expect(Number(seq[1]!.split('@')[1]) - 700).toBe(clearance);
      expect(internals(sim).midClearing.size).toBe(0);
      expect(watch.problems).toEqual([]);
    });

    it('switched on while its cycle would show WALK → a full yellow first; switched on during its vehicle green → the cycle as is', () => {
      for (const [at, first] of [
        [700, 'yellow/red'],
        [100, 'green/red'],
      ] as const) {
        const sim = new Simulation(lineDoc(500, 'road-2', [cw(false)]), { citizens: false, demand: false });
        const watch = new SignalWatch(sim);
        for (let t = 0; t < at; t++) {
          sim.step();
          watch.observe();
        }
        expect(state(sim)).toBe('green/none');
        expect(sim.applyCommand(cw(true)).ok).toBe(true);
        const seq = runSeq(sim, at, at + 900, watch);
        expect(seq[0]).toBe(`${first}@${at}`);
        const walk = seq.findIndex((x) => x.startsWith('red/WALK'));
        expect(seq[walk - 1]).toMatch(/^yellow\/red@/);
        expect(Number(seq[walk]!.split('@')[1]) - Number(seq[walk - 1]!.split('@')[1])).toBe(60);
        expect(watch.problems).toEqual([]);
      }
    });

    it('random on / off toggles with pedestrians (50 seeds): 0 violations, zone invariants hold', () => {
      let violations = 0;
      let toggles = 0;
      let checks = 0;
      const first: string[] = [];
      for (let seed = 1; seed <= 50; seed++) {
        const rng = new Rng(seed);
        const doc = apply(lineDoc(500, 'road-2', [cw(true)]), [
          { type: 'building.place', building: { id: 'h1', typeId: 'house', pos: { x: 120, z: 25 }, rotation: 0 } },
          { type: 'building.place', building: { id: 'h2', typeId: 'shop', pos: { x: 380, z: -25 }, rotation: 0 } },
        ]);
        doc.meta.trafficDensity = 1;
        const sim = new Simulation(doc, { citizens: true });
        const watch = new SignalWatch(sim);
        let on = true;
        const problems: string[] = [];
        for (let t = 0; t < 4000; t++) {
          if (t > 50 && rng.next() < 0.004) {
            on = !on;
            expect(sim.applyCommand(cw(on)).ok).toBe(true);
            watch.edited('cw');
            toggles++;
          }
          sim.step();
          watch.observe();
          if (t % 4 === 0) problems.push(...checkInvariants(sim), ...checkZoneInvariants(sim));
        }
        problems.push(...watch.problems);
        violations += problems.length;
        checks += watch.clearanceChecks;
        if (first.length < 5) first.push(...problems.slice(0, 5 - first.length).map((x) => `seed ${seed}: ${x}`));
      }
      console.log(`mid-block toggle fuzz (50 seeds): ${toggles} toggles, ${checks} WALK exits checked for clearance sufficiency, violations ${violations}`);
      expect(first).toEqual([]);
      expect(toggles).toBeGreaterThan(500);
    }, 300_000);
  });

  describe('lengthened crosswalks get their longer clearance (Sol 4c2-② R2, R3)', () => {
    it("R2: a mid-block signal switched off while its road is widened (7 → 21 m) during WALK → 420 ticks of clearance; widened later during the clearance → extended", () => {
      for (const order of ['together', 'later'] as const) {
        const sim = new Simulation(lineDoc(500, 'road-2', [{ type: 'feature.upsert', feature: { id: 'cw', segmentId: 'ab', kind: 'crosswalk', t: 0.5, signal: true } }]), { citizens: false, demand: false });
        const w = internals(sim);
        const watch = new SignalWatch(sim);
        for (let t = 0; t < 661; t++) {
          sim.step();
          watch.observe();
        }
        const ci = w.graph.crossings.find((c) => c.id === 'cw')!.index;
        expect(w.zs.pedSig[ci]).toBe(PedSignal.walk);
        const off: Command = { type: 'feature.upsert', feature: { id: 'cw', segmentId: 'ab', kind: 'crosswalk', t: 0.5, signal: false } };
        const widen: Command = { type: 'segment.setType', id: 'ab', roadTypeId: 'road-6' };
        expect(sim.applyCommand(off).ok).toBe(true);
        if (order === 'together') expect(sim.applyCommand(widen).ok).toBe(true);
        watch.edited('cw');
        sim.step();
        watch.observe();
        if (order === 'later') {
          expect(w.midClearing.get('cw')!.until).toBe(661 + 140);
          expect(sim.applyCommand(widen).ok).toBe(true);
        }
        for (let t = 0; t < 600; t++) {
          sim.step();
          watch.observe();
          if (w.midClearing.has('cw')) expect(w.midClearing.get('cw')!.until, order).toBe(661 + 420);
        }
        expect(watch.problems).toEqual([]);
        expect(watch.clearanceChecks).toBeGreaterThan(0);
      }
    });

    it('checker (Sol R4): with the extension disabled, a clearance that returns straight to WALK 280 ticks short is reported', () => {
      const run = (extend: boolean): { problems: string[]; checks: number } => {
        const sim = new Simulation(crossDoc(260), { citizens: false, demand: false });
        const w = internals(sim);
        const watch = new SignalWatch(sim);
        sim.step();
        watch.observe();
        expect(sim.applyCommand({ type: 'segment.setType', id: 'E', roadTypeId: 'road-6' }).ok).toBe(true);
        watch.edited('c');
        if (!extend) {
          // The edit's rebuild runs at the next step's flush: run it, then undo the extension (old 7 m clearance).
          (sim as unknown as { flush(): void }).flush();
          const cl = w.signalClearing.get('c')!;
          for (const x of cl.peds) x.end = x.start + 140;
        }
        for (let t = 0; t < 600; t++) {
          sim.step();
          watch.observe();
        }
        return { problems: watch.problems, checks: watch.clearanceChecks };
      };
      expect(run(true).problems).toEqual([]);
      const off = run(false);
      expect(off.problems.some((p) => /c\|E cleared 140 ticks, its length needs 420 \(then WALK\)/.test(p))).toBe(true);
    });

    it('R3: a junction crosswalk lengthened (7 → 21 m) during WALK, and again during CLEARANCE → the clearance runs for the new length', () => {
      for (const when of ['walk', 'clearance'] as const) {
        const sim = new Simulation(crossDoc(260), { citizens: false, demand: false });
        const w = internals(sim);
        const watch = new SignalWatch(sim);
        sim.step();
        watch.observe();
        const ci = () => w.graph.crossings.find((c) => c.id === 'c|E')!.index;
        expect(w.zs.pedSig[ci()]).toBe(PedSignal.walk);
        let at = 1;
        if (when === 'clearance') {
          // Wait for its normal clearance, then widen E.
          while (w.zs.pedSig[ci()] !== PedSignal.clearance) {
            sim.step();
            watch.observe();
          }
          at = w.tick;
        }
        expect(sim.applyCommand({ type: 'segment.setType', id: 'E', roadTypeId: 'road-6' }).ok).toBe(true);
        watch.edited('c');
        let end = -1;
        let seen = false;
        for (let t = 0; t < 900 && end < 0; t++) {
          sim.step();
          watch.observe();
          const sig = w.zs.pedSig[ci()];
          if (sig === PedSignal.clearance) seen = true;
          else if (seen) end = w.tick - 1;
        }
        // Before the fix: tick 141 (the old 7 m clearance). The clearance started at the edit (WALK cut) or at
        // the WALK's end and now lasts 21 s.
        const start = when === 'walk' ? at : at - 1;
        expect(end, when).toBeGreaterThanOrEqual(start + 420);
        expect(watch.problems).toEqual([]);
      }
    });
  });
});
