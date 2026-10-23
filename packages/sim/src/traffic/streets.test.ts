import { describe, expect, it } from 'vitest';
import type { Command } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkInvariants, checkZoneInvariants, crossDoc, internals, lineDoc } from '../testkit.js';
import { PedSignal, SCHOOL_ZONE_SPEED, SPEED_BUMP_SPEED } from '../types.js';

const KMH = 1 / 3.6;
const laneIdx = (sim: Simulation, id: string): number => sim.graph.laneById.get(id)!;
const view = (sim: Simulation, id: number) => sim.vehicles().find((v) => v.id === id);
const opts = { demand: false, citizens: false };

describe('speed bumps and school zones', () => {
  it('slows to about 20 km/h over a speed bump without stopping', () => {
    const sim = new Simulation(lineDoc(400, 'road-2', [{ type: 'feature.upsert', feature: { id: 'bump', segmentId: 'ab', kind: 'speedBump', t: 0.5 } }]), opts);
    const id = sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 6)!;
    expect(id).not.toBeNull();
    let maxBefore = 0;
    let minNear = Infinity;
    let maxOver = 0;
    for (let t = 0; t < 20 * 60 && sim.stats().arrived === 0; t++) {
      sim.step();
      const v = view(sim, id);
      if (!v) break;
      if (v.s < 150) maxBefore = Math.max(maxBefore, v.v);
      if (v.s > 200 - 15 && v.s < 200 + 10) minNear = Math.min(minNear, v.v);
      if (v.s >= 200 && v.s - 4.6 <= 200) maxOver = Math.max(maxOver, v.v);
    }
    expect(sim.stats().arrived).toBe(1);
    expect(maxBefore).toBeGreaterThan(40 * KMH);
    // Crosses at the target speed: slowed down, but never close to a stop.
    expect(minNear).toBeGreaterThan(15 * KMH);
    expect(minNear).toBeLessThan(22 * KMH);
    expect(maxOver).toBeLessThanOrEqual(SPEED_BUMP_SPEED + 0.05);
  });

  it('keeps vehicles at or below 30 km/h inside a school zone', () => {
    const doc = apply(lineDoc(300), [
      { type: 'node.add', node: { id: 'c', pos: { x: 600, z: 0 } } },
      { type: 'segment.add', segment: { id: 'bc', a: 'b', b: 'c', roadTypeId: 'road-2' } },
      { type: 'segment.setSchoolZone', id: 'bc', schoolZone: true },
    ]);
    const sim = new Simulation(doc, opts);
    const id = sim.spawnVehicle('sedan', 'ab|f|0', 'bc|f|0', 6)!;
    const zone = laneIdx(sim, 'bc|f|0');
    let maxIn = 0;
    let maxOut = 0;
    for (let t = 0; t < 20 * 120 && sim.stats().arrived === 0; t++) {
      sim.step();
      const v = view(sim, id);
      if (!v) break;
      if (v.edge.kind === 'lane' && v.edge.index === zone) maxIn = Math.max(maxIn, v.v);
      else if (v.edge.kind === 'lane') maxOut = Math.max(maxOut, v.v);
    }
    expect(sim.stats().arrived).toBe(1);
    expect(maxOut).toBeGreaterThan(40 * KMH);
    expect(maxIn).toBeGreaterThan(25 * KMH);
    expect(maxIn).toBeLessThanOrEqual(SCHOOL_ZONE_SPEED + 1e-6);
  });
});

