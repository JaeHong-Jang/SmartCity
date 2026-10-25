// Regressions from the 4c1-core cross review (harness/runs/4c/sol-core-review.md): activation tick in records,
// obstacles after a recompile, and the global vehicle-id order of the re-route queue.

import { describe, expect, it } from 'vitest';
import { cloneJson, Rng } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { checkInvariants, checkObstacleOverlaps, cityDoc, gridDoc, internals, lineDoc } from '../testkit.js';
import { applyDueInputs } from './apply.js';
import { simulationFromRecord } from './record.js';
import { DEFAULT_POLICY, ENGINE_VERSION, type ScenarioInput, type ScenarioRecord } from './types.js';

declare const structuredClone: <T>(value: T) => T;

function input(eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}, order = 0): ScenarioInput {
  return { eventId, tick, order, kind, target, params };
}

const hash = (sim: Simulation): string => {
  const s = sim.snapshot();
  return Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.stats) + JSON.stringify(s.scenario);
};

describe('#1 activation tick', () => {
  it('a run activated after warm-up (first setPolicy at tick 3000) replays exactly from its record', () => {
    const doc = cityDoc();
    doc.meta.trafficDensity = 1.5;
    const live = new Simulation(cloneJson(doc));
    for (let t = 0; t < 3000; t++) live.step();
    expect(live.scenarioActivatedAt()).toBeNull();
    live.setPolicy({ reroute: true, informedShare: 0.7 });
    expect(live.scenarioActivatedAt()).toBe(3000);
    live.scenarioInput(input('c', 3300, 'closure.start', { segmentId: 'h_1_1' }, { durationTicks: 600 }));
    const a: string[] = [];
    for (let t = 0; t < 1500; t++) {
      live.step();
      if (t % 250 === 249) a.push(hash(live));
    }
    const base: ScenarioRecord = { engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 3000, inputs: live.scenarioInputs(), policy: { ...DEFAULT_POLICY } };
    const replay = (record: ScenarioRecord): string[] => {
      const sim = simulationFromRecord(record);
      expect(sim.stats().tick).toBe(3000);
      const out: string[] = [];
      for (let t = 0; t < 1500; t++) {
        sim.step();
        if (t % 250 === 249) out.push(hash(sim));
      }
      return out;
    };
    const b = replay({ ...base, activatedAtTick: live.scenarioActivatedAt()! });
    expect(b).toHaveLength(6);
    expect(b).toEqual(a);
    // Sol's repro: the same record activated at tick 0 diverges (citizen decisions, KPI `since`).
    expect(replay(base)).not.toEqual(a);
  }, 120_000);

  it('SimOptions.scenario activates at construction: a whole experiment, warm-up included, replays', () => {
    const doc = cityDoc();
    const live = new Simulation(cloneJson(doc), { scenario: true });
    expect(live.scenarioActivatedAt()).toBe(0);
    expect(live.snapshot().scenario?.kpi.since).toBe(0);
    for (let t = 0; t < 1000; t++) live.step();
    live.scenarioInput(input('a', 1200, 'accident.start', { segmentId: 'v_1_0', lane: 0, s: 50 }, { durationTicks: 500 }));
    live.setPolicy({ reroute: true, informedShare: 1 });
    const a: string[] = [];
    for (let t = 0; t < 1000; t++) {
      live.step();
      if (t % 200 === 199) a.push(hash(live));
    }
    const sim = simulationFromRecord({ engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 1000, inputs: live.scenarioInputs(), policy: { ...DEFAULT_POLICY }, activatedAtTick: 0 });
    const b: string[] = [];
    for (let t = 0; t < 1000; t++) {
      sim.step();
      if (t % 200 === 199) b.push(hash(sim));
    }
    expect(b).toEqual(a);
  }, 120_000);
});

