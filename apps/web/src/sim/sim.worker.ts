// Runs the deterministic simulation off the main thread at 20 Hz × speed and streams snapshots.
// Snapshot buffers make a round trip (transfer → returnBuffers) so steady state allocates nothing.

import { Simulation, simulationFromRecord, type ScenarioKpi, type SnapshotBuffers } from '@smartcity/sim';
import { handleScenarioMessage, sanitizeBuffers, snapshotTransferables, TICK_MS, toWorkerError, type FromWorker, type ToWorker, type WorkerSpeed } from './protocol';

let sim: Simulation | null = null;
let speed: WorkerSpeed = 1;
let failed = false;
const pool: SnapshotBuffers[] = [];

/** Fast-forward in progress (runTo). Steps only depend on the tick, never on how the run is chunked. */
interface Run {
  sim: Simulation;
  target: number;
  progressEvery: number;
  kpiEvery: number;
  kpi: ScenarioKpi[];
}
let run: Run | null = null;
/** Work per chunk before yielding to the message queue. */
const CHUNK_MS = 16;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The only way out of the worker. postMessage throws on serialization failures (e.g. DataCloneError, or a
 * RangeError when copying a buffer fails); under our plain-data message and buffer contract such a failure is
 * not something to recover from, so the worker goes fatal at once (loops stop, the
 * simulation is dropped, one error status is attempted) and every later post is ignored. Messages of a tick
 * are posted synchronously in order (outcomes → snapshot → runTo done), so nothing is ever delivered after a
 * message that failed. Returns false once fatal.
 */
function post(msg: FromWorker, transfer: Transferable[] = []): boolean {
  if (failed) return false;
  try {
    (self as unknown as Worker).postMessage(msg, transfer);
    return true;
  } catch (e) {
    die(`메시지 전송 실패: ${errorText(e)}`);
    return false;
  }
}

/** Fatal: stop everything, drop the simulation, try once to report. Only `init` / `initRecord` start again. */
function die(error: string): void {
  if (failed) return;
  sim = null;
  run = null;
  failed = true;
  pool.length = 0;
  try {
    (self as unknown as Worker).postMessage({ t: 'status', status: 'error', error } satisfies FromWorker);
  } catch {
    // Nothing more can be reported.
  }
}

/**
 * Outcomes since the last drain, then the snapshot (both synchronous, in this order). A failing snapshot
 * construction outside a step is fatal too, like a step failure (returned buffers are sanitized on arrival,
 * so the pool cannot cause it).
 */
function publish(): boolean {
  if (!sim) return false;
  const outcomes = sim.drainScenarioOutcomes();
  if (outcomes.length > 0 && !post({ t: 'outcomes', outcomes })) return false;
  let snapshot;
  try {
    snapshot = sim.snapshot(pool.pop());
  } catch (e) {
    die(`스냅샷 생성 실패: ${errorText(e)}`);
    return false;
  }
  return post({ t: 'snapshot', snapshot }, snapshotTransferables(snapshot));
}

/** One simulation step; a failure here means corrupt simulation state: fatal. */
function stepOrFail(s: Simulation): boolean {
  try {
    s.step();
    return true;
  } catch (e) {
    die(errorText(e));
    return false;
  }
}

function started(next: Simulation): void {
  run = null;
  failed = false;
  sim = next;
  if (post({ t: 'status', status: 'ready' })) publish();
}

