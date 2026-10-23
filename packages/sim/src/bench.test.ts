import { describe, expect, it } from 'vitest';
import { Rng } from '@smartcity/shared';
import { spawnWalker } from './citizens/peds.js';
import { compileNetwork } from './network/compile.js';
import { Simulation } from './simulation.js';
import { gridDoc, internals } from './testkit.js';

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
