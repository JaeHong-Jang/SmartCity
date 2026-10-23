import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkInvariants, internals } from '../testkit.js';

function lineDoc(buses: number) {
  return apply(createEmptyDoc('bus', 9), [
    { type: 'node.add', node: { id: 'p', pos: { x: -150, z: 0 } } },
    { type: 'node.add', node: { id: 'q', pos: { x: 150, z: 0 } } },
    { type: 'segment.add', segment: { id: 'PQ', a: 'p', b: 'q', roadTypeId: 'road-2' } },
    { type: 'busStop.add', stop: { id: 'st1', segmentId: 'PQ', t: 0.5, dir: 'forward' } },
    { type: 'busStop.add', stop: { id: 'st2', segmentId: 'PQ', t: 0.5, dir: 'backward' } },
    { type: 'busLine.upsert', line: { id: 'L1', name: '1', color: '#22aa44', stopIds: ['st1', 'st2'], vehicleTypeId: 'city-bus', buses } },
  ]);
}

describe('buses', () => {
  it('runs a 2-stop line, dwells ~10 s at each stop and loops', () => {
    const sim = new Simulation(lineDoc(1), { demand: false });
    const w = internals(sim);
    const dwells: { ticks: number; stop: number; s: number }[] = [];
    let run = 0;
    for (let t = 0; t < 20 * 240; t++) {
      sim.step();
      const vs = sim.vehicles();
      expect(vs.length).toBe(1);
      const v = vs[0]!;
      expect(v.busLineId).toBe('L1');
      if (v.state === 'dwelling') {
        if (run === 0) dwells.push({ ticks: 0, stop: w.vehicles[0]!.bus!.stopIdx, s: v.s });
        run++;
        dwells[dwells.length - 1]!.ticks = run;
        expect(v.v).toBe(0);
      } else run = 0;
      expect(checkInvariants(sim)).toEqual([]);
    }
    expect(dwells.length).toBeGreaterThanOrEqual(4);
    for (const d of dwells.slice(0, -1)) expect(Math.abs(d.ticks - 200)).toBeLessThanOrEqual(2);
    // Alternates between the two stops, and halts at the stop position (mid-lane).
    for (let i = 1; i < dwells.length; i++) expect(dwells[i]!.stop).not.toBe(dwells[i - 1]!.stop);
    const laneLen = sim.graph.lanes[sim.graph.laneById.get('PQ|f|0')!]!.length;
    for (const d of dwells) expect(Math.abs(d.s - laneLen / 2)).toBeLessThan(1.5);
    expect(sim.stats().removed).toBe(0);
  });

  it('respects maxVehicles (Sol review #6)', () => {
    const sim = new Simulation(lineDoc(2), { demand: false, maxVehicles: 1 });
    for (let t = 0; t < 200; t++) {
      sim.step();
      expect(sim.stats().vehicles).toBeLessThanOrEqual(1);
    }
  });

  it('respects maxVehicles together with demand traffic (Sol re-check #6)', () => {
    const doc = lineDoc(2);
    doc.meta.seed = 7;
    doc.meta.trafficDensity = 3;
    const sim = new Simulation(doc, { maxVehicles: 1 });
    for (let t = 0; t < 400; t++) {
      sim.step();
      expect(sim.stats().vehicles).toBeLessThanOrEqual(1);
    }
  });

  it('spreads buses evenly over the stops', () => {
    const sim = new Simulation(lineDoc(2), { demand: false });
    sim.step();
    const vs = sim.vehicles();
    expect(vs.length).toBe(2);
    const lanes = vs.map((v) => sim.graph.lanes[v.edge.index]!.id).sort();
    expect(lanes).toEqual(['PQ|b|0', 'PQ|f|0']);
  });

  it('respawns removed buses and drops buses when the line shrinks', () => {
    const sim = new Simulation(lineDoc(2), { demand: false });
    for (let t = 0; t < 40; t++) sim.step();
    expect(sim.vehicles().length).toBe(2);
    sim.applyCommand({ type: 'busLine.upsert', line: { id: 'L1', name: '1', color: '#22aa44', stopIds: ['st1', 'st2'], vehicleTypeId: 'city-bus', buses: 1 } });
    sim.step();
    expect(sim.vehicles().length).toBe(1);
    sim.applyCommand({ type: 'busLine.remove', id: 'L1' });
    sim.step();
    expect(sim.vehicles().length).toBe(0);
  });
});

describe('vehicle type edits (Sol review #7)', () => {
  it('replaces vehicles whose type physics changed', () => {
    const sim = new Simulation(lineDoc(1), { demand: false });
    for (let t = 0; t < 20; t++) sim.step();
    const before = sim.vehicles()[0]!;
    const bus = { ...sim.doc.vehicleTypes['city-bus']!, maxSpeed: 5, length: 14 };
    sim.applyCommand({ type: 'vehicleType.upsert', vehicleType: bus });
    sim.step();
    expect(sim.stats().removed).toBe(1);
    for (let t = 0; t < 400; t++) sim.step();
    const vs = sim.vehicles();
    expect(vs).toHaveLength(1);
    expect(vs[0]!.id).not.toBe(before.id);
    expect(vs[0]!.v).toBeLessThanOrEqual(5 + 1e-6);
    expect(checkInvariants(sim)).toEqual([]);
  });

  it('keeps vehicles when only cosmetic fields change', () => {
    const sim = new Simulation(lineDoc(1), { demand: false });
    for (let t = 0; t < 20; t++) sim.step();
    const id = sim.vehicles()[0]!.id;
    sim.applyCommand({ type: 'vehicleType.upsert', vehicleType: { ...sim.doc.vehicleTypes['city-bus']!, color: '#123456', name: '새 버스' } });
    sim.step();
    expect(sim.vehicles()[0]!.id).toBe(id);
    expect(sim.stats().removed).toBe(0);
  });
});
