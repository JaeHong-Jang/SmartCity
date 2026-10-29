// Detection (ADR 0013 §1–§3, §5): legacy unchanged, reports vs sensors, physical vs known costs, lifecycle
// (missed, power, same-tick order), determinism (order independence, sensor additions, live = replay),
// records and KPIs.

import { describe, expect, it } from 'vitest';
import { cloneJson, type CityDoc, type Command, type Sensor } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkIncidentInvariants, gridDoc, internals } from '../testkit.js';
import type { World } from '../traffic/world.js';
import { compileSensorCoverage } from './coverage.js';
import { COMPARISON_PRESETS, simulationFromRecord } from './record.js';
import { ENGINE_VERSION, policyError, type ResponsePolicy, type ScenarioInput, type ScenarioOutcome, type ScenarioRecord } from './types.js';

declare const console: { log(...args: unknown[]): void };
declare const performance: { now(): number };

const place = (id: string, typeId: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
const cam = (id: string, segmentId: string, t: number, over: Partial<Sensor> = {}): Sensor => ({ id, kind: 'cctv', segmentId, t, side: 'right', heading: 0, fov: Math.PI / 2, range: 120, ...over });
const sensorCmd = (s: Sensor): Command => ({ type: 'sensor.place', sensor: s });

function input(eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}, order = 0): ScenarioInput {
  return { eventId, tick, order, kind, target, params };
}

/** 4 × 4 grid (150 m, road-4): fire station, hospital, a house to burn, a home for medical calls. */
function town(extra: Command[] = []): CityDoc {
  return apply(gridDoc(4, 150, 'road-4', 4), [place('fs', 'svc-fire-station', -150, -150), place('h', 'svc-hospital', 150, -150), place('home', 'house', -150, 20), place('flat', 'house', 0, 170), ...extra]);
}

/** CCTV on h_1_1 looking along it (covers both accident lanes of h_1_1), and one on v_1_1 looking at the house (−x). */
const COVER = [cam('cam', 'h_1_1', 0.15), cam('house-cam', 'v_1_1', 0.5, { heading: Math.PI / 2, range: 150 })];

const accident = (id: string, tick: number, lane = 0, params: Record<string, number> = {}): ScenarioInput => input(id, tick, 'accident.start', { segmentId: 'h_1_1', lane }, { durationTicks: 30000, ...params });
const SCRIPT: ScenarioInput[] = [accident('acc', 100), accident('acc2', 100, 1), input('fire', 300, 'fire.start', { buildingId: 'home' }, { burnTicks: 40000, suppressTicks: 300 }), input('med', 400, 'medical.start', { buildingId: 'flat' })];

interface Run {
  sim: Simulation;
  hashes: string[];
  out: ScenarioOutcome[];
}

const snapHash = (sim: Simulation): string => {
  const s = sim.snapshot();
  return Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.stats) + JSON.stringify(s.scenario);
};

/** Live run: policy at tick 0 (recorded), the inputs, `each` before every step (edits). Hash every 50 ticks. */
function run(doc: CityDoc, policy: ResponsePolicy, inputs: ScenarioInput[], ticks: number, each?: (sim: Simulation, t: number) => void): Run {
  const sim = new Simulation(doc, { scenario: true, citizens: false });
  sim.setPolicy(policy);
  for (const i of inputs) expect(sim.scenarioInput(i), i.eventId).toEqual({ ok: true });
  const hashes: string[] = [];
  const out: ScenarioOutcome[] = [];
  for (let t = 0; t < ticks; t++) {
    each?.(sim, t);
    sim.step();
    const p = checkIncidentInvariants(sim);
    if (p.length > 0) throw new Error(`tick ${t}: ${p.join('; ')}`);
    out.push(...sim.drainScenarioOutcomes());
    if (t % 50 === 49) hashes.push(snapHash(sim));
  }
  return { sim, hashes, out };
}

const ON: ResponsePolicy = { reroute: true, informedShare: 1 };
const known = (out: ScenarioOutcome[], id: string): ScenarioOutcome | undefined => out.find((o) => o.eventId === id && o.kind === 'detection.known');
const of = (out: ScenarioOutcome[], id: string): string[] => out.filter((o) => o.eventId === id).map((o) => o.kind);