describe('recheck #1/#2: replay activation is exact and read-only queries never activate', () => {
  const recorded = () => {
    const doc = cityDoc();
    doc.meta.trafficDensity = 1.5;
    const live = new Simulation(cloneJson(doc));
    for (let t = 0; t < 300; t++) live.step();
    // Read-only queries before activation: inactive, and they do not activate.
    expect(live.kpi().since).toBe(-1);
    expect(live.scenarioActivatedAt()).toBeNull();
    live.setPolicy({ reroute: true, informedShare: 0.7 });
    live.scenarioInput(input('c', 400, 'closure.start', { segmentId: 'h_1_1' }, { durationTicks: 500 }));
    const at300 = hash(live);
    const record: ScenarioRecord = { engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 300, inputs: live.scenarioInputs(), policy: { ...DEFAULT_POLICY }, activatedAtTick: 300 };
    for (let t = 0; t < 900; t++) live.step();
    return { record, at300, final: hash(live), since: live.kpi().since };
  };

  it('activatedAtTick = warmupTicks: the returned replay is already active at that tick, like the live run', () => {
    const { record, at300 } = recorded();
    const sim = simulationFromRecord(record);
    expect(sim.stats().tick).toBe(300);
    expect(sim.scenarioActivatedAt()).toBe(300);
    expect(sim.snapshot().scenario?.kpi.since).toBe(300);
    expect(hash(sim)).toBe(at300);
  });

  it('kpi() queries and early setPolicy / inputs during a replay change nothing (since and final state)', () => {
    const { record, final, since } = recorded();
    const sim = simulationFromRecord(record, {}, { warmup: false });
    let rejected = 0;
    for (let t = 0; t < 1200; t++) {
      if (t % 7 === 0) sim.kpi();
      if (t === 50) {
        expect(() => sim.setPolicy({ reroute: false, informedShare: 0.1 })).toThrow(RangeError);
        const r = sim.scenarioInput(input('early', 100, 'closure.start', { segmentId: 'h_0_0' }));
        if (!r.ok) rejected++;
        expect(sim.kpi().since).toBe(-1);
        expect(sim.scenarioActivatedAt()).toBeNull();
      }
      sim.step();
    }
    expect(rejected).toBe(1);
    expect(sim.kpi().since).toBe(since);
    expect(since).toBe(300);
    expect(hash(sim)).toBe(final);
  }, 120_000);
});

