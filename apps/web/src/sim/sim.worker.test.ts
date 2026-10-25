// The real worker module with a fake `self` and fake timers: malformed simulator-mode messages are answered
// without stopping the simulation, and runTo matches plain stepping regardless of how it is chunked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, createEmptyDoc, type CityDoc, type Command } from '@smartcity/shared';
import { Simulation, type ScenarioInput, type ScenarioRecord, type SimSnapshot, type SnapshotBuffers } from '@smartcity/sim';
import { sanitizeBuffers, type FromWorker, type ToWorker } from './protocol';

function grid(n: number, spacing: number): CityDoc {
  const doc = createEmptyDoc('grid', 7);
  const cmds: Command[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cmds.push({ type: 'node.add', node: { id: `n_${i}_${j}`, pos: { x: i * spacing, z: j * spacing } } });
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) cmds.push({ type: 'segment.add', segment: { id: `h_${i}_${j}`, a: `n_${i}_${j}`, b: `n_${i + 1}_${j}`, roadTypeId: 'road-4' } });
      if (j + 1 < n) cmds.push({ type: 'segment.add', segment: { id: `v_${i}_${j}`, a: `n_${i}_${j}`, b: `n_${i}_${j + 1}`, roadTypeId: 'road-4' } });
    }
  expect(applyCommand(doc, { type: 'batch', commands: cmds }).ok).toBe(true);
  return doc;
}

const hash = (s: SimSnapshot): string => Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.stats) + JSON.stringify(s.scenario);

const inputs: ScenarioInput[] = [
  { eventId: 'c', tick: 300, order: 0, kind: 'closure.start', target: { segmentId: 'h_1_1' }, params: { durationTicks: 400 } },
  { eventId: 'a', tick: 500, order: 0, kind: 'accident.start', target: { segmentId: 'v_1_0', lane: 0, s: 60 }, params: { durationTicks: 300 } },
];

let out: FromWorker[] = [];
/** Injected postMessage failures (recheck 5). */
let postFail: (m: FromWorker) => boolean = () => false;
let send: (msg: ToWorker) => void = () => undefined;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  vi.resetModules();
  out = [];
  postFail = () => false;
  const self = {
    postMessage: (m: FromWorker) => {
      if (postFail(m)) throw new Error('postMessage failed');
      out.push(m);
    },
    onmessage: null as null | ((ev: { data: ToWorker }) => void),
  };
  (globalThis as unknown as { self: unknown }).self = self;
  await import('./sim.worker');
  send = (msg) => self.onmessage!({ data: msg });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { self?: unknown }).self;
});

