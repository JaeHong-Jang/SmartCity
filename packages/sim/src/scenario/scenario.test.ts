import { describe, expect, it } from 'vitest';
import { cloneJson, createEmptyDoc, type CityDoc } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkInvariants, checkObstacleOverlaps, cityDoc, gridDoc, internals, lineDoc } from '../testkit.js';
import { despawn, type World } from '../traffic/world.js';
import { applyDueInputs } from './apply.js';
import { scenarioHolds } from './state.js';
import { KpiSeries, kpiEveryTicks } from './kpi.js';
import { simulationFromRecord } from './record.js';
import { ENGINE_VERSION, type ScenarioInput, type ScenarioRecord } from './types.js';

const rngState = (r: unknown): number => (r as { s: number }).s;

function input(eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}, order = 0): ScenarioInput {
  return { eventId, tick, order, kind, target, params };
}

/** Every lane of a segment plus the connectors into them. */
function segmentEdges(w: World, segId: string): Set<number> {
  const out = new Set<number>();
  const seg = w.graph.segments.get(segId)!;
  for (const l of seg.lanes) out.add(l);
  for (const c of w.graph.connectors) if (out.has(c.toLane)) out.add(w.net.nLanes + c.index);
  return out;
}

describe('scenario inputs: validation and contract', () => {
  it('rejects unknown targets, past ticks and duplicate event ids; queues valid inputs', () => {
    const sim = new Simulation(cityDoc(), { citizens: false });
    for (let t = 0; t < 10; t++) sim.step();
    expect(sim.scenarioInput(input('a', 20, 'closure.start', { segmentId: 'nope' })).ok).toBe(false);
    expect(sim.scenarioInput(input('a', 20, 'closure.start', { segmentId: 'h_0_0', lane: 9 })).ok).toBe(false);
    expect(sim.scenarioInput(input('a', 5, 'closure.start', { segmentId: 'h_0_0' }))).toEqual({ ok: false, error: '지난 tick 5 (현재 10)' });
    expect(sim.scenarioInput(input('a', 20, 'accident.start', { segmentId: 'h_0_0' })).ok).toBe(false);
    expect(sim.scenarioInput(input('a', 20, 'accident.start', { segmentId: 'h_0_0', lane: 0, s: 9999 })).ok).toBe(false);
    expect(sim.scenarioInput(input('a', 20, 'surge.start', { buildingId: 'nope' }, { extraTrips: 5 })).ok).toBe(false);
    expect(sim.scenarioInput(input('a', 20, 'surge.start', { buildingId: 'office1' }, {})).ok).toBe(false);
    expect(sim.scenarioInput(input('a', 10, 'closure.start', { segmentId: 'h_0_0' }))).toEqual({ ok: true });
    expect(sim.scenarioInput(input('a', 30, 'closure.end', { segmentId: 'h_0_0' })).ok).toBe(false);
    expect(() => sim.setPolicy({ reroute: true, informedShare: 1.5 })).toThrow();
  });

  it('applies due inputs at the tick boundary in (tick, order, eventId) order', () => {
    const sim = new Simulation(gridDoc(3, 150), { demand: false, citizens: false });
    const w = internals(sim);
    // Same tick: order decides, then eventId.
    expect(sim.scenarioInput(input('z', 3, 'closure.start', { segmentId: 'h_0_0' }, {}, 1)).ok).toBe(true);
    expect(sim.scenarioInput(input('b', 3, 'closure.start', { segmentId: 'h_0_1' }, {}, 0)).ok).toBe(true);
    expect(sim.scenarioInput(input('a', 3, 'closure.start', { segmentId: 'h_1_0' }, {}, 0)).ok).toBe(true);
    for (let t = 0; t < 3; t++) sim.step();
    expect(w.sc!.effects.length).toBe(0);
    sim.step();
    expect(w.sc!.log.map((e) => e.eventId)).toEqual(['a', 'b', 'z']);
    expect(sim.kpi().activeEvents).toBe(3);
  });

  it('without events the scenario API changes nothing: same snapshot bytes as a plain run', () => {
    const run = (scenario: boolean): string[] => {
      const sim = new Simulation(gridDoc(3, 150, 'road-4'));
      if (scenario) sim.setPolicy({ reroute: true, informedShare: 0.7 });
      const out: string[] = [];
      for (let t = 0; t < 1500; t++) {
        sim.step();
        if (scenario && t % 50 === 0) sim.kpi();
        if (t % 100 === 99) {
          const s = sim.snapshot();
          out.push(Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.stats));
        }
      }
      return out;
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe('closure', () => {
  // A whole avenue closed: row 2 of a 5 × 5 grid (both directions, all lanes), ticks 1000..7000. A closure
  // whose detour is only a block or two (e.g. a central cross) gives mixed ON/OFF results — see the report.
  const SEGS = ['h_0_2', 'h_1_2', 'h_2_2', 'h_3_2'];
  const START = 1000;
  const END = 7000;
  const closureRun = (reroute: boolean, ticks = 8000) => {
    const doc = gridDoc(5, 150, 'road-4', 3);
    doc.meta.trafficDensity = 1.5;
    const sim = new Simulation(doc, { citizens: false, maxVehicles: 4000 });
    const w = internals(sim);
    sim.setPolicy({ reroute, informedShare: 0.7 });
    for (const seg of SEGS) expect(sim.scenarioInput(input(`c-${seg}`, START, 'closure.start', { segmentId: seg }, { durationTicks: END - START })).ok).toBe(true);
    const edges = new Set<number>();
    let inFlight = new Set<number>();
    const violations: string[] = [];
    const rng: number[] = [];
    let maxLoad = 0;
    let drainedLeft = -1;
    const reopenedUse = new Set<number>();
    for (let t = 0; t < ticks; t++) {
      sim.step();
      rng.push(rngState(w.rng));
      maxLoad = Math.max(maxLoad, w.vehicles.length + w.queue.length);
      if (t === START) {
        for (const seg of SEGS) for (const e of segmentEdges(w, seg)) edges.add(e);
        // In flight at the start: on a closed lane or a connector into one, or already granted into one.
        inFlight = new Set(w.vehicles.filter((v) => edges.has(v.edge) || (v.grant >= 0 && edges.has(w.net.nLanes + v.grant))).map((v) => v.id));
      }
      if (t > START && t < END) for (const v of w.vehicles) if (edges.has(v.edge) && !inFlight.has(v.id)) violations.push(`tick ${t}: vehicle ${v.id} entered closed edge ${v.edge}`);
      if (t > START && t < START + 1500 && violations.length < 5) violations.push(...checkInvariants(sim).map((p) => `tick ${t}: ${p}`));
      // Just before the end: every vehicle that was inside has left, or waits because its only way on is
      // closed too (no route / its next connector is closed), or is queued behind such a vehicle.
      if (t === END - 10) {
        const blockedBehindHeld = (v: (typeof w.vehicles)[number]): boolean => w.onEdge[v.edge]!.some((u) => u.s > v.s && scenarioHolds(w, u));
        drainedLeft = w.vehicles.filter((v) => inFlight.has(v.id) && edges.has(v.edge) && !scenarioHolds(w, v) && !blockedBehindHeld(v)).length;
      }
      // Recovery after the end: traffic uses the reopened roads again.
      if (t > END) for (const v of w.vehicles) if (edges.has(v.edge) && !inFlight.has(v.id)) reopenedUse.add(v.id);
    }
    return { sim, kpi: sim.kpi(), violations, inFlight, drainedLeft, reopened: reopenedUse.size, rng, maxLoad, maxVehicles: 4000 };
  };

  it('no new entry while closed, vehicles inside drain, ON detours and completes at least as many trips, same demand', () => {
    const off = closureRun(false);
    const on = closureRun(true);
    expect(off.violations).toEqual([]);
    expect(on.violations).toEqual([]);
    expect(on.inFlight.size).toBeGreaterThan(0);
    expect(on.drainedLeft).toBe(0);
    expect(off.drainedLeft).toBe(0);
    expect(on.reopened).toBeGreaterThan(20);
    expect(off.reopened).toBeGreaterThan(20);
    expect(on.kpi.noRoute).toBe(0);
    expect(off.kpi.noRoute).toBe(0);
    expect(on.kpi.rerouted).toBeGreaterThan(0);
    expect(on.kpi.detoured).toBeGreaterThan(0);
    expect(off.kpi.rerouted).toBe(0);
    expect(on.kpi.completed).toBeGreaterThanOrEqual(off.kpi.completed);
    // Fairness: the demand RNG went through exactly the same states, tick by tick (the cap was never hit).
    expect(on.maxLoad).toBeLessThan(on.maxVehicles);
    expect(off.maxLoad).toBeLessThan(off.maxVehicles);
    expect(on.rng).toEqual(off.rng);
    expect(on.kpi.activeEvents).toBe(0);
    console.log(`[closure ON/OFF] completed ${on.kpi.completed}/${off.kpi.completed} avgTT ${on.kpi.avgTravelTime.toFixed(1)}/${off.kpi.avgTravelTime.toFixed(1)}s rerouted=${on.kpi.rerouted} detoured=${on.kpi.detoured} recovered ${on.kpi.recovered}/${off.kpi.recovered} removed ${on.kpi.removed}/${off.kpi.removed} dropped ${on.kpi.droppedTrips}/${off.kpi.droppedTrips}`);
  }, 120_000);

  it('a closure that cuts the only way counts the vehicle as "no route"; it waits (not removed) and proceeds after the end', () => {
    const doc = apply(createEmptyDoc('line3', 5), [
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 200, z: 0 } } },
      { type: 'node.add', node: { id: 'c', pos: { x: 400, z: 0 } } },
      { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'bc', a: 'b', b: 'c', roadTypeId: 'road-2' } },
    ]);
    const sim = new Simulation(doc, { demand: false, citizens: false });
    sim.setPolicy({ reroute: false, informedShare: 0 });
    expect(sim.scenarioInput(input('cut', 0, 'closure.start', { segmentId: 'bc' })).ok).toBe(true);
    sim.step();
    const id = sim.spawnVehicle('sedan', 'ab|f|0', 'bc|f|0', 20);
    // Spawn checks the route at creation: the closed goal lane is not reachable, so no vehicle.
    expect(id).toBeNull();
    sim.scenarioInput(input('open0', 1, 'closure.end', { segmentId: 'bc' }));
    sim.step();
    const v = sim.spawnVehicle('sedan', 'ab|f|0', 'bc|f|0', 20);
    expect(v).not.toBeNull();
    sim.scenarioInput(input('cut2', 2, 'closure.start', { segmentId: 'bc' }));
    let noRoute = 0;
    for (let t = 0; t < 2400; t++) {
      sim.step();
      noRoute = Math.max(noRoute, sim.kpi().noRoute);
    }
    expect(noRoute).toBe(1);
    expect(sim.kpi().noRoute).toBe(1);
    // Waited 2 minutes without being removed (stuck removal is 90 s).
    expect(sim.stats().removed).toBe(0);
    expect(sim.vehicles().find((x) => x.id === v)!.v).toBe(0);
    sim.scenarioInput(input('open', 2402, 'closure.end', { segmentId: 'bc' }));
    for (let t = 0; t < 1200; t++) sim.step();
    expect(sim.kpi().noRoute).toBe(0);
    expect(sim.stats().removed).toBe(0);
    expect(sim.stats().arrived).toBe(1);
    expect(sim.kpi().completed).toBe(1);
  });

  it('overlapping accident and closure on one lane: ending the accident keeps the lane closed', () => {
    const sim = new Simulation(gridDoc(3, 150, 'road-4'), { citizens: false });
    const w = internals(sim);
    sim.setPolicy({ reroute: true, informedShare: 0.7 });
    sim.scenarioInput(input('acc', 100, 'accident.start', { segmentId: 'h_0_1', lane: 0, s: 40 }, { durationTicks: 300 }));
    sim.scenarioInput(input('cl', 100, 'closure.start', { segmentId: 'h_0_1', lane: 0 }, {}, 1));
    for (let t = 0; t < 101; t++) sim.step();
    const lane = w.graph.segments.get('h_0_1')!.lanes[0]!;
    expect(w.sc!.ban![lane]).toBe(1);
    expect(w.sc!.obs![lane]!.length).toBe(1);
    for (let t = 0; t < 400; t++) sim.step();
    // The accident ended by duration; the closure still holds.
    expect(w.sc!.obs).toBeNull();
    expect(w.sc!.ban![lane]).toBe(1);
    expect(sim.snapshot().scenario!.closedLanes).toEqual([lane]);
    sim.scenarioInput(input('cl-end', w.tick, 'closure.end', { segmentId: 'h_0_1', lane: 0 }));
    sim.step();
    expect(w.sc!.ban).toBeNull();
    expect(sim.kpi().activeEvents).toBe(0);
    expect(w.sc!.log.map((e) => `${e.eventId}:${e.kind}`)).toEqual(['policy@0#0:policy.set', 'acc:accident.start', 'cl:closure.start', 'acc:accident.end', 'cl:closure.end', 'cl-end:closure.end']);
  });
});

