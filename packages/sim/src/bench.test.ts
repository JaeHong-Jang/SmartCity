import { describe, expect, it } from 'vitest';
import { Rng } from '@smartcity/shared';
import { spawnWalker } from './citizens/peds.js';
import { compileNetwork } from './network/compile.js';
import { updatePreemption } from './scenario/preempt.js';
import { Simulation } from './simulation.js';
import { apply, gridDoc, internals } from './testkit.js';

// Tests run in Node; the sim tsconfig has no DOM/Node libs, so declare the two globals used here.
declare const console: { log(...args: unknown[]): void };
declare const performance: { now(): number };

describe('performance', () => {
  it('~400-segment grid with ~3000 vehicles steps in well under the 8 ms budget', () => {
    const doc = gridDoc(15, 100, 'road-4');
    doc.meta.trafficDensity = 3;
    let t0 = performance.now();
    const graph = compileNetwork(doc);
    const compileMs = performance.now() - t0;
    const sim = new Simulation(doc, { maxVehicles: 3000 });
    for (let i = 0; i < 2000 && sim.stats().vehicles < 2950; i++) sim.step();
    expect(sim.stats().vehicles).toBeGreaterThanOrEqual(2950);
    const steps = 400;
    t0 = performance.now();
    let minVehicles = Infinity;
    for (let i = 0; i < steps; i++) {
      sim.step();
      minVehicles = Math.min(minVehicles, sim.stats().vehicles);
    }
    const stepMs = (performance.now() - t0) / steps;
    t0 = performance.now();
    let reuse = sim.snapshot();
    for (let i = 0; i < 50; i++) reuse = sim.snapshot(reuse);
    const snapMs = (performance.now() - t0) / 50;
    console.log(
      `[sim bench] segments=${Object.keys(doc.segments).length} lanes=${graph.lanes.length} connectors=${graph.connectors.length} ` +
        `compile=${compileMs.toFixed(1)}ms vehicles>=${minVehicles} step=${stepMs.toFixed(2)}ms snapshot=${snapMs.toFixed(2)}ms`,
    );
    expect(Object.keys(doc.segments).length).toBeGreaterThanOrEqual(400);
    expect(minVehicles).toBeGreaterThan(2500);
    // Target is < 8 ms; the assertion leaves headroom for slow CI machines.
    expect(stepMs).toBeLessThan(25);
  }, 120_000);

  it('simulator mode: ~3000 vehicles with a closure, an accident and a surge active at once, policy ON (reported)', () => {
    const doc = apply(gridDoc(15, 100, 'road-4'), [{ type: 'building.place', building: { id: 'arena', typeId: 'office-tower', pos: { x: 50, z: 50 }, rotation: 0 } }]);
    doc.meta.trafficDensity = 3;
    const sim = new Simulation(doc, { maxVehicles: 3000 });
    sim.setPolicy({ reroute: true, informedShare: 0.7 });
    for (let i = 0; i < 2000 && sim.stats().vehicles < 2950; i++) sim.step();
    const t = sim.stats().tick;
    const inputs = [
      { eventId: 'closure', tick: t, order: 0, kind: 'closure.start', target: { segmentId: 'h_7_7' }, params: {} },
      { eventId: 'accident', tick: t, order: 1, kind: 'accident.start', target: { segmentId: 'v_6_7', lane: 0, s: 40 }, params: { durationTicks: 100000 } },
      { eventId: 'surge', tick: t, order: 2, kind: 'surge.start', target: { buildingId: 'arena' }, params: { extraTrips: 300, inflowTicks: 400, stayTicks: 100000 } },
    ] as const;
    for (const input of inputs) expect(sim.scenarioInput({ ...input, target: { ...input.target }, params: { ...input.params } })).toEqual({ ok: true });
    const times: number[] = [];
    let buffers = sim.snapshot();
    const steps = 400;
    for (let i = 0; i < steps; i++) {
      const t0 = performance.now();
      sim.step();
      buffers = sim.snapshot(buffers);
      times.push(performance.now() - t0);
    }
    const k = sim.kpi();
    const first = times[0]!;
    // Later event starts on warm code (no first-use JIT): mean of the start ticks vs the 19 ticks after each.
    let startMs = 0;
    let restMs = 0;
    for (let e = 0; e < 5; e++) {
      const tick = sim.stats().tick;
      const target = { segmentId: `v_${3 + e * 2}_3` };
      expect(sim.scenarioInput({ eventId: `closure${e}`, tick, order: 0, kind: 'closure.start', target, params: { durationTicks: 15 } })).toEqual({ ok: true });
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        sim.step();
        if (i === 0) startMs += (performance.now() - t0) / 5;
        else restMs += (performance.now() - t0) / 95;
      }
    }
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / steps;
    console.log(
      `[sim bench scenario] vehicles=${sim.stats().vehicles} active=${k.activeEvents} rerouted=${k.rerouted} detoured=${k.detoured} waitingToDepart=${k.waitingToDepart} ` +
        `tick(step+snapshot+kpi) mean=${mean.toFixed(2)}ms p95=${times[Math.floor(steps * 0.95)]!.toFixed(2)}ms first(3 events start)=${first.toFixed(2)}ms later closure start/end steps: start mean=${startMs.toFixed(2)}ms other mean=${restMs.toFixed(2)}ms`,
    );
    expect(k.activeEvents).toBe(3);
  }, 120_000);

  it('simulator mode: ~3000 vehicles with 24 fire / medical calls out, pre-emption ON vs OFF (reported)', () => {
    const cmds = [];
    const corners: [number, number][] = [[-650, -650], [650, 650], [-650, 650], [650, -650]];
    for (const [k, [x, z]] of corners.entries()) {
      cmds.push({ type: 'building.place' as const, building: { id: `fs${k}`, typeId: 'svc-fire-station', pos: { x, z }, rotation: 0 } });
      cmds.push({ type: 'building.place' as const, building: { id: `h${k}`, typeId: 'svc-hospital', pos: { x: x / 2 + 50 * Math.sign(x), z: -z / 2 - 50 * Math.sign(z) }, rotation: 0 } });
    }
    for (let k = 0; k < 24; k++) cmds.push({ type: 'building.place' as const, building: { id: `b${k}`, typeId: 'house', pos: { x: -550 + (k % 6) * 200, z: -450 + Math.floor(k / 6) * 300 }, rotation: 0 } });
    const doc = apply(gridDoc(15, 100, 'road-4'), cmds);
    doc.meta.trafficDensity = 3;
    // probe: also times one extra pre-emption pass after every step (that run's own timings are not reported).
    const measure = (preempt: boolean, probe = false) => {
      const sim = new Simulation(doc, { maxVehicles: 3000, scenario: true });
      sim.setPolicy({ reroute: false, informedShare: 0.7, preempt });
      for (let i = 0; i < 2000 && sim.stats().vehicles < 2950; i++) sim.step();
      const t = sim.stats().tick;
      for (let k = 0; k < 24; k++) {
        const kind = k % 2 === 0 ? 'fire.start' : 'medical.start';
        expect(sim.scenarioInput({ eventId: `e${k}`, tick: t, order: 0, kind, target: { buildingId: `b${k}` }, params: kind === 'fire.start' ? { burnTicks: 100000 } : {} }).ok).toBe(true);
      }
      const w = internals(sim);
      const times: number[] = [];
      let out = 0;
      let ctl = 0;
      let pass = 0;
      for (let i = 0; i < 400; i++) {
        const t0 = performance.now();
        sim.step();
        times.push(performance.now() - t0);
        if (probe) {
          const t1 = performance.now();
          updatePreemption(w);
          pass += (performance.now() - t1) / 400;
        }
        out += w.sc!.missions.filter((m) => m.v !== null).length / 400;
        ctl += w.sc!.ctl.size / 400;
      }
      times.sort((a, b) => a - b);
      return { mean: times.reduce((a, b) => a + b, 0) / times.length, p95: times[Math.floor(times.length * 0.95)]!, out, ctl, pass, vehicles: sim.stats().vehicles };
    };
    const off = measure(false);
    const on = measure(true);
    const pass = measure(true, true).pass;
    console.log(
      `[sim bench emergency] vehicles=${on.vehicles} emergency vehicles on the road (mean)=${on.out.toFixed(1)} driven junctions (mean)=${on.ctl.toFixed(1)} ` +
        `step ON mean=${on.mean.toFixed(2)}ms p95=${on.p95.toFixed(2)}ms | OFF mean=${off.mean.toFixed(2)}ms p95=${off.p95.toFixed(2)}ms | pre-emption pass mean=${(pass * 1000).toFixed(1)}µs`,
    );
    expect(on.out).toBeGreaterThan(5);
    expect(on.ctl).toBeGreaterThan(1);
  }, 300_000);

  it('simulator mode: ~3000 vehicles, a blackout darkening ~50 junctions (all-way stops), vs none (reported)', () => {
    const doc = apply(gridDoc(15, 100, 'road-4'), [{ type: 'building.place', building: { id: 'sub', typeId: 'svc-substation', pos: { x: 50, z: 50 }, rotation: 0 } }]);
    doc.meta.trafficDensity = 3;
    const measure = (blackout: boolean) => {
      const sim = new Simulation(doc, { maxVehicles: 3000, scenario: true });
      sim.setPolicy({ reroute: false, informedShare: 0.7, battery: false });
      for (let i = 0; i < 2000 && sim.stats().vehicles < 2950; i++) sim.step();
      const t = sim.stats().tick;
      if (blackout) expect(sim.scenarioInput({ eventId: 'b', tick: t, order: 0, kind: 'blackout.start', target: { buildingId: 'sub' }, params: { durationTicks: 100000 } }).ok).toBe(true);
      const w = internals(sim);
      const times: number[] = [];
      for (let i = 0; i < 400; i++) {
        const t0 = performance.now();
        sim.step();
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return { mean: times.reduce((a, b) => a + b, 0) / times.length, p95: times[Math.floor(times.length * 0.95)]!, dark: w.dark?.junctions.size ?? 0 };
    };
    const none = measure(false);
    const on = measure(true);
    console.log(`[sim bench blackout] dark junctions=${on.dark} step mean=${on.mean.toFixed(2)}ms p95=${on.p95.toFixed(2)}ms | no blackout mean=${none.mean.toFixed(2)}ms p95=${none.p95.toFixed(2)}ms`);
    expect(on.dark).toBeGreaterThan(20);
    expect(none.dark).toBe(0);
  }, 300_000);

  it('~3000 vehicles and ~5000 outdoor pedestrians: reports step mean / p95 (not a pass/fail target)', () => {
    const doc = gridDoc(15, 100, 'road-4');
    doc.meta.trafficDensity = 3;
    const sim = new Simulation(doc, { maxVehicles: 3000 });
    const w = internals(sim);
    const pg = w.ped.pg;
    const rng = new Rng(99);
    const topUp = (n: number): void => {
      for (let k = 0; k < 200 && w.peds.count < n; k++) spawnWalker(w, rng.int(pg.nNodes), rng.int(pg.nNodes), 0.8 + rng.next());
    };
    for (let i = 0; i < 2500 && (sim.stats().vehicles < 2950 || w.peds.count < 4950); i++) {
      topUp(5000);
      sim.step();
    }
    const steps = 400;
    const times: number[] = [];
    const ticks: number[] = [];
    let minPeds = Infinity;
    let minVehicles = Infinity;
    let onCrossings = 0;
    let buffers = sim.snapshot();
    for (let i = 0; i < steps; i++) {
      topUp(5000);
      const t0 = performance.now();
      sim.step();
      const t1 = performance.now();
      // The worker publishes a snapshot every tick (with returned buffers): count both.
      buffers = sim.snapshot(buffers);
      const t2 = performance.now();
      times.push(t1 - t0);
      ticks.push(t2 - t0);
      minPeds = Math.min(minPeds, w.peds.count);
      minVehicles = Math.min(minVehicles, sim.stats().vehicles);
    }
    ticks.sort((a, b) => a - b);
    const tickMean = ticks.reduce((a, b) => a + b, 0) / steps;
    const tickP95 = ticks[Math.floor(steps * 0.95)]!;
    for (const z of w.zs.ped) onCrossings += z;
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / steps;
    const p95 = times[Math.floor(steps * 0.95)]!;
    let t0 = performance.now();
    let reuse = sim.snapshot();
    for (let i = 0; i < 50; i++) reuse = sim.snapshot(reuse);
    const snapMs = (performance.now() - t0) / 50;
    t0 = performance.now();
    sim.applyCommand({ type: 'feature.upsert', feature: { id: 'bench-x', segmentId: 'h_7_7', kind: 'crosswalk', t: 0.5 } });
    sim.step();
    const recompileMs = performance.now() - t0;
    console.log(
      `[sim bench peds] vehicles>=${minVehicles} pedestrians>=${minPeds} pedGraph nodes=${pg.nNodes} edges=${pg.nEdges} crossings=${sim.graph.crossings.length} ` +
        `holding crossings=${onCrossings} step mean=${mean.toFixed(2)}ms p95=${p95.toFixed(2)}ms snapshot=${snapMs.toFixed(2)}ms ` +
        `tick(step+snapshot) mean=${tickMean.toFixed(2)}ms p95=${tickP95.toFixed(2)}ms recompile step=${recompileMs.toFixed(1)}ms`,
    );
    expect(minVehicles).toBeGreaterThan(2500);
    expect(minPeds).toBeGreaterThan(4500);
  }, 300_000);
});
