// P8a (ADR 0015 §2 "기존 tick 효과를 보존하는 어댑터"): the control frame must not change a single byte of the
// simulator mode. These fingerprints were recorded on main 11c7f04 (before src/control/ existed) and cover
// detection (legacy / reports / sensors), dispatch, pre-emption, re-routing, blackouts with batteries, a
// runtime policy change, edits during events and record replays with the comparison presets. Each tick
// hashes the snapshot buffers, the drained outcome stream, and (every 10 ticks) the KPI and the scenario
// view fields that existed before P8a. To re-record after an INTENDED behaviour change: SCENARIO_PRINT=1.

import { describe, expect, it } from 'vitest';
import { cloneJson, type CityDoc, type Command, type Sensor } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, cityDoc, crossDoc, gridDoc } from '../testkit.js';
import { CROSSING_STRIDE, PED_STRIDE, SIGNAL_STRIDE, VEHICLE_STRIDE, type SimSnapshot } from '../types.js';
import { COMPARISON_PRESETS, simulationFromRecord, type ReplayOptions } from '../scenario/record.js';
import type { ResponsePolicy, ScenarioInput, ScenarioKpi, ScenarioRecord } from '../scenario/types.js';

declare const process: { env: Record<string, string | undefined> };
declare const console: { log(...args: unknown[]): void };

const PRINT = process.env.SCENARIO_PRINT === '1';

/** ScenarioView fields as of 11c7f04 (fields added later are not part of the recorded fingerprint). */
const VIEW_KEYS = ['graphRevision', 'obstacles', 'closedLanes', 'kpi', 'activeEvents', 'recentLog', 'incidents', 'damagedBuildings', 'dispatches', 'preempted', 'blackouts', 'darkJunctions', 'darkCrossings', 'battery', 'unpoweredBuildings', 'undetected'] as const;

function fnvBytes(h: number, b: Uint8Array): number {
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
  return h >>> 0;
}
function fnvText(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
const bytes = (a: Float32Array | Uint32Array, n: number): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, n * 4);

function hashSnap(h: number, s: SimSnapshot, withView: boolean): number {
  h = fnvBytes(h, bytes(s.vehicles, s.vehicleCount * VEHICLE_STRIDE));
  h = fnvBytes(h, bytes(s.signals, s.signalCount * SIGNAL_STRIDE));
  h = fnvBytes(h, bytes(s.pedestrians, s.pedestrianCount * PED_STRIDE));
  h = fnvBytes(h, bytes(s.crossings, s.crossingCount * CROSSING_STRIDE));
  h = fnvText(h, JSON.stringify([s.tick, s.stats]));
  if (withView && s.scenario) {
    const v = s.scenario as unknown as Record<string, unknown>;
    h = fnvText(h, JSON.stringify(VIEW_KEYS.map((k) => v[k])));
  }
  return h;
}

/** Steps `ticks`, `each(t)` before every step; a hash every `every` ticks. */
function fingerprint(sim: Simulation, ticks: number, every: number, each?: (t: number) => void): Run {
  const out: string[] = [];
  let h = 0x811c9dc5;
  let buf = sim.snapshot();
  for (let t = 0; t < ticks; t++) {
    each?.(t);
    sim.step();
    buf = sim.snapshot(buf);
    h = hashSnap(h, buf, t % 10 === 9);
    h = fnvText(h, JSON.stringify(sim.drainScenarioOutcomes()));
    if (t % 10 === 9) h = fnvText(h, JSON.stringify(sim.kpi()));
    if ((t + 1) % every === 0) out.push(h.toString(16));
  }
  return { hashes: out, kpi: sim.kpi() };
}

interface Run {
  hashes: string[];
  kpi: ScenarioKpi;
}

const place = (id: string, typeId: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
const cam = (id: string, segmentId: string, t: number, over: Partial<Sensor> = {}): Sensor => ({ id, kind: 'cctv', segmentId, t, side: 'right', heading: 0, fov: Math.PI / 2, range: 120, ...over });
const input = (eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}, order = 0): ScenarioInput => ({ eventId, tick, order, kind, target, params });