describe('accident', () => {
  it('vehicles stop behind the obstacle without overlap, go on after it clears; a covered spot moves ahead', () => {
    const sim = new Simulation(lineDoc(600), { demand: false, citizens: false });
    const w = internals(sim);
    sim.setPolicy({ reroute: true, informedShare: 1 });
    const parked = sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 304)!;
    expect(parked).not.toBeNull();
    // The requested rear (300) is under the parked car's body [299.5, 304]: moved just ahead of it.
    sim.scenarioInput(input('acc', 0, 'accident.start', { segmentId: 'ab', lane: 0, s: 300 }, { durationTicks: 1600 }));
    sim.step();
    const o = w.sc!.obs![0]![0]!;
    const pv = w.vehicles.find((v) => v.id === parked)!;
    expect(o.rear).toBeGreaterThanOrEqual(pv.s + 0.5 - 1e-9);
    expect(w.sc!.log.find((e) => e.eventId === 'acc')!.note).toMatch(/^moved to s=/);
    despawnAll(w, parked);
    const ids: number[] = [];
    for (let k = 0; k < 4; k++) {
      ids.push(sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 10)!);
      for (let t = 0; t < 60; t++) sim.step();
    }
    const problems: string[] = [];
    for (let t = 0; t < 1200; t++) {
      sim.step();
      problems.push(...checkObstacleOverlaps(sim), ...checkInvariants(sim));
    }
    expect(problems).toEqual([]);
    const lead = w.vehicles.find((v) => v.id === ids[0])!;
    expect(lead.v).toBeLessThan(0.1);
    expect(lead.s).toBeLessThanOrEqual(o.rear + 1e-6);
    expect(lead.s).toBeGreaterThan(o.rear - 3);
    // Queued behind the accident for over 60 s, not removed.
    expect(sim.stats().removed).toBe(0);
    const snap = sim.snapshot().scenario!;
    expect(snap.obstacles).toHaveLength(1);
    expect(snap.obstacles[0]!.x).toBeCloseTo(w.graph.lanes[0]!.points[0]!.x + o.rear + o.len / 2, 0);
    for (let t = 0; t < 2000; t++) sim.step();
    expect(w.sc!.obs).toBeNull();
    expect(sim.stats().arrived).toBe(4);
  });

  it('informed vehicles avoid the accident lane through the parallel lane of the same road (lane-shift connectors)', () => {
    // h_1_1 starts at the center node: straight approaches from h_0_1 may shift to the other lane.
    const sim = new Simulation(gridDoc(3, 200, 'road-4', 5), { citizens: false });
    const w = internals(sim);
    sim.setPolicy({ reroute: true, informedShare: 1 });
    for (let t = 0; t < 1200; t++) sim.step();
    const seg = w.graph.segments.get('h_1_1')!;
    const blocked = seg.lanes[0]!;
    const twin = seg.lanes[1]!;
    const users = w.vehicles.filter((v) => v.route.indexOf(blocked, v.ri + 1) > v.ri).map((v) => v.id);
    expect(users.length).toBeGreaterThan(0);
    sim.scenarioInput(input('acc', w.tick, 'accident.start', { segmentId: 'h_1_1', lane: 0, s: 120 }, { durationTicks: 4000 }));
    sim.step();
    sim.step();
    const after = w.vehicles.filter((v) => users.includes(v.id));
    const viaTwin = after.filter((v) => v.route.indexOf(twin, v.ri + 1) > v.ri);
    const stillBlocked = after.filter((v) => v.route.indexOf(blocked, v.ri + 1) > v.ri);
    console.log(`[accident detour] users=${users.length} viaTwin=${viaTwin.length} stillOnBlocked=${stillBlocked.length} detoured=${sim.kpi().detoured}`);
    expect(viaTwin.length).toBeGreaterThan(0);
    expect(sim.kpi().detoured).toBeGreaterThan(0);
  });
});

