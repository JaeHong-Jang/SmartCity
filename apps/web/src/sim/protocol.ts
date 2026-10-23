// Messages between the main thread and sim.worker.ts.

import type { CityDoc, Command } from '@smartcity/shared';
import type { SimSnapshot, SnapshotBuffers } from '@smartcity/sim';

export type WorkerSpeed = 0 | 1 | 2 | 4;

export type ToWorker =
  | { t: 'init'; doc: CityDoc }
  | { t: 'command'; cmd: Command }
  | { t: 'setSpeed'; speed: WorkerSpeed }
  | { t: 'returnBuffers'; buffers: SnapshotBuffers };

export type FromWorker =
  | { t: 'status'; status: 'ready' | 'error'; error?: string }
  | { t: 'snapshot'; snapshot: SimSnapshot };

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;

/** Distinct ArrayBuffers behind a snapshot's arrays, for postMessage transfer lists. */
export function snapshotTransferables(b: SnapshotBuffers): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const a of [b.vehicles, b.signals, b.laneFlow, b.pedestrians, b.pedestrianIds, b.crossings, b.occupancy]) {
    if (a && a.buffer instanceof ArrayBuffer && a.buffer.byteLength > 0 && !out.includes(a.buffer)) out.push(a.buffer);
  }
  return out;
}
