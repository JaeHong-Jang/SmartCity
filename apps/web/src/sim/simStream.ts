// SimulationStream: what renderers subscribe to (ADR 0005). Phase 1 = WorkerSimStream.

import type { CityDoc, Command } from '@smartcity/shared';
import type { DetectionMode, ResponsePolicy, ScenarioInput, ScenarioRecord, SimSnapshot, SnapshotBuffers } from '@smartcity/sim';
import { snapshotTransferables, type FromWorker, type ToWorker, type WorkerSpeed } from './protocol';

/** Worker replies to simulator-mode messages (scenario results, policy result, KPIs). */
export type ScenarioReply = Exclude<FromWorker, { t: 'status' } | { t: 'snapshot' }>;

/**
 * Simulator mode (ADR 0010): an experiment runs in its own WorkerSimStream (a fresh worker = reset), started
 * with `init(docCopy, seed)` and released with `dispose()`. KPIs also arrive with every snapshot
 * (`snapshot.scenario.kpi`) once the scenario API is in use.
 */
export interface ScenarioControl {
  scenario(inputs: ScenarioInput[]): void;
  setPolicy(policy: ResponsePolicy): void;
  requestKpi(): void;
  onScenarioReply(cb: (reply: ScenarioReply) => void): () => void;
  dispose(): void;
}

/**
 * Simulator-mode run control (ADR 0010), separate from ScenarioControl so existing implementations keep
 * compiling. Flow: `init(doc, seed, { scenario: true })` → `runTo(warmup)` → interactive → compare in a new
 * stream: `initRecord(record, !reroute)` → `runTo(tick)`; the `{ t: 'runTo', done, kpi }` reply carries the KPI
 * points at every multiple of `kpiEvery` (default 60), so ON and OFF series align exactly. In interactive play
 * every tick that is a multiple of 60 is published when the run started on such a tick (speeds 1/2/4 divide 60).
 */
export interface FastForwardControl {
  init(doc: CityDoc, seed?: number, opts?: { scenario?: boolean }): void;
  /** `reroute` / `detection` override the record's policy everywhere (comparison presets ① / ②, ADR 0013 §1). */
  initRecord(record: ScenarioRecord, reroute?: boolean, detection?: DetectionMode): void;
  runTo(tick: number, opts?: { progressEvery?: number; kpiEvery?: number }): void;
  cancelRun(): void;
}

export interface SimulationStream {
  latest(): SimSnapshot | null;
  previous(): SimSnapshot | null;
  /** performance.now() when latest/previous arrived. */
  latestAt(): number;
  previousAt(): number;
  subscribe(cb: (s: SimSnapshot) => void): () => void;
}

export interface SimControl {
  init(doc: CityDoc): void;
  command(cmd: Command): void;
  setSpeed(speed: WorkerSpeed): void;
  onStatus(cb: (status: 'ready' | 'error', error?: string) => void): void;
}

export class WorkerSimStream implements SimulationStream, SimControl, ScenarioControl, FastForwardControl {
  private worker: Worker | null = null;
  private cur: SimSnapshot | null = null;
  private prev: SimSnapshot | null = null;
  private curAt = 0;
  private prevAt = 0;
  private listeners = new Set<(s: SimSnapshot) => void>();
  private statusCb: ((status: 'ready' | 'error', error?: string) => void) | null = null;
  private replyListeners = new Set<(reply: ScenarioReply) => void>();

  constructor() {
    try {
      this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(ev.data);
      this.worker.onerror = (ev) => {
        ev.preventDefault();
        this.statusCb?.('error', ev.message || '워커 오류');
      };
    } catch (e) {
      this.worker = null;
      queueMicrotask(() => this.statusCb?.('error', (e as Error).message));
    }
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  private handle(msg: FromWorker): void {
    if (msg.t === 'status') {
      if (msg.status === 'error') {
        this.dropSnapshots();
        console.warn('[sim] 시뮬레이션을 사용할 수 없습니다:', msg.error);
      }
      this.statusCb?.(msg.status, msg.error);
      return;
    }
    if (msg.t !== 'snapshot') {
      for (const l of this.replyListeners) l(msg);
      return;
    }
    // Hand the oldest buffers back to the worker, keep latest + previous for interpolation.
    const old = this.prev;
    this.prev = this.cur;
    this.prevAt = this.curAt;
    this.cur = msg.snapshot;
    this.curAt = performance.now();
    if (old) this.giveBack(old);
    for (const l of this.listeners) l(msg.snapshot);
  }

  private giveBack(s: SimSnapshot): void {
    const buffers: SnapshotBuffers = {
      vehicles: s.vehicles,
      signals: s.signals,
      laneFlow: s.laneFlow,
      pedestrians: s.pedestrians,
      pedestrianIds: s.pedestrianIds,
      crossings: s.crossings,
      occupancy: s.occupancy,
      busLoad: s.busLoad,
      stopWaiting: s.stopWaiting,
    };
    this.post({ t: 'returnBuffers', buffers }, snapshotTransferables(buffers));
  }

  private dropSnapshots(): void {
    this.cur = null;
    this.prev = null;
  }

  /** `seed` overrides the doc's seed (experiment copies); `scenario: true` = simulator mode from tick 0. */
  init(doc: CityDoc, seed?: number, opts: { scenario?: boolean } = {}): void {
    this.dropSnapshots();
    const msg: ToWorker = { t: 'init', doc };
    if (seed !== undefined) msg.seed = seed;
    if (opts.scenario) msg.scenario = true;
    this.post(msg);
  }

  initRecord(record: ScenarioRecord, reroute?: boolean, detection?: DetectionMode): void {
    this.dropSnapshots();
    const msg: ToWorker = { t: 'initRecord', record };
    if (reroute !== undefined) msg.reroute = reroute;
    if (detection !== undefined) msg.detection = detection;
    this.post(msg);
  }

  runTo(tick: number, opts: { progressEvery?: number; kpiEvery?: number } = {}): void {
    this.post({ t: 'runTo', tick, ...opts });
  }

  cancelRun(): void {
    this.post({ t: 'cancel' });
  }

  /** Read-only power coverage; answered with `{ t: 'coverage' }` on the scenario reply listeners. */
  requestCoverage(): void {
    this.post({ t: 'coverage' });
  }

  scenario(inputs: ScenarioInput[]): void {
    this.post({ t: 'scenario', inputs });
  }

  setPolicy(policy: ResponsePolicy): void {
    this.post({ t: 'policy', policy });
  }

  requestKpi(): void {
    this.post({ t: 'kpi' });
  }

  onScenarioReply(cb: (reply: ScenarioReply) => void): () => void {
    this.replyListeners.add(cb);
    return () => this.replyListeners.delete(cb);
  }

  /** Stop the worker and drop snapshots and listeners (leaving simulator mode). */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.dropSnapshots();
    this.listeners.clear();
    this.replyListeners.clear();
    this.statusCb = null;
  }

  command(cmd: Command): void {
    this.post({ t: 'command', cmd });
  }

  setSpeed(speed: WorkerSpeed): void {
    this.post({ t: 'setSpeed', speed });
  }

  onStatus(cb: (status: 'ready' | 'error', error?: string) => void): void {
    this.statusCb = cb;
  }

  latest(): SimSnapshot | null {
    return this.cur;
  }
  previous(): SimSnapshot | null {
    return this.prev;
  }
  latestAt(): number {
    return this.curAt;
  }
  previousAt(): number {
    return this.prevAt;
  }
  subscribe(cb: (s: SimSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