describe('detection modes (ADR 0013 §1)', () => {
  it('legacy: sensors in the doc and sensor edits mid-run change nothing (snapshots, outcomes)', () => {
    const plain = run(town(), ON, SCRIPT, 1500);
    const edits: Record<number, Command> = {
      200: sensorCmd(cam('late', 'v_2_1', 0.5, { kind: 'smartpole', fov: 2 * Math.PI, range: 40 })),
      350: { type: 'sensor.update', id: 'cam', heading: 0.5, range: 80 },
      600: { type: 'sensor.remove', id: 'house-cam' },
    };
    const withSensors = run(town(COVER.map(sensorCmd)), ON, SCRIPT, 1500, (sim, t) => {
      if (edits[t]) expect(sim.applyCommand(edits[t]!)).toEqual({ ok: true });
    });
    expect(withSensors.hashes).toEqual(plain.hashes);
    expect(withSensors.out).toEqual(plain.out);
    expect(plain.out.some((o) => o.kind.startsWith('detection.'))).toBe(false);
    // Legacy: dispatch at the call tick, as before.
    expect(plain.out.find((o) => o.eventId === 'fire' && o.kind === 'dispatch.start')).toBeDefined();
    expect(plain.sim.kpi().detection).toMatchObject({ tracked: 0, detected: 0, missed: 0 });
  }, 60_000);

  it('sensors with no sensor in the doc gives exactly the reports run', () => {
    const reports = run(town(), { ...ON, detection: 'reports' }, SCRIPT, 3000);
    const sensors = run(town(), { ...ON, detection: 'sensors' }, SCRIPT, 3000);
    expect(sensors.hashes).toEqual(reports.hashes);
    expect(sensors.out).toEqual(reports.out);
    expect(known(reports.out, 'acc')!.reason).toMatch(/^report, /);
    expect(reports.sim.kpi().detection).toMatchObject({ tracked: 3, detected: 3, bySensor: 0, covered: 0 });
  }, 60_000);

  it('sensors: a covering sensor can only make it earlier; report draws do not change; extra or reordered sensors change nothing', () => {
    const reports = run(town(COVER.map(sensorCmd)), { ...ON, detection: 'reports' }, SCRIPT, 3000);
    const sensors = run(town(COVER.map(sensorCmd)), { ...ON, detection: 'sensors' }, SCRIPT, 3000);
    let bySensor = 0;
    for (const id of ['acc', 'acc2', 'fire']) {
      const r = known(reports.out, id)!;
      const s = known(sensors.out, id)!;
      expect(s.tick).toBeLessThanOrEqual(r.tick);
      if (s.reason!.startsWith('report')) expect(s.tick).toBe(r.tick);
      else bySensor++;
    }
    expect(bySensor).toBeGreaterThan(0);
    const k = sensors.sim.kpi().detection!;
    expect(k).toMatchObject({ tracked: 3, covered: 3, detected: 3, bySensor });
    expect(k.avgDelay).toBeLessThan(reports.sim.kpi().detection!.avgDelay);
    // A sensor far from every event, and the same sensors placed in another order: identical runs.
    const far = run(town([...COVER.map(sensorCmd), sensorCmd(cam('far', 'h_2_3', 0.5, { heading: Math.PI }))]), { ...ON, detection: 'sensors' }, SCRIPT, 3000);
    const reordered = run(town([...COVER].reverse().map(sensorCmd)), { ...ON, detection: 'sensors' }, SCRIPT, 3000);
    expect(far.out).toEqual(sensors.out);
    expect(reordered.hashes).toEqual(sensors.hashes);
    expect(reordered.out).toEqual(sensors.out);
    // Overlapping sensors of one event: adding a second camera on the same stretch keeps the first one's draws.
    const both = run(town([...COVER.map(sensorCmd), sensorCmd(cam('cam2', 'h_1_1', 0.1))]), { ...ON, detection: 'sensors' }, SCRIPT, 3000);
    expect(known(both.out, 'acc')!.tick).toBeLessThanOrEqual(known(sensors.out, 'acc')!.tick);
  }, 120_000);

  it('medical calls are known at once in every mode; fires and accidents wait', () => {
    const r = run(town(), { ...ON, detection: 'reports' }, SCRIPT, 3000);
    const legacy = run(town(), ON, SCRIPT, 3000);
    const start = (x: Run, id: string) => x.out.find((o) => o.eventId === id && o.kind === 'dispatch.start')!.tick;
    expect(start(r, 'med')).toBe(start(legacy, 'med'));
    expect(of(r.out, 'med')).not.toContain('detection.known');
    expect(start(r, 'fire')).toBeGreaterThanOrEqual(known(r.out, 'fire')!.tick);
    expect(start(r, 'fire')).toBeGreaterThan(start(legacy, 'fire'));
    expect(of(r.out, 'fire').filter((k) => k === 'detection.known')).toHaveLength(1);
  }, 60_000);
});

