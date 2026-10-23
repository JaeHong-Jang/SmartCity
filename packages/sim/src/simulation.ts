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
import { citizenGoal, citizenStats, refreshBuildingIndex, newCitizenWorld, processCitizenEvents, reconcileCitizens, retargetCitizens, syncTransit, updateCitizens } from './citizens/citizens.js';
import { movePeds, newPedWorld, pedRequests, PedPool, processPedQueue, removePed, resetBands } from './citizens/peds.js';
import { reprojectPeds, retargetWalkers, routeCrossers, walkerGoal } from './citizens/reproject.js';
import { capacityOf, clearTransitCaches, newTransit } from './citizens/transit.js';
import { compileNetwork, newCompileCache } from './network/compile.js';
import { buildPedGraph, type PedGraph } from './network/pedGraph.js';
import { buildNet } from './network/net.js';
import { Router } from './network/route.js';
import { newSnapshotScratch, writeSnapshot } from './snapshot.js';
import { maintainBuses, syncBusLines, updateBus } from './traffic/buses.js';
import { buildDemand, generateTrips } from './traffic/demand.js';
import { processRequests } from './traffic/intersections.js';
import { edgeArrays, installStreet, recompileWorld } from './traffic/recompile.js';
import { createVehicle, routeVehicle } from './traffic/ops.js';
import { buildSignals, signalView, updateSignals } from './traffic/signals.js';
import { computeAccelerations, integrate } from './traffic/vehicles.js';
import { canPlace, despawn, STOP_SPEED, type Vehicle, type World } from './traffic/world.js';
import { processInnerRequests, updateGates } from './traffic/zones.js';
import {
  CLOCK_SCALE,
  CLOCK_START,
  PedSignal,
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
  'segment.setSchoolZone',
  'feature.upsert',
  'feature.remove',
]);

export class Simulation {
  private readonly w: World;
  private netDirty = false;
  private derivedDirty = false;
  /** Snapshot scratch for laneFlow (internal, never handed out). */
  private readonly snapScratch = newSnapshotScratch();
  /** Building layout and served bus stops: the pedestrian graph (doors, stop nodes) is rebuilt when it changes. */
  private buildingSig = '';

  constructor(doc: CityDoc, opts: SimOptions = {}) {
    const d = normalizeDoc(cloneJson(doc));
    const tickRate = opts.tickRate ?? 20;
    const compileCache = newCompileCache();
    const graph = compileNetwork(d, compileCache);
    const net = buildNet(graph);
    const nLanes = net.nLanes;
    this.w = {
      doc: d,
      tickRate,
      dt: 1 / tickRate,
      tick: 0,
      routeBudget: opts.routeBudget ?? 100,
      maxVehicles: opts.maxVehicles ?? 10000,
      demandOn: opts.demand ?? true,
      rng: new Rng(d.meta.seed),
      graph,
      compileCache,
      net,
      router: new Router(net),
      graphRevision: 0,
      vehicles: [],
      onEdge: edgeArrays(net),
      holders: new Int32Array(graph.connectors.length),
      reserved: new Float64Array(nLanes),
      laneGreen: new Uint8Array(nLanes).fill(1),
      zones: undefined as unknown as World['zones'],
      zs: undefined as unknown as World['zs'],
      crossingSig: 0,
      bumps: [],
      hasBumps: false,
      laneStopReq: new Uint8Array(nLanes),
      noGrantTick: -1,
      ped: undefined as unknown as World['ped'],
      peds: new PedPool(),
      cz: newCitizenWorld(d.meta.seed, opts.citizens ?? true, opts.maxCitizens ?? 8000),
      transit: newTransit(),
      lostDrivers: [],
      arrivedDrivers: [],
      stopped: new Int32Array(nLanes),
      queue: [],
      typeIds: [],
      types: new Map(),
      signals: { plans: [], mids: [] },
      demand: buildDemand(d, net),
      lines: [],
      nextId: 1,
      spawned: 0,
      arrived: 0,
      removed: 0,
    };
    installStreet(this.w);
    this.w.ped = newPedWorld(buildPedGraph(d, graph));
    resetBands(this.w);
    this.buildingSig = this.buildingSignature();
    this.refreshDerived();
    reconcileCitizens(this.w);
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
    updateSignals(w.signals, w.tick, w.laneGreen, w.zs.pedSig, w.zs.midColor);
    processCitizenEvents(w);
    if (w.demandOn) generateTrips(w);
    maintainBuses(w);
    this.processQueue();
    processPedQueue(w);
    updateGates(w);
    w.zs.elig.fill(0);
    pedRequests(w);
    processRequests(w);
    processInnerRequests(w);
    computeAccelerations(w);
    integrate(w);
    movePeds(w);
    this.finalize();
    updateCitizens(w);
    w.ped.arrived.length = 0;
    w.ped.failed.length = 0;
    w.lostDrivers.length = 0;
    w.arrivedDrivers.length = 0;
    w.tick++;
  }

