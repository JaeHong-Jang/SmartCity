import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkInvariants, crossDoc, internals } from '../testkit.js';

const laneIdx = (sim: Simulation, id: string): number => sim.graph.laneById.get(id)!;
const connIdx = (sim: Simulation, id: string): number => sim.graph.connectors.find((c) => c.id === id)!.index;
const view = (sim: Simulation, id: number) => sim.vehicles().find((v) => v.id === id);

describe('signals', () => {
  it('stops a car at red and lets it go on green', () => {
    const sim = new Simulation(crossDoc(120), { demand: false });
    const green = sim.signals()[0]!.greenApproaches;
    expect(green.length).toBe(2);
    const red = ['N', 'S', 'E', 'W'].find((s) => !green.includes(s))!;
    const lane = laneIdx(sim, `${red}|f|0`);
    const L = sim.graph.lanes[lane]!.length;
    const opposite = { N: 'S', S: 'N', E: 'W', W: 'E' }[red]!;
    const id = sim.spawnVehicle('sedan', `${red}|f|0`, `${opposite}|b|0`, 30)!;
    expect(id).not.toBeNull();
    let stoppedAtRed = false;
    let departTick = -1;
    for (let t = 0; t < 20 * 60; t++) {
      sim.step();
      const sig = sim.signals()[0]!;
      const v = view(sim, id)!;
      const isGreen = sig.greenApproaches.includes(red);
      if (!isGreen && departTick < 0) {
        // Never past the stop line while red.
        expect(v.edge).toEqual({ kind: 'lane', index: lane });
        expect(v.s).toBeLessThanOrEqual(L + 1e-9);
        if (v.v < 0.05 && L - v.s < 5) stoppedAtRed = true;
      }
      if (v.edge.kind === 'connector') {
        expect(isGreen || sig.color !== 'green' || departTick >= 0).toBe(true);
        departTick = t;
        break;
      }
    }
    expect(stoppedAtRed).toBe(true);
    expect(departTick).toBeGreaterThan(0);
    // Departure happens within a few seconds of the switch to green (green starts after 20+3+2 s).
    expect(departTick / 20).toBeGreaterThanOrEqual(25);
    expect(departTick / 20).toBeLessThan(31);
  });

  it('exposes one signal head per incoming lane with colors', () => {
    const sim = new Simulation(crossDoc(120, 'road-4'), { demand: false });
    sim.step();
    const snap = sim.snapshot();
    expect(snap.signalCount).toBe(8);
    const colors = new Set<number>();
    for (let i = 0; i < snap.signalCount; i++) colors.add(snap.signals[i * 4 + 3]!);
    expect(colors).toEqual(new Set([0, 2]));
  });
});