describe('demand surge', () => {
  it('pre-generates N inflow + N outflow trips on schedule from its own RNG; existing RNG streams untouched', () => {
    // Light background traffic: in a dense stream a departure may wait long for a gap at the curb.
    const doc = cityDoc();
    doc.meta.trafficDensity = 0.3;
    const sim = new Simulation(doc);
    const w = internals(sim);
    for (let t = 0; t < 200; t++) sim.step();
    const T = w.tick;
    expect(sim.scenarioInput(input('fair', T, 'surge.start', { buildingId: 'office1' }, { extraTrips: 30, inflowTicks: 600, stayTicks: 300, outflowTicks: 450 })).ok).toBe(true);
    const before = [w.rng, w.cz.rngAssign, w.cz.rngSched, w.cz.rngMode].map(rngState);
    applyDueInputs(w);
    expect([w.rng, w.cz.rngAssign, w.cz.rngSched, w.cz.rngMode].map(rngState)).toEqual(before);
    const trips = w.sc!.surgeTrips;
    const inflow = trips.filter((t) => t.dir === 0);
    const outflow = trips.filter((t) => t.dir === 1);
    expect(inflow).toHaveLength(30);
    expect(outflow).toHaveLength(30);
    inflow.forEach((t, i) => expect(t.depart).toBe(T + Math.floor((i * 600) / 30)));
    outflow.forEach((t, i) => expect(t.depart).toBe(T + 600 + 300 + Math.floor((i * 450) / 30)));
    const office = w.demand.access.get('office1')!;
    for (const t of inflow) expect(t.to).toEqual(office);
    let maxWaiting = 0;
    for (let t = 0; t < 6000; t++) {
      sim.step();
      maxWaiting = Math.max(maxWaiting, sim.kpi().waitingToDepart);
    }
    for (const t of trips) {
      expect(t.dropped).toBe(false);
      expect(t.spawnTick).toBeGreaterThanOrEqual(t.depart);
    }
    // Departures never leave early. All visitors of one home start from the same curb point, so later ones
    // wait for the previous car (and signal queues) to clear it: counted as waiting to depart meanwhile.
    expect(inflow[0]!.spawnTick).toBe(inflow[0]!.depart);
    expect(maxWaiting).toBeGreaterThan(0);
    const late = inflow.map((t) => t.spawnTick - t.depart).sort((a, b) => a - b);
    console.log(`[surge] inflow departure delay median=${late[15]} max=${late[29]} ticks, max waitingToDepart=${maxWaiting}`);
    expect(sim.kpi().activeEvents).toBe(0);
  }, 60_000);

  it('same surge input, policy ON or OFF → same surge trips; the background demand RNG matches a run without the surge tick by tick', () => {
    const run = (surge: boolean, reroute: boolean): { rng: number[]; trips: string } => {
      const sim = new Simulation(cityDoc(), { citizens: false });
      const w = internals(sim);
      sim.setPolicy({ reroute, informedShare: 0.7 });
      if (surge) sim.scenarioInput(input('s', 100, 'surge.start', { buildingId: 'shop1' }, { extraTrips: 25, inflowTicks: 300, stayTicks: 100 }));
      // A closure too, so that ON actually re-routes.
      sim.scenarioInput(input('c', 150, 'closure.start', { segmentId: 'h_1_1' }, { durationTicks: 900 }));
      const rng: number[] = [];
      for (let t = 0; t < 1500; t++) {
        sim.step();
        rng.push(rngState(w.rng));
      }
      return { rng, trips: JSON.stringify(w.sc!.surgeTrips.map((t) => [t.i, t.dir, t.depart, t.typeId, t.from, t.to])) };
    };
    const on = run(true, true);
    const off = run(true, false);
    const plain = run(false, true);
    expect(JSON.parse(on.trips)).toHaveLength(50);
    expect(on.trips).toBe(off.trips);
    expect(on.rng).toEqual(off.rng);
    expect(on.rng).toEqual(plain.rng);
  });
});