/** 4 × 4 grid with a fire station, hospital, two homes and two sensors (detection.test.ts `town` + COVER). */
function town(): CityDoc {
  const doc = apply(gridDoc(4, 150, 'road-4', 4), [
    place('fs', 'svc-fire-station', -150, -150),
    place('h', 'svc-hospital', 150, -150),
    place('home', 'house', -150, 20),
    place('flat', 'house', 0, 170),
    place('apt', 'apartment', 150, 150),
    place('office', 'office-tower', 0, -150),
    { type: 'sensor.place', sensor: cam('cam', 'h_1_1', 0.15) },
    { type: 'sensor.place', sensor: cam('house-cam', 'v_1_1', 0.5, { heading: Math.PI / 2, range: 150 }) },
  ]);
  doc.meta.trafficDensity = 4;
  return doc;
}
const TOWN_SCRIPT: ScenarioInput[] = [
  input('acc', 100, 'accident.start', { segmentId: 'h_1_1', lane: 0 }, { durationTicks: 1800 }),
  input('acc2', 100, 'accident.start', { segmentId: 'h_1_1', lane: 1 }, { durationTicks: 30000 }),
  input('clo', 250, 'closure.start', { segmentId: 'v_2_1' }, { durationTicks: 900 }),
  input('fire', 300, 'fire.start', { buildingId: 'home' }, { burnTicks: 40000, suppressTicks: 300 }),
  input('med', 400, 'medical.start', { buildingId: 'flat' }),
  input('fire2', 1200, 'fire.start', { buildingId: 'flat' }, { burnTicks: 900 }),
  input('acc2-end', 2200, 'accident.end', { eventId: 'acc2' }),
];

function townRun(policy: ResponsePolicy, change?: ResponsePolicy): Run {
  const sim = new Simulation(town(), { scenario: true, citizens: false });
  sim.setPolicy(policy);
  for (const i of TOWN_SCRIPT) expect(sim.scenarioInput(i), i.eventId).toEqual({ ok: true });
  return fingerprint(sim, 3000, 500, (t) => {
    if (t === 1000 && change) sim.setPolicy(change);
    // An edit during the events: a sensor move (no rebuild) and a building edit (derived refresh).
    if (t === 700) expect(sim.applyCommand({ type: 'sensor.update', id: 'cam', heading: 0.4 })).toEqual({ ok: true });
    if (t === 1500) expect(sim.applyCommand(place('extra', 'house', 150, 170))).toEqual({ ok: true });
  });
}

/** Four-arm junction (preempt.test.ts `crossCity`): fire truck from N, ambulance from W, both to `home` on S. */
function crossRun(preempt: boolean): Run {
  const doc = apply(crossDoc(260), [place('fs', 'svc-fire-station', -40, -200), place('hosp', 'svc-hospital', -200, 45), place('home', 'house', -20, 180)]);
  doc.meta.trafficDensity = 1.2;
  const sim = new Simulation(doc, { scenario: true });
  sim.setPolicy({ reroute: false, informedShare: 0.7, preempt });
  for (const i of [input('f', 400, 'fire.start', { buildingId: 'home' }), input('m', 405, 'medical.start', { buildingId: 'home' }), input('f2', 1500, 'fire.start', { buildingId: 'home' })]) expect(sim.scenarioInput(i).ok).toBe(true);
  return fingerprint(sim, 2600, 650);
}

/** Substation blackout over a pre-empting fire call, batteries on, a sensor on the dark side (blackout.test.ts `powerCity`). */
function powerRun(battery: boolean): Run {
  const doc = apply(crossDoc(260), [
    place('sub', 'svc-substation', 60, 60),
    place('home', 'house', -20, 180),
    place('fs', 'svc-fire-station', -40, -200),
    { type: 'feature.upsert', feature: { id: 'cw', segmentId: 'N', kind: 'crosswalk', t: 0.5, signal: true } },
    { type: 'sensor.place', sensor: cam('pole', 'S', 0.4, { kind: 'smartpole', fov: 2 * Math.PI, range: 80 }) },
  ]);
  doc.meta.trafficDensity = 1;
  const sim = new Simulation(doc, { scenario: true });
  sim.setPolicy({ reroute: true, informedShare: 0.7, battery, preempt: true, detection: 'sensors' });
  for (const i of [
    input('b', 300, 'blackout.start', { buildingId: 'sub' }, { durationTicks: 3000 }),
    input('f', 500, 'fire.start', { buildingId: 'home' }),
    input('a', 600, 'accident.start', { segmentId: 'S', lane: 0 }, { durationTicks: 1200 }),
  ])
    expect(sim.scenarioInput(i).ok).toBe(true);
  return fingerprint(sim, 4000, 1000);
}

