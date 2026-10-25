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
import { buildNet, writePose } from './network/net.js';
import { Router } from './network/route.js';
import { applyDueInputs, ensureScenario, queuePolicy, queueScenarioInput, relocateObstacles } from './scenario/apply.js';
import { emergencyArrived, fireProgress, processEmergency, recheckIncidents } from './scenario/emergency.js';
import { inactiveKpi, scenarioKpi } from './scenario/kpi.js';
import { controlledJunctions, rebindSignalControl, updatePreemption, writeSignalControl } from './scenario/preempt.js';
import { processReroutes } from './scenario/reroute.js';
import { scenarioHolds } from './scenario/state.js';
import { processSurge } from './scenario/surge.js';
import { policyError, RECENT_LOG_SIZE, type ResponsePolicy, type ScenarioOutcome, type ScenarioInput, type ScenarioKpi, type ScenarioResult, type ScenarioView } from './scenario/types.js';
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
  private boundary: { tick: number; fn: () => void } | null = null;

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
      sc: null,
    };
    installStreet(this.w);
    this.w.ped = newPedWorld(buildPedGraph(d, graph));
    resetBands(this.w);
    this.buildingSig = this.buildingSignature();
    this.refreshDerived();
    reconcileCitizens(this.w);
    // Simulator mode from tick 0 (ADR 0010): the whole experiment, warm-up included, runs in scenario mode.
    if (opts.scenario) ensureScenario(this.w);
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

  /**
   * @internal Replay (scenario/record.ts): run `fn` at the boundary before the step of `tick` — after pending
   * edits are flushed, where a live `setPolicy` / `scenarioInput` call between steps would have activated.
   */
  atTickBoundary(tick: number, fn: () => void): void {
    this.boundary = { tick, fn };
    this.reachBoundary();
  }

  /** Run a scheduled boundary as soon as the sim stands on it, so it is observable at that tick. */
  private reachBoundary(): void {
    if (this.boundary === null || this.boundary.tick !== this.w.tick) return;
    const fn = this.boundary.fn;
    this.boundary = null;
    this.flush();
    fn();
  }

  step(): void {
    const w = this.w;
    this.flush();
    if (w.sc !== null) applyDueInputs(w);
    updateSignals(w.signals, w.tick, w.laneGreen, w.zs.pedSig, w.zs.midColor);
    // Signal control state machine (ADR 0010 §4): only while emergency vehicles are out or a junction is driven.
    if (w.sc !== null && (w.sc.missions.length > 0 || w.sc.ctl.size > 0 || w.sc.clearing.size > 0)) updatePreemption(w);
    processCitizenEvents(w);
    if (w.demandOn) generateTrips(w);
    maintainBuses(w);
    this.processQueue();
    if (w.sc !== null) {
      processReroutes(w);
      processSurge(w);
      if (w.sc.incidents.length > 0 || w.sc.missions.length > 0) processEmergency(w);
    }
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
    if (this.boundary !== null) this.reachBoundary();
  }

  snapshot(reuse?: SnapshotBuffers): SimSnapshot {
    const snap = writeSnapshot(this.w, this.snapScratch, this.stats(), reuse);
    if (this.w.sc !== null) snap.scenario = this.scenarioView();
    return snap;
  }

  // ---------- simulator mode (ADR 0010) ----------

  /**
   * Queue an experiment input. Validated now (existing segment/lane/building, not a past tick, unique
   * eventId); applied at the start of the step whose tick it names, in (tick, order, eventId) order.
   */
  scenarioInput(input: ScenarioInput): ScenarioResult {
    if (this.boundary !== null) return { ok: false, error: this.replayGuard() };
    this.flush();
    return queueScenarioInput(this.w, input);
  }

  /** A record replay activates only at its recorded boundary: nothing may activate (or queue) before it. */
  private replayGuard(): string {
    return `기록 재생: 시나리오는 tick ${this.boundary!.tick}에 활성화됩니다 (현재 ${this.w.tick})`;
  }

  /**
   * Response policy for events from now on (re-route of informed vehicles). Recorded as a `policy.set` input
   * at the current tick boundary (applied first in the next step) and returned, for the ScenarioRecord.
   */
  setPolicy(policy: ResponsePolicy): ScenarioInput {
    const bad = policyError(policy);
    if (bad) throw new RangeError(bad);
    if (this.boundary !== null) throw new RangeError(this.replayGuard());
    this.flush();
    return queuePolicy(this.w, policy);
  }

  /**
   * Every apply-time scenario outcome since the last drain, in apply order — applied inputs and no-ops,
   * automatic ends, obstacle moves/removals after edits — then clears the stream. Lossless (unlike
   * `snapshot.scenario.recentLog`); reading it changes no simulation state and never activates.
   */
  drainScenarioOutcomes(): ScenarioOutcome[] {
    const sc = this.w.sc;
    if (sc === null || sc.outcomes.length === 0) return [];
    const out = sc.outcomes.map((e) => ({ eventId: e.eventId, tick: e.tick, kind: e.kind, applied: e.applied, ...(e.note !== undefined ? { reason: e.note } : {}) }));
    sc.outcomes = [];
    return out;
  }

  /** Every accepted scenario input so far (policy changes included), in acceptance order: ScenarioRecord.inputs. */
  scenarioInputs(): ScenarioInput[] {
    return (this.w.sc?.accepted ?? []).map((i) => ({ ...i, target: { ...i.target }, params: { ...i.params } }));
  }

  /**
   * Tick the scenario state was created at (SimOptions.scenario → 0; else the first scenarioInput / setPolicy
   * call; a record replay at its `activatedAtTick`), null while inactive. Put it in ScenarioRecord.activatedAtTick.
   */
  scenarioActivatedAt(): number | null {
    return this.w.sc !== null ? this.w.sc.since : null;
  }

  /**
   * Read-only: never creates or activates the scenario state. Before activation the event counters are 0 and
   * `since` is −1 (inactive); the live quantities (in progress, congestion, waiting) are still reported.
   */
  kpi(): ScenarioKpi {
    return this.w.sc !== null ? scenarioKpi(this.w) : inactiveKpi(this.w);
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

  private scenarioView(): ScenarioView {
    const w = this.w;
    const sc = w.sc!;
    const obstacles: ScenarioView['obstacles'] = [];
    const pose = new Float32Array(3);
    if (sc.obs !== null) {
      for (let l = 0; l < w.net.nLanes; l++) {
        for (const o of sc.obs[l]!) {
          writePose(w.net.pts[l]!, w.net.cum[l]!, o.rear + o.len / 2, false, 0, pose, 0);
          obstacles.push({ eventId: o.eventId, lane: l, x: pose[0]!, z: pose[1]!, heading: pose[2]!, length: o.len });
        }
      }
    }
    const activeEvents: ScenarioView['activeEvents'] = sc.effects.map((e) => ({ eventId: e.eventId, kind: e.kind, startTick: e.startTick, endTick: e.endTick === Infinity ? null : e.endTick }));
    const surges = new Set<string>();
    for (const t of sc.surgeQueue) surges.add(t.eventId);
    for (const id of surges) {
      const s = sc.surges.get(id)!;
      activeEvents.push({ eventId: id, kind: 'surge', startTick: s.startTick, endTick: s.endTick });
    }
    for (const inc of sc.incidents) activeEvents.push({ eventId: inc.eventId, kind: inc.kind, startTick: inc.startTick, endTick: null });
    activeEvents.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    const recentLog = sc.log.slice(-RECENT_LOG_SIZE).map((e) => ({ eventId: e.eventId, tick: e.tick, kind: e.kind, applied: e.applied, ...(e.note !== undefined ? { reason: e.note } : {}) }));
    const byEvent = <T extends { eventId: string }>(list: T[]): T[] => list.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    const incidents = byEvent(sc.incidents.map((inc) => ({ eventId: inc.eventId, kind: inc.kind, buildingId: inc.buildingId, state: inc.state, progress: inc.kind === 'fire' ? fireProgress(inc, w.tick) : 0 })));
    const dispatches = byEvent(
      sc.missions.map((m) => ({ eventId: m.incident.eventId, kind: m.incident.kind, vehicleId: m.v !== null ? m.v.id : null, stage: m.stage, facilityId: m.facilityId, buildingId: m.incident.buildingId })),
    );
    const preempted = controlledJunctions(w);
    return {
      graphRevision: w.graphRevision,
      obstacles,
      closedLanes: sc.closedLanes.slice(),
      kpi: scenarioKpi(w),
      activeEvents,
      recentLog,
      incidents,
      damagedBuildings: sc.damaged.slice(),
      dispatches,
      preempted,
    };
  }

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
    w.signals.builtAt = w.tick;
    if (w.sc !== null) rebindSignalControl(w);
    w.laneGreen.fill(1);
    w.zs.pedSig.fill(PedSignal.none);
    w.zs.midColor.fill(2);
    updateSignals(w.signals, w.tick, w.laneGreen, w.zs.pedSig, w.zs.midColor);
    if (w.sc !== null && (w.sc.ctl.size > 0 || w.sc.clearing.size > 0)) writeSignalControl(w);
    w.demand = buildDemand(w.doc, w.net);
    // Incidents whose building, and dispatches whose facility, an edit removed (ADR 0010 §3).
    if (w.sc !== null && (w.sc.incidents.length > 0 || w.sc.missions.length > 0)) recheckIncidents(w);
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
    // Scenario overrides are per lane index: re-place obstacles against the kept vehicles and recompose them
    // on the new graph (records keep stable ids).
    if (this.w.sc !== null) relocateObstacles(this.w);
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
          // Simulator mode counts trips that cannot start (no route, origin lane closed).
          if (!createVehicle(w, typeId, lane, s, goal, null) && w.sc !== null) w.sc.dropped++;
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
        if (v.em !== null) emergencyArrived(w, v);
        else if (w.sc !== null) {
          w.sc.completed++;
          w.sc.ttTicks += w.tick + 1 - v.t0;
        }
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
        // Held by a scenario event (closure ahead, no route, behind an accident): not stuck; the stop
        // clock restarts at the reroute mark so the vehicle gets a full window once released.
        if (v.stopTime >= STUCK_REMOVE && w.sc !== null && scenarioHolds(w, v)) v.stopTime = STUCK_REROUTE;
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