describe('*.end by target.eventId', () => {
  it('two closures on one segment: ending B by id keeps A; ends that find no active event are logged no-ops; replay matches', () => {
    const doc = gridDoc(3, 150, 'road-4');
    const live = new Simulation(cloneJson(doc), { citizens: false, scenario: true });
    const w = internals(live);
    expect(live.scenarioInput(input('A', 10, 'closure.start', { segmentId: 'h_1_1' })).ok).toBe(true);
    expect(live.scenarioInput(input('B', 20, 'closure.start', { segmentId: 'h_1_1' })).ok).toBe(true);
    // Well-formed ends are always accepted (static validation); whether they find their event is decided at apply time.
    for (const [id, tick, kind, target] of [
      ['endB-early', 15, 'closure.end', { eventId: 'B' }],
      ['endB', 40, 'closure.end', { eventId: 'B' }],
      ['endB-twice', 45, 'closure.end', { eventId: 'B' }],
      ['endX', 40, 'closure.end', { eventId: 'nope' }],
      ['endAcc', 40, 'accident.end', { eventId: 'A' }],
    ] as const)
      expect(live.scenarioInput(input(id, tick, kind, target)).ok).toBe(true);
    // Static errors are still rejected: an eventId on a start, an empty eventId.
    expect(live.scenarioInput(input('startWithId', 40, 'closure.start', { segmentId: 'h_0_0', eventId: 'A' })).ok).toBe(false);
    expect(live.scenarioInput(input('emptyId', 40, 'closure.end', { eventId: '' })).ok).toBe(false);
    const hashes: string[] = [];
    for (let t = 0; t < 600; t++) {
      live.step();
      if (t % 100 === 99) hashes.push(hash(live));
    }
    expect(w.sc!.effects.map((e) => e.eventId)).toEqual(['A']);
    expect(w.sc!.ban).not.toBeNull();
    const ends = w.sc!.log.filter((e) => e.kind.endsWith('.end') && e.eventId !== 'B').map((e) => `${e.eventId}:${e.applied}`);
    // The FIFO rule would have ended A (the earliest-started) instead.
    // Same tick 40: (order, eventId) order → endAcc, endB, endX.
    expect(ends).toEqual(['endB-early:false', 'endAcc:false', 'endB:true', 'endX:false', 'endB-twice:false']);
    expect(live.scenarioInput(input('endB-late', w.tick, 'closure.end', { eventId: 'B' })).ok).toBe(true);
    const sim = simulationFromRecord({ engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: live.scenarioInputs(), policy: { ...DEFAULT_POLICY } }, { citizens: false });
    const again: string[] = [];
    for (let t = 0; t < 600; t++) {
      sim.step();
      if (t % 100 === 99) again.push(hash(sim));
    }
    expect(again).toEqual(hashes);
  });

  it('snapshot.scenario lists the active events and why an end did nothing (activeEvents, recentLog)', () => {
    const sim = new Simulation(gridDoc(3, 150, 'road-4'), { citizens: false, scenario: true });
    sim.scenarioInput(input('A', 0, 'closure.start', { segmentId: 'h_1_1' }, { durationTicks: 500 }));
    sim.scenarioInput(input('B', 0, 'closure.start', { segmentId: 'h_1_1' }));
    sim.step();
    expect(sim.snapshot().scenario!.activeEvents).toEqual([
      { eventId: 'A', kind: 'closure', startTick: 0, endTick: 500 },
      { eventId: 'B', kind: 'closure', startTick: 0, endTick: null },
    ]);
    sim.scenarioInput(input('endB', 1, 'closure.end', { eventId: 'B' }));
    sim.scenarioInput(input('endB-again', 1, 'closure.end', { eventId: 'B' }, {}, 1));
    sim.step();
    const view = sim.snapshot().scenario!;
    expect(view.activeEvents.map((e) => e.eventId)).toEqual(['A']);
    expect(view.recentLog.find((e) => e.eventId === 'endB')).toMatchObject({ tick: 1, kind: 'closure.end', applied: true });
    const noop = view.recentLog.find((e) => e.eventId === 'endB-again')!;
    expect(noop).toMatchObject({ tick: 1, kind: 'closure.end', applied: false });
    expect(noop.reason).toMatch(/not active/);
    // A surge is listed while trips are still to depart.
    const city = new Simulation(cityDoc(), { citizens: false, scenario: true });
    city.scenarioInput(input('S', 0, 'surge.start', { buildingId: 'shop1' }, { extraTrips: 4, inflowTicks: 40, stayTicks: 20, outflowTicks: 40 }));
    city.step();
    expect(city.snapshot().scenario!.activeEvents).toEqual([{ eventId: 'S', kind: 'surge', startTick: 0, endTick: 40 + 20 + 30 }]);
    // Bounded log: at most RECENT_LOG_SIZE entries.
    for (let k = 0; k < 30; k++) sim.scenarioInput(input(`x${k}`, 2, 'closure.end', { eventId: 'none' }));
    sim.step();
    expect(sim.snapshot().scenario!.recentLog).toHaveLength(20);
  });

  it("Sol's repro: an end before its start in the same tick, then another end — accepted live, accepted and identical on replay", () => {
    for (const kind of ['closure', 'accident'] as const) {
      const doc = lineDoc(300);
      const live = new Simulation(cloneJson(doc), { scenario: true, demand: false, citizens: false });
      const w = internals(live);
      expect(live.scenarioInput(input('A', 10, `${kind}.start`, { segmentId: 'ab', lane: 0 }, {}, 1)).ok).toBe(true);
      expect(live.scenarioInput(input('E0', 10, `${kind}.end`, { eventId: 'A' }, {}, 0)).ok).toBe(true);
      for (let t = 0; t < 11; t++) live.step();
      expect(live.scenarioInput(input('E1', 12, `${kind}.end`, { eventId: 'A' })).ok).toBe(true);
      for (let t = 0; t < 10; t++) live.step();
      const applied = w.sc!.log.filter((e) => e.eventId === 'E0' || e.eventId === 'E1').map((e) => `${e.eventId}:${e.applied}`);
      expect(applied).toEqual(['E0:false', 'E1:true']);
      const sim = simulationFromRecord({ engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 21, inputs: live.scenarioInputs(), policy: { ...DEFAULT_POLICY } }, { demand: false, citizens: false });
      expect(internals(sim).sc!.log).toEqual(w.sc!.log);
      expect(hash(sim)).toBe(hash(live));
    }
  });

  it('property: any accepted live interleaving of starts, FIFO ends and eventId ends replays identically (acceptance or sorted order)', () => {
    const doc = lineDoc(300, 'road-4');
    doc.meta.trafficDensity = 0.5;
    for (let seed = 1; seed <= 12; seed++) {
      const rng = new Rng(seed);
      const live = new Simulation(cloneJson(doc), { scenario: true, citizens: false });
      const w = internals(live);
      const ids: string[] = [];
      let n = 0;
      const hashes: string[] = [];
      for (let t = 0; t < 120; t++) {
        const k = rng.int(3);
        for (let q = 0; q < k; q++) {
          const kind = rng.next() < 0.5 ? 'closure' : 'accident';
          const tick = w.tick + rng.int(4);
          const order = rng.int(3) - 1;
          const lane = rng.int(2);
          const id = `e${seed}-${n++}`;
          const r = rng.next();
          let inp: ScenarioInput;
          if (r < 0.4 || ids.length === 0) {
            inp = input(id, tick, `${kind}.start`, kind === 'accident' ? { segmentId: 'ab', lane, s: 20 + rng.int(200) } : { segmentId: 'ab', lane }, { durationTicks: 5 + rng.int(40) }, order);
            ids.push(id);
          } else if (r < 0.65) inp = input(id, tick, `${kind}.end`, { segmentId: 'ab', lane }, {}, order);
          else inp = input(id, tick, `${kind}.end`, { eventId: rng.next() < 0.9 ? ids[rng.int(ids.length)]! : 'ghost' }, {}, order);
          expect(live.scenarioInput(inp).ok).toBe(true);
        }
        live.step();
        hashes.push(hash(live));
      }
      const inputs = live.scenarioInputs();
      const replay = (list: ScenarioInput[]): void => {
        const sim = simulationFromRecord({ engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: list, policy: { ...DEFAULT_POLICY } }, { citizens: false });
        for (let t = 0; t < 120; t++) {
          sim.step();
          expect(hash(sim)).toBe(hashes[t]);
        }
        expect(internals(sim).sc!.log).toEqual(w.sc!.log);
      };
      replay(inputs);
      // As the UI recorder stores them: sorted by (tick, order, eventId).
      replay([...inputs].sort((a, b) => a.tick - b.tick || a.order - b.order || (a.eventId < b.eventId ? -1 : 1)));
      // Saved and loaded as JSON: every accepted number survives, the record replays.
      replay(JSON.parse(JSON.stringify(inputs)) as ScenarioInput[]);
      expect(w.sc!.log.some((e) => !e.applied)).toBe(true);
    }
  }, 120_000);
});