/** Let chunks run until a runTo reply other than progress arrives. */
async function finishRun(): Promise<Extract<FromWorker, { t: 'runTo' }>> {
  for (let k = 0; k < 10000; k++) {
    const r = out.find((m): m is Extract<FromWorker, { t: 'runTo' }> => m.t === 'runTo' && !('progress' in m));
    if (r) return r;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error('runTo did not finish');
}

describe('sim.worker recheck regressions', () => {
  const late = (): { record: ScenarioRecord; final: string; at300: string } => {
    const doc = grid(3, 150);
    const live = new Simulation(doc);
    for (let t = 0; t < 300; t++) live.step();
    live.setPolicy({ reroute: true, informedShare: 0.7 });
    for (const i of inputs.slice(0, 1)) expect(live.scenarioInput({ ...i, tick: 400 }).ok).toBe(true);
    const at300 = hash(live.snapshot());
    for (let t = 0; t < 900; t++) live.step();
    const record: ScenarioRecord = { engineVersion: 1, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: live.scenarioInputs(), policy: { reroute: false, informedShare: 0.7 }, activatedAtTick: 300 };
    return { record, final: hash(live.snapshot()), at300 };
  };

  it('KPI requests during a replay runTo never activate early: same since and state for any chunk size', async () => {
    const { record, final } = late();
    let clock = 0;
    let dt = 1;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += dt));
    try {
      const results: [number | undefined, string][] = [];
      for (const [chunkDt, queries] of [
        [1, false],
        [6, true],
        [1, true],
      ] as const) {
        dt = chunkDt;
        out = [];
        send({ t: 'initRecord', record });
        send({ t: 'setSpeed', speed: 0 });
        send({ t: 'runTo', tick: 1200 });
        for (let k = 0; k < 100000; k++) {
          if (out.some((m) => m.t === 'runTo' && 'done' in m)) break;
          if (queries) send({ t: 'kpi' });
          await vi.advanceTimersByTimeAsync(1);
        }
        const early = out.filter((m): m is Extract<FromWorker, { t: 'kpi' }> => m.t === 'kpi').filter((m) => m.kpi.tick < 300);
        if (queries) expect(early.length).toBeGreaterThan(0);
        for (const m of early) expect(m.kpi.since).toBe(-1);
        const snap = out.filter((m): m is Extract<FromWorker, { t: 'snapshot' }> => m.t === 'snapshot').pop()!.snapshot;
        results.push([snap.scenario?.kpi.since, hash(snap)]);
      }
      expect(results.map((r) => r[0])).toEqual([300, 300, 300]);
      expect(results.map((r) => r[1])).toEqual([final, final, final]);
    } finally {
      now.mockRestore();
    }
  });

  it('runTo that ends on the activation boundary reports the scenario active there', async () => {
    const { record, at300 } = late();
    send({ t: 'initRecord', record });
    send({ t: 'setSpeed', speed: 0 });
    send({ t: 'runTo', tick: 300 });
    const done = await finishRun();
    expect(done).toMatchObject({ done: 300 });
    const snap = out.filter((m): m is Extract<FromWorker, { t: 'snapshot' }> => m.t === 'snapshot').pop()!.snapshot;
    expect(snap.scenario?.kpi.since).toBe(300);
    expect(hash(snap)).toBe(at300);
  });

  it('survives anything posted to it: every malformed message gets an error reply', () => {
    send({ t: 'init', doc: grid(3, 150) });
    send({ t: 'setSpeed', speed: 0 });
    const junk: unknown[] = [
      null,
      undefined,
      5,
      'init',
      [],
      {},
      { t: 'nope' },
      { t: 7 },
      { t: 'init' },
      { t: 'init', doc: null },
      { t: 'init', doc: {}, seed: 'x' },
      { t: 'initRecord' },
      { t: 'initRecord', record: { doc: {} } },
      { t: 'initRecord', record: 'r' },
      { t: 'command' },
      { t: 'command', cmd: { type: 'node.move' } },
      { t: 'setSpeed', speed: 3 },
      { t: 'returnBuffers' },
      { t: 'runTo' },
      { t: 'runTo', tick: 1.5 },
      { t: 'scenario' },
      { t: 'policy' },
    ];
    for (const m of junk) (globalThis as unknown as { self: { onmessage: (ev: { data: unknown }) => void } }).self.onmessage({ data: m });
    expect(out.filter((m) => m.t === 'status').map((m) => (m as { status: string }).status)).toEqual(['ready']);
    expect(out.filter((m) => m.t === 'error').length).toBeGreaterThanOrEqual(19);
    out = [];
    send({ t: 'kpi' });
    expect(out.map((m) => m.t)).toEqual(['kpi']);
  });
});