describe('replay and KPI', () => {
  it('the same ScenarioRecord replays to identical states every 100 ticks (closure, accident, surge, policy ON)', () => {
    const doc = cityDoc();
    doc.meta.trafficDensity = 1.5;
    const record: ScenarioRecord = {
      engineVersion: ENGINE_VERSION,
      scenarioVersion: 1,
      baseSeq: 42,
      doc: cloneJson(doc) as CityDoc,
      seed: 99,
      tickRate: 20,
      warmupTicks: 600,
      inputs: [
        input('c1', 800, 'closure.start', { segmentId: 'h_1_1' }, { durationTicks: 1200 }),
        input('a1', 900, 'accident.start', { segmentId: 'v_1_0', lane: 0, s: 60 }, { durationTicks: 800 }),
        input('s1', 700, 'surge.start', { buildingId: 'shop1' }, { extraTrips: 20, inflowTicks: 400, stayTicks: 400 }),
      ],
      policy: { reroute: true, informedShare: 0.7 },
    };
    const problems: string[] = [];
    let obstacleTicks = 0;
    const run = (): string[] => {
      const sim = simulationFromRecord(record);
      const out: string[] = [];
      for (let t = 0; t < 2400; t++) {
        sim.step();
        // Physical invariants under events, in traffic: no body overlaps, none on an obstacle.
        problems.push(...checkInvariants(sim), ...checkObstacleOverlaps(sim));
        if (internals(sim).sc!.obs) obstacleTicks++;
        if (t % 100 === 99) {
          const s = sim.snapshot();
          out.push(Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.stats) + JSON.stringify(s.scenario));
        }
      }
      return out;
    };
    const a = run();
    const b = run();
    expect(a).toHaveLength(24);
    expect(a).toEqual(b);
    expect(problems.slice(0, 5)).toEqual([]);
    expect(obstacleTicks).toBeGreaterThan(1000);
    expect(() => simulationFromRecord({ ...record, engineVersion: 0 })).toThrow();
  }, 120_000);

  it('congestion length: lanes holding a vehicle below 0.3 × speed limit, each lane once', () => {
    const sim = new Simulation(lineDoc(300, 'road-4'), { demand: false, citizens: false });
    const w = internals(sim);
    expect(sim.kpi().congestionLength).toBe(0);
    sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 50);
    sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 100);
    // Two slow (just spawned) vehicles on one lane: that lane's length, once.
    expect(sim.kpi().congestionLength).toBeCloseTo(w.net.len[w.graph.laneById.get('ab|f|0')!]!, 6);
    for (const v of w.vehicles) v.v = 0.31 * w.net.speed[v.edge]!;
    expect(sim.kpi().congestionLength).toBe(0);
    w.vehicles[0]!.v = 0.29 * w.net.speed[w.vehicles[0]!.edge]!;
    expect(sim.kpi().congestionLength).toBeGreaterThan(0);
  });

  it('KpiSeries records one point per 30 game seconds', () => {
    const sim = new Simulation(gridDoc(3, 150), { citizens: false, scenario: true });
    const every = kpiEveryTicks(20);
    expect(every).toBe(60);
    const series = new KpiSeries(every);
    for (let t = 0; t < 600; t++) {
      sim.step();
      series.record(sim.stats().tick, sim);
    }
    expect(series.points.map((p) => p.tick)).toEqual([60, 120, 180, 240, 300, 360, 420, 480, 540, 600]);
    expect(series.points.every((p) => p.since === 0)).toBe(true);
    expect(sim.snapshot().scenario).toBeDefined();
    // Reading KPIs never activates: a plain simulation stays without scenario state.
    const plain = new Simulation(gridDoc(3, 150));
    expect(plain.kpi().since).toBe(-1);
    expect(plain.snapshot().scenario).toBeUndefined();
    expect(plain.scenarioActivatedAt()).toBeNull();
  });
});

function despawnAll(w: World, id: number): void {
  despawn(w, w.vehicles.find((x) => x.id === id)!);
  w.vehicles = w.vehicles.filter((x) => x.alive);
}

declare const console: { log(...args: unknown[]): void };