describe('only plain-JSON inputs and strict policies (recheck 4)', () => {
  it('unknown, BigInt, function and nested-object keys are rejected; every accepted input JSON round-trips', () => {
    const sim = new Simulation(lineDoc(300), { scenario: true, demand: false, citizens: false });
    const ok = (): ScenarioInput => input('ok', 5, 'accident.start', { segmentId: 'ab', lane: 0, s: 50 }, { durationTicks: 50, length: 9 });
    const bad: [string, (i: Record<string, unknown>) => void][] = [
      ['top-level extra', (i) => (i.extra = 1)],
      ['top-level BigInt', (i) => (i.big = BigInt(1))],
      ['top-level function', (i) => (i.fn = () => 0)],
      ['target extra BigInt', (i) => ((i.target as Record<string, unknown>).extra = BigInt(1))],
      ['target nested', (i) => ((i.target as Record<string, unknown>).segmentId = { id: 'ab' })],
      ['target function', (i) => ((i.target as Record<string, unknown>).fn = () => 0)],
      ['params BigInt', (i) => ((i.params as Record<string, unknown>).durationTicks = BigInt(50))],
      ['params nested', (i) => ((i.params as Record<string, unknown>).length = { m: 9 })],
      ['params of another kind', (i) => ((i.params as Record<string, unknown>).extraTrips = 3)],
      ['params unknown', (i) => ((i.params as Record<string, unknown>).speed = 3)],
    ];
    let k = 0;
    for (const [what, mutate] of bad) {
      const i = ok() as unknown as Record<string, unknown>;
      i.eventId = `bad${k++}`;
      mutate(i);
      expect(sim.scenarioInput(i as unknown as ScenarioInput).ok, what).toBe(false);
    }
    expect(sim.scenarioInput(input('end', 6, 'closure.end', { segmentId: 'ab' }, { durationTicks: 5 })).ok).toBe(false);
    expect(sim.scenarioInput(ok()).ok).toBe(true);
    expect(sim.scenarioInput(input('pol', 5, 'policy.set', {}, { reroute: 1, informedShare: 0.5 })).ok).toBe(true);
    // A key holding undefined is not stored.
    expect(sim.scenarioInput(input('c', 5, 'closure.start', { segmentId: 'ab', lane: undefined }, {})).ok).toBe(true);
    const accepted = sim.scenarioInputs();
    expect(accepted.map((i) => i.eventId)).toEqual(['ok', 'pol', 'c']);
    expect(JSON.parse(JSON.stringify(accepted))).toEqual(accepted);
    expect(structuredClone(accepted)).toEqual(accepted);
    expect(Object.keys(accepted[2]!.target)).toEqual(['segmentId']);
  });

  it('record and setPolicy share one strict policy check: null, "0.7", false and numbers for reroute are rejected', () => {
    const doc = lineDoc(300);
    const base: ScenarioRecord = { engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: [], policy: { ...DEFAULT_POLICY } };
    const sim = new Simulation(lineDoc(300), { scenario: true, demand: false, citizens: false });
    for (const informedShare of [null, '0.7', false, NaN, -0.1, 1.1, undefined]) {
      const policy = { reroute: true, informedShare } as unknown as ScenarioRecord['policy'];
      expect(() => simulationFromRecord({ ...base, policy }), String(informedShare)).toThrow(/informedShare/);
      expect(() => sim.setPolicy(policy), String(informedShare)).toThrow(RangeError);
    }
    for (const reroute of [null, 'true', 1, 0, undefined]) {
      const policy = { reroute, informedShare: 0.7 } as unknown as ScenarioRecord['policy'];
      expect(() => simulationFromRecord({ ...base, policy }), String(reroute)).toThrow(/reroute/);
      expect(() => sim.setPolicy(policy), String(reroute)).toThrow(RangeError);
    }
    expect(() => simulationFromRecord({ ...base, policy: null as unknown as ScenarioRecord['policy'] })).toThrow(/policy/);
    expect(() => simulationFromRecord({ ...base, policy: { reroute: false, informedShare: 0 } })).not.toThrow();
  });
});

