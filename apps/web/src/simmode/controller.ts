// Simulator mode (ADR 0010): a copy of the city runs in its own worker; the renderer is pointed at it through
// the switchable stream. Nothing here talks to the server or dispatches a Command.

import { cloneJson, type CityDoc } from '@smartcity/shared';
import { compileNetwork, DEFAULT_POLICY, type ResponsePolicy, type RoadGraph, type ScenarioInput, type ScenarioTarget, type SimSnapshot } from '@smartcity/sim';
import type { WorkerSpeed } from '../sim/protocol';
import type { FastForwardControl, ScenarioReply, ScenarioControl, SimulationStream } from '../sim/simStream';
import { applyOutcomes, reconcileEvents, type EventOutcome, type PendingEnd } from './eventState';
import { accidentPlace, closurePlace, surgePlace } from './label';
import { KPI_EVERY, KpiCollector } from './kpiSeries';
import { transition, type SimAction } from './machine';
import { accidentParams, closureParams, eventEndTick, ScenarioRecorder, surgeParams } from './record';
import { simModeStore, type ArmedEvent, type EventKind, type EventRow, type SimModeStore } from './store';
import { EVENT_LEAD_TICKS, WARMUP_TICKS } from './time';

/** What the controller needs from a worker stream (WorkerSimStream implements it). */
export interface CopyStream extends SimulationStream, ScenarioControl, FastForwardControl {
  setSpeed(speed: WorkerSpeed): void;
  onStatus(cb: (status: 'ready' | 'error', error?: string) => void): void;
}

export interface SimModeDeps {
  getDoc(): CityDoc;
  getSeq(): number;
  /** Main city's game time of day in seconds (null before the first snapshot). */
  getDayTime(): number | null;
  /** The speed chosen in the status bar. */
  getSpeed(): WorkerSpeed;
  setMainSpeed(speed: WorkerSpeed): void;
  /** Lock/unlock the shared editing tools (entering switches to the select tool; leaving restores). */
  setEditLock(locked: boolean): void;
  createStream(): CopyStream;
  /** Where the renderer reads snapshots from; `main` is the shared city's stream. */
  proxy: { use(stream: SimulationStream): void };
  main: SimulationStream;
  /** The renderer should draw this doc (the frozen copy), or the live doc again for null. */
  setViewDoc?(doc: CityDoc | null): void;
  store?: SimModeStore;
  now?: () => number;
}

export const SIM_STOPPED = "시뮬레이션이 중단되었습니다 — '최신 도시로 다시 시작'을 눌러 주세요";
const TICK_PUBLISH_MS = 200;
const DEFAULT_POLICY_ON: ResponsePolicy = { reroute: true, informedShare: 0.7 };

export class SimModeController {
  private readonly store: SimModeStore;
  private readonly now: () => number;
  private copy: CopyStream | null = null;
  private cmp: CopyStream | null = null;
  private readonly live = new Set<CopyStream>();
  private recorder: ScenarioRecorder | null = null;
  private collector = new KpiCollector();
  private copyDoc: CityDoc | null = null;
  private graph: RoadGraph | null = null;
  private unsubs: (() => void)[] = [];
  private lastPublish = 0;
  private aligning = false;
  /** Unsubscribes of the running comparison only; released when it finishes, is cancelled or fails. */
  private cmpUnsubs: (() => void)[] = [];
  private runs = 0;
  /** end-input eventId → the event row it ends. */
  private endOf = new Map<string, PendingEnd>();

  constructor(private readonly deps: SimModeDeps) {
    this.store = deps.store ?? simModeStore;
    this.now = deps.now ?? (() => performance.now());
  }

  get active(): boolean {
    return this.store.getState().phase !== 'off';
  }

  /** Live workers (copy + compare); 0 outside simulator mode. */
  liveWorkers(): number {
    return this.live.size;
  }

  /** Compiled road graph of the copy (lane geometry for the scenario layer). */
  roadGraph(): RoadGraph | null {
    return this.graph;
  }

  copyCityDoc(): CityDoc | null {
    return this.copyDoc;
  }

  /** Latest tick of the copy, or 0. */
  tickNow(): number {
    return this.copy?.latest()?.tick ?? 0;
  }

  private setAligning(v: boolean): void {
    this.aligning = v;
    if (this.store.getState().aligning !== v) this.store.set({ aligning: v });
  }

  private publishWorkers(): void {
    this.store.set({ workers: this.live.size });
  }

  private spawn(): CopyStream {
    const s = this.deps.createStream();
    this.live.add(s);
    this.publishWorkers();
    return s;
  }

  private release(s: CopyStream | null): void {
    if (!s || !this.live.delete(s)) return;
    s.cancelRun();
    s.dispose();
    this.publishWorkers();
  }