describe('allStop junctions', () => {
  it('makes every vehicle stop completely at the line and serves them in stop order', () => {
    const doc = apply(crossDoc(120), [{ type: 'intersection.set', control: { nodeId: 'c', kind: 'allStop', yellow: 3, allRed: 2, offset: 0 } }]);
    const sim = new Simulation(doc, opts);
    expect(sim.signals()).toEqual([]);
    const L = sim.graph.lanes[laneIdx(sim, 'W|f|0')]!.length;
    const first = sim.spawnVehicle('sedan', 'W|f|0', 'E|b|0', L - 30)!;
    const second = sim.spawnVehicle('sedan', 'N|f|0', 'S|b|0', L - 45)!;
    const stopDone = new Map<number, number>();
    const entered = new Map<number, number>();
    const fullStop = new Map<number, number>();
    for (let t = 0; t < 20 * 60 && entered.size < 2; t++) {
      sim.step();
      expect(checkInvariants(sim)).toEqual([]);
      for (const v of sim.vehicles()) {
        if (v.edge.kind === 'lane' && L - v.s <= 1.5 && v.v < 0.15) {
          fullStop.set(v.id, (fullStop.get(v.id) ?? 0) + 1);
          if (fullStop.get(v.id) === 10) stopDone.set(v.id, t);
        }
        if (v.edge.kind === 'connector' && !entered.has(v.id)) {
          entered.set(v.id, t);
          // Entered only after a complete stop (10 ticks at ≤ 1.5 m below 0.15 m/s).
          expect(stopDone.has(v.id)).toBe(true);
        }
      }
    }
    expect(entered.size).toBe(2);
    expect(stopDone.get(first)!).toBeLessThan(stopDone.get(second)!);
    expect(entered.get(first)!).toBeLessThan(entered.get(second)!);
    for (let t = 0; t < 20 * 60 && sim.stats().arrived < 2; t++) sim.step();
    expect(sim.stats().arrived).toBe(2);
  });

  it('breaks stop-order ties by vehicle id', () => {
    const doc = apply(crossDoc(120), [{ type: 'intersection.set', control: { nodeId: 'c', kind: 'allStop', yellow: 3, allRed: 2, offset: 0 } }]);
    const sim = new Simulation(doc, opts);
    const L = sim.graph.lanes[laneIdx(sim, 'W|f|0')]!.length;
    const a = sim.spawnVehicle('sedan', 'N|f|0', 'S|b|0', L - 30)!;
    const b = sim.spawnVehicle('sedan', 'W|f|0', 'E|b|0', L - 30)!;
    const entered: number[] = [];
    const w = internals(sim);
    for (let t = 0; t < 20 * 60 && entered.length < 2; t++) {
      sim.step();
      for (const v of w.vehicles) if (v.edge >= w.net.nLanes && !entered.includes(v.id)) entered.push(v.id);
    }
    expect(entered).toEqual([a, b]);
  });
});

describe('mid-block crosswalks (vehicles)', () => {
  const mid = (extra: Partial<{ signal: boolean }> = {}, cmds: Command[] = []) =>
    lineDoc(300, 'road-2', [{ type: 'feature.upsert', feature: { id: 'x', segmentId: 'ab', kind: 'crosswalk', t: 0.5, ...extra } }, ...cmds]);

  it('passes an empty unsignalized crosswalk without slowing down much and releases the zone behind it', () => {
    const sim = new Simulation(mid(), opts);
    const w = internals(sim);
    expect(w.zones.stopLanes.length).toBe(2);
    const p = w.zones.lane[laneIdx(sim, 'ab|f|0')]![0]!;
    expect(p.enterS).toBeLessThan(150 - 1.5);
    expect(p.exitS).toBeGreaterThan(150 + 1.5);
    const id = sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 60)!;
    let minNear = Infinity;
    let held = false;
    for (let t = 0; t < 20 * 40 && sim.stats().arrived === 0; t++) {
      sim.step();
      expect(checkZoneInvariants(sim)).toEqual([]);
      const v = view(sim, id);
      if (!v) break;
      if (v.s > p.enterS - 20 && v.s < p.exitS) minNear = Math.min(minNear, v.v);
      if (w.zs.veh[0]! > 0) held = true;
      if (v.s - 4.6 > p.exitS + 0.5) expect(w.zs.veh[0]).toBe(0);
    }
    expect(held).toBe(true);
    expect(minNear).toBeGreaterThan(30 * KMH);
  });

  it('stops at a red mid-block signal and goes on green', () => {
    const sim = new Simulation(mid({ signal: true }), opts);
    const w = internals(sim);
    expect(w.signals.mids.length).toBe(1);
    const m = w.signals.mids[0]!;
    // Cycle: 30 s green, 3 s yellow, then WALK 7 s and CLEARANCE ⌈7 m / 1 m/s⌉ = 7 s.
    expect(m.cycle).toBe(20 * (30 + 3 + 7 + 7));
    // Two heads (one per lane) appear in the snapshot signal array.
    expect(sim.snapshot().signalCount).toBe(2);
    for (let t = 0; t < 20 * 29; t++) sim.step();
    const p = w.zones.lane[laneIdx(sim, 'ab|f|0')]![0]!;
    const id = sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', p.enterS - 40)!;
    let stoppedAtRed = false;
    let passedTick = -1;
    const sigs: number[] = [];
    for (let t = 0; t < 20 * 40 && passedTick < 0; t++) {
      sim.step();
      sigs.push(w.zs.pedSig[0]!);
      const v = view(sim, id)!;
      const color = w.zs.midColor[0]!;
      if (v.s > p.enterS + 1e-6) {
        passedTick = sim.stats().tick;
        expect(w.vehicles[0]!.zones.length).toBeGreaterThan(0);
      } else if (color === 0 && v.v < 0.1) stoppedAtRed = true;
      expect(checkZoneInvariants(sim)).toEqual([]);
    }
    expect(stoppedAtRed).toBe(true);
    // Goes when the next cycle's green starts (tick 940).
    expect(passedTick).toBeGreaterThanOrEqual(m.cycle);
    expect(passedTick).toBeLessThan(m.cycle + 20 * 6);
    expect(sigs).toContain(PedSignal.walk);
    expect(sigs).toContain(PedSignal.clearance);
  });

  it('makes vehicles stop completely before an unsignalized school-zone crosswalk', () => {
    const sim = new Simulation(mid({}, [{ type: 'segment.setSchoolZone', id: 'ab', schoolZone: true }]), opts);
    const w = internals(sim);
    const p = w.zones.lane[laneIdx(sim, 'ab|f|0')]![0]!;
    const id = sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 60)!;
    let fullStop = 0;
    let passed = false;
    for (let t = 0; t < 20 * 60 && !passed; t++) {
      sim.step();
      const v = view(sim, id)!;
      if (p.enterS - v.s <= 1.5 && p.enterS - v.s >= 0 && v.v < 0.15) fullStop++;
      if (v.s > p.enterS + 1e-6) passed = true;
    }
    expect(passed).toBe(true);
    expect(fullStop).toBeGreaterThanOrEqual(10);
  });
});