describe('drainScenarioOutcomes (lossless outcome stream)', () => {
  it('40 accidents on one short lane: exactly 40 creation outcomes, 1 applied and 39 not; draining is idempotent and read-only', () => {
    const sim = new Simulation(lineDoc(15), { scenario: true, demand: false, citizens: false });
    for (let k = 0; k < 40; k++) expect(sim.scenarioInput(input(`acc${k}`, 3, 'accident.start', { segmentId: 'ab', lane: 0, s: 2 }, { durationTicks: 1000 }, k)).ok).toBe(true);
    for (let t = 0; t < 4; t++) sim.step();
    // recentLog keeps only 20; the stream keeps all 40.
    expect(sim.snapshot().scenario!.recentLog).toHaveLength(20);
    const before = hash(sim);
    const out = sim.drainScenarioOutcomes();
    expect(out.filter((o) => o.kind === 'accident.start')).toHaveLength(40);
    expect(out.map((o) => o.eventId)).toEqual(Array.from({ length: 40 }, (_, k) => `acc${k}`));
    expect(out.filter((o) => o.applied).map((o) => o.eventId)).toEqual(['acc0']);
    expect(out.filter((o) => !o.applied).every((o) => o.reason === 'no room on lane')).toBe(true);
    expect(sim.drainScenarioOutcomes()).toEqual([]);
    expect(hash(sim)).toBe(before);
    expect(sim.snapshot().scenario!.activeEvents.map((e) => e.eventId)).toEqual(['acc0']);
    // Never activates: a plain simulation drains nothing and stays inactive.
    const plain = new Simulation(lineDoc(15), { demand: false, citizens: false });
    expect(plain.drainScenarioOutcomes()).toEqual([]);
    expect(plain.scenarioActivatedAt()).toBeNull();
  });

  it('replay hashes do not depend on how often outcomes are drained; the drained stream equals the log', () => {
    const doc = cityDoc();
    const inputs: ScenarioInput[] = [
      input('c', 50, 'closure.start', { segmentId: 'h_1_1' }, { durationTicks: 200 }),
      input('a', 80, 'accident.start', { segmentId: 'v_1_0', lane: 0, s: 50 }, { durationTicks: 150 }),
      input('e', 120, 'closure.end', { eventId: 'c' }),
      input('e2', 130, 'closure.end', { eventId: 'c' }),
    ];
    const record: ScenarioRecord = { engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs, policy: { reroute: true, informedShare: 0.7 } };
    const run = (every: number): { hashes: string[]; drained: string[]; log: string[] } => {
      const sim = simulationFromRecord(record);
      const hashes: string[] = [];
      const drained: string[] = [];
      for (let t = 0; t < 400; t++) {
        sim.step();
        if (every > 0 && t % every === 0) for (const o of sim.drainScenarioOutcomes()) drained.push(`${o.eventId}:${o.kind}:${o.tick}:${o.applied}`);
        if (t % 50 === 49) hashes.push(hash(sim));
      }
      for (const o of sim.drainScenarioOutcomes()) drained.push(`${o.eventId}:${o.kind}:${o.tick}:${o.applied}`);
      return { hashes, drained, log: internals(sim).sc!.log.map((o) => `${o.eventId}:${o.kind}:${o.tick}:${o.applied}`) };
    };
    const never = run(0);
    const often = run(1);
    const sometimes = run(37);
    expect(often.hashes).toEqual(never.hashes);
    expect(sometimes.hashes).toEqual(never.hashes);
    expect(often.drained).toEqual(often.log);
    expect(sometimes.drained).toEqual(often.log);
    expect(never.drained).toEqual(often.log);
    expect(often.log).toContain('e2:closure.end:130:false');
  }, 60_000);
});