describe('physical effect now, known cost later (ADR 0013 §2)', () => {
  // Contract (ADR 0013 §2): before detection routing may see live congestion (`w.stopped`, like probe data in a
  // navigation app) but not the incident: no accident penalty, no ban, no broadcast re-route, no dispatch. Every
  // Router.find call is recorded — spawns, stuck re-routes, buses, scenario re-routes and emergency dispatch.
  it('before the report: every route search sees live congestion but no incident cost; no broadcast, no dispatch; after it, both', () => {
    // Both forward lanes of h_1_1 blocked (mid-lane: out of every driver's on-site view from the lane before).
    const inputs = [accident('a0', 100, 0), accident('a1', 100, 1), input('fire', 100, 'fire.start', { buildingId: 'home' }, { burnTicks: 40000 })];
    const doc = town([
      place('apt', 'apartment', -150, -130),
      place('office', 'office-tower', 150, 0),
      { type: 'busStop.add', stop: { id: 'b1', segmentId: 'h_0_1', t: 0.5, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'b2', segmentId: 'h_2_1', t: 0.5, dir: 'forward' } },
      { type: 'busLine.upsert', line: { id: 'L', name: '1', color: '#22aa44', stopIds: ['b1', 'b2'], vehicleTypeId: 'city-bus', buses: 2 } },
    ]);
    doc.meta.trafficDensity = 3;
    const sim = new Simulation(doc, { scenario: true, citizens: false });
    const w = internals(sim);
    sim.setPolicy({ ...ON, detection: 'reports' });
    for (const i of inputs) sim.scenarioInput(i);
    const seg = w.graph.segments.get('h_1_1')!;
    const blocked = seg.lanes.slice(0, 2);
    const calls: { tick: number; penalty: boolean; live: boolean }[] = [];
    const find = w.router.find.bind(w.router);
    w.router.find = (start, at, goals, bus, stopped) => {
      const rear = w.router.obsRear;
      calls.push({ tick: w.tick, penalty: rear !== null && blocked.some((l) => rear[l]! < Infinity), live: stopped === w.stopped });
      return find(start, at, goals, bus, stopped);
    };
    const from = w.graph.segments.get('h_0_1')!.lanes[0]!;
    const to = w.graph.segments.get('h_2_1')!.lanes[0]!;
    let knownAt = -1;
    for (let t = 0; t < 4000 && knownAt < 0; t++) {
      // A trip starting while the accidents are unknown (live costs, no incident cost), and one already behind the obstacle.
      if (w.tick === 102) {
        const id = sim.spawnVehicle('sedan', 'h_0_1|f|0', 'h_2_1|f|0', 10);
        const v = w.vehicles.find((x) => x.id === id)!;
        expect(v.route).toEqual(find(from, 10, [{ lane: to, destS: w.net.len[to]! }], false, w.stopped)!.path);
        expect(sim.spawnVehicle('sedan', 'h_1_1|f|0', 'h_2_1|f|0', 8)).not.toBeNull();
      }
      sim.step();
      const out = sim.drainScenarioOutcomes();
      const k = out.find((o) => o.kind === 'detection.known');
      if (k) knownAt = k.tick;
      else if (w.tick > 101) {
        expect(w.sc!.obs![blocked[0]!]!.length).toBe(1);
        expect(w.router.obsRear).toBeNull();
        expect(w.sc!.rerouted).toBe(0);
        expect(w.sc!.rq.some((v) => !v.scWait)).toBe(false);
        expect(out.some((o) => o.eventId === 'fire' && o.kind.startsWith('dispatch'))).toBe(false);
      }
    }
    expect(knownAt).toBeGreaterThan(101);
    const before = calls.filter((c) => c.tick > 100 && c.tick < knownAt);
    expect(before.length).toBeGreaterThan(10);
    expect(before.some((c) => c.penalty)).toBe(false);
    // The live-congestion path really ran (spawns, stuck re-routes, buses use `w.stopped`).
    expect(before.filter((c) => c.live).length).toBeGreaterThan(5);
    // a0 / a1 known: the penalty is there and a free-flow search leaves h_1_1.
    for (let t = 0; t < 4000 && sim.kpi().detection!.detected < 3; t++) sim.step();
    expect(w.router.obsRear![blocked[0]!]).toBeLessThan(Infinity);
    expect(find(from, 0, [{ lane: to, destS: 10 }], false, w.sc!.zero)!.path.some((e) => blocked.includes(e))).toBe(false);
    expect(calls.some((c) => c.tick > knownAt && c.penalty)).toBe(true);
    for (let t = 0; t < 200; t++) sim.step();
    expect(w.sc!.rerouted).toBeGreaterThan(0);
    // Exposure: vehicles drove onto the blocked lanes before the city knew.
    expect(sim.kpi().detection!.exposedVehicles).toBeGreaterThan(0);
  }, 60_000);

  it('legacy: the router knows at once (same object as the physical array)', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false });
    const w = internals(sim);
    sim.setPolicy(ON);
    sim.scenarioInput(accident('a', 5));
    for (let t = 0; t < 7; t++) sim.step();
    expect(w.router.obsRear).not.toBeNull();
    expect(w.router.obsRear).toBe(w.sc!.obsRear);
  });
});

