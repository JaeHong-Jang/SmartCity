// The sample new town (ADR 0014 §7) as the simulation sees it: every building reaches a sidewalk and a road
// (no inner complex roads), both bus lines have a route between every pair of consecutive stops in both
// directions, and a few minutes of traffic run without invariant violations within the load budget.

import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, sampleCityPlan } from '@smartcity/shared';
import { groupKey } from './network/net.js';
import { Router } from './network/route.js';
import { Simulation } from './simulation.js';
import { checkCitizenInvariants, checkInvariants, internals } from './testkit.js';
import { laneSAtT } from './traffic/demand.js';

function sampleDoc() {
  const doc = createEmptyDoc('sample', 7);
  expect(applyCommand(doc, sampleCityPlan().batch)).toEqual({ ok: true });
  return doc;
}

describe('sample new town in the simulation', () => {
  it('gives every building pedestrian access and a vehicle access road', () => {
    const doc = sampleDoc();
    const w = internals(new Simulation(doc));
    const ids = Object.keys(doc.buildings).sort();
    expect(w.ped.pg.buildingIds).toEqual(ids);
    const noDoor = ids.filter((_, i) => w.ped.pg.access[i] === null);
    expect(noDoor).toEqual([]);
    const noRoad = ids.filter((id) => !w.demand.access.has(id));
    expect(noRoad).toEqual([]);
  });

  it('routes both bus lines stop to stop, out on one side and back on the other', () => {
    const doc = sampleDoc();
    const w = internals(new Simulation(doc));
    const router = new Router(w.net);
    const stopped = new Int32Array(w.net.nLanes);
    const at = (stopId: string): { lane: number; s: number } => {
      const stop = doc.busStops[stopId]!;
      const lanes = w.net.groups.get(groupKey(stop.segmentId, stop.dir))!;
      const lane = lanes[lanes.length - 1]!;
      return { lane, s: laneSAtT(w.net, lane, stop.t) };
    };
    for (const line of Object.values(doc.busLines)) {
      const dirs = new Set(line.stopIds.map((id) => doc.busStops[id]!.dir));
      expect([...dirs].sort()).toEqual(['backward', 'forward']);
      for (let k = 0; k < line.stopIds.length; k++) {
        const from = at(line.stopIds[k]!);
        const to = at(line.stopIds[(k + 1) % line.stopIds.length]!);
        const route = router.find(from.lane, from.s, [{ lane: to.lane, destS: to.s }], true, stopped);
        expect(route, `${line.id}: ${line.stopIds[k]} → next`).not.toBeNull();
      }
    }
  });

  it('runs traffic, buses and citizens for three minutes without invariant violations', () => {
    const doc = sampleDoc();
    const sim = new Simulation(doc);
    const ticks = 180 * 20;
    for (let t = 1; t <= ticks; t++) {
      sim.step();
      if (t % 200 === 0) {
        expect(checkInvariants(sim)).toEqual([]);
        expect(checkCitizenInvariants(sim)).toEqual([]);
      }
    }
    const st = sim.stats();
    const buses = sim.vehicles().filter((v) => v.busLineId).length;
    expect(buses).toBe(12);
    expect(st.vehicles).toBeGreaterThan(buses);
    // Load budget: the P6 benchmark city was measured with about 3,000 vehicles (docs/perf/p6-baseline.md).
    expect(st.vehicles).toBeLessThan(3000);
    expect(st.citizens.total).toBeLessThanOrEqual(8000);
  }, 120_000);
});