describe('numbers that do not survive JSON are rejected (recheck 3)', () => {
  it('NaN / ±Infinity / null in tick, order, target.lane, target.s and params are rejected live and on replay', () => {
    const sim = new Simulation(lineDoc(300), { scenario: true, demand: false, citizens: false });
    const bad = [NaN, Infinity, -Infinity, null];
    const base = (): ScenarioInput => input('x', 5, 'accident.start', { segmentId: 'ab', lane: 0, s: 100 }, { durationTicks: 50, length: 9 }, 0);
    const cases: [string, (i: ScenarioInput, v: unknown) => void][] = [
      ['tick', (i, v) => ((i as unknown as Record<string, unknown>).tick = v)],
      ['order', (i, v) => ((i as unknown as Record<string, unknown>).order = v)],
      ['target.lane', (i, v) => ((i.target as Record<string, unknown>).lane = v)],
      ['target.s', (i, v) => ((i.target as Record<string, unknown>).s = v)],
      ['params.durationTicks', (i, v) => ((i.params as Record<string, unknown>).durationTicks = v)],
      ['params.length', (i, v) => ((i.params as Record<string, unknown>).length = v)],
    ];
    let k = 0;
    for (const [field, set] of cases)
      for (const v of bad) {
        const i = base();
        i.eventId = `bad${k++}`;
        set(i, v);
        expect(sim.scenarioInput(i).ok, `${field} = ${String(v)}`).toBe(false);
      }
    // Policy values, through a policy.set input (setPolicy validates the same way).
    for (const [reroute, informedShare] of [[NaN, 0.5], [1, NaN], [1, Infinity], [2, 0.5], [1, 1.5], [null, 0.5], [1, null]] as const) {
      const r = sim.scenarioInput(input(`pol${k++}`, 5, 'policy.set', {}, { reroute, informedShare } as unknown as Record<string, number>));
      expect(r.ok, `policy ${String(reroute)} ${String(informedShare)}`).toBe(false);
    }
    expect(() => sim.setPolicy({ reroute: true, informedShare: NaN })).toThrow(RangeError);
    // A fractional order would not be an integer key: rejected too.
    expect(sim.scenarioInput(input('frac', 5, 'closure.start', { segmentId: 'ab' }, {}, 0.5)).ok).toBe(false);
    expect(sim.scenarioInputs()).toEqual([]);
    // A record carrying such values (e.g. hand-edited) is refused by replay with the same rules.
    const doc = lineDoc(300);
    const record: ScenarioRecord = { engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: [{ ...base(), target: { segmentId: 'ab', lane: 0, s: NaN } }], policy: { ...DEFAULT_POLICY } };
    expect(() => simulationFromRecord(record, { demand: false, citizens: false })).toThrow(/target\.s/);
    expect(() => simulationFromRecord(JSON.parse(JSON.stringify(record)) as ScenarioRecord, { demand: false, citizens: false })).toThrow(/target\.s/);
    expect(() => simulationFromRecord({ ...record, inputs: [], tickRate: NaN })).toThrow(/tickRate/);
    expect(() => simulationFromRecord({ ...record, inputs: [], policy: { reroute: true, informedShare: NaN } })).toThrow(/policy/);
  });
});

