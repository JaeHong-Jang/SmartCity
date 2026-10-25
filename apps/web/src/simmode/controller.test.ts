import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type CityDoc } from '@smartcity/shared';
import type { ResponsePolicy, ScenarioInput, ScenarioKpi, ScenarioRecord, SimSnapshot } from '@smartcity/sim';
import type { WorkerSpeed } from '../sim/protocol';
import type { ScenarioReply, SimulationStream } from '../sim/simStream';
import { SIM_STOPPED, SimModeController, type CopyStream } from './controller';
import type { EventRow } from './store';
import { SimModeStore } from './store';
import { DEFAULT_ARMED } from './store';
import { SwitchableStream } from './switchableStream';
import { WARMUP_TICKS } from './time';

const kpi = (tick: number): ScenarioKpi => ({
  tick, since: 0, completed: tick / 100, avgTravelTime: 30, inProgress: 2, noRoute: 0, droppedTrips: 0, waitingToDepart: 0, removed: 0, congestionLength: 0, rerouted: 0, detoured: 0, recovered: 0, activeEvents: 0,
});

class FakeStream implements CopyStream {
  static all: FakeStream[] = [];
  snap: SimSnapshot | null = null;
  speeds: WorkerSpeed[] = [];
  inits: { doc: CityDoc; seed?: number; scenario?: boolean }[] = [];
  records: { record: ScenarioRecord; reroute?: boolean }[] = [];
  runs: { tick: number; kpiEvery?: number }[] = [];
  cancels = 0;
  policies: ResponsePolicy[] = [];
  sent: ScenarioInput[] = [];
  disposed = false;
  private subs = new Set<(s: SimSnapshot) => void>();
  private replies = new Set<(r: ScenarioReply) => void>();
  constructor() {
    FakeStream.all.push(this);
  }
  latest() { return this.snap; }
  previous() { return null; }
  latestAt() { return 0; }
  previousAt() { return 0; }
  subscribe(cb: (s: SimSnapshot) => void) { this.subs.add(cb); return () => this.subs.delete(cb); }
  init(doc: CityDoc, seed?: number, opts: { scenario?: boolean } = {}) { this.inits.push({ doc, seed, scenario: opts.scenario }); }
  initRecord(record: ScenarioRecord, reroute?: boolean) { this.records.push({ record, reroute }); }
  runTo(tick: number, opts: { kpiEvery?: number } = {}) { this.runs.push({ tick, kpiEvery: opts.kpiEvery }); }
  cancelRun() { this.cancels++; }
  setSpeed(s: WorkerSpeed) { this.speeds.push(s); }
  statusCb: ((s: 'ready' | 'error', e?: string) => void) | null = null;
  onStatus(cb: (s: 'ready' | 'error', e?: string) => void) { this.statusCb = cb; }
  /** What the next snapshots report as the sim's active events and recent log. */
  active: { eventId: string; kind: string; startTick: number; endTick: number | null }[] = [];
  log: { eventId: string; tick: number; kind: string; applied: boolean; reason?: string }[] = [];
  /** The lossless outcome stream (posted before the snapshot that shows the effect). */
  outcomes(list: { eventId: string; tick: number; kind: string; applied: boolean; reason?: string }[]) {
    this.reply({ t: 'outcomes', outcomes: list });
  }
  rejectEnds = false;
  scenario(inputs: ScenarioInput[]) {
    this.sent.push(...inputs);
    this.reply({
      t: 'scenario',
      results: inputs.map((i) => (this.rejectEnds && i.kind.endsWith('.end') ? { eventId: i.eventId, ok: false as const, error: '활성 사건 없음' } : { eventId: i.eventId, ok: true as const })),
    });
  }
  setPolicy(p: ResponsePolicy) {
    this.policies.push(p);
    // the sim answers with the tick-aligned input the change was recorded as
    this.reply({ t: 'policy', result: { ok: true }, input: { eventId: `pol-${this.policies.length}`, tick: 0, order: -1, kind: 'policy.set', target: {}, params: { reroute: p.reroute ? 1 : 0, informedShare: p.informedShare } } });
  }
  requestKpi() {}
  onScenarioReply(cb: (r: ScenarioReply) => void) { this.replies.add(cb); return () => this.replies.delete(cb); }
  dispose() { this.disposed = true; this.subs.clear(); this.replies.clear(); }
  reply(r: ScenarioReply) { for (const cb of this.replies) cb(r); }
  /** Deliver a snapshot at `tick`. */
  emit(tick: number) {
    this.snap = { tick, scenario: { graphRevision: 1, obstacles: [], closedLanes: [], kpi: kpi(tick), activeEvents: this.active, recentLog: this.log } } as unknown as SimSnapshot;
    for (const cb of this.subs) cb(this.snap);
  }
  /** The runTo reply: done at `tick` with grid KPI points every 60 ticks. */
  done(tick: number) {
    const points: ScenarioKpi[] = [];
    for (let t = 0; t <= tick; t += 60) points.push(kpi(t));
    this.emit(tick);
    this.reply({ t: 'runTo', done: tick, kpi: points });
  }
}

