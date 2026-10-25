// ON/OFF fairness with citizens and at the vehicle cap, and exact replay of runtime policy changes (ADR 0010 §5).

import { describe, expect, it } from 'vitest';
import { cloneJson } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { cityDoc, gridDoc, internals } from '../testkit.js';
import { CLOCK_SCALE, CLOCK_START } from '../types.js';
import { simulationFromRecord } from './record.js';
import { ENGINE_VERSION, type ScenarioInput } from './types.js';

declare const console: { log(...args: unknown[]): void };

const rngState = (r: unknown): number => (r as { s: number }).s;
const INDOOR = new Set([0, 5, 6]);
const HOME = 0;

function input(eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}): ScenarioInput {
  return { eventId, tick, order: 0, kind, target, params };
}

/** Tick of a game clock time (seconds since day-1 midnight) at 20 Hz. */
const tickOf = (game: number): number => Math.ceil(((game - CLOCK_START) / CLOCK_SCALE) * 20);

interface Trip {
  dep: number;
  fromHome: boolean;
  from: string;
  dest: string;
  purpose: number;
  /** Arrival tick of the trip before (−1 for the first). */
  prevArr: number;
  arr: number;
}

describe('ON/OFF fairness', () => {
  it('with citizens: same trip intents for 2 game days; home departures at identical ticks, other departures a fixed stay after arrival', () => {
    // 450 m blocks: walks between corners exceed 1 km, so car-owning citizens drive through the closures.
    const END = tickOf(86400 + 9.5 * 3600); // day 2, 09:30 (after the second morning's departures)
    const run = (reroute: boolean) => {
      const doc = cityDoc(450);
      const sim = new Simulation(doc);
      const w = internals(sim);
      sim.setPolicy({ reroute, informedShare: 0.7 });
      // Morning and evening rush closures of the central crossing's roads.
      for (const [k, from, to] of [
        ['am', tickOf(7.2 * 3600), tickOf(9.5 * 3600)],
        ['pm', tickOf(15 * 3600), tickOf(18 * 3600)],
      ] as const)
        for (const seg of ['h_0_1', 'h_1_1', 'v_1_0', 'v_1_1'])
          expect(sim.scenarioInput(input(`${k}-${seg}`, from, 'closure.start', { segmentId: seg }, { durationTicks: to - from })).ok).toBe(true);
      const trips = new Map<number, Trip[]>();
      const prev = new Map<number, { state: number; at: string | null; arr: number }>();
      for (const c of w.cz.slots) if (c) prev.set(c.id, { state: c.state, at: c.at, arr: -1 });
      let maxDriving = 0;
      for (let t = 0; t < END; t++) {
        sim.step();
        maxDriving = Math.max(maxDriving, w.cz.counts[3]!);
        for (const c of w.cz.slots) {
          if (!c) continue;
          const p = prev.get(c.id)!;
          const wasIn = INDOOR.has(p.state);
          const isIn = INDOOR.has(c.state);
          const list = trips.get(c.id) ?? [];
          // Departure: out of a building, or (a trip that failed at once) indoors in another building.
          if (wasIn && (!isIn || c.at !== p.at)) {
            list.push({ dep: w.tick - 1, fromHome: p.state === HOME, from: p.at!, dest: isIn ? c.at! : c.dest!, purpose: isIn ? -1 : c.purpose, prevArr: p.arr, arr: isIn ? w.tick - 1 : -1 });
            trips.set(c.id, list);
            if (isIn) p.arr = w.tick - 1;
          } else if (!wasIn && isIn) {
            const last = list[list.length - 1]!;
            last.arr = w.tick - 1;
            p.arr = w.tick - 1;
          }
          p.state = c.state;
          p.at = c.at;
        }
      }
      return { trips, maxDriving, kpi: sim.kpi(), dropped: sim.kpi().droppedTrips };
    };
    const on = run(true);
    const off = run(false);
    const day2 = tickOf(86400);
    let compared = 0;
    let homeDeps = 0;
    let day2HomeDeps = 0;
    let stays = 0;
    let arrivalsDiffer = 0;
    const problems: string[] = [];
    let boundary = 0;
    const ids = new Set([...on.trips.keys(), ...off.trips.keys()]);
    for (const id of ids) {
      const a = on.trips.get(id) ?? [];
      const b = off.trips.get(id) ?? [];
      const n = Math.min(a.length, b.length);
      // Equal counts, except one trip at the end of the window: a departure a stay after an arrival that
      // came later on the other side, which then had not happened yet at END (never a home departure).
      if (a.length !== b.length) {
        const [long, short] = a.length > b.length ? [a, b] : [b, a];
        const extra = long[n]!;
        const last = short[n - 1];
        const legit = long.length - short.length === 1 && !extra.fromHome && last !== undefined && (last.arr < 0 || last.arr + (extra.dep - extra.prevArr) >= END - 1);
        if (!legit) problems.push(`citizen ${id}: ${a.length} trips ON vs ${b.length} OFF (extra ${extra.from}→${extra.dest} at ${extra.dep})`);
        else boundary++;
      }
      for (let k = 0; k < n; k++) {
        const x = a[k]!;
        const y = b[k]!;
        compared++;
        // Same intent: origin, destination and purpose (the scheduled plan), whatever the traffic did.
        if (x.from !== y.from || x.dest !== y.dest || (x.purpose >= 0 && y.purpose >= 0 && x.purpose !== y.purpose)) problems.push(`citizen ${id} trip ${k}: ${x.from}→${x.dest} vs ${y.from}→${y.dest}`);
        if (x.fromHome !== y.fromHome) problems.push(`citizen ${id} trip ${k}: from home ${x.fromHome} vs ${y.fromHome}`);
        else if (x.fromHome) {
          // Scheduled from home: hash of (citizen, day) → identical tick.
          homeDeps++;
          if (x.dep >= day2) day2HomeDeps++;
          if (x.dep !== y.dep) problems.push(`citizen ${id} trip ${k}: home departure ${x.dep} vs ${y.dep}`);
        } else {
          // From work or a shop: a fixed (work) or per-citizen-day hashed (shop) stay after the arrival.
          stays++;
          if (x.dep - x.prevArr !== y.dep - y.prevArr) problems.push(`citizen ${id} trip ${k}: stay ${x.dep - x.prevArr} vs ${y.dep - y.prevArr}`);
        }
        if (x.arr !== y.arr) arrivalsDiffer++;
      }
    }
    console.log(
      `[citizen fairness] trips compared=${compared} lengthDiffAtWindowEnd=${boundary} homeDepartures=${homeDeps} (day 2: ${day2HomeDeps}) staysAfterArrival=${stays} arrivalsDiffer=${arrivalsDiffer} ` +
        `maxDriving ON/OFF=${on.maxDriving}/${off.maxDriving} rerouted=${on.kpi.rerouted} completed ON/OFF=${on.kpi.completed}/${off.kpi.completed}`,
    );
    expect(problems.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(500);
    expect(day2HomeDeps).toBeGreaterThan(50);
    expect(stays).toBeGreaterThan(100);
    // The comparison is not trivial: citizens drove, ON re-routed, and the traffic outcome differed.
    expect(on.maxDriving).toBeGreaterThan(0);
    expect(on.kpi.rerouted).toBeGreaterThan(0);
    expect(arrivalsDiffer).toBeGreaterThan(0);
  }, 600_000);

  it('at the vehicle cap: demand draws continue (counted as dropped), so the demand RNG matches ON/OFF tick by tick', () => {
    const run = (reroute: boolean) => {
      const doc = gridDoc(4, 150, 'road-4', 3);
      doc.meta.trafficDensity = 3;
      const sim = new Simulation(doc, { citizens: false, maxVehicles: 60 });
      const w = internals(sim);
      sim.setPolicy({ reroute, informedShare: 0.7 });
      for (const seg of ['h_1_1', 'h_1_2', 'v_1_1', 'v_2_1']) sim.scenarioInput(input(`c-${seg}`, 300, 'closure.start', { segmentId: seg }, { durationTicks: 1500 }));
      const rng: number[] = [];
      let atCap = 0;
      for (let t = 0; t < 2400; t++) {
        sim.step();
        rng.push(rngState(w.rng));
        if (w.vehicles.length + w.queue.length >= 60) atCap++;
      }
      return { rng, atCap, kpi: sim.kpi(), vehicles: sim.stats().vehicles };
    };
    const on = run(true);
    const off = run(false);
    console.log(`[cap fairness] ticks at cap ON/OFF=${on.atCap}/${off.atCap} dropped ON/OFF=${on.kpi.droppedTrips}/${off.kpi.droppedTrips} rerouted=${on.kpi.rerouted}`);
    expect(on.atCap).toBeGreaterThan(500);
    expect(on.kpi.droppedTrips).toBeGreaterThan(0);
    expect(off.kpi.droppedTrips).toBeGreaterThan(0);
    expect(on.kpi.rerouted).toBeGreaterThan(0);
    expect(on.rng).toEqual(off.rng);
  }, 120_000);
});

describe('runtime policy changes', () => {
  it('are recorded as tick-aligned inputs: a record built from a live run replays it exactly', () => {
    const doc = cityDoc();
    doc.meta.trafficDensity = 1.5;
    const initial = { reroute: false, informedShare: 0.7 };
    const live = new Simulation(cloneJson(doc));
    live.setPolicy(initial);
    live.scenarioInput(input('c1', 400, 'closure.start', { segmentId: 'h_1_1' }, { durationTicks: 900 }));
    live.scenarioInput(input('c2', 1000, 'closure.start', { segmentId: 'v_1_0' }, { durationTicks: 900 }));
    const hash = (sim: Simulation): string => {
      const s = sim.snapshot();
      return Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.stats) + JSON.stringify(s.scenario);
    };
    const a: string[] = [];
    const recorded: ScenarioInput[] = [];
    for (let t = 0; t < 2000; t++) {
      // Policy flips between steps, as the worker does when a message arrives.
      if (t === 350) recorded.push(live.setPolicy({ reroute: true, informedShare: 0.7 }));
      if (t === 900) recorded.push(live.setPolicy({ reroute: true, informedShare: 0.3 }));
      if (t === 900) recorded.push(live.setPolicy({ reroute: false, informedShare: 0.3 }));
      if (t === 980) recorded.push(live.setPolicy({ reroute: true, informedShare: 1 }));
      live.step();
      if (t % 100 === 99) a.push(hash(live));
    }
    expect(recorded.map((r) => [r.eventId, r.tick, r.params.reroute])).toEqual([
      ['policy@350#1', 350, 1],
      ['policy@900#2', 900, 1],
      ['policy@900#3', 900, 0],
      ['policy@980#4', 980, 1],
    ]);
    const inputs = live.scenarioInputs();
    expect(inputs.filter((i) => i.kind === 'policy.set')).toHaveLength(5);
    const replay = simulationFromRecord({ engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs, policy: initial });
    const b: string[] = [];
    for (let t = 0; t < 2000; t++) {
      replay.step();
      if (t % 100 === 99) b.push(hash(replay));
    }
    expect(b).toEqual(a);
    // Without the recorded changes (initial policy only) the run differs: the changes mattered.
    const bare = simulationFromRecord({ engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: inputs.filter((i) => i.kind !== 'policy.set'), policy: initial });
    const c: string[] = [];
    for (let t = 0; t < 2000; t++) {
      bare.step();
      if (t % 100 === 99) c.push(hash(bare));
    }
    expect(c).not.toEqual(a);
  }, 120_000);
});