describe('#2 obstacles across recompiles', () => {
  it('a lane shortened twice by 0.4 m never pushes the obstacle into a kept vehicle (checked every tick)', () => {
    const sim = new Simulation(lineDoc(300), { demand: false, citizens: false });
    const w = internals(sim);
    expect(sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 290.5)).not.toBeNull();
    sim.scenarioInput(input('acc', 0, 'accident.start', { segmentId: 'ab', lane: 0, s: 291 }, { durationTicks: 4000 }));
    const problems: string[] = [];
    const step = (): void => {
      sim.step();
      problems.push(...checkObstacleOverlaps(sim), ...checkInvariants(sim));
    };
    step();
    expect(w.sc!.obs![0]![0]!.rear).toBe(291);
    for (const x of [299.6, 299.2]) {
      expect(sim.applyCommand({ type: 'node.move', id: 'b', pos: { x, z: 0 } }).ok).toBe(true);
      step();
    }
    // The vehicle survived both edits and the obstacle was re-placed (behind it: no room left ahead).
    expect(w.vehicles).toHaveLength(1);
    const o = w.sc!.obs![0]![0]!;
    expect(o.rear + o.len).toBeLessThanOrEqual(w.vehicles[0]!.s - w.vehicles[0]!.len);
    expect(w.sc!.log.some((e) => e.eventId === 'acc' && e.kind === 'accident.move')).toBe(true);
    for (let t = 0; t < 200; t++) step();
    expect(problems).toEqual([]);
    // Nothing blocks it any more: it reaches the lane end.
    expect(sim.stats().arrived).toBe(1);
  });

  it('an obstacle whose lane vanished ends (logged) instead of lingering', () => {
    const sim = new Simulation(gridDoc(3, 150, 'road-4'), { demand: false, citizens: false });
    const w = internals(sim);
    sim.scenarioInput(input('acc', 0, 'accident.start', { segmentId: 'h_0_0', lane: 0, s: 40 }, { durationTicks: 4000 }));
    sim.step();
    expect(sim.kpi().activeEvents).toBe(1);
    expect(sim.applyCommand({ type: 'segment.remove', id: 'h_0_0' }).ok).toBe(true);
    sim.step();
    expect(w.sc!.obs).toBeNull();
    expect(sim.kpi().activeEvents).toBe(0);
    expect(w.sc!.log.find((e) => e.eventId === 'acc' && e.kind === 'accident.end')?.note).toBe('lane gone');
  });
});

