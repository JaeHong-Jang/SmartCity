// Pedestrian-only phase (보행 전용 위상, ADR 0009 §3).

import { describe, expect, it } from 'vitest';
import type { Command } from '@smartcity/shared';
import { spawnWalker } from '../citizens/peds.js';
import { Simulation } from '../simulation.js';
import { apply, checkInvariants, checkZoneInvariants, crossDoc, internals, pedestriansOnCrossings } from '../testkit.js';
import { PedSignal } from '../types.js';

const opts = { demand: false, citizens: false };
const SCRAMBLE: Command = { type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: true } };
const zoneOf = (sim: Simulation, id: string): number => sim.graph.crossings.find((c) => c.id === id)!.index;

describe('pedestrian-only phase (scramble)', () => {
  it('appends an all-red phase where every crosswalk walks 7 s then clears ⌈longest / 1 m/s⌉ s; no WALK in vehicle phases', () => {
    // Leg E is a 6-lane road (21 m crossing), the others 2-lane (7 m): clearance 21 s for every leg.
    const doc = apply(crossDoc(120), [{ type: 'segment.setType', id: 'E', roadTypeId: 'road-6' }, SCRAMBLE]);
    const sim = new Simulation(doc, opts);
    const w = internals(sim);
    const plan = w.signals.plans[0]!;
    expect(plan.phases).toHaveLength(3);
    expect(plan.phases[2]!.approaches).toEqual([]);
    // Vehicle phases keep their 20 s green (not stretched for pedestrians), yellow 3 s, all-red 2 s.
    const iv = plan.intervals.map((x) => [x.phase, x.color, (x.end - x.start) / 20]);
    expect(iv).toEqual([
      [0, 'green', 20],
      [0, 'yellow', 3],
      [0, 'allRed', 2],
      [1, 'green', 20],
      [1, 'yellow', 3],
      [1, 'allRed', 2],
      [2, 'allRed', 28],
    ]);
    const view = sim.signals()[0]!;
    expect(view.cycle).toBe(78);
    expect(view.scramble).toBe(true);
    const zs = ['N', 'S', 'E', 'W'].map((l) => zoneOf(sim, `c|${l}`));
    const heads = plan.heads.map((h) => h.lane);
    let walk = 0;
    let clear = 0;
    let pedPhaseTicks = 0;
    for (let t = 0; t < plan.cycle; t++) {
      sim.step();
      const sig = zs.map((z) => w.zs.pedSig[z]!);
      const anyGreen = heads.some((l) => w.laneGreen[l] === 1);
      // All crosswalks show the same signal at once.
      expect(new Set(sig).size).toBe(1);
      if (anyGreen) expect(sig[0]).toBe(PedSignal.red);
      if (sim.signals()[0]!.phaseIndex === 2) {
        pedPhaseTicks++;
        expect(anyGreen).toBe(false);
      }
      if (sig[0] === PedSignal.walk) walk++;
      if (sig[0] === PedSignal.clearance) clear++;
    }
    expect(pedPhaseTicks).toBe(28 * 20);
    expect(walk).toBe(7 * 20);
    expect(clear).toBe(21 * 20);
  });

  it('is ignored at build time when later edits break the condition (fewer than 2 crosswalk legs)', () => {
    const bare = { id: 'bare', name: 'bare', lanesForward: 1, lanesBackward: 1, laneWidth: 3.5, speedLimit: 50 / 3.6, sidewalk: false, busOnlyRightLane: false };
    const doc = apply(crossDoc(120), [SCRAMBLE]);
    const sim = new Simulation(doc, opts);
    expect(internals(sim).signals.plans[0]!.phases).toHaveLength(3);
    expect(
      sim.applyCommand({
        type: 'batch',
        commands: [{ type: 'roadType.upsert', roadType: bare }, ...['N', 'S', 'E'].map((id) => ({ type: 'segment.setType' as const, id, roadTypeId: 'bare' }))],
      }).ok,
    ).toBe(true);
    sim.step();
    const plan = internals(sim).signals.plans[0]!;
    expect(sim.doc.intersections.c!.scramble).toBe(true);
    expect(plan.scramble).toBe(false);
    expect(plan.phases).toHaveLength(2);
    expect(sim.signals()[0]!.scramble).toBe(false);
    // The remaining crosswalk walks with a vehicle phase again (normal rule).
    expect(plan.peds).toHaveLength(1);
    expect(plan.peds[0]!.walks.some(Boolean)).toBe(true);
  });

  it('keeps vehicles out while a slow pedestrian is still on the crosswalk after the phase ends', () => {
    const sim = new Simulation(apply(crossDoc(120), [SCRAMBLE]), opts);
    const w = internals(sim);
    sim.step();
    const first = sim.signals()[0]!.greenApproaches;
    const leg = first[0]!;
    const z = zoneOf(sim, `c|${leg}`);
    const pg = w.ped.pg;
    const e = pg.crossingEdge[z]!;
    // 0.3 m/s over a 7 m crossing: still on it when the next vehicle phase turns green.
    spawnWalker(w, pg.from[e]!, pg.to[e]!, 0.3);
    const opp = first[1]!;
    const lane = `${leg}|f|0`;
    const L = sim.graph.lanes[sim.graph.laneById.get(lane)!]!.length;
    let veh = -1;
    let onTicks = 0;
    let lastOn = -1;
    let greenWhileOn = false;
    let entered = -1;
    const plan = w.signals.plans[0]!;
    for (let t = 1; t < 3 * plan.cycle && entered < 0; t++) {
      // Put the car at the stop line once the pedestrian phase has started.
      if (veh < 0 && sim.signals()[0]!.phaseIndex === 2) veh = sim.spawnVehicle('sedan', lane, `${opp}|b|0`, L - 10)!;
      sim.step();
      expect(checkZoneInvariants(sim)).toEqual([]);
      expect(checkInvariants(sim)).toEqual([]);
      const on = pedestriansOnCrossings(sim)[z]!;
      if (on > 0) {
        onTicks++;
        lastOn = t;
        expect(w.zs.pedSig[z] === PedSignal.walk || onTicks > 1).toBe(true);
        if (sim.signals()[0]!.greenApproaches.includes(leg)) greenWhileOn = true;
      }
      const v = veh >= 0 ? sim.vehicles().find((x) => x.id === veh) : undefined;
      if (v && v.edge.kind === 'connector') entered = t;
    }
    expect(onTicks).toBeGreaterThan(14 * 20);
    expect(greenWhileOn).toBe(true);
    expect(entered).toBeGreaterThan(lastOn);
  });
});