function chunk(r: Run): void {
  // Superseded (cancel, init, failure) since this chunk was scheduled.
  if (failed || run !== r || sim !== r.sim) return;
  const t0 = performance.now();
  let tick = r.sim.stats().tick;
  while (tick < r.target && performance.now() - t0 < CHUNK_MS) {
    if (!stepOrFail(r.sim)) return;
    tick++;
    let kpiError: unknown = null;
    try {
      if (tick % r.kpiEvery === 0 && r.sim.scenarioActivatedAt() !== null) r.kpi.push(r.sim.kpi());
    } catch (e) {
      kpiError = e;
    }
    if (kpiError !== null) {
      // Not a step failure: the run stops with an error reply, the simulation stays usable.
      run = null;
      post({ t: 'runTo', error: errorText(kpiError) });
      return;
    }
    if (tick % r.progressEvery === 0 && tick < r.target && !post({ t: 'runTo', progress: tick })) return;
  }
  if (tick >= r.target) {
    run = null;
    // Outcomes → final snapshot → done, synchronously; a failure stops before `done`.
    if (publish()) post({ t: 'runTo', done: tick, kpi: r.kpi });
    return;
  }
  const outcomes = r.sim.drainScenarioOutcomes();
  if (outcomes.length > 0 && !post({ t: 'outcomes', outcomes })) return;
  setTimeout(() => chunk(r), 0);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  // Anything can be posted here: a malformed message is answered, never fatal.
  const bad = toWorkerError(ev.data);
  // After a fatal error only a new init / initRecord does anything (a cancel, kpi, … is ignored).
  if (failed && !(bad === null && (ev.data.t === 'init' || ev.data.t === 'initRecord'))) return;
  if (bad) {
    post({ t: 'error', error: bad });
    return;
  }
  const msg = ev.data;
  // Building a new simulation from a bad doc or record fails before it replaces the running one.
  if (msg.t === 'init' || msg.t === 'initRecord') {
    let next: Simulation;
    try {
      next =
        msg.t === 'init'
          ? new Simulation(msg.seed === undefined ? msg.doc : { ...msg.doc, meta: { ...msg.doc.meta, seed: msg.seed } }, msg.scenario ? { scenario: true } : {})
          : simulationFromRecord(msg.record, {}, { warmup: false, ...(msg.reroute === undefined ? {} : { reroute: msg.reroute }), ...(msg.detection === undefined ? {} : { detection: msg.detection }) });
    } catch (e) {
      post({ t: 'error', error: e instanceof Error ? e.message : String(e), for: msg.t });
      return;
    }
    started(next);
    return;
  }
  try {
    switch (msg.t) {
      case 'runTo': {
        if (!sim) return;
        if (run) post({ t: 'runTo', cancelled: run.sim.stats().tick, kpi: run.kpi });
        const valid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
        if (typeof msg.tick !== 'number' || !Number.isInteger(msg.tick)) {
          run = null;
          post({ t: 'runTo', error: 'tick은 정수여야 합니다' });
          return;
        }
        run = { sim, target: msg.tick, progressEvery: valid(msg.progressEvery) ? msg.progressEvery : 600, kpiEvery: valid(msg.kpiEvery) ? msg.kpiEvery : 60, kpi: [] };
        chunk(run);
        return;
      }
      case 'cancel':
        if (run) {
          post({ t: 'runTo', cancelled: run.sim.stats().tick, kpi: run.kpi });
          run = null;
        }
        return;
      case 'coverage':
        if (sim) post({ t: 'coverage', coverage: sim.powerCoverage() });
        return;
      case 'scenario':
      case 'policy':
      case 'kpi': {
        if (sim) post(handleScenarioMessage(sim, msg));
        return;
      }
      case 'command':
        if (sim) sim.applyCommand(msg.cmd);
        return;
      case 'setSpeed':
        speed = msg.speed;
        return;
      case 'returnBuffers':
        // Only well-typed live arrays enter the pool; anything else would break the next snapshot.
        if (pool.length < 4) pool.push(sanitizeBuffers(msg.buffers));
        return;
    }
  } catch (e) {
    // A message handler failed (e.g. a command the shape check could not catch): answered, not fatal. Only
    // a failing step (corrupt simulation state) stops the worker.
    post({ t: 'error', error: e instanceof Error ? e.message : String(e), for: msg.t });
  }
};

setInterval(() => {
  if (!sim || failed || run || speed === 0) return;
  const s = sim;
  for (let i = 0; i < speed; i++) if (!stepOrFail(s)) return;
  publish();
}, TICK_MS);
