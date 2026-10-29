// Golden traces: fixed seeds and command scripts, hashed snapshot bytes + stats every tick. Optimizations
// must keep these hashes (behaviour-preserving refactors). To re-record after an intended behaviour
// change, run with GOLDEN_PRINT=1 and paste the printed values.

import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type Command } from '@smartcity/shared';
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
function trace(sim: Simulation, ticks: number, every: number, script: Record<number, Command[]>, transit = false): { hashes: string[]; maxPeds: number } {
  const out: string[] = [];
  let maxPeds = 0;
  let h = 0x811c9dc5;
  let buf = sim.snapshot();
  for (let t = 0; t < ticks; t++) {
    for (const c of script[t] ?? []) expect(sim.applyCommand(c)).toEqual({ ok: true });
    sim.step();
    buf = sim.snapshot(buf);
    h = hashSnapshot(h, buf);
    // Bus passengers (ADR 0009 §2), only in traces recorded with them.
    if (transit) {
      h = fnv(h, new Uint8Array(buf.busLoad.buffer, 0, buf.vehicleCount * 2));
      h = fnv(h, new Uint8Array(buf.stopWaiting.buffer, 0, buf.busStopIds.length * 2));
    }
    maxPeds = Math.max(maxPeds, buf.pedestrianCount);
    if ((t + 1) % every === 0) out.push(h.toString(16));
  }
  return { hashes: out, maxPeds };
}

const PRINT = process.env.GOLDEN_PRINT === '1';