describe('lifecycle before detection (ADR 0013 §3)', () => {
  it('ended, burned down, ended by input or target gone before detection → missed with its reason, never dispatched', () => {
    const inputs = [
      accident('short', 100, 0, { durationTicks: 20 }),
      input('flash', 100, 'fire.start', { buildingId: 'home' }, { burnTicks: 10 }),
      input('ended', 200, 'fire.start', { buildingId: 'flat' }, { burnTicks: 30000 }),
      input('end', 210, 'fire.end', { eventId: 'ended' }),
      input('gone', 300, 'fire.start', { buildingId: 'shed' }, { burnTicks: 30000 }),
    ];
    const r = run(town([place('shed', 'house', 170, 20)]), { ...ON, detection: 'reports' }, inputs, 2000, (sim, t) => {
      if (t === 320) expect(sim.applyCommand({ type: 'building.remove', id: 'shed' })).toEqual({ ok: true });
    });
    const missed = (id: string) => r.out.find((o) => o.eventId === id && o.kind === 'detection.missed')?.reason;
    expect(missed('short')).toBe('ended before detection');
    expect(missed('flash')).toBe('burned before detection');
    expect(missed('ended')).toBe('ended before detection');
    expect(missed('gone')).toBe('target gone');
    for (const id of ['short', 'flash', 'ended', 'gone']) {
      expect(of(r.out, id)).not.toContain('detection.known');
      expect(of(r.out, id)).not.toContain('dispatch.start');
    }
    expect(r.sim.kpi().detection).toMatchObject({ tracked: 4, detected: 0, missed: 4, missedDamaged: 1, undetectedNow: 0 });
    expect(r.sim.kpi().damaged).toBe(1);
  }, 60_000);

  it('same tick: an accident expiring at its report tick is missed (expiry first); one tick later it is known, then ends', () => {
    const probe = run(town(), { ...ON, detection: 'reports' }, [accident('x', 100)], 2000);
    const R = known(probe.out, 'x')!.tick;
    const at = run(town(), { ...ON, detection: 'reports' }, [accident('x', 100, 0, { durationTicks: R - 100 })], R + 5);
    expect(of(at.out, 'x')).toEqual(['accident.start', 'accident.end', 'detection.missed']);
    const after = run(town(), { ...ON, detection: 'reports' }, [accident('x', 100, 0, { durationTicks: R - 100 + 1 })], R + 5);
    expect(of(after.out, 'x')).toEqual(['accident.start', 'detection.known', 'accident.end']);
  }, 60_000);

  it('a sensor in a blackout at its detection tick is void; the report still comes', () => {
    const doc = town(COVER.map(sensorCmd));
    const base = run(cloneJson(doc), { ...ON, detection: 'sensors' }, [accident('x', 100)], 3000);
    const viaSensor = known(base.out, 'x')!;
    expect(viaSensor.reason).toMatch(/^sensor cam, /);
    const reportTick = known(run(cloneJson(doc), { ...ON, detection: 'reports' }, [accident('x', 100)], 3000).out, 'x')!.tick;
    const w = internals(base.sim);
    const p = { x: w.graph.segments.get('h_1_1')!.centerline[0]!.x, z: w.graph.segments.get('h_1_1')!.centerline[0]!.z };
    const cut = input('cut', viaSensor.tick - 2, 'blackout.start', {}, { x: p.x + 20, z: p.z, radius: 30, durationTicks: 50000 });
    const dark = run(cloneJson(doc), { ...ON, detection: 'sensors' }, [accident('x', 100), cut], 3000);
    expect(dark.out.find((o) => o.kind === 'detection.unpowered')).toMatchObject({ eventId: 'x', tick: viaSensor.tick, reason: 'cam' });
    expect(known(dark.out, 'x')).toMatchObject({ tick: reportTick });
    expect(known(dark.out, 'x')!.reason).toMatch(/^report, /);
  }, 60_000);
});

