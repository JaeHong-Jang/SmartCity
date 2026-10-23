// Simulation: fixed-step driver over the traffic modules. Tick order (packages/sim/AGENTS.md):
// (1) recompile + carry vehicles over (2) signals (3) demand + buses (4) route queue (budget)
// (5) intersection grants (6) IDM accelerations (7) integration + edge moves (8) arrivals / stuck removal.

import {
  applyCommand,
  cloneJson,
  normalizeDoc,
  pointAtLength,
  Rng,
  tangentAtLength,
  type ApplyResult,
  type CityDoc,
  type Command,
} from '@smartcity/shared';
import { compileNetwork } from './network/compile.js';
import { buildNet } from './network/net.js';
import { Router } from './network/route.js';
import { maintainBuses, syncBusLines, updateBus } from './traffic/buses.js';
import { buildDemand, generateTrips } from './traffic/demand.js';
import { processRequests } from './traffic/intersections.js';
import { edgeArrays, recompileWorld } from './traffic/recompile.js';
import { createVehicle, routeVehicle } from './traffic/ops.js';
import { buildSignals, headColor, signalView, updateSignals } from './traffic/signals.js';
import { computeAccelerations, integrate } from './traffic/vehicles.js';
import { canPlace, despawn, STOP_SPEED, type Vehicle, type World } from './traffic/world.js';
import {
  SIGNAL_STRIDE,
  VEHICLE_STRIDE,
  type RoadGraph,
  type SignalView,
  type SimOptions,
  type SimSnapshot,
  type SimStats,
  type SnapshotBuffers,
  type VehicleView,
} from './types.js';

const STUCK_REROUTE = 30;
const STUCK_REMOVE = 90;
const ARRIVE_TOLERANCE = 0.5;

const NETWORK_COMMANDS = new Set<Command['type']>([
  'node.add',
  'node.move',
  'segment.add',
  'segment.remove',
  'segment.split',
  'segment.setType',
  'roadType.upsert',
  'closure.set',
  'closure.remove',
  'intersection.set',
  'intersection.reset',
]);

export class Simulation {
  private readonly w: World;
  private netDirty = false;
  private derivedDirty = false;
  /** Snapshot scratch for laneFlow (internal, never handed out). */
  private flowSum = new Float64Array(0);
  private flowCnt = new Int32Array(0);

  constructor(doc: CityDoc, opts: SimOptions = {}) {
    const d = normalizeDoc(cloneJson(doc));
    const tickRate = opts.tickRate ?? 20;
    const graph = compileNetwork(d);
    const net = buildNet(graph);
    const nLanes = net.nLanes;
    this.w = {
      doc: d,
      tickRate,
      dt: 1 / tickRate,
      tick: 0,
      routeBudget: opts.routeBudget ?? 200,
      maxVehicles: opts.maxVehicles ?? 10000,
      demandOn: opts.demand ?? true,
      rng: new Rng(d.meta.seed),
      graph,
      net,
      router: new Router(net),
      graphRevision: 0,
      vehicles: [],
      onEdge: edgeArrays(net),
      holders: new Int32Array(graph.connectors.length),
      reserved: new Float64Array(nLanes),
      laneGreen: new Uint8Array(nLanes).fill(1),
      stopped: new Int32Array(nLanes),
      queue: [],
      typeIds: [],
      types: new Map(),
      signals: [],
      demand: buildDemand(d, net),
      lines: [],
      nextId: 1,
      spawned: 0,
      arrived: 0,
      removed: 0,
    };
    this.refreshDerived();
  }

  applyCommand(cmd: Command): ApplyResult {
    // Commands reaching the sim were accepted by the authoritative sequencer already.
    const res = applyCommand(this.w.doc, cmd, { trusted: true });
    if (!res.ok) return res;
    const types = cmd.type === 'batch' ? cmd.commands.map((c) => c.type) : [cmd.type];
    if (types.some((t) => NETWORK_COMMANDS.has(t))) this.netDirty = true;
    else this.derivedDirty = true;
    return res;
  }

  step(): void {
    const w = this.w;
    this.flush();
    updateSignals(w.signals, w.tick, w.laneGreen);
    if (w.demandOn) generateTrips(w);
    maintainBuses(w);
    this.processQueue();
    processRequests(w);
    computeAccelerations(w);
    integrate(w);
    this.finalize();
    w.tick++;
  }

