// Golden traces: fixed seeds and command scripts, hashed snapshot bytes + stats every tick. Optimizations
// must keep these hashes (behaviour-preserving refactors). To re-record after an intended behaviour
// change, run with GOLDEN_PRINT=1 and paste the printed values.

import { describe, expect, it } from 'vitest';
import type { Command } from '@smartcity/shared';
import { Simulation } from './simulation.js';
import { apply, cityDoc, gridDoc } from './testkit.js';
import { CROSSING_STRIDE, PED_STRIDE, SIGNAL_STRIDE, VEHICLE_STRIDE, type SimSnapshot } from './types.js';

declare const process: { env: Record<string, string | undefined> };
declare const console: { log(...args: unknown[]): void };

function fnv(h: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return h >>> 0;
}

const bytes = (a: Float32Array | Uint32Array, n: number): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, n * 4);

function hashSnapshot(h: number, s: SimSnapshot): number {
  h = fnv(h, bytes(s.vehicles, s.vehicleCount * VEHICLE_STRIDE));
  h = fnv(h, bytes(s.signals, s.signalCount * SIGNAL_STRIDE));
  h = fnv(h, bytes(s.laneFlow, s.laneFlow.length));
  h = fnv(h, bytes(s.pedestrians, s.pedestrianCount * PED_STRIDE));
  h = fnv(h, bytes(s.pedestrianIds, s.pedestrianCount));
  h = fnv(h, bytes(s.crossings, s.crossingCount * CROSSING_STRIDE));
  h = fnv(h, bytes(s.occupancy, s.buildingIds.length));
  const meta = JSON.stringify([s.tick, s.graphRevision, s.crossingSig, s.vehicleTypeIds, s.buildingIds, s.stats]);
  for (let i = 0; i < meta.length; i++) h = Math.imul(h ^ meta.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Runs `ticks` steps, applying `script[tick]` before the step; returns hashes at every `every` ticks. */
function trace(sim: Simulation, ticks: number, every: number, script: Record<number, Command[]>): { hashes: string[]; maxPeds: number } {
  const out: string[] = [];
  let maxPeds = 0;
  let h = 0x811c9dc5;
  let buf = sim.snapshot();
  for (let t = 0; t < ticks; t++) {
    for (const c of script[t] ?? []) expect(sim.applyCommand(c)).toEqual({ ok: true });
    sim.step();
    buf = sim.snapshot(buf);
    h = hashSnapshot(h, buf);
    maxPeds = Math.max(maxPeds, buf.pedestrianCount);
    if ((t + 1) % every === 0) out.push(h.toString(16));
  }
  return { hashes: out, maxPeds };
}

const PRINT = process.env.GOLDEN_PRINT === '1';

describe('golden traces (behaviour-preserving optimizations)', () => {
  it('small city: citizens, bus line, street features, edits that recompile', () => {
    const doc = apply(cityDoc(), [
      { type: 'busStop.add', stop: { id: 's1', segmentId: 'h_0_1', t: 0.5, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 's2', segmentId: 'h_1_1', t: 0.5, dir: 'forward' } },
      { type: 'busLine.upsert', line: { id: 'L', name: '1', color: '#22aa44', stopIds: ['s1', 's2'], vehicleTypeId: 'city-bus', buses: 2 } },
      { type: 'feature.upsert', feature: { id: 'cw', segmentId: 'v_1_0', kind: 'crosswalk', t: 0.5, signal: true } },
      { type: 'feature.upsert', feature: { id: 'bump', segmentId: 'h_0_0', kind: 'speedBump', t: 0.5 } },
    ]);
    doc.meta.trafficDensity = 2;
    const sim = new Simulation(doc);
    const { hashes: got, maxPeds } = trace(sim, 7200, 600, {
      600: [{ type: 'feature.upsert', feature: { id: 'cw2', segmentId: 'v_2_1', kind: 'crosswalk', t: 0.5 } }],
      1500: [{ type: 'segment.setSchoolZone', id: 'h_1_2', schoolZone: true }],
      2500: [{ type: 'intersection.set', control: { nodeId: 'n_1_1', kind: 'allStop', yellow: 3, allRed: 1, offset: 0 } }],
      3800: [{ type: 'feature.remove', id: 'bump' }],
      4200: [{ type: 'building.remove', id: 'shop2' }],
    });
    if (PRINT) console.log('small city', JSON.stringify(got));
    // The script must exercise walking citizens (morning commute) and the bus line.
    expect(maxPeds).toBeGreaterThan(20);
    expect(sim.vehicles().some((v) => v.busLineId === 'L')).toBe(true);
    expect(got).toEqual(SMALL_CITY);
  }, 120_000);

  it('dense grid: heavy traffic, signals, splits and node moves', () => {
    const doc = gridDoc(7, 120, 'road-4', 11);
    doc.meta.trafficDensity = 3;
    const sim = new Simulation(doc, { maxVehicles: 1500 });
    const { hashes: got } = trace(sim, 2400, 300, {
      400: [{ type: 'feature.upsert', feature: { id: 'f1', segmentId: 'h_2_3', kind: 'crosswalk', t: 0.5, signal: true } }],
      900: [{ type: 'node.move', id: 'n_3_3', pos: { x: 5, z: -4 } }],
      1300: [{ type: 'segment.split', id: 'v_4_2', t: 0.5, nodeId: 'mid', segmentIds: ['v_4_2a', 'v_4_2b'] }],
      1700: [{ type: 'closure.set', closure: { segmentId: 'h_1_1', reason: 'golden' } }],
      2000: [{ type: 'segment.remove', id: 'v_5_5' }],
    });
    if (PRINT) console.log('dense grid', JSON.stringify(got));
    expect(got).toEqual(DENSE_GRID);
  }, 120_000);
});

const SMALL_CITY = ["abd22600","7be520d5","3473c037","c963d2b5","d8785a55","77e12fe8","48845201","77c6691","f9cf5552","321bf933","f77774f3","8f7ec53e"];
const DENSE_GRID = ["53671d38","a711768","93e5a844","953b91d1","525b3568","bd3ff771","c1112f13","706cdc0a"];