describe('on-site recovery (ADR 0013 §2)', () => {
  const at = (sim: Simulation, id: number): string | null => {
    const w = internals(sim);
    const v = w.vehicles.find((x) => x.id === id);
    return v ? (v.edge < w.net.nLanes ? w.graph.lanes[v.edge]!.id : 'connector') : null;
  };
  const blockedSim = (detection: ResponsePolicy['detection'], roadType = 'road-4', s = 60, durationTicks = 30000): Simulation => {
    const sim = new Simulation(gridDoc(4, 150, roadType, 4), { scenario: true, citizens: false });
    sim.setPolicy({ ...ON, detection });
    sim.scenarioInput(input('a', 0, 'accident.start', { segmentId: 'h_1_1', lane: 0, s }, { durationTicks }));
    sim.step();
    return sim;
  };

  it('before detection: a driver stopped behind the unknown accident steps to the free lane and drives on; the router never learns it', () => {
    const sim = blockedSim('reports');
    const w = internals(sim);
    const id = sim.spawnVehicle('sedan', 'h_1_1|f|0', 'h_2_1|f|0', 8)!;
    let stepped = -1;
    let knownAt = -1;
    for (let t = 0; t < 3000 && at(sim, id) !== null; t++) {
      sim.step();
      if (sim.drainScenarioOutcomes().some((o) => o.kind === 'detection.known')) knownAt = w.tick;
      if (stepped < 0 && at(sim, id) === 'h_1_1|f|1') {
        stepped = w.tick;
        expect(knownAt).toBe(-1);
        expect(w.router.obsRear).toBeNull();
      }
    }
    expect(stepped).toBeGreaterThan(0);
    expect(at(sim, id)).toBeNull(); // arrived, long before the accident ends (tick 30000)
    expect(sim.kpi().detection!.onSiteRecoveries).toBeGreaterThan(0);
    // Legacy keeps the old behaviour: the same driver waits behind the obstacle.
    const legacy = blockedSim(undefined);
    const lid = legacy.spawnVehicle('sedan', 'h_1_1|f|0', 'h_2_1|f|0', 8)!;
    for (let t = 0; t < 3000; t++) legacy.step();
    expect(at(legacy, lid)).toBe('h_1_1|f|0');
    expect(legacy.kpi().detection!.onSiteRecoveries).toBe(0);
  }, 60_000);

  it('after detection: a driver that reaches the known accident on its lane is handled the same way', () => {
    const sim = blockedSim('reports');
    const w = internals(sim);
    for (let t = 0; t < 3000 && sim.kpi().detection!.detected === 0; t++) sim.step();
    expect(w.router.obsRear).not.toBeNull();
    // Its current lane is blocked ahead; the known penalty cannot move it off a lane it is already on.
    const id = sim.spawnVehicle('sedan', 'h_1_1|f|0', 'h_2_1|f|0', 8)!;
    let stepped = false;
    for (let t = 0; t < 3000 && at(sim, id) !== null; t++) {
      sim.step();
      stepped ||= at(sim, id) === 'h_1_1|f|1';
    }
    expect(stepped).toBe(true);
    expect(at(sim, id)).toBeNull();
  }, 60_000);

  it('before its lane: one vehicle-local re-route, nothing leaks to others; released when the accident ends', () => {
    // One lane per direction (no side step), obstacle right after the junction n_1_1.
    const sim = blockedSim('reports', 'road-2', 5, 3000);
    const w = internals(sim);
    const blocked = w.graph.laneById.get('h_1_1|f|0')!;
    const prevLen = w.net.len[w.graph.laneById.get('h_0_1|f|0')!]!;
    const routeHas = (id: number): boolean => w.vehicles.find((x) => x.id === id)!.route.slice(w.vehicles.find((x) => x.id === id)!.ri + 1).includes(blocked);
    const near = sim.spawnVehicle('sedan', 'h_0_1|f|0', 'h_2_1|f|0', prevLen - 8)!;
    const far = sim.spawnVehicle('sedan', 'h_0_1|f|0', 'h_2_1|f|0', 12)!;
    expect(routeHas(near) && routeHas(far)).toBe(true);
    sim.step();
    // The near driver sees it and avoids the lane; the far one (out of sight) and every shared search do not.
    expect(routeHas(near)).toBe(false);
    expect(routeHas(far)).toBe(true);
    expect(w.router.obsRear).toBeNull();
    const from = w.graph.laneById.get('h_0_1|f|0')!;
    const to = w.graph.laneById.get('h_2_1|f|0')!;
    expect(w.router.find(from, 12, [{ lane: to, destS: 10 }], false, w.sc!.zero)!.path).toContain(blocked);
    expect(sim.kpi().detection!.onSiteRecoveries).toBe(1);
    // A driver stuck behind it on its single lane waits, then drives on once it ends (tick 3000).
    const stuckRun = blockedSim('reports', 'road-2', 60, 3000);
    const sid = stuckRun.spawnVehicle('sedan', 'h_1_1|f|0', 'h_2_1|f|0', 8)!;
    for (let t = 0; t < 2900; t++) stuckRun.step();
    expect(at(stuckRun, sid)).toBe('h_1_1|f|0');
    for (let t = 0; t < 2000 && at(stuckRun, sid) !== null; t++) stuckRun.step();
    expect(at(stuckRun, sid)).toBeNull();
    // After the end nothing is left: a new driver at the same spot keeps the lane.
    for (let t = 0; internals(sim).tick <= 3001; t++) sim.step();
    expect(w.sc!.effects).toEqual([]);
    const later = sim.spawnVehicle('sedan', 'h_0_1|f|0', 'h_2_1|f|0', prevLen - 8);
    if (later !== null) {
      sim.step();
      expect(routeHas(later)).toBe(true);
    }
  }, 60_000);
});