function setup() {
  FakeStream.all = [];
  const doc = createEmptyDoc('t', 9);
  const store = new SimModeStore();
  const main: SimulationStream = new FakeStream();
  FakeStream.all.length = 0;
  const proxy = new SwitchableStream(main);
  const log: string[] = [];
  let mainSpeed: WorkerSpeed = 1;
  let uiSpeed: WorkerSpeed = 2;
  let t = 0;
  const c = new SimModeController({
    getDoc: () => doc,
    getSeq: () => 42,
    getDayTime: () => 8 * 3600,
    getSpeed: () => uiSpeed,
    setMainSpeed: (s) => { mainSpeed = s; log.push(`main:${s}`); },
    setEditLock: (l) => log.push(`lock:${l}`),
    createStream: () => new FakeStream(),
    proxy,
    main,
    store,
    now: () => (t += 1000),
  });
  return { c, store, proxy, main, doc, log, mainSpeed: () => mainSpeed, setUiSpeed: (s: WorkerSpeed) => (uiSpeed = s), streams: () => FakeStream.all };
}

describe('SimModeController', () => {
  it('enter: copies the doc, pauses main, points the renderer at the copy, then warms up to ready', () => {
    const e = setup();
    e.c.enter();
    const st = e.store.getState();
    expect(st.phase).toBe('warming');
    expect(st.baseSeq).toBe(42);
    expect(st.baseDayTime).toBe(8 * 3600);
    expect(e.mainSpeed()).toBe(0);
    expect(e.log).toEqual(['lock:true', 'main:0']);
    const copy = e.streams()[0]!;
    expect(copy.inits[0]!.doc).not.toBe(e.doc);
    expect(copy.inits[0]!.doc).toEqual(e.doc);
    expect(copy.inits[0]!.seed).toBe(9);
    expect(copy.policies).toEqual([{ reroute: true, informedShare: 0.7 }]);
    expect(copy.inits[0]!.scenario).toBe(true); // scenario mode from tick 0, warm-up included
    expect(copy.speeds).toEqual([0]); // real-time loop held while runTo fast-forwards
    expect(copy.runs).toEqual([{ tick: WARMUP_TICKS, kpiEvery: 60 }]);
    expect(e.proxy.current).toBe(copy);
    copy.reply({ t: 'runTo', progress: 600 });
    expect(e.store.getState().progress).toBeCloseTo(0.5, 5);
    copy.done(WARMUP_TICKS);
    expect(e.store.getState().phase).toBe('ready');
    expect(copy.speeds.at(-1)).toBe(2); // follows the status-bar speed once ready
  });

  it('exit: disposes workers, hands the renderer back, restores main speed and tools', () => {
    const e = setup();
    e.c.enter();
    e.streams()[0]!.done(WARMUP_TICKS);
    e.c.exit();
    expect(e.store.getState().phase).toBe('off');
    expect(e.c.liveWorkers()).toBe(0);
    expect(e.streams()[0]!.disposed).toBe(true);
    expect(e.proxy.current).toBe(e.main);
    expect(e.mainSpeed()).toBe(2);
    expect(e.log.at(-2)).toBe('lock:false');
  });

  it('ten enter/exit cycles leave no worker behind', () => {
    const e = setup();
    for (let i = 0; i < 10; i++) {
      e.c.enter();
      expect(e.c.liveWorkers()).toBe(1);
      e.streams().at(-1)!.done(WARMUP_TICKS);
      e.c.exit();
      expect(e.c.liveWorkers()).toBe(0);
    }
    expect(e.streams().length).toBe(10);
    expect(e.streams().every((s) => s.disposed)).toBe(true);
  });

  it('restart replaces the copy from the latest doc and clears events', () => {
    const e = setup();
    e.c.enter();
    const first = e.streams()[0]!;
    first.done(WARMUP_TICKS);
    e.c.placeClosure('s1', DEFAULT_ARMED.closure);
    e.c.restart();
    expect(first.disposed).toBe(true);
    expect(e.c.liveWorkers()).toBe(1);
    expect(e.store.getState().phase).toBe('warming');
    expect(e.store.getState().events).toEqual([]);
    expect(e.proxy.current).toBe(e.streams()[1]);
  });

  it('events: need ready, start after the current tick, unique ids, recorded; rejects are dropped from the record', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    expect(e.c.placeClosure('s1', DEFAULT_ARMED.closure)).toBe(false); // still warming
    copy.done(WARMUP_TICKS);
    expect(e.c.placeClosure('s1', DEFAULT_ARMED.closure)).toBe(true);
    expect(e.c.placeAccident('s2', 1, 12.5, DEFAULT_ARMED.accident)).toBe(true);
    expect(e.c.placeSurge('b1', { ...DEFAULT_ARMED.surge, people: 50 })).toBe(true);
    expect(copy.sent.map((i) => i.kind)).toEqual(['closure.start', 'accident.start', 'surge.start']);
    expect(copy.sent.every((i) => i.tick > WARMUP_TICKS)).toBe(true);
    expect(new Set(copy.sent.map((i) => i.eventId)).size).toBe(3);
    expect(copy.sent[0]!.params).toEqual({ durationTicks: 3600 });
    expect(copy.sent[1]!.target).toEqual({ segmentId: 's2', lane: 1, s: 12.5 });
    expect(copy.sent[2]!.params.extraTrips).toBe(50);
    // 확인 중 until the sim reports the outcome (an ack only proves the input was queued)
    expect(e.store.getState().events.map((x) => x.status)).toEqual(['pending', 'pending', 'pending']);
    copy.outcomes(copy.sent.map((i) => ({ eventId: i.eventId, tick: i.tick, kind: i.kind, applied: true })));
    expect(e.store.getState().events.map((x) => x.status)).toEqual(['ok', 'ok', 'ok']);
    // a rejection from the sim removes the row's status and the input from the record
    const id = copy.sent[1]!.eventId;
    copy.reply({ t: 'scenario', results: [{ eventId: id, ok: false, error: '없는 도로' }] });
    expect(e.store.getState().events[1]!.status).toBe('rejected');
  });

  it('policy is changeable only before the first event', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    expect(e.c.setPolicy({ reroute: false, informedShare: 0.5 })).toBe(true);
    expect(e.store.getState().policy).toEqual({ reroute: false, informedShare: 0.5 });
    e.c.placeClosure('s1', DEFAULT_ARMED.closure);
    expect(e.c.setPolicy({ reroute: true, informedShare: 0.9 })).toBe(false);
  });

  it('ending an event sends the matching *.end input; the row ends when the sim stops listing the event, not on the ack', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    e.c.placeAccident('s2', 1, 3, DEFAULT_ARMED.accident);
    const row = e.store.getState().events[0]!;
    expect(row.active).toBe(false); // not listed yet
    copy.active = [{ eventId: row.eventId, kind: 'accident', startTick: row.startTick, endTick: row.endTick }];
    copy.emit(row.startTick + 1);
    expect(e.store.getState().events[0]!.active).toBe(true);
    expect(e.c.endEvent(row.eventId)).toBe(true);
    const end = copy.sent[1]!;
    expect(end.kind).toBe('accident.end');
    expect(end.target).toMatchObject({ segmentId: 's2', lane: 1, eventId: row.eventId });
    expect(e.store.getState().events[0]!.ended).toBe(false); // the ack (ok) proves nothing
    expect(e.c.endEvent(row.eventId)).toBe(false); // an end is already in flight
    copy.active = [];
    copy.outcomes([{ eventId: end.eventId, tick: row.startTick + 20, kind: 'accident.end', applied: true }]);
    copy.emit(row.startTick + 21);
    const after = e.store.getState().events[0]!;
    expect(after.ended).toBe(true);
    expect(after.active).toBe(false);
    expect(after.endError).toBeUndefined();
  });

  it('compare: one extra worker replays the record with the opposite reroute to the same grid tick, exact points, then is released', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    for (let t = WARMUP_TICKS + 60; t <= 1800; t += 60) copy.emit(t);
    e.c.placeClosure('s1', DEFAULT_ARMED.closure);
    for (let t = 1860; t <= 2400; t += 60) copy.emit(t);
    copy.emit(2430); // off-grid snapshots never become points
    expect(e.c.compare()).toBe(true);
    expect(e.store.getState().phase).toBe('comparing');
    expect(copy.speeds.at(-1)).toBe(0); // screen copy paused during the comparison
    expect(e.c.liveWorkers()).toBe(2);
    const cmp = e.streams()[1]!;
    expect(cmp.records).toHaveLength(1);
    const { record, reroute } = cmp.records[0]!;
    expect(reroute).toBe(false); // screen is ON → the compare run is OFF
    expect(record.seed).toBe(9);
    expect(record.activatedAtTick).toBe(0);
    expect(record.policy).toEqual({ reroute: false, informedShare: 0.7 }); // the copy's initial policy ...
    expect(record.inputs.map((i) => i.kind)).toEqual(['policy.set', 'closure.start']); // ... plus the recorded changes and events
    expect(cmp.runs).toEqual([{ tick: 2400, kpiEvery: 60 }]);
    expect(e.c.compare()).toBe(false); // never a second parallel run
    cmp.reply({ t: 'runTo', progress: 1200 });
    expect(e.store.getState().progress).toBeCloseTo(0.5, 5);
    cmp.done(2400);
    const st = e.store.getState();
    expect(st.phase).toBe('ready');
    expect(e.c.liveWorkers()).toBe(1);
    expect(cmp.disposed).toBe(true);
    expect(st.compare!.untilTick).toBe(2400);
    expect(st.compare!.screenReroute).toBe(true);
    const ticks = (k: { tick: number }[]) => k.map((p) => p.tick);
    expect(ticks(st.compare!.on)).toEqual(ticks(st.compare!.off)); // identical x ticks
    expect(ticks(st.compare!.on).at(-1)).toBe(2400);
    expect(ticks(st.compare!.on).every((t) => t % 60 === 0)).toBe(true);
    // the copy was paused off-grid (tick 2430): it first fast-forwards to the next grid tick, then plays
    expect(copy.runs.at(-1)).toEqual({ tick: 2460, kpiEvery: 60 });
    expect(copy.speeds.at(-1)).toBe(0);
    copy.done(2460);
    expect(copy.speeds.at(-1)).toBe(2);
  });

  it('switching speed from an off-grid tick aligns to the KPI grid first, so no grid point is skipped', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    copy.emit(1403);
    e.c.routeSpeed(4);
    expect(copy.speeds.at(-1)).toBe(0);
    expect(copy.runs.at(-1)).toEqual({ tick: 1440, kpiEvery: 60 });
    e.c.routeSpeed(1); // while aligning: only the final speed counts
    expect(copy.runs).toHaveLength(2);
    copy.done(1440);
    expect(copy.speeds.at(-1)).toBe(2); // the status-bar speed at that moment (fake keeps 2)
    // on a grid tick the speed applies at once
    copy.emit(1500);
    e.c.routeSpeed(4);
    expect(copy.speeds.at(-1)).toBe(4);
    expect(copy.runs).toHaveLength(2);
  });

  it('cancelling a comparison releases its worker and resumes the copy', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    copy.emit(1500);
    e.c.compare();
    const cmp = e.streams()[1]!;
    e.c.cancelCompare();
    expect(cmp.cancels).toBe(1); // cancelRun, then dispose
    expect(cmp.disposed).toBe(true);
    expect(e.store.getState().phase).toBe('ready');
    expect(e.c.liveWorkers()).toBe(1);
    expect(e.store.getState().compare).toBeNull();
  });

  it('speed buttons drive the main city outside simulator mode and the copy inside', () => {
    const e = setup();
    e.c.routeSpeed(4);
    expect(e.log.at(-1)).toBe('main:4');
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    e.c.routeSpeed(1);
    expect(copy.speeds.at(-1)).toBe(1);
    expect(e.mainSpeed()).toBe(0);
  });

  it('compare cannot start while a grid-align runTo is in flight, and a late align reply never resumes the copy under a compare', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    copy.emit(1403);
    e.c.routeSpeed(4); // starts runTo(1440)
    expect(e.store.getState().aligning).toBe(true);
    expect(e.c.compare()).toBe(false); // waits for the alignment
    expect(e.store.getState().phase).toBe('ready');
    expect(e.c.liveWorkers()).toBe(1);
    copy.done(1440); // alignment finished: copy plays again
    expect(e.store.getState().aligning).toBe(false);
    for (let t = 1500; t <= 1800; t += 60) copy.emit(t);
    expect(e.c.compare()).toBe(true);
    expect(copy.speeds.at(-1)).toBe(0);
    copy.done(1800); // a stray late done from the copy must not resume it while comparing
    expect(e.store.getState().phase).toBe('comparing');
    expect(copy.speeds.at(-1)).toBe(0);
  });

  it('ending a selected event ends exactly that one: two closures on one road, end B → B ends, A stays', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    e.c.placeClosure('s1', DEFAULT_ARMED.closure);
    e.c.placeClosure('s1', DEFAULT_ARMED.closure);
    const [a, b] = e.store.getState().events as [EventRow, EventRow];
    const listing = (...rows: EventRow[]) => rows.map((r) => ({ eventId: r.eventId, kind: 'closure', startTick: r.startTick, endTick: r.endTick }));
    copy.active = listing(a, b);
    copy.emit(b.startTick + 1);
    expect(e.c.endEvent(b.eventId)).toBe(true);
    const end = copy.sent.at(-1)!;
    expect(end.kind).toBe('closure.end');
    expect(end.target).toMatchObject({ segmentId: 's1', eventId: b.eventId });
    copy.active = listing(a); // the sim ended B only
    copy.outcomes([{ eventId: end.eventId, tick: b.startTick + 10, kind: 'closure.end', applied: true }]);
    copy.emit(b.startTick + 11);
    const rows = e.store.getState().events;
    expect(rows[0]!.ended).toBe(false);
    expect(rows[0]!.active).toBe(true);
    expect(rows[1]!.ended).toBe(true);
  });

  it('an end the sim could not apply shows its reason on the row (the event stays active); a retry that works clears it', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    e.c.placeAccident('s2', 0, 5, DEFAULT_ARMED.accident);
    const row = e.store.getState().events[0]!;
    const act = [{ eventId: row.eventId, kind: 'accident', startTick: row.startTick, endTick: row.endTick }];
    copy.active = act;
    copy.emit(row.startTick + 1);
    expect(e.c.endEvent(row.eventId)).toBe(true);
    const first = copy.sent.at(-1)!;
    copy.outcomes([{ eventId: first.eventId, tick: row.startTick + 5, kind: 'accident.end', applied: false, reason: '사건이 활성 상태가 아닙니다' }]);
    copy.emit(row.startTick + 6);
    let r = e.store.getState().events[0]!;
    expect(r.status).toBe('ok'); // creation was fine; only the end was a no-op
    expect(r.error).toBeUndefined();
    expect(r.endError).toBe('사건이 활성 상태가 아닙니다');
    expect(r.active).toBe(true);
    expect(r.ended).toBe(false);
    // retry
    expect(e.c.endEvent(row.eventId)).toBe(true);
    const second = copy.sent.at(-1)!;
    copy.active = [];
    copy.outcomes([{ eventId: second.eventId, tick: row.startTick + 30, kind: 'accident.end', applied: true }]);
    copy.emit(row.startTick + 31);
    r = e.store.getState().events[0]!;
    expect(r.endError).toBeUndefined();
    expect(r.ended).toBe(true);
  });

  it('shape-level rejections show at once; an input the sim could not apply at its tick turns the row into a rejected one', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    e.c.placeAccident('s2', 0, 5, DEFAULT_ARMED.accident);
    copy.rejectEnds = true;
    copy.active = [{ eventId: e.store.getState().events[0]!.eventId, kind: 'accident', startTick: 0, endTick: null }];
    copy.emit(e.store.getState().events[0]!.startTick + 1);
    expect(e.c.endEvent(e.store.getState().events[0]!.eventId)).toBe(true);
    expect(e.store.getState().events[0]!.endError).toBe('활성 사건 없음');
    // apply-time failure of a start
    copy.rejectEnds = false;
    e.c.placeClosure('s1', DEFAULT_ARMED.closure);
    const closure = e.store.getState().events[1]!;
    copy.outcomes([{ eventId: closure.eventId, tick: closure.startTick, kind: 'closure.start', applied: false, reason: 'target gone' }]);
    copy.emit(closure.startTick + 1);
    const r = e.store.getState().events[1]!;
    expect(r.status).toBe('rejected');
    expect(r.error).toBe('target gone');
  });

  it('twenty finished and cancelled comparisons leave no subscriptions behind', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    for (let t = WARMUP_TICKS + 60; t <= 1500; t += 60) copy.emit(t);
    const internals = e.c as unknown as { unsubs: unknown[]; cmpUnsubs: unknown[] };
    const baseline = internals.unsubs.length;
    for (let i = 0; i < 20; i++) {
      expect(e.c.compare()).toBe(true);
      const cmp = e.streams().at(-1)!;
      if (i % 2) cmp.done(1500);
      else e.c.cancelCompare();
      expect(e.store.getState().phase).toBe('ready');
      copy.emit(1500);
    }
    expect(internals.unsubs.length).toBe(baseline);
    expect(internals.cmpUnsubs.length).toBe(0);
    expect(e.c.liveWorkers()).toBe(1);
  });

  it('a generic error reply from the compare worker fails the comparison cleanly', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    copy.emit(1500);
    expect(e.c.compare()).toBe(true);
    const cmp = e.streams()[1]!;
    cmp.reply({ t: 'error', error: '잘못된 기록', for: 'initRecord' });
    const st = e.store.getState();
    expect(st.phase).toBe('ready');
    expect(st.error).toContain('잘못된 기록');
    expect(cmp.disposed).toBe(true);
    expect(e.c.liveWorkers()).toBe(1);
    expect((e.c as unknown as { cmpUnsubs: unknown[] }).cmpUnsubs.length).toBe(0);
    expect(copy.speeds.at(-1)).toBe(2); // the copy plays again
  });

  it('40 accidents queued on one lane: 1 applied, 39 rejected, none shown as ended (the lossy 20-entry log cannot decide)', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    for (let i = 0; i < 40; i++) e.c.placeAccident('s2', 0, 5, DEFAULT_ARMED.accident);
    const rows = e.store.getState().events;
    expect(rows).toHaveLength(40);
    const start = rows[0]!.startTick;
    // before any outcome: nothing is active, nothing is ended, everything is unconfirmed
    copy.emit(start + 5);
    expect(e.store.getState().events.every((r) => r.status === 'pending' && !r.ended && !r.active)).toBe(true);
    // the sim lists the one that fit; the other 39 are no-ops (outcomes are lossless, the log would hold only 20)
    copy.active = [{ eventId: rows[0]!.eventId, kind: 'accident', startTick: rows[0]!.startTick, endTick: rows[0]!.endTick }];
    copy.outcomes(
      rows.map((r, i) => ({ eventId: r.eventId, tick: r.startTick, kind: 'accident.start', applied: i === 0, ...(i === 0 ? {} : { reason: 'no room on lane' }) })),
    );
    copy.emit(start + 10);
    const after = e.store.getState().events;
    expect(after.filter((r) => r.status === 'ok' && r.active)).toHaveLength(1);
    expect(after.filter((r) => r.status === 'rejected')).toHaveLength(39);
    expect(after.some((r) => r.ended)).toBe(false);
    expect(after[5]!.error).toBe('no room on lane');
  });

  it('an applied event that started and ended between snapshots shows as ended once the outcome confirmed it', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    e.c.placeClosure('s1', DEFAULT_ARMED.closure);
    const row = e.store.getState().events[0]!;
    copy.outcomes([{ eventId: row.eventId, tick: row.startTick, kind: 'closure.start', applied: true }]);
    copy.emit(row.startTick + 60); // never listed in a snapshot
    const r = e.store.getState().events[0]!;
    expect(r.status).toBe('ok');
    expect(r.ended).toBe(true);
  });

  it('an accident the sim moved or removed after a road edit says so on its row', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    e.c.placeAccident('s2', 0, 5, DEFAULT_ARMED.accident);
    e.c.placeAccident('s2', 1, 5, DEFAULT_ARMED.accident);
    const [a, b] = e.store.getState().events as [EventRow, EventRow];
    copy.outcomes([
      { eventId: a.eventId, tick: a.startTick, kind: 'accident.start', applied: true },
      { eventId: b.eventId, tick: b.startTick, kind: 'accident.start', applied: true },
      { eventId: a.eventId, tick: a.startTick + 50, kind: 'accident.move', applied: true, reason: 'moved to s=12.00 after edit' },
      { eventId: b.eventId, tick: b.startTick + 50, kind: 'accident.end', applied: true, reason: 'lane gone' },
    ]);
    copy.emit(b.startTick + 60);
    const rows = e.store.getState().events;
    expect(rows[0]!.note).toBe('사고 위치 이동');
    expect(rows[1]!.note).toBe('도로 편집으로 제거됨');
    // a normal duration end carries no note
    copy.outcomes([{ eventId: a.eventId, tick: a.startTick + 90, kind: 'accident.end', applied: true, reason: 'duration' }]);
    expect(e.store.getState().events[0]!.note).toBe('사고 위치 이동');
  });

  it('after a fatal copy-worker error the banner says so, unconfirmed rows stop being checked and creation is disabled until restart', () => {
    const e = setup();
    e.c.enter();
    const copy = e.streams()[0]!;
    copy.done(WARMUP_TICKS);
    e.c.placeClosure('s1', DEFAULT_ARMED.closure);
    copy.statusCb!('error', 'boom');
    const st = e.store.getState();
    expect(st.fatal).toBe(true);
    expect(st.error).toBe(SIM_STOPPED);
    expect(st.events[0]!.status).toBe('pending'); // not guessed
    expect(e.c.placeClosure('s1', DEFAULT_ARMED.closure)).toBe(false);
    expect(e.c.placeAccident('s2', 0, 1, DEFAULT_ARMED.accident)).toBe(false);
    expect(e.c.placeSurge('b1', DEFAULT_ARMED.surge)).toBe(false);
    expect(e.c.compare()).toBe(false);
    expect(e.store.getState().events).toHaveLength(1);
    e.c.restart();
    expect(e.store.getState().fatal).toBe(false);
    expect(e.store.getState().error).toBeNull();
    e.streams()[1]!.done(WARMUP_TICKS);
    expect(e.c.placeClosure('s1', DEFAULT_ARMED.closure)).toBe(true);
  });
});