  snapshot(reuse?: SnapshotBuffers): SimSnapshot {
    const w = this.w;
    const n = w.vehicles.length;
    let vb = reuse?.vehicles;
    if (!vb || vb.length < n * VEHICLE_STRIDE) vb = new Float32Array(Math.ceil(n * 1.25) * VEHICLE_STRIDE);
    for (let i = 0; i < n; i++) {
      const v = w.vehicles[i]!;
      const p = this.pose(v);
      const o = i * VEHICLE_STRIDE;
      vb[o] = p.x;
      vb[o + 1] = p.z;
      vb[o + 2] = p.heading;
      vb[o + 3] = v.typeIdx;
      vb[o + 4] = v.v;
      vb[o + 5] = v.id;
    }
    let heads = 0;
    for (const p of w.signals) heads += p.heads.length;
    let sb = reuse?.signals;
    if (!sb || sb.length < heads * SIGNAL_STRIDE) sb = new Float32Array(heads * SIGNAL_STRIDE);
    let o = 0;
    for (const p of w.signals) {
      for (let h = 0; h < p.heads.length; h++) {
        const head = p.heads[h]!;
        const c = headColor(p, h);
        sb[o++] = head.x;
        sb[o++] = head.z;
        sb[o++] = head.heading;
        sb[o++] = c === 'green' ? 2 : c === 'yellow' ? 1 : 0;
      }
    }
    const nLanes = w.net.nLanes;
    let lf = reuse?.laneFlow;
    if (!lf || lf.length !== nLanes) lf = new Float32Array(nLanes);
    if (this.flowSum.length !== nLanes) {
      this.flowSum = new Float64Array(nLanes);
      this.flowCnt = new Int32Array(nLanes);
    }
    const sum = this.flowSum.fill(0);
    const cnt = this.flowCnt.fill(0);
    for (const v of w.vehicles) {
      if (v.edge >= nLanes) continue;
      sum[v.edge]! += v.v / w.net.speed[v.edge]!;
      cnt[v.edge]!++;
    }
    for (let l = 0; l < nLanes; l++) lf[l] = cnt[l]! > 0 ? Math.min(1, sum[l]! / cnt[l]!) : -1;
    return {
      tick: w.tick,
      time: w.tick / w.tickRate,
      graphRevision: w.graphRevision,
      vehicles: vb,
      vehicleCount: n,
      vehicleTypeIds: w.typeIds.slice(),
      signals: sb,
      signalCount: heads,
      laneFlow: lf,
      stats: this.stats(),
    };
  }

  stats(): SimStats {
    const w = this.w;
    let speed = 0;
    let stopped = 0;
    for (const v of w.vehicles) {
      speed += v.v;
      if (v.v < STOP_SPEED) stopped++;
    }
    const n = w.vehicles.length;
    return {
      tick: w.tick,
      time: w.tick / w.tickRate,
      vehicles: n,
      spawned: w.spawned,
      arrived: w.arrived,
      removed: w.removed,
      avgSpeed: n > 0 ? speed / n : 0,
      stopped,
      pendingRoutes: w.queue.length,
      graphRevision: w.graphRevision,
    };
  }

  get graph(): RoadGraph {
    return this.w.graph;
  }

  get doc(): Readonly<CityDoc> {
    return this.w.doc;
  }

  vehicles(): VehicleView[] {
    const w = this.w;
    const nLanes = w.net.nLanes;
    return w.vehicles.map((v) => {
      const p = this.pose(v);
      const view: VehicleView = {
        id: v.id,
        typeId: v.typeId,
        edge: v.edge < nLanes ? { kind: 'lane', index: v.edge } : { kind: 'connector', index: v.edge - nLanes },
        s: v.s,
        v: v.v,
        pos: { x: p.x, z: p.z },
        heading: p.heading,
        state: v.bus && v.bus.dwell > 0 ? 'dwelling' : v.v < STOP_SPEED ? 'waiting' : 'driving',
      };
      if (v.bus) view.busLineId = v.bus.lineId;
      return view;
    });
  }

  signals(): SignalView[] {
    return this.w.signals.map((p) => signalView(p, this.w.tickRate));
  }

  spawnVehicle(typeId: string, fromLaneId: string, toLaneId: string, s?: number): number | null {
    this.flush();
    const w = this.w;
    const from = w.graph.laneById.get(fromLaneId);
    const to = w.graph.laneById.get(toLaneId);
    const type = w.types.get(typeId);
    if (from === undefined || to === undefined || !type) return null;
    const L = w.net.len[from]!;
    const pos = Math.max(0, Math.min(L, s ?? Math.min(L, type.length + 1)));
    if (!canPlace(w, from, pos, type.length, 0.5)) return null;
    const tl = w.graph.lanes[to]!;
    const goal = { segId: tl.segmentId, dir: tl.dir, anyDir: false, laneIndex: tl.laneIndex, mode: 'end' as const, t: 1 };
    return createVehicle(w, typeId, from, pos, goal, null)?.id ?? null;
  }

