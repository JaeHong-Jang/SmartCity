// Bus passengers (ADR 0009 §2): queues, boarding/alighting, capacity, dwell, patience, every cleanup path,
// mode choice and the citizen invariants with the waiting/riding states.

import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type CityDoc, type Command } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkCitizenInvariants, checkInvariants, checkZoneInvariants, internals } from '../testkit.js';
import { CLOCK_SCALE, PedState } from '../types.js';
import type { Vehicle, World } from '../traffic/world.js';
import { CitState, Leg, type Citizen } from './citizens.js';
import { spawnPed } from './peds.js';
import { gameDuration, schedule } from './schedule.js';
import { busOption, enqueue } from './transit.js';

/** Ticks until the game clock shows `hours` on day 1 (the clock starts at 06:30). */
const ticksUntil = (hours: number): number => Math.round((((hours - 6.5) * 3600) / CLOCK_SCALE) * 20);

const LINE = (stopIds: string[], buses: number): Command => ({
  type: 'busLine.upsert',
  line: { id: 'L', name: '1', color: '#22aa44', stopIds, vehicleTypeId: 'city-bus', buses },
});

/**
 * 1.6 km road a → b (two dead ends) with an apartment near a and an office tower near b. Stops at both ends
 * in both directions; line L loops Af → Bf → Bb → Ab.
 */