describe('burn-out and detection on the same tick (ADR 0013 §3)', () => {
  // Sol's repro (seed 4, `fire` at tick 10: report after 244 ticks); `blaze` is seen by house-cam first.
  for (const [label, detection, doc, id] of [
    ['report', 'reports', () => town(), 'fire'],
    ['sensor', 'sensors', () => town(COVER.map(sensorCmd)), 'blaze'],
  ] as const) {
    const fire = (burnTicks: number): ScenarioInput => input(id, 10, 'fire.start', { buildingId: 'home' }, { burnTicks, suppressTicks: 300 });
    it(`${label}: a fire reaching 100 % at its detection tick is missed (damage), one tick later it is known`, () => {
      const probe = run(doc(), { ...ON, detection }, [fire(40000)], 3000);
      const k = known(probe.out, id)!;
      expect(k.reason!.startsWith(label)).toBe(true);
      const tie = run(doc(), { ...ON, detection }, [fire(k.tick - 10)], k.tick + 30);
      expect(of(tie.out, id)).toEqual(['fire.start', 'fire.damaged', 'detection.missed']);
      expect(tie.out.find((o) => o.kind === 'detection.missed')!.reason).toBe('burned before detection');
      expect(tie.sim.kpi().detection).toMatchObject({ tracked: 1, detected: 0, missed: 1, missedDamaged: 1 });
      const later = run(doc(), { ...ON, detection }, [fire(k.tick - 10 + 1)], k.tick + 30);
      expect(known(later.out, id)!.tick).toBe(k.tick);
      expect(later.sim.kpi().detection).toMatchObject({ detected: 1, missed: 0, missedDamaged: 0 });
    }, 60_000);
  }
});

