import { describe, expect, it } from 'vitest';
import type { Command } from '@smartcity/shared';
import { Simulation } from './simulation.js';
import { apply, checkInvariants, crossDoc, gridDoc, internals } from './testkit.js';

function snapshotBytes(sim: Simulation): string {
  const s = sim.snapshot();
  const parts = [
    new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 6 * 4),
    new Uint8Array(s.signals.buffer, 0, s.signalCount * 4 * 4),
    new Uint8Array(s.laneFlow.buffer),
  ];
  return parts.map((p) => Array.from(p).join(',')).join('|') + JSON.stringify(s.stats);
}

describe('Simulation', () => {
  it('is deterministic: same doc + same commands at the same ticks → identical snapshots', () => {
    const script: Record<number, Command> = {
      200: { type: 'closure.set', closure: { segmentId: 'h_1_1', reason: 'accident' } },
      450: { type: 'segment.split', id: 'v_0_1', t: 0.5, nodeId: 'split_n', segmentIds: ['split_a', 'split_b'] },
      700: { type: 'closure.remove', segmentId: 'h_1_1' },
    };
    const run = (): string[] => {
      const sim = new Simulation(gridDoc(3, 150));
      const out: string[] = [];
      for (let t = 0; t < 1000; t++) {
        const cmd = script[t];
        if (cmd) expect(sim.applyCommand(cmd).ok).toBe(true);
        sim.step();
        if (t % 100 === 99) out.push(snapshotBytes(sim));
      }
      return out;
    };
    const a = run();
    const b = run();
    expect(a.length).toBe(10);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('keeps vehicles across a recompile that keeps their lanes', () => {
    const sim = new Simulation(gridDoc(3, 150));
    for (let t = 0; t < 600; t++) sim.step();
    const before = sim.vehicles().map((v) => v.id);
    expect(before.length).toBeGreaterThan(20);
    const removed = sim.stats().removed;
    expect(sim.applyCommand({ type: 'intersection.set', control: { nodeId: 'n_1_1', kind: 'uncontrolled', yellow: 3, allRed: 2, offset: 0 } }).ok).toBe(true);
    sim.step();
    expect(sim.stats().graphRevision).toBe(1);
    const after = new Set(sim.vehicles().map((v) => v.id));
    // Same lanes, same lengths → everybody stays (and is rerouted); only arrivals during the step leave.
    const gone = before.filter((id) => !after.has(id)).length;
    expect(sim.stats().removed - removed).toBe(0);
    expect(gone).toBeLessThanOrEqual(sim.stats().arrived);
    expect(sim.graph.nodes.get('n_1_1')!.signalized).toBe(false);
  });

  it('survives road edits under traffic and removes only the vehicles on changed lanes', () => {
    const sim = new Simulation(gridDoc(3, 150));
    for (let t = 0; t < 900; t++) sim.step();
    const w = internals(sim);
    const onSplit = w.vehicles.filter((v) => v.edge < w.net.nLanes && w.graph.lanes[v.edge]!.segmentId === 'h_0_1').map((v) => v.id);
    expect(onSplit.length).toBeGreaterThan(0);
    const removedBefore = sim.stats().removed;
    expect(sim.applyCommand({ type: 'segment.split', id: 'h_0_1', t: 0.5, nodeId: 'mid', segmentIds: ['h_0_1a', 'h_0_1b'] }).ok).toBe(true);
    sim.step();
    const ids = new Set(sim.vehicles().map((v) => v.id));
    for (const id of onSplit) expect(ids.has(id)).toBe(false);
    expect(sim.stats().removed - removedBefore).toBeGreaterThanOrEqual(onSplit.length);
    for (let t = 0; t < 300; t++) sim.step();
    expect(sim.applyCommand({ type: 'segment.remove', id: 'v_1_0' }).ok).toBe(true);
    for (let t = 0; t < 1200; t++) {
      sim.step();
      if (t > 20) expect(checkInvariants(sim)).toEqual([]);
    }
    expect(sim.stats().graphRevision).toBe(2);
    expect(sim.stats().vehicles).toBeGreaterThan(0);
    for (const v of sim.vehicles()) expect(Number.isFinite(v.pos.x) && Number.isFinite(v.pos.z)).toBe(true);
  });

  it('reroutes around a closure when an alternative exists', () => {
    const doc = gridDoc(4, 120, 'road-2');
    const sim = new Simulation(doc, { demand: false });
    const id = sim.spawnVehicle('sedan', 'h_0_1|f|0', 'h_2_1|f|0', 10)!;
    expect(id).not.toBeNull();
    const w = internals(sim);
    const planned = w.vehicles[0]!.route.map((e) => (e < w.net.nLanes ? w.graph.lanes[e]!.segmentId : ''));
    expect(planned).toContain('h_1_1');
    sim.applyCommand({ type: 'closure.set', closure: { segmentId: 'h_1_1', reason: 'roadworks' } });
    let usedClosed = false;
    for (let t = 0; t < 20 * 120 && sim.stats().arrived === 0; t++) {
      sim.step();
      const v = sim.vehicles()[0];
      if (v && v.edge.kind === 'lane' && sim.graph.lanes[v.edge.index]!.segmentId === 'h_1_1') usedClosed = true;
    }
    expect(usedClosed).toBe(false);
    expect(sim.stats().arrived).toBe(1);
    expect(sim.stats().removed).toBe(0);
  });

  it('lets vehicles already on a closed road drain out', () => {
    const sim = new Simulation(gridDoc(3, 150, 'road-2'), { demand: false });
    const id = sim.spawnVehicle('sedan', 'h_0_1|f|0', 'h_1_1|f|0', 20)!;
    sim.applyCommand({ type: 'closure.set', closure: { segmentId: 'h_0_1', reason: 'x' } });
    for (let t = 0; t < 20 * 120 && sim.stats().arrived === 0; t++) sim.step();
    expect(sim.stats().arrived).toBe(1);
    expect(sim.vehicles().some((v) => v.id === id)).toBe(false);
  });

  it('reuses snapshot buffers that are large enough and never exposes internal state', () => {
    const sim = new Simulation(gridDoc(3, 150));
    for (let t = 0; t < 300; t++) sim.step();
    const first = sim.snapshot();
    expect(first.vehicleCount).toBeGreaterThan(0);
    expect(first.vehicleTypeIds).toEqual(['ambulance', 'city-bus', 'sedan', 'suv', 'truck']);
    expect(first.laneFlow.length).toBe(sim.graph.lanes.length);
    expect(Array.from(first.laneFlow).every((f) => f === -1 || (f >= 0 && f <= 1))).toBe(true);
    const reuse = { vehicles: first.vehicles, signals: first.signals, laneFlow: first.laneFlow };
    first.vehicles.fill(12345);
    sim.step();
    const second = sim.snapshot(reuse);
    expect(second.laneFlow).toBe(reuse.laneFlow);
    expect(second.signals).toBe(reuse.signals);
    if (second.vehicleCount * 6 <= reuse.vehicles.length) expect(second.vehicles).toBe(reuse.vehicles);
    expect(second.vehicles[0]).not.toBe(12345);
    const small = sim.snapshot({ vehicles: new Float32Array(1) });
    expect(small.vehicles.length).toBeGreaterThanOrEqual(small.vehicleCount * 6);
    // Vehicle ids in the buffer match the views.
    const ids = sim.vehicles().map((v) => v.id);
    expect(Array.from({ length: small.vehicleCount }, (_, i) => small.vehicles[i * 6 + 5])).toEqual(ids);
  });

  it('spawnVehicle rejects unknown lanes, types and occupied spots', () => {
    const sim = new Simulation(gridDoc(2, 150, 'road-2'), { demand: false });
    expect(sim.spawnVehicle('nope', 'h_0_0|f|0', 'h_0_1|f|0')).toBeNull();
    expect(sim.spawnVehicle('sedan', 'missing', 'h_0_1|f|0')).toBeNull();
    expect(sim.spawnVehicle('sedan', 'h_0_0|f|0', 'v_1_0|f|0', 50)).not.toBeNull();
    expect(sim.spawnVehicle('sedan', 'h_0_0|f|0', 'v_1_0|f|0', 52)).toBeNull();
  });

  it('reroutes once after 30 s waiting and removes non-bus vehicles stopped for 90 s (counted)', () => {
    const doc = apply(crossDoc(120), [
      {
        type: 'intersection.set',
        control: { nodeId: 'c', kind: 'signal', phases: [{ approaches: ['N', 'S'], green: 150 }, { approaches: ['E', 'W'], green: 20 }], yellow: 3, allRed: 2, offset: 0 },
      },
    ]);
    const sim = new Simulation(doc, { demand: false });
    const L = sim.graph.lanes[sim.graph.laneById.get('W|f|0')!]!.length;
    const id = sim.spawnVehicle('sedan', 'W|f|0', 'E|b|0', L - 5)!;
    const w = internals(sim);
    let queuedForStuck = false;
    for (let t = 0; t < 20 * 89; t++) {
      sim.step();
      if (w.queue.some((q) => 'v' in q && q.v.id === id && q.reason === 'stuck')) queuedForStuck = true;
    }
    expect(sim.vehicles().map((v) => v.id)).toEqual([id]);
    expect(w.vehicles[0]!.rerouted).toBe(true);
    expect(queuedForStuck || w.vehicles[0]!.stopTime > 30).toBe(true);
    // The stop clock starts once it has crept up to the stop line (a few seconds after spawning).
    for (let t = 0; t < 20 * 12; t++) sim.step();
    expect(sim.vehicles()).toEqual([]);
    expect(sim.stats().removed).toBe(1);
    expect(sim.stats().arrived).toBe(0);
  });
  it('keeps cars off bus-only lanes', () => {
    const sim = new Simulation(gridDoc(3, 150, 'road-4-bus'));
    const busLanes = new Set(sim.graph.lanes.filter((l) => l.busOnly).map((l) => l.index));
    expect(busLanes.size).toBe(24);
    let cars = 0;
    for (let t = 0; t < 1200; t++) {
      sim.step();
      for (const v of sim.vehicles()) {
        if (v.edge.kind !== 'lane') continue;
        cars++;
        expect(busLanes.has(v.edge.index)).toBe(false);
      }
    }
    expect(cars).toBeGreaterThan(0);
  });

  it('generates building-based trips between homes and workplaces', () => {
    const doc = apply(gridDoc(3, 150, 'road-2'), [
      { type: 'building.place', building: { id: 'home1', typeId: 'apartment', pos: { x: -100, z: -100 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'home2', typeId: 'house', pos: { x: 40, z: 100 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'shop1', typeId: 'shop', pos: { x: 100, z: 40 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'far', typeId: 'shop', pos: { x: 900, z: 900 }, rotation: 0 } },
    ]);
    const sim = new Simulation(doc);
    const w = internals(sim);
    expect(w.demand.homes.length).toBe(2);
    // The far shop has no road within 80 m and is not attached.
    expect(w.demand.works.length).toBe(1);
    for (let t = 0; t < 20 * 120; t++) sim.step();
    expect(sim.stats().spawned).toBeGreaterThan(20);
    expect(sim.stats().arrived).toBeGreaterThan(5);
  });
});