function corridor(buses: number, extra: Command[] = [], line = true): CityDoc {
  return apply(createEmptyDoc('corridor', 21), [
    { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
    { type: 'node.add', node: { id: 'b', pos: { x: 1600, z: 0 } } },
    { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
    { type: 'building.place', building: { id: 'apt', typeId: 'apartment', pos: { x: 100, z: 35 }, rotation: 0 } },
    { type: 'building.place', building: { id: 'office', typeId: 'office-tower', pos: { x: 1500, z: 40 }, rotation: 0 } },
    { type: 'busStop.add', stop: { id: 'Af', segmentId: 'ab', t: 0.0625, dir: 'forward' } },
    { type: 'busStop.add', stop: { id: 'Bf', segmentId: 'ab', t: 0.9375, dir: 'forward' } },
    { type: 'busStop.add', stop: { id: 'Bb', segmentId: 'ab', t: 0.9375, dir: 'backward' } },
    { type: 'busStop.add', stop: { id: 'Ab', segmentId: 'ab', t: 0.0625, dir: 'backward' } },
    ...(line ? [LINE(['Af', 'Bf', 'Bb', 'Ab'], buses)] : []),
    ...extra,
  ]);
}

function setState(w: World, c: Citizen, s: number): void {
  w.cz.counts[c.state]!--;
  c.state = s;
  w.cz.counts[s]!++;
}

/** Put a citizen (at home) into the queue of `stop` for line L, heading home after the ride. */
function queueAt(w: World, c: Citizen, stop: string, alight: string, tick: number): void {
  const pg = w.ped.pg;
  const node = pg.stopNode[pg.stopIndex.get(stop)!]!;
  setState(w, c, CitState.waiting);
  c.from = c.at;
  c.at = null;
  c.dest = c.home;
  c.purpose = 0;
  c.ped = spawnPed(w, node, c.id, c.slot, c.vPref, c.style, 0);
  w.peds.pending[c.ped] = 1;
  w.peds.state[c.ped] = PedState.busStop;
  c.leg = Leg.wait;
  c.line = 'L';
  c.board = stop;
  c.alight = alight;
  enqueue(w, stop, 'L', { slot: c.slot, pid: c.id, tick });
  schedule(w, c, w.tick + gameDuration(w, 30 * 60));
}

const citizens = (w: World): Citizen[] => w.cz.slots.filter((c): c is Citizen => c !== null).sort((a, b) => a.id - b.id);

/** Step until `pred` holds (checking every invariant each tick); returns the ticks taken. */
function stepUntil(sim: Simulation, pred: () => boolean, max: number): number {
  for (let t = 0; t < max; t++) {
    if (pred()) return t;
    sim.step();
    const p = [...checkCitizenInvariants(sim), ...checkInvariants(sim), ...checkZoneInvariants(sim)];
    if (p.length) throw new Error(`tick ${sim.stats().tick}: ${p.slice(0, 4).join('; ')}`);
  }
  throw new Error('condition not reached');
}

/** One bus, 25 citizens queued at Bf at tick 0: five of them with a later arrival tick, inserted in reverse id order. */
function queuedScenario(extra: Command[] = []): { sim: Simulation; w: World; bus: () => Vehicle; fifo: Citizen[] } {
  const sim = new Simulation(corridor(1, extra), { demand: false });
  const w = internals(sim);
  const cs = citizens(w).slice(0, 25);
  for (let k = cs.length - 1; k >= 0; k--) queueAt(w, cs[k]!, 'Bf', 'Ab', k < 5 ? 1 : 0);
  const fifo = [...cs.slice(5), ...cs.slice(0, 5)];
  expect(checkCitizenInvariants(sim)).toEqual([]);
  return { sim, w, bus: () => w.vehicles.find((v) => v.bus)!, fifo };
}

const dwelling = (v: Vehicle | undefined): boolean => !!v && !!v.bus && v.bus.dwell > 0;

describe('bus passengers: boarding, alighting, dwell', () => {
  it('boards FIFO by (arrival tick, id), at most 20 per stop, and dwells clamp(10 + max(alight, 1.5 board), 10, 40) s', () => {
    const { sim, w, bus, fifo } = queuedScenario();
    sim.step();
    expect(w.vehicles.filter((v) => v.bus)).toHaveLength(1);
    stepUntil(sim, () => dwelling(bus()), 4000);
    const b = bus().bus!;
    expect(w.doc.busLines.L!.stopIds[b.stopIdx]).toBe('Bf');
    // 25 waiting, capacity 40: the 20-per-arrival cap applies; dwell = 10 + 20 · 1.5 = 40 s.
    expect(b.riders.map((r) => r.slot)).toEqual(fifo.slice(0, 20).map((c) => c.slot));
    expect(b.dwell).toBe(40 * 20);
    for (const c of fifo.slice(0, 20)) {
      expect(c.state).toBe(CitState.riding);
      expect(c.ped).toBe(-1);
    }
    const st = sim.stats().citizens;
    expect(st.riding).toBe(20);
    expect(st.waitingBus).toBe(5);
    const snap = sim.snapshot();
    const vi = w.vehicles.indexOf(bus());
    expect(snap.busLoad[vi]).toBe(20);
    expect(snap.busStopIds).toEqual(['Ab', 'Af', 'Bb', 'Bf']);
    expect(Array.from(snap.stopWaiting.subarray(0, 4))).toEqual([0, 0, 0, 5]);
    const view = sim.vehicles().find((v) => v.busLineId === 'L')!;
    expect(view.passengers).toBe(20);
    expect(view.capacity).toBe(40);
    // Queued pedestrians stand in two columns behind the stop, 0.65 m apart, never on the same spot.
    const pts = new Set<string>();
    for (let k = 0; k < snap.pedestrianCount; k++) {
      expect(snap.pedestrians[k * 8 + 6]).toBe(PedState.busStop);
      pts.add(`${snap.pedestrians[k * 8]!.toFixed(2)},${snap.pedestrians[k * 8 + 1]!.toFixed(2)}`);
    }
    expect(pts.size).toBe(5);

    // Next stop Bb: nobody gets on or off → exactly 10 s.
    stepUntil(sim, () => !dwelling(bus()), 1000);
    stepUntil(sim, () => dwelling(bus()), 4000);
    expect(w.doc.busLines.L!.stopIds[bus().bus!.stopIdx]).toBe('Bb');
    expect(bus().bus!.dwell).toBe(10 * 20);
    expect(bus().bus!.riders).toHaveLength(20);

    // Ab: all 20 get off → 10 + 20 · 1.0 = 30 s; they step onto the sidewalk when the dwell ends.
    stepUntil(sim, () => !dwelling(bus()), 1000);
    stepUntil(sim, () => dwelling(bus()), 6000);
    expect(w.doc.busLines.L!.stopIds[bus().bus!.stopIdx]).toBe('Ab');
    expect(bus().bus!.dwell).toBe(30 * 20);
    expect(bus().bus!.riders).toHaveLength(0);
    expect(bus().bus!.alighting).toHaveLength(20);
    expect(sim.snapshot().busLoad[w.vehicles.indexOf(bus())]).toBe(20);
    stepUntil(sim, () => !dwelling(bus()), 1000);
    const pg = w.ped.pg;
    const abNode = pg.stopNode[pg.stopIndex.get('Ab')!]!;
    for (const c of fifo.slice(0, 20)) {
      expect(c.state).not.toBe(CitState.riding);
      expect(c.ride).toBeNull();
    }
    expect(fifo.slice(0, 20).every((c) => c.ped >= 0 && w.peds.node[c.ped] === abNode)).toBe(true);
    // They walk home from the stop (one band behind the slowest walker).
    stepUntil(sim, () => fifo.slice(0, 20).every((c) => c.state === CitState.home), 12000);
    expect(w.cz.failedTrips).toBe(0);
  }, 60_000);

  it('gives up after 30 game minutes (180 s) and walks; a boarded rider ignores its stale patience event', () => {
    const { sim, w, fifo } = queuedScenario();
    stepUntil(sim, () => fifo[0]!.state === CitState.riding, 4000);
    // The five left behind time out at tick 3600 (30 min · 60 / 10 · 20); riders stay aboard.
    stepUntil(sim, () => sim.stats().tick >= 3599, 4000);
    expect(fifo.slice(20).every((c) => c.state === CitState.waiting)).toBe(true);
    sim.step();
    sim.step();
    for (const c of fifo.slice(20)) {
      expect(c.state).toBe(CitState.walking);
      expect(c.board).toBeNull();
      expect(w.peds.state[c.ped]).not.toBe(PedState.busStop);
    }
    expect(w.transit.queues.size).toBe(0);
    for (const c of fifo.slice(0, 20)) expect(c.state).toBe(CitState.riding);
    expect(checkCitizenInvariants(sim)).toEqual([]);
  }, 60_000);

  it('capacity: boards only up to the capacity; a smaller capacity keeps the riders aboard but boards nobody', () => {
    const { sim, w, bus, fifo } = queuedScenario([
      { type: 'vehicleType.upsert', vehicleType: { ...createEmptyDoc('x', 1).vehicleTypes['city-bus']!, capacity: 12 } },
    ]);
    stepUntil(sim, () => dwelling(bus()), 4000);
    expect(bus().bus!.riders.map((r) => r.slot)).toEqual(fifo.slice(0, 12).map((c) => c.slot));
    expect(bus().bus!.dwell).toBe(28 * 20);
    const id = bus().id;
    sim.applyCommand({ type: 'vehicleType.upsert', vehicleType: { ...sim.doc.vehicleTypes['city-bus']!, capacity: 5 } });
    stepUntil(sim, () => !dwelling(bus()), 1000);
    expect(bus().id).toBe(id);
    expect(bus().bus!.riders).toHaveLength(12);
    // Three citizens queue at the next stop: over capacity, nobody boards (10 s dwell).
    const more = citizens(w).filter((c) => c.state === CitState.home).slice(0, 3);
    for (const c of more) queueAt(w, c, 'Bb', 'Ab', w.tick);
    stepUntil(sim, () => dwelling(bus()), 4000);
    expect(bus().bus!.riders).toHaveLength(12);
    expect(bus().bus!.dwell).toBe(10 * 20);
    expect(more.every((c) => c.state === CitState.waiting)).toBe(true);
    expect(sim.vehicles()[0]!.capacity).toBe(5);
  }, 60_000);
});

describe('bus passengers: cleanup paths (each exactly once)', () => {
  it('bus removed (line shrinks to 0 buses): riders end their trip, counted once', () => {
    const { sim, w, fifo } = queuedScenario();
    stepUntil(sim, () => fifo[0]!.state === CitState.riding, 4000);
    expect(sim.applyCommand(LINE(['Af', 'Bf', 'Bb', 'Ab'], 0)).ok).toBe(true);
    sim.step();
    expect(checkCitizenInvariants(sim)).toEqual([]);
    expect(w.cz.failedTrips).toBe(20);
    for (const c of fifo.slice(0, 20)) expect(c.state).toBe(CitState.home);
    // The others still wait (the stop is still on the line) until their patience runs out.
    expect(fifo.slice(20).every((c) => c.state === CitState.waiting)).toBe(true);
    for (let t = 0; t < 200; t++) sim.step();
    expect(w.cz.failedTrips).toBe(20);
  }, 60_000);

  it('alighting stop removed from the line: riders get off at the next stop and walk', () => {
    const { sim, w, bus, fifo } = queuedScenario();
    stepUntil(sim, () => fifo[0]!.state === CitState.riding, 4000);
    expect(sim.applyCommand(LINE(['Af', 'Bf', 'Bb'], 1)).ok).toBe(true);
    stepUntil(sim, () => !dwelling(bus()), 1000);
    stepUntil(sim, () => dwelling(bus()), 4000);
    expect(w.doc.busLines.L!.stopIds[bus().bus!.stopIdx]).toBe('Bb');
    expect(bus().bus!.alighting).toHaveLength(20);
    expect(bus().bus!.dwell).toBe(30 * 20);
    stepUntil(sim, () => !dwelling(bus()), 1000);
    for (const c of fifo.slice(0, 20)) expect([CitState.walking, CitState.leaving]).toContain(c.state);
    expect(w.cz.failedTrips).toBe(0);
  }, 60_000);

  it('stop deleted: waiters leave the queue and walk', () => {
    const { sim, w, fifo } = queuedScenario();
    sim.step();
    expect(sim.applyCommand({ type: 'busStop.remove', id: 'Bf' }).ok).toBe(true);
    sim.step();
    expect(checkCitizenInvariants(sim)).toEqual([]);
    expect(w.transit.queues.size).toBe(0);
    for (const c of fifo) {
      expect(c.state).toBe(CitState.walking);
      expect(c.ped).toBeGreaterThanOrEqual(0);
    }
    // Their patience events are void: nothing happens to them at tick 3600 except walking on.
    stepUntil(sim, () => sim.stats().tick > 3700, 4000);
    expect(w.cz.failedTrips).toBe(0);
  }, 60_000);

  it('sidewalk gone: the stop is no longer served and its waiters walk', () => {
    // Road a – m – b; stop M on m–b 8 m past m. Only m–b loses its sidewalks.
    const doc = apply(createEmptyDoc('split', 21), [
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'm', pos: { x: 800, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 1600, z: 0 } } },
      { type: 'segment.add', segment: { id: 'am', a: 'a', b: 'm', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'mb', a: 'm', b: 'b', roadTypeId: 'road-2' } },
      { type: 'building.place', building: { id: 'apt', typeId: 'apartment', pos: { x: 100, z: 35 }, rotation: 0 } },
      { type: 'busStop.add', stop: { id: 'A', segmentId: 'am', t: 0.125, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'M', segmentId: 'mb', t: 0.01, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'B', segmentId: 'mb', t: 0.875, dir: 'forward' } },
      LINE(['A', 'M', 'B'], 1),
    ]);
    const sim = new Simulation(doc, { demand: false });
    const w = internals(sim);
    const cs = citizens(w).slice(0, 6);
    for (const c of cs) queueAt(w, c, 'M', 'A', 0);
    sim.step();
    expect(cs.every((c) => c.state === CitState.waiting)).toBe(true);
    const rt = { ...sim.doc.roadTypes['road-2']!, id: 'bare', name: 'bare', sidewalk: false };
    expect(sim.applyCommand({ type: 'batch', commands: [{ type: 'roadType.upsert', roadType: rt }, { type: 'segment.setType', id: 'mb', roadTypeId: 'bare' }] }).ok).toBe(true);
    sim.step();
    expect(checkCitizenInvariants(sim)).toEqual([]);
    expect(w.ped.pg.stopIds).toEqual(['A']);
    expect(w.transit.queues.size).toBe(0);
    for (const c of cs) expect(c.state).toBe(CitState.walking);
    expect(w.cz.failedTrips).toBe(0);
    stepUntil(sim, () => cs.every((c) => c.state === CitState.home), 40000);
  }, 60_000);

  it('line deleted: waiters walk, riders end their trip (counted)', () => {
    const { sim, w, fifo } = queuedScenario();
    stepUntil(sim, () => fifo[0]!.state === CitState.riding, 4000);
    expect(sim.applyCommand({ type: 'busLine.remove', id: 'L' }).ok).toBe(true);
    sim.step();
    expect(checkCitizenInvariants(sim)).toEqual([]);
    expect(w.cz.failedTrips).toBe(20);
    for (const c of fifo.slice(0, 20)) expect(c.state).toBe(CitState.home);
    for (const c of fifo.slice(20)) expect(c.state).toBe(CitState.walking);
    expect(w.transit.queues.size).toBe(0);
  }, 60_000);

  it('home demolished: waiting and riding residents disappear from every queue and bus', () => {
    const { sim, w, bus, fifo } = queuedScenario();
    stepUntil(sim, () => fifo[0]!.state === CitState.riding, 4000);
    expect(sim.applyCommand({ type: 'building.remove', id: 'apt' }).ok).toBe(true);
    sim.step();
    expect(checkCitizenInvariants(sim)).toEqual([]);
    expect(w.cz.count).toBe(0);
    expect(w.transit.queues.size).toBe(0);
    expect(bus().bus!.riders).toHaveLength(0);
    for (let t = 0; t < 400; t++) sim.step();
    expect(checkCitizenInvariants(sim)).toEqual([]);
  }, 60_000);
});