describe('replay and comparison (ADR 0013 §1, §4)', () => {
  const record = (doc: CityDoc, inputs: ScenarioInput[], policy: ResponsePolicy, engineVersion = ENGINE_VERSION): ScenarioRecord => ({ engineVersion, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs, policy });
  const replay = (sim: Simulation, ticks: number): Run => {
    const hashes: string[] = [];
    const out: ScenarioOutcome[] = [];
    for (let t = 0; t < ticks; t++) {
      sim.step();
      out.push(...sim.drainScenarioOutcomes());
      if (t % 50 === 49) hashes.push(snapHash(sim));
    }
    return { sim, hashes, out };
  };

  it('live = replay of its record (sensors, blackout and runtime policy change included)', () => {
    const doc = town(COVER.map(sensorCmd));
    const inputs = [...SCRIPT, input('cut', 500, 'blackout.start', {}, { x: 0, z: 0, radius: 120, durationTicks: 600 })];
    const live = run(cloneJson(doc), { ...ON, detection: 'sensors' }, inputs, 2500, (sim, t) => {
      if (t === 1000) sim.setPolicy({ reroute: true, informedShare: 0.5, detection: 'reports' });
    });
    const rec = record(cloneJson(doc), live.sim.scenarioInputs(), { reroute: false, informedShare: 0.7 });
    expect(rec.inputs.filter((i) => i.kind === 'policy.set').map((i) => i.params.detection)).toEqual([2, 1]);
    const again = replay(simulationFromRecord(rec, { citizens: false }), 2500);
    expect(again.hashes).toEqual(live.hashes);
    expect(again.out).toEqual(live.out);
  }, 60_000);

  it('preset ② replays one record as reports vs sensors with everything else fixed; preset ① keeps the detection mode', () => {
    const doc = town(COVER.map(sensorCmd));
    const rec = record(doc, SCRIPT, { reroute: true, informedShare: 0.7 });
    const [a, b] = COMPARISON_PRESETS.detection.map((how) => replay(simulationFromRecord(rec, { citizens: false }, how), 3000));
    const ref = run(cloneJson(doc), { reroute: true, informedShare: 0.7, detection: 'reports' }, [], 0);
    expect(ref.out).toEqual([]);
    expect(a!.sim.kpi().detection!.bySensor).toBe(0);
    expect(b!.sim.kpi().detection!.bySensor).toBeGreaterThan(0);
    for (const id of ['acc', 'acc2', 'fire']) expect(known(b!.out, id)!.tick).toBeLessThanOrEqual(known(a!.out, id)!.tick);
    const sensorsRec = record(doc, SCRIPT, { reroute: false, informedShare: 0.7, detection: 'sensors' });
    const on = simulationFromRecord(sensorsRec, { citizens: false }, COMPARISON_PRESETS.smartResponse[1]);
    expect(internals(on).sc!.policy).toEqual({ reroute: true, informedShare: 0.7, detection: 'sensors' });
  }, 120_000);

  it('engine-1 records replay as legacy; a detection input in one is refused; bad modes are refused', () => {
    const doc = town(COVER.map(sensorCmd));
    const legacy = replay(simulationFromRecord(record(doc, SCRIPT, ON), { citizens: false }), 1500);
    const v1 = replay(simulationFromRecord(record(doc, SCRIPT, { ...ON, detection: 'sensors' }, 1), { citizens: false }), 1500);
    expect(v1.hashes).toEqual(legacy.hashes);
    const withInput = [...SCRIPT, input('p', 0, 'policy.set', {}, { reroute: 1, informedShare: 1, detection: 2 })];
    expect(() => simulationFromRecord(record(doc, withInput, ON, 1))).toThrow(/detection/);
    expect(() => simulationFromRecord(record(doc, SCRIPT, ON, 99))).toThrow(/engineVersion/);
    expect(policyError({ ...ON, detection: 'cctv' })).toMatch(/detection/);
    expect(policyError({ ...ON, detection: 'sensors' })).toBeNull();
    const sim = new Simulation(doc, { scenario: true, citizens: false });
    expect(sim.scenarioInput(input('p', 0, 'policy.set', {}, { reroute: 1, informedShare: 1, detection: 3 })).ok).toBe(false);
    expect(() => sim.setPolicy({ ...ON, detection: 'x' as never })).toThrow();
    expect(sim.setPolicy({ ...ON, detection: 'sensors' }).params).toEqual({ reroute: 1, informedShare: 1, detection: 2 });
  }, 60_000);
});