describe('sim.worker buffers and publish errors (recheck 2)', () => {
  it("Sol's repro: a malformed returnBuffers never reaches a snapshot; wrong types and lengths are dropped", async () => {
    send({ t: 'init', doc: grid(3, 150) });
    send({ t: 'returnBuffers', buffers: { stopWaiting: {} } as unknown as SnapshotBuffers });
    send({ t: 'returnBuffers', buffers: { vehicles: new Int8Array(64), laneFlow: new Uint16Array(3), busLoad: new Float32Array(4) } as unknown as SnapshotBuffers });
    // Right type but too short, and an empty one: dropped or regrown, never a crash.
    send({ t: 'returnBuffers', buffers: { vehicles: new Float32Array(2), signals: new Float32Array(0), stopWaiting: new Uint16Array(1) } });
    out = [];
    await vi.advanceTimersByTimeAsync(200);
    expect(out.some((m) => m.t === 'status')).toBe(false);
    expect(out.filter((m) => m.t === 'snapshot').length).toBeGreaterThanOrEqual(3);
    out = [];
    send({ t: 'kpi' });
    expect(out.map((m) => m.t)).toEqual(['kpi']);
  });

  it('a failing snapshot construction is fatal (one error status), and only a new init restarts', async () => {
    send({ t: 'init', doc: grid(3, 150) });
    const mod = await import('@smartcity/sim');
    const spy = vi.spyOn(mod.Simulation.prototype, 'snapshot').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    out = [];
    await vi.advanceTimersByTimeAsync(120);
    spy.mockRestore();
    expect(out).toEqual([{ t: 'status', status: 'error', error: '스냅샷 생성 실패: boom' }]);
    send({ t: 'kpi' });
    send({ t: 'cancel' });
    await vi.advanceTimersByTimeAsync(120);
    expect(out).toHaveLength(1);
    send({ t: 'init', doc: grid(3, 150) });
    expect(out.slice(1).map((m) => m.t)).toEqual(['status', 'snapshot']);
  });

  it('sanitizeBuffers keeps only exact typed arrays with a live buffer', () => {
    const v = new Float32Array(6);
    const b = sanitizeBuffers({ vehicles: v, signals: [1, 2], pedestrianIds: new Float32Array(2), stopWaiting: new Uint16Array(0), extra: v });
    expect(b).toEqual({ vehicles: v });
    expect(sanitizeBuffers(null)).toEqual({});
  });
});