describe('bus passengers: mode choice', () => {
  it('without a direct bus candidate the old rule decides (a line with 0 buses is no candidate)', () => {
    const run = (doc: CityDoc): { drivers: number[]; bus: boolean } => {
      const sim = new Simulation(doc, { demand: false });
      const w = internals(sim);
      const drivers = new Set<number>();
      let bus = false;
      for (let t = 0; t < ticksUntil(9.2); t++) {
        sim.step();
        for (const v of sim.vehicles()) if (v.personId !== undefined) drivers.add(v.personId);
        const st = sim.stats().citizens;
        if (st.waitingBus + st.riding > 0) bus = true;
      }
      for (const a of w.ped.pg.access) for (const b of w.ped.pg.access) if (a && b && a !== b) expect(busOption(w, a.door, b.door)).toBeNull();
      return { drivers: [...drivers].sort((x, y) => x - y), bus };
    };
    const none = run(corridor(0, [], false));
    const zero = run(corridor(0));
    expect(none.drivers.length).toBeGreaterThan(20);
    expect(zero.drivers).toEqual(none.drivers);
    expect(zero.bus).toBe(false);
    expect(none.bus).toBe(false);
  }, 60_000);

  it('a long trip along a bus line takes the bus (walk → queue → ride → walk), invariants hold all day', () => {
    const sim = new Simulation(corridor(2), { demand: false });
    const w = internals(sim);
    const rode = new Set<number>();
    const commuted = new Set<number>();
    let maxRiding = 0;
    let maxWaiting = 0;
    let loadSeen = false;
    for (let t = 0; t < ticksUntil(21); t++) {
      sim.step();
      if (t % 5 === 0) {
        const p = checkCitizenInvariants(sim);
        if (p.length) throw new Error(`tick ${t}: ${p.slice(0, 4).join('; ')}`);
      }
      const st = sim.stats().citizens;
      maxRiding = Math.max(maxRiding, st.riding);
      maxWaiting = Math.max(maxWaiting, st.waitingBus);
      for (const c of w.cz.slots) {
        if (!c) continue;
        if (c.state === CitState.riding) rode.add(c.id);
        if (rode.has(c.id) && c.state === CitState.atWork) commuted.add(c.id);
      }
      if (t % 200 === 0 && st.riding > 0) {
        const snap = sim.snapshot();
        let load = 0;
        for (let k = 0; k < snap.vehicleCount; k++) load += snap.busLoad[k]!;
        expect(load).toBe(st.riding);
        loadSeen = true;
      }
    }
    // Car owners drive (faster), the others take the bus instead of walking 1.4 km.
    const workers = w.cz.slots.filter((c) => c && c.worker && c.work).length;
    const carless = w.cz.slots.filter((c) => c && c.worker && c.work && !c.hasCar).length;
    expect(workers).toBeGreaterThan(50);
    expect(rode.size).toBeGreaterThan(0.6 * carless);
    expect(commuted.size).toBeGreaterThan(0.6 * carless);
    expect(maxRiding).toBeGreaterThan(5);
    expect(maxWaiting).toBeGreaterThan(0);
    expect(loadSeen).toBe(true);
    expect(w.cz.failedTrips).toBe(0);
    // Evening: (almost) everyone is home; the rest still walk 1.4 km from a curb where the car could not start.
    expect(sim.stats().citizens.home).toBeGreaterThan(0.9 * w.cz.count);
  }, 120_000);

  it('is deterministic with buses and passengers (same doc and seed → same snapshot bytes)', () => {
    const run = (): number[] => {
      const sim = new Simulation(corridor(2), { demand: false });
      const out: number[] = [];
      for (let t = 0; t < ticksUntil(8.2); t++) {
        sim.step();
        if (t % 500 === 0) {
          const s = sim.snapshot();
          out.push(...s.pedestrians.subarray(0, s.pedestrianCount * 8), ...s.busLoad.subarray(0, s.vehicleCount), ...s.stopWaiting.subarray(0, 4));
        }
      }
      return out;
    };
    expect(run()).toEqual(run());
  }, 60_000);
});