/** Busy grid: two accidents and a closure, a fire, a surge, a split mid-run; informed 70 %. */
function gridRun(): Run {
  const doc = apply(gridDoc(5, 130, 'road-4', 9), [
    place('fs', 'svc-fire-station', -195, -65),
    place('apt', 'apartment', 65, 65),
    place('apt2', 'apartment', -195, 195),
    place('apt3', 'apartment', 195, 65),
    place('office', 'office-tower', 195, -195),
    place('office2', 'office-tower', -65, -195),
    place('shop', 'shop', -65, 195),
  ]);
  doc.meta.trafficDensity = 6;
  const sim = new Simulation(doc, { scenario: true, citizens: false, maxVehicles: 1500 });
  sim.setPolicy({ reroute: true, informedShare: 0.7 });
  for (const i of [
    input('a1', 200, 'accident.start', { segmentId: 'h_2_2', lane: 0 }, { durationTicks: 1500 }),
    input('a2', 200, 'accident.start', { segmentId: 'v_2_2', lane: 1 }, { durationTicks: 1500 }, 1),
    input('c1', 300, 'closure.start', { segmentId: 'h_1_2' }, { durationTicks: 1000 }),
    input('s1', 250, 'surge.start', { buildingId: 'shop' }, { extraTrips: 40, inflowTicks: 400, stayTicks: 300 }),
    input('f1', 450, 'fire.start', { buildingId: 'apt' }),
  ])
    expect(sim.scenarioInput(i), i.eventId).toEqual({ ok: true });
  return fingerprint(sim, 2400, 600, (t) => {
    if (t === 900) expect(sim.applyCommand({ type: 'segment.split', id: 'v_3_1', t: 0.5, nodeId: 'mid', segmentIds: ['v_3_1a', 'v_3_1b'] })).toEqual({ ok: true });
  });
}

function recordRun(how: ReplayOptions): Run {
  const doc = cityDoc();
  doc.meta.trafficDensity = 1.5;
  const record: ScenarioRecord = {
    engineVersion: 2,
    scenarioVersion: 1,
    baseSeq: 1,
    doc: cloneJson(apply(doc, [place('fs', 'svc-fire-station', 40, 40), { type: 'sensor.place', sensor: cam('c', 'v_1_0', 0.5) }])),
    seed: 99,
    tickRate: 20,
    warmupTicks: 300,
    inputs: [
      input('c1', 500, 'closure.start', { segmentId: 'h_1_1' }, { durationTicks: 300 }),
      input('a1', 600, 'accident.start', { segmentId: 'v_1_0', lane: 0, s: 60 }, { durationTicks: 800 }),
      input('policy@700#0', 700, 'policy.set', {}, { reroute: 1, informedShare: 0.5, preempt: 0 }, Number.MIN_SAFE_INTEGER),
      input('f1', 850, 'fire.start', { buildingId: 'house2' }),
      input('a2', 900, 'accident.start', { segmentId: 'h_0_1', lane: 1 }, { durationTicks: 600 }),
    ],
    policy: { reroute: true, informedShare: 0.7, detection: 'reports' },
    activatedAtTick: 200,
  };
  return fingerprint(simulationFromRecord(record, {}, how), 2500, 500);
}