describe('sim.worker: a failing postMessage is fatal (recheck 6, Lead decision)', () => {
  const shortLane = (): CityDoc => {
    const doc = createEmptyDoc('short', 5);
    expect(
      applyCommand(doc, {
        type: 'batch',
        commands: [
          { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
          { type: 'node.add', node: { id: 'b', pos: { x: 15, z: 0 } } },
          { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
        ],
      }).ok,
    ).toBe(true);
    return doc;
  };
  const accidents = (): ScenarioInput[] => Array.from({ length: 40 }, (_, k) => ({ eventId: `acc${k}`, tick: 3, order: k, kind: 'accident.start', target: { segmentId: 'ab', lane: 0, s: 2 }, params: { durationTicks: 1000 } }));
  const fatal = (): FromWorker[] => out.filter((m) => m.t === 'status' && m.status === 'error');

  it('normal path: all 40 accident outcomes in one batch, before the snapshot of that tick', async () => {
    send({ t: 'init', doc: shortLane(), scenario: true });
    send({ t: 'scenario', inputs: accidents() });
    out = [];
    await vi.advanceTimersByTimeAsync(400);
    const i = out.findIndex((m) => m.t === 'outcomes');
    const batch = (out[i] as Extract<FromWorker, { t: 'outcomes' }>).outcomes;
    expect(batch.filter((o) => o.kind === 'accident.start')).toHaveLength(40);
    expect(batch.filter((o) => o.applied).map((o) => o.eventId)).toEqual(['acc0']);
    const before = out.slice(0, i).filter((m): m is Extract<FromWorker, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(before.every((m) => m.snapshot.stats.tick <= 3)).toBe(true);
    expect((out.slice(i + 1).find((m) => m.t === 'snapshot') as Extract<FromWorker, { t: 'snapshot' }>).snapshot.stats.tick).toBe(4);
    expect(fatal()).toEqual([]);
  });

  it("an outcomes post failure (once or persistent): one fatal status, nothing after it, no growth, later messages ignored", async () => {
    for (const persistent of [false, true]) {
      send({ t: 'init', doc: shortLane(), scenario: true });
      send({ t: 'scenario', inputs: accidents() });
      let failures = 0;
      postFail = (m) => m.t === 'outcomes' && (persistent || failures++ === 0);
      out = [];
      await vi.advanceTimersByTimeAsync(2000);
      expect(out.filter((m) => m.t !== 'snapshot')).toEqual([{ t: 'status', status: 'error', error: '메시지 전송 실패: postMessage failed' }]);
      // Nothing after the fatal status: no snapshot of the tick whose outcomes were lost, no growing backlog.
      const iFatal = out.findIndex((m) => m.t === 'status');
      expect(iFatal).toBe(out.length - 1);
      expect(out.filter((m): m is Extract<FromWorker, { t: 'snapshot' }> => m.t === 'snapshot').every((m) => m.snapshot.stats.tick <= 3)).toBe(true);
      postFail = () => false;
      send({ t: 'kpi' });
      send({ t: 'cancel' });
      send({ t: 'runTo', tick: 50 });
      await vi.advanceTimersByTimeAsync(500);
      expect(out).toHaveLength(iFatal + 1);
    }
  });

  it("Sol's repros: a failing final snapshot post never lets `done` through; a cancel after it is ignored without a crash", async () => {
    send({ t: 'init', doc: shortLane(), scenario: true });
    send({ t: 'setSpeed', speed: 0 });
    postFail = (m) => m.t === 'snapshot';
    out = [];
    send({ t: 'runTo', tick: 5 });
    await vi.advanceTimersByTimeAsync(200);
    expect(out).toEqual([{ t: 'status', status: 'error', error: '메시지 전송 실패: postMessage failed' }]);
    postFail = () => false;
    send({ t: 'cancel' });
    await vi.advanceTimersByTimeAsync(500);
    expect(out).toHaveLength(1);
    // Outcomes failing during a runTo: no snapshot and no done after the failure either.
    send({ t: 'init', doc: shortLane(), scenario: true });
    send({ t: 'setSpeed', speed: 0 });
    send({ t: 'scenario', inputs: accidents() });
    postFail = (m) => m.t === 'outcomes';
    out = [];
    send({ t: 'runTo', tick: 20 });
    await vi.advanceTimersByTimeAsync(200);
    expect(out.map((m) => m.t)).toEqual(['status']);
    expect(out.some((m) => m.t === 'runTo')).toBe(false);
  });
});

describe('sim.worker outcome stream', () => {
  it('posts { t: "outcomes" } before the snapshot of the same tick, in real time and during runTo', async () => {
    send({ t: 'init', doc: grid(3, 150), scenario: true });
    send({ t: 'scenario', inputs: [inputs[0]!, { eventId: 'end-c', tick: 3, order: 0, kind: 'closure.end', target: { eventId: 'nope' }, params: {} }] });
    send({ t: 'scenario', inputs: [{ ...inputs[0]!, eventId: 'c-now', tick: 2 }] });
    out = [];
    await vi.advanceTimersByTimeAsync(300);
    const i = out.findIndex((m) => m.t === 'outcomes');
    expect(i).toBeGreaterThanOrEqual(0);
    const first = out[i] as Extract<FromWorker, { t: 'outcomes' }>;
    expect(first.outcomes.map((o) => [o.eventId, o.applied])).toEqual([['c-now', true]]);
    // Applied during the step of tick 2; the next snapshot (stats.tick 3) comes after it.
    const snapAfter = out.findIndex((m, k) => k > i && m.t === 'snapshot');
    const snapBefore = out.slice(0, i).filter((m): m is Extract<FromWorker, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(snapBefore.every((m) => m.snapshot.stats.tick <= 2)).toBe(true);
    expect((out[snapAfter] as Extract<FromWorker, { t: 'snapshot' }>).snapshot.stats.tick).toBe(3);
    const all = out.filter((m): m is Extract<FromWorker, { t: 'outcomes' }> => m.t === 'outcomes').flatMap((m) => m.outcomes);
    expect(all.find((o) => o.eventId === 'end-c')).toMatchObject({ applied: false, tick: 3 });
    // runTo: the closure 'c' (tick 300) and its automatic end (tick 700) arrive as outcomes before `done`.
    send({ t: 'setSpeed', speed: 0 });
    out = [];
    send({ t: 'runTo', tick: 800 });
    await finishRun();
    const ran = out.filter((m): m is Extract<FromWorker, { t: 'outcomes' }> => m.t === 'outcomes').flatMap((m) => m.outcomes);
    expect(ran.filter((o) => o.eventId === 'c').map((o) => [o.kind, o.tick, o.applied])).toEqual([
      ['closure.start', 300, true],
      ['closure.end', 700, true],
    ]);
    const lastOutcome = out.map((m) => m.t).lastIndexOf('outcomes');
    expect(lastOutcome).toBeLessThan(out.map((m) => m.t).lastIndexOf('snapshot'));
  });
});

describe('sim.worker emergency outcomes (4c2-①)', () => {
  it('dispatch and fire outcomes arrive in the outcome stream before the snapshot; the overlay lists the incident and vehicle', async () => {
    const doc = grid(3, 150);
    expect(
      applyCommand(doc, {
        type: 'batch',
        commands: [
          { type: 'building.place', building: { id: 'fs', typeId: 'svc-fire-station', pos: { x: 75, z: 75 }, rotation: 0 } },
          { type: 'building.place', building: { id: 'home', typeId: 'house', pos: { x: 225, z: 230 }, rotation: 0 } },
          { type: 'building.place', building: { id: 'lone', typeId: 'house', pos: { x: 230, z: 75 }, rotation: 0 } },
        ],
      }).ok,
    ).toBe(true);
    send({ t: 'init', doc, scenario: true });
    send({ t: 'setSpeed', speed: 0 });
    send({ t: 'policy', policy: { reroute: true, informedShare: 0.7, preempt: false } });
    expect(out.find((m) => m.t === 'policy')).toMatchObject({ result: { ok: true }, input: { params: { reroute: 1, preempt: 0 } } });
    send({
      t: 'scenario',
      inputs: [
        { eventId: 'f', tick: 10, order: 0, kind: 'fire.start', target: { buildingId: 'home' }, params: { burnTicks: 30000 } },
        { eventId: 'm', tick: 12, order: 0, kind: 'medical.start', target: { buildingId: 'lone' }, params: {} },
        { eventId: 'x', tick: 12, order: 0, kind: 'medical.start', target: { buildingId: 'home' }, params: { burnTicks: 5 } },
      ],
    });
    const reply = out.find((m): m is Extract<FromWorker, { t: 'scenario' }> => m.t === 'scenario')!;
    expect(reply.results.map((r) => r.ok)).toEqual([true, true, false]);
    out = [];
    send({ t: 'runTo', tick: 2000 });
    await finishRun();
    const kinds = out.filter((m): m is Extract<FromWorker, { t: 'outcomes' }> => m.t === 'outcomes').flatMap((m) => m.outcomes.map((o) => `${o.eventId}:${o.kind}`));
    expect(kinds).toContain('f:dispatch.start');
    expect(kinds).toContain('f:dispatch.arrive');
    // No hospital in this city: the call runs, the dispatch fails.
    expect(kinds).toContain('m:dispatch.failed');
    expect(out.map((m) => m.t).lastIndexOf('outcomes')).toBeLessThan(out.map((m) => m.t).lastIndexOf('snapshot'));
    const snap = out.filter((m): m is Extract<FromWorker, { t: 'snapshot' }> => m.t === 'snapshot').pop()!.snapshot;
    expect(snap.scenario!.incidents.map((i) => [i.eventId, i.kind])).toEqual([
      ['f', 'fire'],
      ['m', 'medical'],
    ]);
    expect(snap.scenario!.kpi.dispatchFailed).toBe(1);
    expect(structuredClone(snap.scenario)).toEqual(snap.scenario);
  });
});

describe('sim.worker simulator mode', () => {
  it('answers malformed scenario messages with errors and keeps running', () => {
    send({ t: 'init', doc: grid(3, 150) });
    send({ t: 'setSpeed', speed: 0 });
    const bad: unknown[] = [
      null,
      { eventId: 'k', tick: 5, order: 0, kind: 'explode', target: {}, params: {} },
      { eventId: 'n', tick: NaN, order: 0, kind: 'closure.start', target: { segmentId: 'h_0_0' }, params: {} },
      { eventId: 'm', tick: 5, order: 0, kind: 'closure.start', params: {} },
      { eventId: 'ok', tick: 5, order: 0, kind: 'closure.start', target: { segmentId: 'h_0_0' }, params: {} },
    ];
    send({ t: 'scenario', inputs: bad as ScenarioInput[] });
    send({ t: 'scenario', inputs: 'nope' as unknown as ScenarioInput[] });
    send({ t: 'scenario', inputs: [undefined, 42, []] as unknown as ScenarioInput[] });
    send({ t: 'policy', policy: null as unknown as { reroute: boolean; informedShare: number } });
    send({ t: 'kpi' });
    expect(out.filter((m) => m.t === 'status').map((m) => (m as { status: string }).status)).toEqual(['ready']);
    const replies = out.filter((m): m is Extract<FromWorker, { t: 'scenario' }> => m.t === 'scenario');
    expect(replies[0]!.results.map((r) => [r.eventId, r.ok])).toEqual([
      ['', false],
      ['k', false],
      ['n', false],
      ['m', false],
      ['ok', true],
    ]);
    expect(replies[1]!.error).toBeDefined();
    expect(replies[1]!.results).toEqual([]);
    expect(replies[2]!.results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(out.find((m) => m.t === 'policy')).toMatchObject({ result: { ok: false } });
    const kpi = out.find((m) => m.t === 'kpi');
    expect(kpi && kpi.t === 'kpi' && kpi.kpi.tick).toBe(0);
  });

  it('runTo equals plain stepping (whatever the chunking), posts the final snapshot and the KPI grid', async () => {
    const doc = grid(3, 150);
    send({ t: 'init', doc, scenario: true });
    send({ t: 'setSpeed', speed: 0 });
    send({ t: 'scenario', inputs });
    // Interrupted: a first run to 450, then on to 1200 (a different chunking than one run).
    send({ t: 'runTo', tick: 450, progressEvery: 100 });
    const first = await finishRun();
    expect(first).toMatchObject({ t: 'runTo', done: 450 });
    out = [];
    send({ t: 'runTo', tick: 1200, kpiEvery: 60 });
    const done = await finishRun();
    expect(done).toMatchObject({ t: 'runTo', done: 1200 });
    const snaps = out.filter((m): m is Extract<FromWorker, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.snapshot.scenario?.kpi.tick).toBe(1200);

    const ref = new Simulation(doc, { scenario: true });
    for (const i of inputs) expect(ref.scenarioInput(i).ok).toBe(true);
    const grid60: number[] = [];
    const kpis: unknown[] = [];
    for (let t = 0; t < 1200; t++) {
      ref.step();
      if ((t + 1) % 60 === 0 && t + 1 > 450) {
        grid60.push(t + 1);
        kpis.push(ref.kpi());
      }
    }
    expect(hash(snaps[0]!.snapshot)).toBe(hash(ref.snapshot()));
    if (!('kpi' in done)) throw new Error('no kpi');
    expect(done.kpi.map((k) => k.tick)).toEqual(grid60);
    expect(done.kpi).toEqual(kpis);
  });

  it('initRecord replays from tick 0 with reroute overridden; cancel stops a run', async () => {
    const doc = grid(3, 150);
    send({
      t: 'initRecord',
      record: { engineVersion: 1, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 600, inputs, policy: { reroute: true, informedShare: 0.7 } },
      reroute: false,
    });
    send({ t: 'setSpeed', speed: 0 });
    send({ t: 'kpi' });
    const kpi = out.find((m) => m.t === 'kpi');
    expect(kpi && kpi.t === 'kpi' && kpi.kpi.tick).toBe(0);
    send({ t: 'runTo', tick: 100000 });
    await vi.advanceTimersByTimeAsync(1);
    send({ t: 'cancel' });
    const r = await finishRun();
    expect('cancelled' in r && r.cancelled).toBeLessThan(100000);
    // Still alive after the cancel.
    out = [];
    send({ t: 'kpi' });
    expect(out.map((m) => m.t)).toEqual(['kpi']);
  });
});