describe('Sol 3b review #8: no walking route, but a direct bus', () => {
  it('rides the bus instead of failing the trip when the sidewalk is missing in the middle', () => {
    const doc = apply(createEmptyDoc('gap', 21), [
      { type: 'roadType.upsert', roadType: { id: 'bare-2', name: '보도 없는 2차선', lanesForward: 1, lanesBackward: 1, laneWidth: 3.5, speedLimit: 13.89, sidewalk: false, busOnlyRightLane: false } },
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'm1', pos: { x: 300, z: 0 } } },
      { type: 'node.add', node: { id: 'm2', pos: { x: 1300, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 1600, z: 0 } } },
      { type: 'segment.add', segment: { id: 'A', a: 'a', b: 'm1', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'M', a: 'm1', b: 'm2', roadTypeId: 'bare-2' } },
      { type: 'segment.add', segment: { id: 'B', a: 'm2', b: 'b', roadTypeId: 'road-2' } },
      { type: 'building.place', building: { id: 'apt', typeId: 'apartment', pos: { x: 120, z: 35 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'office', typeId: 'office-tower', pos: { x: 1480, z: 40 }, rotation: 0 } },
      { type: 'busStop.add', stop: { id: 'Af', segmentId: 'A', t: 0.5, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'Bf', segmentId: 'B', t: 0.5, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'Bb', segmentId: 'B', t: 0.5, dir: 'backward' } },
      { type: 'busStop.add', stop: { id: 'Ab', segmentId: 'A', t: 0.5, dir: 'backward' } },
      LINE(['Af', 'Bf', 'Bb', 'Ab'], 3),
    ]);
    const sim = new Simulation(doc, { demand: false });
    const w = internals(sim);
    let peakRiding = 0;
    for (let t = 0; t < ticksUntil(9.5); t++) {
      sim.step();
      peakRiding = Math.max(peakRiding, sim.stats().citizens.riding);
      if (t % 200 === 0) expect(checkCitizenInvariants(sim)).toEqual([]);
    }
    expect(peakRiding).toBeGreaterThan(0);
    // Most commuters got there by bus rather than by a counted failure.
    expect(w.cz.failedTrips).toBeLessThan(w.cz.trips / 2);
  }, 120_000);
});
