// Runs the deterministic simulation off the main thread at 20 Hz × speed and streams snapshots.
// Snapshot buffers make a round trip (transfer → returnBuffers) so steady state allocates nothing.

import { Simulation, type SnapshotBuffers } from '@smartcity/sim';
import { snapshotTransferables, TICK_MS, type FromWorker, type ToWorker, type WorkerSpeed } from './protocol';

let sim: Simulation | null = null;
let speed: WorkerSpeed = 1;
let failed = false;
const pool: SnapshotBuffers[] = [];

const post = (msg: FromWorker, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(msg, transfer);
};

function fail(e: unknown): void {
  sim = null;
  failed = true;
  post({ t: 'status', status: 'error', error: e instanceof Error ? e.message : String(e) });
}

function publish(): void {
  if (!sim) return;
  const snapshot = sim.snapshot(pool.pop());
  post({ t: 'snapshot', snapshot }, snapshotTransferables(snapshot));
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.t) {
      case 'init':
        failed = false;
        sim = new Simulation(msg.doc);
        post({ t: 'status', status: 'ready' });
        publish();
        return;
      case 'command':
        if (sim) sim.applyCommand(msg.cmd);
        return;
      case 'setSpeed':
        speed = msg.speed;
        return;
      case 'returnBuffers':
        if (pool.length < 4) pool.push(msg.buffers);
        return;
    }
  } catch (e) {
    fail(e);
  }
};

setInterval(() => {
  if (!sim || failed || speed === 0) return;
  try {
    for (let i = 0; i < speed; i++) sim.step();
    publish();
  } catch (e) {
    fail(e);
  }
}, TICK_MS);
