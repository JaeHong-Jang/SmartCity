import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';
import { checkCitizenInvariants, checkInvariants, checkZoneInvariants, cityDoc, gridDoc } from './testkit.js';

describe('collision invariants', () => {
  it('3×3 grid of 4-lane roads with demand: no overlaps and no conflicting occupancy for 3 minutes', () => {
    const sim = new Simulation(gridDoc(3, 150, 'road-4'));
    const problems: string[] = [];
    for (let t = 0; t < 3600; t++) {
      sim.step();
      const p = checkInvariants(sim);
      if (p.length) problems.push(`tick ${t}: ${p.slice(0, 3).join('; ')}`);
      if (problems.length > 5) break;
    }
    expect(problems).toEqual([]);
    const st = sim.stats();
    expect(st.spawned).toBeGreaterThan(200);
    expect(st.arrived).toBeGreaterThan(30);
  });

  it('holds with buses and a mixed fleet at high density on 2-lane roads', () => {
    const sim = new Simulation(gridDoc(3, 120, 'road-2', 11));
    sim.applyCommand({ type: 'meta.update', trafficDensity: 2 });
    sim.applyCommand({
      type: 'batch',
      commands: [
        { type: 'busStop.add', stop: { id: 'a', segmentId: 'h_0_0', t: 0.5, dir: 'forward' } },
        { type: 'busStop.add', stop: { id: 'b', segmentId: 'h_1_2', t: 0.5, dir: 'backward' } },
        { type: 'busLine.upsert', line: { id: 'L', name: 'L', color: '#123456', stopIds: ['a', 'b'], vehicleTypeId: 'city-bus', buses: 2 } },
      ],
    });
    const problems: string[] = [];
    for (let t = 0; t < 3600; t++) {
      sim.step();
      const p = checkInvariants(sim);
      if (p.length) problems.push(`tick ${t}: ${p.slice(0, 3).join('; ')}`);
      if (problems.length > 5) break;
    }
    expect(problems).toEqual([]);
    expect(sim.vehicles().filter((v) => v.busLineId === 'L').length).toBe(2);
  });

  it('grid with citizens: vehicle bodies and pedestrians never share a crossing zone (checked every tick)', () => {
    const sim = new Simulation(cityDoc());
    sim.applyCommand({ type: 'meta.update', trafficDensity: 2 });
    // Morning rush: departures start at 07:00 (tick 3600).
    for (let t = 0; t < 3400; t++) sim.step();
    const problems: string[] = [];
    let maxPeds = 0;
    let crossingTicks = 0;
    for (let t = 0; t < 6000; t++) {
      sim.step();
      const p = [...checkZoneInvariants(sim), ...checkInvariants(sim), ...checkCitizenInvariants(sim)];
      if (p.length) problems.push(`tick ${t}: ${p.slice(0, 3).join('; ')}`);
      if (problems.length > 5) break;
      const snap = sim.snapshot();
      maxPeds = Math.max(maxPeds, snap.pedestrianCount);
      for (let c = 0; c < snap.crossingCount; c++) if (snap.crossings[c * 3 + 1]! > 0) crossingTicks++;
    }
    expect(problems).toEqual([]);
    expect(maxPeds).toBeGreaterThan(50);
    // Pedestrians really used the crosswalks while traffic was running.
    expect(crossingTicks).toBeGreaterThan(2000);
    expect(sim.stats().arrived).toBeGreaterThan(50);
  }, 120_000);
});