describe('pedestrian signal timing', () => {
  it('walks 7 s then clears for ⌈L / 1 m/s⌉ s and stretches short greens', () => {
    const sim = new Simulation(crossDoc(150, 'road-6'), opts);
    const w = internals(sim);
    const plan = w.signals.plans[0]!;
    // 6 lanes × 3.5 m = 21 m → clearance 21 s; green max(20, 7 + 21 − 3) = 25 s.
    expect(plan.intervals[0]!.end - plan.intervals[0]!.start).toBe(25 * 20);
    const green0 = plan.phases[0]!.approaches;
    const walkLegs = ['N', 'S', 'E', 'W'].filter((s) => !green0.includes(s));
    const z = (leg: string) => sim.graph.crossings.find((c) => c.id === `c|${leg}`)!.index;
    const seq: Record<string, number[]> = {};
    for (const leg of ['N', 'S', 'E', 'W']) seq[leg] = [];
    for (let t = 0; t < plan.intervals[1]!.end; t++) {
      sim.step();
      for (const leg of ['N', 'S', 'E', 'W']) seq[leg]!.push(w.zs.pedSig[z(leg)]!);
    }
    for (const leg of walkLegs) {
      const s = seq[leg]!;
      expect(s.filter((x) => x === PedSignal.walk).length).toBe(7 * 20);
      expect(s.filter((x) => x === PedSignal.clearance).length).toBe(21 * 20);
      expect(s[0]).toBe(PedSignal.walk);
    }
    for (const leg of green0) expect(new Set(seq[leg])).toEqual(new Set([PedSignal.red]));
    // Unsignalized junctions show no pedestrian signal.
    const un = new Simulation(apply(crossDoc(120), [{ type: 'intersection.set', control: { nodeId: 'c', kind: 'uncontrolled', yellow: 3, allRed: 2, offset: 0 } }]), opts);
    un.step();
    expect(Array.from(internals(un).zs.pedSig)).toEqual([3, 3, 3, 3]);
    const snap = un.snapshot();
    expect(snap.crossingCount).toBe(4);
    expect(snap.crossings[0]).toBe(PedSignal.none);
  });

  it('reserves the crossing zones of a connector with its grant and releases them behind the tail', () => {
    const sim = new Simulation(crossDoc(120), opts);
    const L = sim.graph.lanes[laneIdx(sim, 'N|f|0')]!.length;
    // Southbound right turn N → W passes the N and W crossings.
    const id = sim.spawnVehicle('sedan', 'N|f|0', 'W|b|0', L - 20)!;
    const w = internals(sim);
    const zn = sim.graph.crossings.find((c) => c.id === 'c|N')!.index;
    const zw = sim.graph.crossings.find((c) => c.id === 'c|W')!.index;
    let both = false;
    for (let t = 0; t < 20 * 30 && sim.stats().arrived === 0; t++) {
      sim.step();
      expect(checkZoneInvariants(sim)).toEqual([]);
      if (w.zs.veh[zn] === 1 && w.zs.veh[zw] === 1) both = true;
      const v = view(sim, id);
      if (v && v.edge.kind === 'lane' && v.edge.index === laneIdx(sim, 'W|b|0') && v.s > 10) expect(Array.from(w.zs.veh)).toEqual([0, 0, 0, 0]);
    }
    expect(both).toBe(true);
  });
});
