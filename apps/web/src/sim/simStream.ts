// SimulationStream: what renderers subscribe to (ADR 0005). Phase 1 = WorkerSimStream.

import type { CityDoc, Command } from '@smartcity/shared';
import type { SimSnapshot } from '@smartcity/sim';
import { snapshotTransferables, type FromWorker, type ToWorker, type WorkerSpeed } from './protocol';

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

export class WorkerSimStream implements SimulationStream, SimControl {
  private worker: Worker | null = null;
  private cur: SimSnapshot | null = null;
  private prev: SimSnapshot | null = null;
  private curAt = 0;
  private prevAt = 0;
  private listeners = new Set<(s: SimSnapshot) => void>();
  private statusCb: ((status: 'ready' | 'error', error?: string) => void) | null = null;

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
    const buffers = { vehicles: s.vehicles, signals: s.signals, laneFlow: s.laneFlow };
    this.post({ t: 'returnBuffers', buffers }, snapshotTransferables(buffers));
  }

  private dropSnapshots(): void {
    this.cur = null;
    this.prev = null;
  }

  init(doc: CityDoc): void {
    this.dropSnapshots();
    this.post({ t: 'init', doc });
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