describe('#4 re-route queue order', () => {
  it('two events in one tick: the queue is in vehicle id order as a whole', () => {
    const sim = new Simulation(gridDoc(3, 150), { demand: false, citizens: false });
    const w = internals(sim);
    sim.setPolicy({ reroute: true, informedShare: 1 });
    expect(sim.spawnVehicle('sedan', 'h_0_0|f|0', 'h_1_0|f|0', 20)).toBe(1);
    expect(sim.spawnVehicle('sedan', 'h_0_1|f|0', 'h_1_1|f|0', 20)).toBe(2);
    sim.step();
    // Event A concerns vehicle 2, event B (later in the same tick) vehicle 1.
    sim.scenarioInput(input('A', w.tick, 'accident.start', { segmentId: 'h_1_1', lane: 0, s: 60 }, {}, 0));
    sim.scenarioInput(input('B', w.tick, 'accident.start', { segmentId: 'h_1_0', lane: 0, s: 60 }, {}, 1));
    applyDueInputs(w);
    expect(w.sc!.rq.map((v) => v.id)).toEqual([1, 2]);
    // A vehicle already queued is not queued twice by a later event.
    sim.scenarioInput(input('C', w.tick, 'closure.start', { segmentId: 'h_1_0', lane: 0 }, {}, 2));
    applyDueInputs(w);
    expect(w.sc!.rq.map((v) => v.id)).toEqual([1, 2]);
  });

  it('a later tick never overtakes: (enqueue tick, id) order, so a low id requested later queues last', () => {
    const sim = new Simulation(gridDoc(3, 150), { demand: false, citizens: false });
    const w = internals(sim);
    sim.setPolicy({ reroute: true, informedShare: 1 });
    expect(sim.spawnVehicle('sedan', 'h_0_0|f|0', 'h_1_0|f|0', 20)).toBe(1);
    expect(sim.spawnVehicle('sedan', 'h_0_1|f|0', 'h_1_1|f|0', 20)).toBe(2);
    sim.step();
    const t = w.tick;
    sim.scenarioInput(input('A', t, 'accident.start', { segmentId: 'h_1_1', lane: 0, s: 60 }));
    sim.scenarioInput(input('B', t + 1, 'accident.start', { segmentId: 'h_1_0', lane: 0, s: 60 }));
    applyDueInputs(w);
    expect(w.sc!.rq.map((v) => v.id)).toEqual([2]);
    // The next tick boundary, without processing the queue in between (unit check of the queue order).
    w.tick++;
    applyDueInputs(w);
    expect(w.sc!.rq.map((v) => v.id)).toEqual([2, 1]);
  });
});