  // ---------- internals ----------

  private flush(): void {
    if (this.netDirty) this.recompile();
    else if (this.derivedDirty) this.refreshDerived();
    this.netDirty = false;
    this.derivedDirty = false;
  }

  /** Body center position and heading (the center may sit on the previous edge). */
  private pose(v: Vehicle): { x: number; z: number; heading: number } {
    const net = this.w.net;
    let e = v.edge;
    let s = v.s - v.len / 2;
    if (s < 0 && v.ri > 0) {
      e = v.route[v.ri - 1]!;
      s = Math.max(0, net.len[e]! + s);
    }
    s = Math.max(0, s);
    const p = pointAtLength(net.pts[e]!, net.cum[e]!, s);
    const t = tangentAtLength(net.pts[e]!, net.cum[e]!, s);
    return { x: p.x, z: p.z, heading: Math.atan2(t.z, t.x) };
  }

  private refreshDerived(): void {
    const w = this.w;
    w.typeIds = Object.keys(w.doc.vehicleTypes).sort();
    w.types = new Map(w.typeIds.map((id) => [id, w.doc.vehicleTypes[id]!]));
    for (const v of w.vehicles) {
      if (!v.alive) continue;
      v.typeIdx = w.typeIds.indexOf(v.typeId);
      const t = w.types.get(v.typeId);
      // A deleted or physically edited type: replace the vehicle rather than mutating a body
      // that already holds reservations sized for the old dimensions. Buses respawn via their line.
      const changed =
        !t || t.kind !== v.kind || t.length !== v.len || t.maxAccel !== v.a || t.comfortDecel !== v.b || t.maxSpeed !== v.maxSpeed;
      if (changed) {
        despawn(w, v);
        w.removed++;
      }
    }
    w.signals = buildSignals(w.doc, w.net, w.tickRate);
    w.laneGreen.fill(1);
    updateSignals(w.signals, w.tick, w.laneGreen);
    w.demand = buildDemand(w.doc, w.net);
    syncBusLines(w);
    w.vehicles = w.vehicles.filter((v) => v.alive);
  }

  /** Rebuild the network; keep vehicles whose lane/connector survived (see AGENTS.md "재컴파일"). */
  private recompile(): void {
    recompileWorld(this.w);
    this.refreshDerived();
  }

  private processQueue(): void {
    const w = this.w;
    let budget = w.routeBudget;
    let i = 0;
    while (i < w.queue.length && budget > 0) {
      const item = w.queue[i++]!;
      if ('trip' in item) {
        budget--;
        const { typeId, lane, s, goal } = item.trip;
        const type = w.types.get(typeId);
        // Re-check the cap at the actual spawn: buses may have taken slots since the trip was queued.
        if (type && w.vehicles.length < w.maxVehicles && canPlace(w, lane, s, type.length, 2.5)) {
          createVehicle(w, typeId, lane, s, goal, null);
        }
        continue;
      }
      const v = item.v;
      if (!v.alive) continue;
      v.queued = false;
      budget--;
      if (!routeVehicle(w, v) && item.reason === 'replan') {
        despawn(w, v);
        w.removed++;
      }
    }
    w.queue.splice(0, i);
  }

  private finalize(): void {
    const w = this.w;
    const nLanes = w.net.nLanes;
    w.stopped.fill(0);
    let dead = false;
    for (const v of w.vehicles) {
      if (v.alive && v.bus) updateBus(w, v);
      else if (v.alive && v.ri === v.route.length - 1 && v.edge < nLanes && v.s >= v.destS - ARRIVE_TOLERANCE) {
        despawn(w, v);
        w.arrived++;
      }
      if (!v.alive) {
        dead = true;
        continue;
      }
      if (v.v < STOP_SPEED && !(v.bus && v.bus.dwell > 0)) v.stopTime += w.dt;
      else {
        v.stopTime = 0;
        v.rerouted = false;
      }
      if (!v.bus) {
        if (v.stopTime >= STUCK_REMOVE) {
          despawn(w, v);
          w.removed++;
          dead = true;
          continue;
        }
        if (v.stopTime >= STUCK_REROUTE && !v.rerouted) {
          v.rerouted = true;
          if (!v.queued) {
            v.queued = true;
            w.queue.push({ v, reason: 'stuck' });
          }
        }
      }
      if (v.edge < nLanes && v.v < STOP_SPEED) w.stopped[v.edge]!++;
    }
    if (dead) w.vehicles = w.vehicles.filter((v) => v.alive);
  }
}