describe('P8a: simulator mode unchanged (fingerprints recorded on 11c7f04)', () => {
  // Each case also states what it exercises, so a fingerprint can never pass on an idle run.
  const has = (k: ScenarioKpi, what: (keyof ScenarioKpi)[]): void => {
    for (const key of what) expect(k[key], key).toBeGreaterThan(0);
  };
  const cases: [string, () => Run, (k: ScenarioKpi) => void][] = [
    ['town legacy ON', () => townRun({ reroute: true, informedShare: 1 }), (k) => has(k, ['rerouted', 'responses'])],
    ['town reports ON → OFF', () => townRun({ reroute: true, informedShare: 0.8, detection: 'reports' }, { reroute: false, informedShare: 0.8, detection: 'reports' }), (k) => (has(k, ['rerouted', 'responses']), expect(k.detection!.detected).toBeGreaterThan(0))],
    ['town sensors ON', () => townRun({ reroute: true, informedShare: 0.6, detection: 'sensors' }), (k) => (has(k, ['rerouted', 'responses']), expect(k.detection!.bySensor).toBeGreaterThan(0))],
    ['town sensors preempt only', () => townRun({ reroute: false, informedShare: 0.6, preempt: true, detection: 'sensors' }), (k) => (has(k, ['responses']), expect(k.rerouted).toBe(0))],
    ['cross preempt ON', () => crossRun(true), (k) => has(k, ['responses', 'extinguished'])],
    ['cross preempt OFF', () => crossRun(false), (k) => has(k, ['responses'])],
    ['power battery ON', () => powerRun(true), (k) => has(k, ['responses', 'batteryJunctionMinutes', 'darkJunctionMinutes', 'rerouted'])],
    ['power battery OFF', () => powerRun(false), (k) => (has(k, ['darkJunctionMinutes', 'darkQueueVehicleMinutes']), expect(k.detection!.detected).toBeGreaterThan(0))],
    ['grid reroute + split', () => gridRun(), (k) => has(k, ['rerouted', 'detoured', 'responses'])],
    ['record as recorded', () => recordRun({}), (k) => has(k, ['rerouted', 'responses'])],
    ['record smart OFF', () => recordRun(COMPARISON_PRESETS.smartResponse[0]), (k) => (has(k, ['responses']), expect(k.rerouted).toBe(0))],
    ['record smart ON', () => recordRun(COMPARISON_PRESETS.smartResponse[1]), (k) => has(k, ['rerouted', 'responses'])],
    ['record sensors', () => recordRun(COMPARISON_PRESETS.detection[1]), (k) => (has(k, ['rerouted', 'responses']), expect(k.detection!.covered).toBeGreaterThan(0))],
  ];
  for (const [name, fn, check] of cases) {
    it(name, () => {
      const got = fn();
      if (PRINT) console.log(`  ${JSON.stringify(name)}: ${JSON.stringify(got.hashes)},`);
      check(got.kpi);
      expect(got.hashes).toEqual(RECORDED[name]);
    }, 120_000);
  }
});

const RECORDED: Record<string, string[]> = {
  "town legacy ON": ["b466fdff","d27287cd","ae257fc5","d12150ee","bf25be98","27612a73"],
  "town reports ON → OFF": ["f43153d","ba3c13bb","d81eacb6","3a2e857a","95192685","ea65cb20"],
  "town sensors ON": ["ee9e7ed4","cc63a29c","be12a7b6","9f35dc0a","7da0757b","e21f58e9"],
  "town sensors preempt only": ["590953a1","a117f19f","a03b4c29","41292070","89ff35c6","326786bf"],
  "cross preempt ON": ["7b4f0fc6","88cdc779","f49029be","f001e682"],
  "cross preempt OFF": ["64339e71","d643f9f","822882c4","c569c588"],
  "power battery ON": ["372960dc","ff35d541","6395f2aa","50605f1b"],
  "power battery OFF": ["fe7cb079","f140021e","3cdc9067","26153aa1"],
  "grid reroute + split": ["d91cfb7f","92289162","1afcae0f","c66c1401"],
  "record as recorded": ["e592704e","2a611a05","1e996964","8dd74273","2bfa785b"],
  "record smart OFF": ["dee21b71","65b673f7","5187b8a0","87fe5e9c","fd9d175e"],
  "record smart ON": ["e592704e","c9b26ed3","d2b6b4e2","4c80e752","5a64d466"],
  "record sensors": ["e592704e","65d761c3","c9049179","469097de","11b59c07"],
};