  private clearCmpSubs(): void {
    for (const u of this.cmpUnsubs) u();
    this.cmpUnsubs = [];
  }

  private clearSubs(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private teardownWorkers(): void {
    this.setAligning(false);
    this.clearSubs();
    this.clearCmpSubs();
    this.release(this.cmp);
    this.cmp = null;
    this.release(this.copy);
    this.copy = null;
  }

  private move(action: SimAction): boolean {
    const cur = this.store.getState().phase;
    const next = transition(cur, action);
    if (next === cur && !(action === 'restart' && cur !== 'off')) return false;
    this.store.set({ phase: next });
    return true;
  }

  // ---------- enter / restart / exit ----------

  enter(): void {
    if (this.store.getState().phase !== 'off') return;
    this.store.reset();
    this.move('enter');
    this.deps.setEditLock(true);
    this.deps.setMainSpeed(0);
    this.store.set({ policy: { ...DEFAULT_POLICY_ON } });
    this.begin();
  }

  /** Start over from the latest shared city (new copy, new warm-up, empty record). */
  restart(): void {
    if (!this.move('restart')) return;
    this.teardownWorkers();
    this.begin();
  }

  private begin(): void {
    const doc = cloneJson(this.deps.getDoc());
    const seed = doc.meta.seed;
    const policy = this.store.getState().policy;
    this.copyDoc = doc;
    try {
      this.graph = compileNetwork(doc);
    } catch {
      this.graph = null;
    }
    this.collector = new KpiCollector();
    this.endOf.clear();
    const baseSeq = this.deps.getSeq();
    this.runs++;
    this.recorder = new ScenarioRecorder({ baseSeq, doc, seed, warmupTicks: WARMUP_TICKS, policy: { ...DEFAULT_POLICY } }, `sm${this.runs}`);
    this.store.set({
      baseSeq,
      baseDayTime: this.deps.getDayTime() ?? 0,
      progress: 0,
      tick: 0,
      armed: null,
      events: [],
      compare: null,
      error: null,
      fatal: false,
    });

    const copy = this.spawn();
    this.copy = copy;
    copy.onStatus((status, error) => {
      if (status === 'error') this.store.set({ error: SIM_STOPPED, fatal: true });
    });
    this.unsubs.push(
      copy.subscribe((snap) => this.onCopySnapshot(snap)),
      copy.onScenarioReply((r) => {
        if (r.t === 'scenario') this.onResults(r.results);
        else if (r.t === 'policy') this.onPolicyReply(r.input);
        else if (r.t === 'runTo') this.onCopyRun(r);
        else if (r.t === 'error') this.store.set({ error: r.error });
        else if (r.t === 'outcomes') this.onOutcomes(r.outcomes);
      }),
    );
    // Scenario mode from tick 0 (warm-up included), so the record replays exactly. The real-time loop stays
    // paused while runTo fast-forwards the warm-up.
    copy.init(doc, seed, { scenario: true });
    copy.setSpeed(0);
    copy.setPolicy(policy);
    copy.runTo(WARMUP_TICKS, { progressEvery: 60, kpiEvery: KPI_EVERY });
    this.deps.proxy.use(copy);
    this.deps.setViewDoc?.(doc);
  }

  exit(): void {
    if (!this.move('exit')) return;
    this.teardownWorkers();
    this.deps.proxy.use(this.deps.main);
    this.deps.setViewDoc?.(null);
    this.copyDoc = null;
    this.graph = null;
    this.recorder = null;
    this.endOf.clear();
    this.deps.setEditLock(false);
    this.store.reset();
    this.deps.setMainSpeed(this.deps.getSpeed());
  }

  /** Status-bar speed buttons: the shared city when off, the copy when ready. */
  routeSpeed(speed: WorkerSpeed): void {
    const phase = this.store.getState().phase;
    if (phase === 'off') this.deps.setMainSpeed(speed);
    else if (phase === 'ready') this.resume(speed);
  }

  // ---------- snapshots ----------

  private onCopySnapshot(snap: SimSnapshot): void {
    if (snap.scenario) {
      this.collector.offer(snap.scenario.kpi);
      const rows = this.store.getState().events;
      const next = reconcileEvents(rows, snap.scenario, snap.tick, this.endOf);
      if (next !== rows) this.store.set({ events: next });
    }
    if (this.store.getState().phase !== 'warming') this.publish({ tick: snap.tick });
  }

  private onCopyRun(r: Extract<ScenarioReply, { t: 'runTo' }>): void {
    const phase = this.store.getState().phase;
    if ('error' in r) {
      this.store.set({ error: r.error });
      return;
    }
    if (phase === 'warming') {
      if ('progress' in r) this.store.set({ progress: Math.min(1, r.progress / WARMUP_TICKS) });
      else if ('done' in r) {
        this.collector.seed(r.kpi);
        this.setAligning(false);
        this.copy?.setSpeed(this.deps.getSpeed());
        this.store.set({ progress: 1, tick: r.done });
        this.move('warmedUp');
      }
      return;
    }
    // The short fast-forward to the next KPI grid tick that precedes real-time play.
    if ('done' in r && this.aligning) {
      this.collector.seed(r.kpi);
      this.setAligning(false);
      // Never resume the copy under a comparison (compare cannot start while aligning, but stay safe).
      if (phase === 'ready') this.copy?.setSpeed(this.deps.getSpeed());
    }
  }

  /**
   * Play the copy at `speed`. The sim publishes every multiple of 60 ticks only when real-time play starts on
   * one (speeds 1/2/4 divide 60), so from an off-grid tick it first fast-forwards to the next grid tick.
   */
  private resume(speed: WorkerSpeed): void {
    const copy = this.copy;
    if (!copy) return;
    if (this.aligning) return; // the pending alignment resumes at the then-current speed
    const tick = this.tickNow();
    if (speed === 0 || tick % KPI_EVERY === 0) {
      copy.setSpeed(speed);
      return;
    }
    this.setAligning(true);
    copy.setSpeed(0);
    copy.runTo(tick - (tick % KPI_EVERY) + KPI_EVERY, { kpiEvery: KPI_EVERY });
  }

  private onOutcomes(outcomes: readonly EventOutcome[]): void {
    const rows = this.store.getState().events;
    const next = applyOutcomes(rows, outcomes, this.endOf);
    if (next !== rows) this.store.set({ events: next });
  }

  /** A policy change the sim recorded as a tick-aligned input belongs to the record. */
  private onPolicyReply(input: ScenarioInput | undefined): void {
    if (input) this.recorder?.add(input);
  }

  private publish(patch: { progress?: number; tick: number }): void {
    const t = this.now();
    if (t - this.lastPublish < TICK_PUBLISH_MS) return;
    this.lastPublish = t;
    this.store.set(patch);
  }

  private onResults(results: ({ eventId: string; ok: boolean; error?: string })[]): void {
    const st = this.store.getState();
    let events = st.events;
    for (const r of results) {
      const end = this.endOf.get(r.eventId);
      if (end !== undefined) {
        // An accepted end input says nothing about the event: whether it ended is read from the snapshot.
        // Only a shape-level rejection is reported here.
        if (!r.ok) {
          this.endOf.delete(r.eventId);
          this.recorder?.reject(r.eventId);
          events = events.map((e) => (e.eventId === end.rowId ? { ...e, endError: r.error } : e));
        }
        continue;
      }
      if (!r.ok) this.recorder?.reject(r.eventId);
      // An ack only proves the input was well-formed and queued; the outcome stream confirms it.
      if (!r.ok) events = events.map((e) => (e.eventId === r.eventId ? { ...e, status: 'rejected', error: r.error } : e));
    }
    this.store.set({ events });
  }

  // ---------- events ----------

  setArmed(armed: ArmedEvent | null): void {
    this.store.set({ armed });
  }

  private send(input: ScenarioInput): void {
    this.recorder!.add(input);
    this.copy!.scenario([input]);
  }

  private ready(): boolean {
    return this.store.getState().phase === 'ready' && !this.store.getState().fatal && !!this.copy && !!this.recorder;
  }

  private row(r: Omit<EventRow, 'status' | 'ended' | 'active'>): void {
    const st = this.store.getState();
    this.store.set({ events: [...st.events, { ...r, status: 'pending', active: false, ended: false }] });
  }

  placeClosure(segmentId: string, a: ArmedEvent): boolean {
    if (!this.ready()) return false;
    const tick = this.tickNow() + EVENT_LEAD_TICKS;
    const params = closureParams(a.durationMin);
    const input = this.recorder!.make('closure.start', tick, { segmentId }, params);
    this.row({ eventId: input.eventId, kind: 'closure', ...closurePlace(this.copyDoc!, segmentId), startTick: tick, endTick: eventEndTick(input.kind, tick, params), segmentId });
    this.send(input);
    return true;
  }

  placeAccident(segmentId: string, lane: number, s: number, a: ArmedEvent): boolean {
    if (!this.ready()) return false;
    const tick = this.tickNow() + EVENT_LEAD_TICKS;
    const params = accidentParams(a.durationMin);
    const input = this.recorder!.make('accident.start', tick, { segmentId, lane, s }, params);
    this.row({ eventId: input.eventId, kind: 'accident', ...accidentPlace(this.copyDoc!, this.graph, segmentId, lane, s), startTick: tick, endTick: eventEndTick(input.kind, tick, params), segmentId, lane });
    this.send(input);
    return true;
  }

  placeSurge(buildingId: string, a: ArmedEvent): boolean {
    if (!this.ready()) return false;
    const tick = this.tickNow() + EVENT_LEAD_TICKS;
    const params = surgeParams(a);
    const input = this.recorder!.make('surge.start', tick, { buildingId }, params);
    this.row({ eventId: input.eventId, kind: 'surge', ...surgePlace(this.copyDoc!, buildingId, a.people), startTick: tick, endTick: eventEndTick(input.kind, tick, params), buildingId });
    this.send(input);
    return true;
  }

  /** End a closure or accident now (surges have no end input). */
  endEvent(eventId: string): boolean {
    if (!this.ready()) return false;
    const row = this.store.getState().events.find((e) => e.eventId === eventId);
    if (!row || row.ended || !row.active || row.status === 'rejected') return false;
    const kind: EventKind = row.kind;
    if (kind === 'surge') return false;
    for (const pending of this.endOf.values()) if (pending.rowId === row.eventId) return false; // end already in flight
    const tick = this.tickNow() + EVENT_LEAD_TICKS;
    // `eventId` makes the sim end exactly this event.
    const target: ScenarioTarget = kind === 'closure' ? { segmentId: row.segmentId, eventId: row.eventId } : { segmentId: row.segmentId, lane: row.lane, eventId: row.eventId };
    const input = this.recorder!.make(kind === 'closure' ? 'closure.end' : 'accident.end', tick, target);
    this.endOf.set(input.eventId, { rowId: row.eventId, tick });
    this.send(input);
    return true;
  }

  /** Policy can only change before the first event: the record holds one policy for the whole run. */
  setPolicy(policy: ResponsePolicy): boolean {
    if (!this.ready() || this.store.getState().events.length > 0) return false;
    this.copy!.setPolicy(policy);
    this.store.set({ policy: { ...policy } });
    return true;
  }

  // ---------- compare ----------

  /** Replay the record with the opposite reroute on a headless worker up to the copy's current grid tick. */
  compare(): boolean {
    if (!this.ready() || this.aligning) return false;
    const copy = this.copy!;
    const untilTick = Math.floor(this.tickNow() / KPI_EVERY) * KPI_EVERY;
    if (untilTick <= WARMUP_TICKS) {
      this.store.set({ error: '비교할 진행 시간이 부족합니다' });
      return false;
    }
    const record = this.recorder!.toRecord();
    const screenReroute = this.store.getState().policy.reroute;
    const screenPoints = this.collector.points.filter((p) => p.tick <= untilTick);
    copy.setSpeed(0);
    this.move('compare');
    this.store.set({ progress: 0, error: null, compare: null });

    const cmp = this.spawn();
    this.cmp = cmp;
    let done = false;
    const fail = (error: string): void => {
      if (done) return;
      done = true;
      this.finishCompare();
      this.store.set({ error });
    };
    cmp.onStatus((status, error) => {
      if (status === 'error') fail(error ?? '비교 워커 오류');
    });
    const off = cmp.onScenarioReply((r) => {
      if (done) return;
      if (r.t === 'error') return fail(`비교 실행 오류: ${r.error}`);
      if (r.t !== 'runTo') return;
      if ('progress' in r) this.store.set({ progress: Math.min(1, r.progress / untilTick) });
      else if ('error' in r) fail(`비교 실행 오류: ${r.error}`);
      else if ('done' in r) {
        done = true;
        const mine = r.kpi.filter((p) => p.tick <= untilTick);
        this.finishCompare();
        this.store.set({ compare: { screenReroute, untilTick, on: screenReroute ? screenPoints : mine, off: screenReroute ? mine : screenPoints } });
      }
    });
    this.cmpUnsubs.push(off);
    cmp.initRecord(record, !screenReroute);
    cmp.setSpeed(0);
    cmp.runTo(untilTick, { progressEvery: 120, kpiEvery: KPI_EVERY });
    return true;
  }

  cancelCompare(): void {
    if (this.store.getState().phase !== 'comparing') return;
    this.finishCompare();
  }

  /** Back to the paused-or-running copy, comparison worker released. */
  private finishCompare(): void {
    this.clearCmpSubs();
    this.release(this.cmp);
    this.cmp = null;
    if (this.store.getState().phase === 'comparing') this.move('compareDone');
    this.store.set({ progress: 1 });
    this.resume(this.deps.getSpeed());
  }
}