describe('detection KPIs (ADR 0013 §5)', () => {
  it('undetected now and elapsed; response stages add up to the response time', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false });
    sim.setPolicy({ ...ON, detection: 'reports' });
    sim.scenarioInput(input('fire', 10, 'fire.start', { buildingId: 'home' }, { burnTicks: 40000, suppressTicks: 300 }));
    for (let t = 0; t < 20; t++) sim.step();
    const k = sim.kpi().detection!;
    expect(k.undetectedNow).toBe(1);
    expect(k.oldestUndetectedMinutes).toBeGreaterThan(0);
    expect(sim.snapshot().scenario!.undetected).toEqual([{ eventId: 'fire', kind: 'fire', startTick: 10 }]);
    for (let t = 0; t < 8000 && sim.kpi().responses < 1; t++) sim.step();
    const kpi = sim.kpi();
    const r = kpi.response!;
    expect(r.arrivals).toBe(1);
    expect(r.detect).toBeGreaterThan(0);
    expect(r.travel).toBeGreaterThan(0);
    expect(r.detect + r.dispatchWait + r.travel).toBeCloseTo(kpi.avgResponseTime, 9);
    for (let t = 0; t < 400; t++) sim.step();
    expect(sim.kpi().response!.workDone).toBe(1);
    expect(sim.kpi().response!.work).toBeCloseTo(300 / 20 / 6, 9);
  }, 60_000);
});

describe('performance (reported)', () => {
  it('coverage compile with 200 sensors on ~1000 roads; sim tick with 0 vs 200 sensors (sensors mode, events pending)', () => {
    const doc = gridDoc(23, 100, 'road-4', 5);
    const segs = Object.keys(doc.segments).sort();
    const sensors: Command[] = [];
    for (let i = 0; i < 200; i++) sensors.push(sensorCmd(cam(`s${i}`, segs[(i * 37) % segs.length]!, 0.2 + ((i * 13) % 7) / 10, { kind: (['cctv', 'radar', 'smartpole'] as const)[i % 3], side: i % 2 ? 'left' : 'right', heading: (i % 5) - 2 })));
    const withSensors = apply(cloneJson(doc), sensors);
    const sim0 = new Simulation(doc, { scenario: true, citizens: false, maxVehicles: 3000 });
    const sim200 = new Simulation(withSensors, { scenario: true, citizens: false, maxVehicles: 3000 });
    // Coverage compile: the first sensors-mode event builds it (median of 5 fresh compiles).
    const w = internals(sim200);
    const times: number[] = [];
    let lanes = 0;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      const cov = compileCoverage(w);
      times.push(performance.now() - t0);
      lanes = cov;
    }
    times.sort((a, b) => a - b);
    const setup = (sim: Simulation): number => {
      sim.setPolicy({ reroute: true, informedShare: 0.7, detection: 'sensors' });
      for (let i = 0; i < 600; i++) sim.step();
      const t = internals(sim).tick;
      for (let k = 0; k < 20; k++) sim.scenarioInput(input(`a${k}`, t, 'accident.start', { segmentId: segs[(k * 53) % segs.length]!, lane: 0 }, { durationTicks: 100000 }));
      sim.step();
      return 0;
    };
    const block = (sim: Simulation): number => {
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) sim.step();
      return (performance.now() - t0) / 100;
    };
    setup(sim0);
    setup(sim200);
    // Alternating blocks so JIT warm-up and machine noise hit both alike.
    let sum0 = 0;
    let sum200 = 0;
    for (let k = 0; k < 4; k++) {
      sum0 += block(sim0);
      sum200 += block(sim200);
    }
    const ms0 = sum0 / 4;
    const ms200 = sum200 / 4;
    console.log(`[detection bench] segments=${segs.length} sensors=200 intervals=${lanes} coverage compile median=${times[2]!.toFixed(1)}ms (max ${times[4]!.toFixed(1)}) | tick (sensors mode, 20 accidents pending, ${sim200.stats().vehicles} veh): 0 sensors ${ms0.toFixed(2)}ms, 200 sensors ${ms200.toFixed(2)}ms`);
    expect(segs.length).toBeGreaterThanOrEqual(1000);
    expect(times[2]!).toBeLessThan(500);
  }, 180_000);
});

/** Fresh coverage compile of the sim's doc and graph; returns the interval count. */
function compileCoverage(w: World): number {
  return compileSensorCoverage(w.doc, w.graph).reduce((n, c) => n + c.lanes.length, 0);
}