  snapshot(reuse?: SnapshotBuffers): SimSnapshot {
    return writeSnapshot(this.w, this.snapScratch, this.stats(), reuse);
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
    const game = CLOCK_START + (w.tick / w.tickRate) * CLOCK_SCALE;
    return {
      tick: w.tick,
      time: w.tick / w.tickRate,
      clock: { dayTime: game % 86400, day: Math.floor(game / 86400) + 1 },
      citizens: citizenStats(w),
      pedestrians: w.peds.count,
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
      if (v.bus) {
        view.busLineId = v.bus.lineId;
        view.passengers = v.bus.riders.length + v.bus.alighting.length;
        view.capacity = capacityOf(w.types.get(v.typeId));
      }
      if (v.person >= 0) view.personId = w.cz.slots[v.person]?.id;
      return view;
    });
  }

  signals(): SignalView[] {
    return this.w.signals.plans.map((p) => signalView(p, this.w.tickRate));
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

  /**
   * Buildings (position, rotation, type and design revision) and the bus stops of lines (the stops the
   * pedestrian graph gives a node, ADR 0009 §2) as one comparable string.
   */
  private buildingSignature(): string {
    const d = this.w.doc;
    let sig = '';
    for (const id of Object.keys(d.buildings).sort()) {
      const b = d.buildings[id]!;
      const t = d.buildingTypes[b.typeId];
      sig += `${id}:${b.typeId}:${t?.rev ?? 0}:${t ? t.parts.length : -1}:${b.pos.x},${b.pos.z},${b.rotation};`;
    }
    const served = new Set<string>();
    for (const line of Object.values(d.busLines)) for (const s of line.stopIds) served.add(s);
    for (const id of [...served].sort()) {
      const s = d.busStops[id];
      if (s) sig += `|${id}:${s.segmentId}:${s.t}:${s.dir}`;
    }
    return sig;
  }

  /** New pedestrian graph from the current doc and network; pedestrians are re-projected onto it. */
  private rebuildPeds(oldPg: PedGraph, oldCrossingIds: string[]): void {
    const w = this.w;
    const next = w.ped.nextWalker;
    w.ped = newPedWorld(buildPedGraph(w.doc, w.graph));
    w.ped.nextWalker = next;
    w.noGrantTick = w.tick;
    refreshBuildingIndex(w);
    const lost = new Set(reprojectPeds(w, oldPg, oldCrossingIds, (i) => (w.peds.owner[i]! >= 0 ? citizenGoal(w, w.peds.owner[i]!) : walkerGoal(w, i))));
    reconcileCitizens(w);
    retargetCitizens(w, lost);
    const p = w.peds;
    const walkers: number[] = [];
    for (let i = 0; i < p.hi; i++) {
      if (!p.alive[i] || p.owner[i]! >= 0) continue;
      if (lost.has(i)) removePed(w, i);
      else walkers.push(i);
    }
    retargetWalkers(w, walkers);
    routeCrossers(w);
  }

  private refreshDerived(): void {
    const w = this.w;
    const sig = this.buildingSignature();
    if (sig !== this.buildingSig) {
      this.buildingSig = sig;
      this.rebuildPeds(w.ped.pg, w.graph.crossings.map((c) => c.id));
    }
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
    w.signals = buildSignals(w.doc, w.net, w.zones, w.tickRate);
    w.laneGreen.fill(1);
    w.zs.pedSig.fill(PedSignal.none);
    w.zs.midColor.fill(2);
    updateSignals(w.signals, w.tick, w.laneGreen, w.zs.pedSig, w.zs.midColor);
    w.demand = buildDemand(w.doc, w.net);
    syncBusLines(w);
    syncTransit(w);
    clearTransitCaches(w);
    w.vehicles = w.vehicles.filter((v) => v.alive);
  }

  /** Rebuild the network; keep vehicles whose lane/connector survived (see AGENTS.md "재컴파일"). */
  private recompile(): void {
    const oldPg = this.w.ped.pg;
    const oldIds = this.w.graph.crossings.map((c) => c.id);
    recompileWorld(this.w);
    this.buildingSig = this.buildingSignature();
    this.rebuildPeds(oldPg, oldIds);
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
        if (v.person >= 0) w.arrivedDrivers.push({ person: v.person, lane: v.edge });
        v.person = -1;
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