describe('golden traces (behaviour-preserving optimizations)', () => {
  // Phase 3b (ADR 0009 §2) adds bus stop nodes to the pedestrian graph and the passenger model. In this
  // 300 m city no bus estimate beats walking, so the trace kept its Phase 3a hashes; passengers are covered
  // by the corridor trace below.
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

  // Phase 3b regression (ADR 0009 "결과"): bus stops without any line and signals without `scramble` must
  // behave exactly as in Phase 3a. Recorded before the passenger model and the pedestrian-only phase landed.
  it('small city without bus lines or scramble: identical to Phase 3a', () => {
    const doc = apply(cityDoc(), [
      { type: 'busStop.add', stop: { id: 's1', segmentId: 'h_0_1', t: 0.5, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 's2', segmentId: 'h_1_1', t: 0.5, dir: 'forward' } },
      { type: 'feature.upsert', feature: { id: 'cw', segmentId: 'v_1_0', kind: 'crosswalk', t: 0.5, signal: true } },
      { type: 'intersection.set', control: { nodeId: 'n_1_1', kind: 'signal', yellow: 3, allRed: 2, offset: 0, scramble: false } },
    ]);
    doc.meta.trafficDensity = 2;
    const sim = new Simulation(doc);
    const { hashes: got, maxPeds } = trace(sim, 7200, 900, {
      1500: [{ type: 'busStop.add', stop: { id: 's3', segmentId: 'v_1_1', t: 0.4, dir: 'backward' } }],
      3000: [{ type: 'busStop.remove', id: 's1' }],
    });
    if (PRINT) console.log('no lines', JSON.stringify(got));
    expect(maxPeds).toBeGreaterThan(20);
    expect(got).toEqual(NO_LINES);
  }, 120_000);

  it('bus corridor: passengers queue, board, ride and alight; a line edit and a stop removal mid-run', () => {
    const doc = apply(createEmptyDoc('corridor', 21), [
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 1600, z: 0 } } },
      { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      { type: 'building.place', building: { id: 'apt', typeId: 'apartment', pos: { x: 100, z: 35 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'office', typeId: 'office-tower', pos: { x: 1500, z: 40 }, rotation: 0 } },
      { type: 'busStop.add', stop: { id: 'Af', segmentId: 'ab', t: 0.0625, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'Bf', segmentId: 'ab', t: 0.9375, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'Bb', segmentId: 'ab', t: 0.9375, dir: 'backward' } },
      { type: 'busStop.add', stop: { id: 'Ab', segmentId: 'ab', t: 0.0625, dir: 'backward' } },
      { type: 'busLine.upsert', line: { id: 'L', name: '1', color: '#22aa44', stopIds: ['Af', 'Bf', 'Bb', 'Ab'], vehicleTypeId: 'city-bus', buses: 2 } },
    ]);
    doc.meta.trafficDensity = 0.5;
    const sim = new Simulation(doc);
    let riders = 0;
    const { hashes: got } = trace(
      sim,
      9000,
      900,
      {
        5000: [{ type: 'busLine.upsert', line: { id: 'L', name: '1', color: '#22aa44', stopIds: ['Af', 'Bf', 'Bb', 'Ab'], vehicleTypeId: 'city-bus', buses: 3 } }],
        7000: [{ type: 'busStop.remove', id: 'Bb' }],
      },
      true,
    );
    for (const v of sim.vehicles()) riders += v.passengers ?? 0;
    if (PRINT) console.log('bus corridor', JSON.stringify(got));
    expect(riders + sim.stats().citizens.waitingBus).toBeGreaterThan(0);
    expect(got).toEqual(BUS_CORRIDOR);
  }, 120_000);

  // Safe plan changes (ADR 0010 §4, traffic/signalClearing.ts) changed this trace from tick 900 on (hashes
  // 4–8; 1–3 unchanged): the node move at 900 changes the plan identity of 5 junctions (automatic phase order
  // and two crosswalk clearances) and the split at 1300 the approach ids at 2 — those now go through yellow,
  // all red and pedestrian clearance, then restart at their first phase. The crosswalk (400) and the
  // closure (1700) keep every identity; the removal at 2000 hits its two junctions in their last all-red tick.
  // Safety of the new behaviour: traffic/signalEdits.test.ts (same script under the per-tick checker).
  // Re-recorded again (hashes 4–8) for clearance sufficiency (Sol 4c2-② R3): the node move at 900 lengthens
  // crosswalks n_3_2|v_3_2 and n_3_3|v_3_2 (14 → 15 s) while they flash CLEARANCE (since 640); their
  // clearance now runs to 940 instead of 920 (the junctions' clearings 20 ticks longer). Without the
  // extension the checker reports both ("cleared 280 ticks, its length needs 300").
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

  // ADR 0013: roadside sensors feed only the detection model. The same dense-grid script with sensors in the
  // doc, sensor edits mid-run and sensors cascading with the split / removal keeps the recorded hashes.
  it('dense grid with sensors and sensor edits: identical to the trace without them', () => {
    const cam = (id: string, segmentId: string, t: number) => ({ id, kind: 'cctv' as const, segmentId, t, side: 'right' as const, heading: 0, fov: Math.PI / 2, range: 120 });
    const doc = apply(gridDoc(7, 120, 'road-4', 11), [
      { type: 'sensor.place', sensor: cam('s1', 'v_4_2', 0.3) },
      { type: 'sensor.place', sensor: cam('s2', 'v_5_5', 0.5) },
      { type: 'sensor.place', sensor: { ...cam('s3', 'h_2_3', 0.7), kind: 'smartpole', fov: 2 * Math.PI, range: 40 } },
    ]);
    doc.meta.trafficDensity = 3;
    const sim = new Simulation(doc, { maxVehicles: 1500 });
    const { hashes: got } = trace(sim, 2400, 300, {
      200: [{ type: 'sensor.place', sensor: cam('s4', 'h_1_1', 0.5) }],
      400: [{ type: 'feature.upsert', feature: { id: 'f1', segmentId: 'h_2_3', kind: 'crosswalk', t: 0.5, signal: true } }],
      600: [{ type: 'sensor.update', id: 's1', heading: 1, range: 60 }],
      900: [{ type: 'node.move', id: 'n_3_3', pos: { x: 5, z: -4 } }],
      1300: [{ type: 'segment.split', id: 'v_4_2', t: 0.5, nodeId: 'mid', segmentIds: ['v_4_2a', 'v_4_2b'] }],
      1500: [{ type: 'batch', commands: [{ type: 'sensor.remove', id: 's3' }, { type: 'sensor.place', sensor: cam('s5', 'v_4_2b', 0.5) }] }],
      1700: [{ type: 'closure.set', closure: { segmentId: 'h_1_1', reason: 'golden' } }],
      2000: [{ type: 'segment.remove', id: 'v_5_5' }],
    });
    expect(Object.keys(sim.doc.sensors).sort()).toEqual(['s1', 's4', 's5']);
    expect(sim.doc.sensors.s1!.segmentId).toBe('v_4_2a');
    expect(got).toEqual(DENSE_GRID);
  }, 120_000);
});

const SMALL_CITY = ["abd22600","7be520d5","3473c037","c963d2b5","d8785a55","77e12fe8","48845201","77c6691","f9cf5552","321bf933","f77774f3","8f7ec53e"];
const DENSE_GRID = ["53671d38","a711768","93e5a844","6a1c978d","b2473e19","75df7052","2eecec38","dae04c0"];
const NO_LINES = ["8863d04b","880f1ab2","b3af70f5","320000a9","8f7b1bf8","f0b3eb82","a1ceba0b","c55fdc77"];
const BUS_CORRIDOR = ["fc6cbbff","e9d05de9","64ae7cb2","4ad71dff","e532dcbe","159290f4","c0bd4582","78bbdad6","6fb1e2a0","65af2598"];