describe('intersection manager', () => {
  it('makes a left turn yield to an opposing straight request', () => {
    const sim = new Simulation(crossDoc(120), { demand: false });
    const green = sim.signals()[0]!.greenApproaches;
    expect(green.sort()).toEqual(['N', 'S']);
    const L = sim.graph.lanes[laneIdx(sim, 'N|f|0')]!.length;
    // Southbound from N, a left turn goes east. The left-turner is closer to the stop line.
    const left = sim.spawnVehicle('sedan', 'N|f|0', 'E|b|0', L - 3)!;
    const straight = sim.spawnVehicle('sedan', 'S|f|0', 'N|b|0', L - 10)!;
    const cStraight = connIdx(sim, 'S|f|0>N|b|0');
    const w = internals(sim);
    let straightEntered = -1;
    let straightCleared = -1;
    let leftEntered = -1;
    for (let t = 0; t < 20 * 20 && leftEntered < 0; t++) {
      sim.step();
      if (straightEntered < 0 && view(sim, straight)?.edge.kind === 'connector') straightEntered = t;
      if (straightEntered >= 0 && straightCleared < 0 && w.holders[cStraight] === 0) straightCleared = t;
      if (view(sim, left)?.edge.kind === 'connector') leftEntered = t;
      expect(checkInvariants(sim)).toEqual([]);
    }
    expect(straightEntered).toBeGreaterThanOrEqual(0);
    expect(leftEntered).toBeGreaterThan(straightEntered);
    expect(leftEntered).toBeGreaterThanOrEqual(straightCleared);
  });

  it('lets a lone left turn go immediately', () => {
    const sim = new Simulation(crossDoc(120), { demand: false });
    const L = sim.graph.lanes[laneIdx(sim, 'N|f|0')]!.length;
    const left = sim.spawnVehicle('sedan', 'N|f|0', 'E|b|0', L - 3)!;
    let entered = -1;
    for (let t = 0; t < 200 && entered < 0; t++) {
      sim.step();
      if (view(sim, left)?.edge.kind === 'connector') entered = t;
    }
    expect(entered).toBeGreaterThanOrEqual(0);
    expect(entered).toBeLessThan(60);
  });

  it('releases a reservation only when the bus tail leaves the connector', () => {
    const sim = new Simulation(crossDoc(120), { demand: false });
    const L = sim.graph.lanes[laneIdx(sim, 'N|f|0')]!.length;
    const bus = sim.spawnVehicle('city-bus', 'N|f|0', 'S|b|0', L - 12)!;
    const c = connIdx(sim, 'N|f|0>S|b|0');
    const out = laneIdx(sim, 'S|b|0');
    const w = internals(sim);
    const busLen = w.types.get('city-bus')!.length;
    let sawHeldWithTailOn = false;
    let released = false;
    for (let t = 0; t < 20 * 30 && !released; t++) {
      sim.step();
      const v = view(sim, bus)!;
      if (v.edge.kind === 'lane' && v.edge.index === out) {
        if (v.s < busLen - 0.01) {
          expect(w.holders[c]).toBeGreaterThan(0);
          sawHeldWithTailOn = true;
        } else if (v.s > busLen + 1) {
          expect(w.holders[c]).toBe(0);
          released = true;
        }
      }
    }
    expect(sawHeldWithTailOn).toBe(true);
    expect(released).toBe(true);
  });

  it('never grants more exit space than the exit lane has (no blocking the box)', () => {
    // a ── b ── c (signal, red for BC for 60 s) with side arms; BC is a short 22 m exit lane.
    const doc = apply(createEmptyDoc('exit', 5), [
      { type: 'node.add', node: { id: 'a', pos: { x: -200, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'c', pos: { x: 30, z: 0 } } },
      { type: 'node.add', node: { id: 'cn', pos: { x: 30, z: -100 } } },
      { type: 'node.add', node: { id: 'cs', pos: { x: 30, z: 100 } } },
      { type: 'node.add', node: { id: 'ce', pos: { x: 130, z: 0 } } },
      { type: 'segment.add', segment: { id: 'AB', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'BC', a: 'b', b: 'c', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'CN', a: 'cn', b: 'c', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'CS', a: 'cs', b: 'c', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'CE', a: 'c', b: 'ce', roadTypeId: 'road-2' } },
      {
        type: 'intersection.set',
        // No crosswalks here: the test is about the exit lane length, which the crossing zone would shorten.
        control: { nodeId: 'c', kind: 'signal', crosswalkLegs: [], phases: [{ approaches: ['CN', 'CS'], green: 60 }, { approaches: ['BC', 'CE'], green: 20 }], yellow: 3, allRed: 2, offset: 0 },
      },
    ]);
    const sim = new Simulation(doc, { demand: false });
    const bc = laneIdx(sim, 'BC|f|0');
    const bcLen = sim.graph.lanes[bc]!.length;
    expect(bcLen).toBeCloseTo(22, 0);
    const ids: number[] = [];
    for (let k = 0; k < 5; k++) ids.push(sim.spawnVehicle('sedan', 'AB|f|0', 'CE|f|0', 190 - k * 12)!);
    expect(ids.every((id) => id !== null)).toBe(true);
    const w = internals(sim);
    for (let t = 0; t < 20 * 55; t++) {
      sim.step();
      expect(checkInvariants(sim)).toEqual([]);
      // Space promised + space used never exceeds the lane.
      const used = w.onEdge[bc]!.reduce((sum, v) => sum + v.len, 0);
      expect(w.reserved[bc]! + used).toBeLessThanOrEqual(bcLen + 1e-6);
    }
    // After the queue settles at the red light, nobody is left standing inside the junction at b.
    const vs = sim.vehicles();
    expect(vs.filter((v) => v.edge.kind === 'connector')).toEqual([]);
    const inBC = vs.filter((v) => v.edge.kind === 'lane' && v.edge.index === bc);
    expect(inBC.length).toBe(3);
    for (const v of inBC) expect(v.s - 4.6).toBeGreaterThanOrEqual(-1e-6);
  });
});
