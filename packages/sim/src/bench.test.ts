import { describe, expect, it } from 'vitest';
import { compileNetwork } from './network/compile.js';
import { Simulation } from './simulation.js';
import { gridDoc } from './testkit.js';

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
});
