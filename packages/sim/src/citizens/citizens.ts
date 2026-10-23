// Persistent citizens (ADR 0008 §4). Population per building = residential floor area / 30 m² and jobs =
// floor area per use / the stats.ts coefficients (shared `AREA_PER_PERSON`, `AREA_PER_JOB`), capped at
// `maxCitizens` agents (each agent stands for `scale` residents), distributed by largest remainder (ties by
// building id). A citizen is in exactly one state; events run in (dueTick, personId, seq) order and the
// next one is always scheduled from the actual arrival. Trips: door → walk (route ≤ 1 km, or no car) or
// door → curb → car (personId on the vehicle) → curb → walk → door, or (ADR 0009 §2, only when a direct bus
// line serves both ends) door → stop → queue → bus → stop → walk → door. A citizen belongs to exactly one
// of: building, pedestrian, car, stop queue (it keeps its pedestrian there), bus riders, bus alighting.

import { AREA_PER_JOB, AREA_PER_PERSON, buildingMetrics, Rng, WORKFORCE_SHARE, type CityDoc, type TravelDir } from '@smartcity/shared';
import { groupKey } from '../network/net.js';
import { laneSAtT } from '../traffic/demand.js';
import { createVehicle } from '../traffic/ops.js';
import { canPlace, despawn, type Goal, type Vehicle, type World } from '../traffic/world.js';
import { ROUTE_SPEED, type BuildingAccess } from '../network/pedGraph.js';
import { PedState, type CitizenStats } from '../types.js';
import { DOOR_SECONDS, removePed, requestRoute, setRoute, spawnPed } from './peds.js';
import { gameDuration, gameSec, hash01, heapPop, schedule, tickAt, type Ev } from './schedule.js';
import { busOption, capacityOf, dequeue, dwellSeconds, enqueue, EST_SPEED, MAX_BOARD, queueOf, sortedQueues, takeFront, WAIT_MINUTES } from './transit.js';

export const CitState = { home: 0, leaving: 1, walking: 2, driving: 3, entering: 4, atWork: 5, atShop: 6, displaced: 7, waiting: 8, riding: 9 } as const;
const N_STATES = 10;
const Purpose = { home: 0, work: 1, shop: 2 } as const;
/**
 * Trip leg: none, waiting for the walking route (mode choice), walking to the door, walking to the car,
 * walking from the car, walking to the bus stop, queued at the stop, aboard a bus (riders or alighting).
 */
export const Leg = { none: 0, plan: 1, walk: 2, toCar: 3, fromCar: 4, toStop: 5, wait: 6, ride: 7 } as const;

/** Walk when the walking route is at most this long (m). */
export const WALK_MAX = 1000;
/** Share of citizens owning a car (seeded once per citizen). */
export const CAR_OWNERSHIP = 0.6;
const WORK_HOURS = 8;
const SHOP_PROB = 0.3;
const SHOP_MIN_MINUTES = 15;
const SHOP_MAX_MINUTES = 45;
const DEPART_START = 7 * 3600;
const DEPART_SPAN = 2 * 3600;
const ERRAND_START = 10 * 3600;
const ERRAND_SPAN = 6 * 3600;
const ERRAND_PROB = 0.3;
/** Seconds a citizen waits at the curb for room to start the car before walking instead. */
const CAR_WAIT = 30;
const DAY = 86400;

export interface Citizen {
  id: number;
  slot: number;
  home: string;
  work: string | null;
  worker: boolean;
  hasCar: boolean;
  vPref: number;
  style: number;
  state: number;
  /** Building the citizen is inside (null while outdoors). */
  at: string | null;
  /** Trip origin and destination buildings. */
  from: string | null;
  dest: string | null;
  purpose: number;
  leg: number;
  ped: number;
  car: Vehicle | null;
  carWait: number;
  seq: number;
  /** Bus leg of the current trip: line, boarding and alighting stop ids (null when not travelling by bus). */
  line: string | null;
  board: string | null;
  alight: string | null;
  /** Bus the citizen is aboard (riders or alighting). */
  ride: Vehicle | null;
}

export interface CitizenWorld {
  enabled: boolean;
  max: number;
  scale: number;
  slots: (Citizen | null)[];
  free: number[];
  byId: Map<number, Citizen>;
  count: number;
  counts: Int32Array;
  nextId: number;
  heap: Ev[];
  rngAssign: Rng;
  rngSched: Rng;
  rngMode: Rng;
  /** Job capacity (agents) and use per building. */
  jobCap: Map<string, number>;
  jobUsed: Map<string, number>;
  shopIds: string[];
  shopW: number[];
  /** Building id → index in the pedestrian graph's sorted building list. */
  bIndex: Map<string, number>;
  /** Trips that ended without walking/driving all the way (no route, car removed, edits). */
  failedTrips: number;
  /** Citizens removed because their home was demolished or shrank. */
  removedCitizens: number;
  trips: number;
}

export function newCitizenWorld(seed: number, enabled: boolean, max: number): CitizenWorld {
  return {
    enabled,
    max,
    scale: 1,
    slots: [],
    free: [],
    byId: new Map(),
    count: 0,
    counts: new Int32Array(N_STATES),
    nextId: 1,
    heap: [],
    rngAssign: new Rng((seed ^ 0x5bd1e995) >>> 0),
    rngSched: new Rng((seed ^ 0x27d4eb2f) >>> 0),
    rngMode: new Rng((seed ^ 0x165667b1) >>> 0),
    jobCap: new Map(),
    jobUsed: new Map(),
    shopIds: [],
    shopW: [],
    bIndex: new Map(),
    failedTrips: 0,
    removedCitizens: 0,
    trips: 0,
  };
}

// ---------- population ----------

/** Integer shares of `total` proportional to `quotas` (largest remainder, ties by position). */
function largestRemainder(quotas: number[], total: number): number[] {
  const out = quotas.map((q) => Math.floor(q));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = quotas.map((_, i) => i).sort((i, j) => quotas[j]! - Math.floor(quotas[j]!) - (quotas[i]! - Math.floor(quotas[i]!)) || i - j);
  for (const i of order) {
    if (rest <= 0) break;
    out[i]!++;
    rest--;
  }
  return out;
}

function setState(w: World, c: Citizen, s: number): void {
  w.cz.counts[c.state]!--;
  c.state = s;
  w.cz.counts[s]!++;
}

const access = (w: World, id: string | null): BuildingAccess | null => {
  if (id === null) return null;
  const i = w.cz.bIndex.get(id);
  return i === undefined ? null : w.ped.pg.access[i]!;
};

/** Leave every bus relation (stop queue, riders, alighting). Idempotent; a dropped queue place voids the patience event. */
function detachBus(w: World, c: Citizen): void {
  if (c.board !== null && c.line !== null && dequeue(w, c.board, c.line, c.slot)) c.seq++;
  const bus = c.ride?.bus;
  if (bus) {
    const k = bus.riders.findIndex((r) => r.slot === c.slot);
    if (k >= 0) bus.riders.splice(k, 1);
    const a = bus.alighting.indexOf(c.slot);
    if (a >= 0) bus.alighting.splice(a, 1);
  }
  c.ride = null;
  c.line = null;
  c.board = null;
  c.alight = null;
}

function removeCitizen(w: World, c: Citizen): void {
  const cz = w.cz;
  detachBus(w, c);
  if (c.ped >= 0) removePed(w, c.ped);
  c.ped = -1;
  if (c.car) {
    c.car.person = -1;
    if (c.car.alive) {
      despawn(w, c.car);
      w.removed++;
    }
    c.car = null;
  }
  cz.counts[c.state]!--;
  cz.count--;
  cz.byId.delete(c.id);
  cz.slots[c.slot] = null;
  cz.free.push(c.slot);
  if (c.work) cz.jobUsed.set(c.work, (cz.jobUsed.get(c.work) ?? 0) - 1);
}

function assignJob(w: World, c: Citizen): void {
  const cz = w.cz;
  if (!c.worker || c.work !== null) return;
  const ids: string[] = [];
  const free: number[] = [];
  for (const [id, cap] of cz.jobCap) {
    const f = cap - (cz.jobUsed.get(id) ?? 0);
    if (f > 0) {
      ids.push(id);
      free.push(f);
    }
  }
  const k = cz.rngAssign.weighted(free);
  if (k < 0) return;
  c.work = ids[k]!;
  cz.jobUsed.set(c.work, (cz.jobUsed.get(c.work) ?? 0) + 1);
}

function createCitizen(w: World, home: string): Citizen {
  const cz = w.cz;
  const r = cz.rngAssign;
  const slot = cz.free.pop() ?? cz.slots.length;
  const c: Citizen = {
    id: cz.nextId++,
    slot,
    home,
    work: null,
    worker: r.next() < WORKFORCE_SHARE,
    hasCar: cz.rngMode.next() < CAR_OWNERSHIP,
    vPref: Math.max(0.8, Math.min(1.8, 1.3 + 0.5 * (r.next() - r.next()))),
    style: r.int(16),
    state: CitState.home,
    at: home,
    from: null,
    dest: null,
    purpose: Purpose.home,
    leg: Leg.none,
    ped: -1,
    car: null,
    carWait: 0,
    seq: 0,
    line: null,
    board: null,
    alight: null,
    ride: null,
  };
  cz.slots[slot] = c;
  cz.byId.set(c.id, c);
  cz.count++;
  cz.counts[CitState.home]!++;
  assignJob(w, c);
  scheduleHome(w, c);
  return c;
}

/**
 * Match the citizens to the buildings (start and after every building edit): homes gain or lose agents,
 * jobs over capacity are released, citizens inside a vanished building go home, a changed scale restarts
 * the population. Call after the pedestrian graph has been rebuilt.
 */
export function reconcileCitizens(w: World): void {
  const cz = w.cz;
  const doc: CityDoc = w.doc;
  cz.bIndex = new Map(w.ped.pg.buildingIds.map((id, i) => [id, i]));
  if (!cz.enabled) return;
  let prevJobs = 0;
  for (const n of cz.jobCap.values()) prevJobs += n;
  const prevShops = cz.shopIds.length;
  const ids = Object.keys(doc.buildings).sort();
  const metrics = new Map<string, ReturnType<typeof buildingMetrics>>();
  const res: number[] = [];
  const jobs: number[] = [];
  cz.shopIds = [];
  cz.shopW = [];
  for (const id of ids) {
    const type = doc.buildingTypes[doc.buildings[id]!.typeId];
    let m = type ? metrics.get(type.id) : undefined;
    if (type && !m) metrics.set(type.id, (m = buildingMetrics(type)));
    const a = m?.areaByUse;
    res.push(a ? a.residential / AREA_PER_PERSON : 0);
    jobs.push(a ? a.commercial / AREA_PER_JOB.commercial + a.office / AREA_PER_JOB.office + a.industrial / AREA_PER_JOB.industrial + a.public / AREA_PER_JOB.public : 0);
    if (a && a.commercial > 0) {
      cz.shopIds.push(id);
      cz.shopW.push(a.commercial);
    }
  }
  const population = res.reduce((a, b) => a + b, 0);
  const scale = Math.max(1, Math.ceil(population / cz.max));
  if (scale !== cz.scale) {
    for (const c of cz.slots) if (c) removeCitizen(w, c);
    cz.scale = scale;
  }
  const homes = largestRemainder(
    res.map((r) => r / scale),
    Math.round(population / scale),
  );
  const totalJobs = jobs.reduce((a, b) => a + b, 0);
  const caps = largestRemainder(
    jobs.map((j) => j / scale),
    Math.round(totalJobs / scale),
  );
  const want = new Map<string, number>();
  ids.forEach((id, i) => {
    if (homes[i]! > 0) want.set(id, homes[i]!);
  });
  cz.jobCap = new Map();
  ids.forEach((id, i) => {
    if (caps[i]! > 0) cz.jobCap.set(id, caps[i]!);
  });
  // Group the living citizens by home (slot order = creation order for equal ids).
  const byHome = new Map<string, Citizen[]>();
  const all = cz.slots.filter((c): c is Citizen => c !== null).sort((a, b) => a.id - b.id);
  for (const c of all) {
    const l = byHome.get(c.home);
    if (l) l.push(c);
    else byHome.set(c.home, [c]);
  }
  for (const [home, list] of byHome) {
    const n = want.get(home) ?? 0;
    for (let k = list.length - 1; k >= n; k--) {
      removeCitizen(w, list[k]!);
      cz.removedCitizens++;
    }
  }
  // Jobs: release vanished or over-capacity workplaces (highest ids first).
  cz.jobUsed = new Map();
  let released = false;
  const living = cz.slots.filter((c): c is Citizen => c !== null).sort((a, b) => a.id - b.id);
  for (const c of living) {
    if (c.work === null) continue;
    const used = cz.jobUsed.get(c.work) ?? 0;
    if (used >= (cz.jobCap.get(c.work) ?? 0)) {
      c.work = null;
      released = true;
    } else cz.jobUsed.set(c.work, used + 1);
  }
  for (const c of living) {
    // Inside a building that no longer exists: home again (counted as a failed trip).
    if (c.at !== null && !doc.buildings[c.at]) {
      cz.failedTrips++;
      setState(w, c, CitState.home);
      c.at = c.home;
      scheduleHome(w, c);
    }
    if (c.dest !== null && !doc.buildings[c.dest]) {
      c.dest = c.home;
      c.purpose = Purpose.home;
    }
  }
  for (const id of ids) {
    const n = want.get(id) ?? 0;
    for (let k = byHome.get(id)?.filter((c) => cz.byId.has(c.id)).length ?? 0; k < n; k++) createCitizen(w, id);
  }
  // Jobs or shops appeared since a citizen last planned: someone at home without a job (or without
  // anywhere to go) has no pending event and would sleep forever. Replanning is idempotent (departure
  // times are a hash of id and day); doing it only on growth or lost jobs keeps stale heap entries bounded.
  let jobs2 = 0;
  for (const n of cz.jobCap.values()) jobs2 += n;
  if (released || jobs2 > prevJobs || cz.shopIds.length > prevShops) {
    for (const c of cz.slots) if (c && c.state === CitState.home && (c.work === null || !c.worker)) scheduleHome(w, c);
  }
}

// ---------- daily plan ----------

function scheduleHome(w: World, c: Citizen): void {
  assignJob(w, c);
  const day0 = Math.floor(gameSec(w, w.tick) / DAY);
  for (let d = day0; d < day0 + 14; d++) {
    let at: number;
    if (c.worker && c.work !== null) at = d * DAY + DEPART_START + hash01(c.id, d, 1) * DEPART_SPAN;
    else if (w.cz.shopIds.length > 0 && hash01(c.id, d, 2) < ERRAND_PROB) at = d * DAY + ERRAND_START + hash01(c.id, d, 3) * ERRAND_SPAN;
    else continue;
    const t = tickAt(w, at);
    if (t > w.tick) {
      schedule(w, c, t);
      return;
    }
  }
}

function pickShop(w: World): string | null {
  const k = w.cz.rngSched.weighted(w.cz.shopW);
  return k < 0 ? null : w.cz.shopIds[k]!;
}

function act(w: World, c: Citizen): void {
  // Patience at the stop ran out: walk the rest of the way.
  if (c.state === CitState.waiting) return leaveStop(w, c);
  if (c.state === CitState.home) {
    if (c.worker && c.work !== null && w.doc.buildings[c.work]) return startTrip(w, c, c.work, Purpose.work);
    const shop = pickShop(w);
    if (shop && shop !== c.home) return startTrip(w, c, shop, Purpose.shop);
    return scheduleHome(w, c);
  }
  if (c.state === CitState.atWork) {
    const shop = w.cz.rngSched.next() < SHOP_PROB ? pickShop(w) : null;
    if (shop && shop !== c.at) return startTrip(w, c, shop, Purpose.shop);
    return startTrip(w, c, c.home, Purpose.home);
  }
  if (c.state === CitState.atShop) startTrip(w, c, c.home, Purpose.home);
}

function startTrip(w: World, c: Citizen, dest: string, purpose: number): void {
  const cz = w.cz;
  cz.trips++;
  c.from = c.at;
  c.at = null;
  c.dest = dest;
  c.purpose = purpose;
  setState(w, c, CitState.leaving);
  const ao = access(w, c.from);
  const ad = access(w, dest);
  if (!ao || !ad || ao.door === ad.door) return failTrip(w, c);
  c.ped = spawnPed(w, ao.door, c.id, c.slot, c.vPref, c.style, Math.max(1, Math.round(DOOR_SECONDS * w.tickRate)));
  c.leg = Leg.plan;
  requestRoute(w, c.ped, ad.door);
}

/** The trip ends now at its destination (no route, car removed, edits): counted, never silent. */
function failTrip(w: World, c: Citizen): void {
  w.cz.failedTrips++;
  if (c.ped >= 0) removePed(w, c.ped);
  c.ped = -1;
  if (c.car) {
    c.car.person = -1;
    if (c.car.alive) {
      despawn(w, c.car);
      w.removed++;
    }
    c.car = null;
  }
  arrive(w, c);
}

function arrive(w: World, c: Citizen): void {
  detachBus(w, c);
  let dest = c.dest;
  let purpose = c.purpose;
  if (dest === null || !w.doc.buildings[dest]) {
    dest = c.home;
    purpose = Purpose.home;
  }
  if (c.ped >= 0) removePed(w, c.ped);
  c.ped = -1;
  c.car = null;
  c.at = dest;
  c.from = null;
  c.dest = null;
  c.leg = Leg.none;
  c.carWait = 0;
  if (purpose === Purpose.work) {
    setState(w, c, CitState.atWork);
    schedule(w, c, w.tick + gameDuration(w, WORK_HOURS * 3600));
  } else if (purpose === Purpose.shop) {
    setState(w, c, CitState.atShop);
    const minutes = SHOP_MIN_MINUTES + w.cz.rngSched.next() * (SHOP_MAX_MINUTES - SHOP_MIN_MINUTES);
    schedule(w, c, w.tick + gameDuration(w, minutes * 60));
  } else {
    setState(w, c, CitState.home);
    scheduleHome(w, c);
  }
}

// ---------- cars ----------

const sideDir = (w: World, segId: string, side: number): TravelDir => {
  const rt = w.graph.segments.get(segId)?.roadType;
  return side === -1 && rt && rt.lanesBackward > 0 ? 'backward' : 'forward';
};

/** Start the car at the curb next to the origin's access point. */
function tryCar(w: World, c: Citizen): 'ok' | 'wait' | 'walk' {
  const ao = access(w, c.from);
  const ad = access(w, c.dest);
  const cs = ao ? w.graph.segments.get(ao.segId) : undefined;
  const ds = ad ? w.graph.segments.get(ad.segId) : undefined;
  if (!ao || !ad || !cs || !ds || w.demand.typeIds.length === 0) return 'walk';
  const lanes = w.net.groups.get(groupKey(ao.segId, sideDir(w, ao.segId, ao.side)));
  let lane = -1;
  if (lanes) for (let k = lanes.length - 1; k >= 0 && lane < 0; k--) if (!w.net.busOnly[lanes[k]!]) lane = lanes[k]!;
  if (lane < 0 || w.net.closed[lane]) return 'walk';
  if (w.vehicles.length >= w.maxVehicles) return 'wait';
  const typeId = w.demand.typeIds[w.cz.rngMode.weighted(w.demand.typeW)]!;
  const type = w.types.get(typeId)!;
  const L = w.net.len[lane]!;
  if (L < type.length + 1) return 'walk';
  const s = Math.max(type.length + 0.5, Math.min(L, laneSAtT(w.net, lane, ao.s / cs.length)));
  if (!canPlace(w, lane, s, type.length, 2.5)) return 'wait';
  // Park on the destination's side of the road (no detour over a crosswalk on foot); either side if that fails.
  const goal: Goal = { segId: ad.segId, dir: sideDir(w, ad.segId, ad.side), anyDir: false, laneIndex: -1, mode: 't', t: ad.s / ds.length };
  const v = createVehicle(w, typeId, lane, s, goal, null) ?? createVehicle(w, typeId, lane, s, { ...goal, anyDir: true }, null);
  if (!v) return 'walk';
  v.person = c.slot;
  c.car = v;
  if (c.ped >= 0) removePed(w, c.ped);
  c.ped = -1;
  setState(w, c, CitState.driving);
  return 'ok';
}

/** Walk the rest of the way to the destination door from where the pedestrian stands. */
function walkToDoor(w: World, c: Citizen): void {
  const ad = access(w, c.dest);
  if (!ad || c.ped < 0) return failTrip(w, c);
  c.leg = Leg.walk;
  w.peds.doorOnArrive[c.ped] = 1;
  requestRoute(w, c.ped, ad.door);
}

// ---------- buses (ADR 0009 §2) ----------

/** Sidewalk node of a served stop on the current pedestrian graph, −1 when the stop is not served. */
function stopNode(w: World, stop: string | null): number {
  const k = stop === null ? undefined : w.ped.pg.stopIndex.get(stop);
  return k === undefined ? -1 : w.ped.pg.stopNode[k]!;
}

/** The queue (stop, line) still exists in the doc and the stop is served. */
function queueValid(w: World, stop: string, line: string): boolean {
  return stopNode(w, stop) >= 0 && (w.doc.busLines[line]?.stopIds.includes(stop) ?? false);
}

/** Out of the stop queue (patience, stop or line gone): walk from where the pedestrian stands. */
function leaveStop(w: World, c: Citizen): void {
  if (c.board !== null && c.line !== null && dequeue(w, c.board, c.line, c.slot)) c.seq++;
  c.line = null;
  c.board = null;
  c.alight = null;
  if (c.ped < 0) return failTrip(w, c);
  w.peds.state[c.ped] = PedState.waiting;
  setState(w, c, CitState.walking);
  walkToDoor(w, c);
}

/** The pedestrian reached its boarding stop: join the queue (or walk on when it is gone). */
function joinStop(w: World, c: Citizen): void {
  const node = stopNode(w, c.board);
  if (c.board === null || c.line === null || node < 0 || w.peds.node[c.ped] !== node || !queueValid(w, c.board, c.line)) {
    c.line = null;
    c.board = null;
    c.alight = null;
    return walkToDoor(w, c);
  }
  enqueue(w, c.board, c.line, { slot: c.slot, pid: c.id, tick: w.tick });
  c.leg = Leg.wait;
  w.peds.state[c.ped] = PedState.busStop;
  setState(w, c, CitState.waiting);
  schedule(w, c, w.tick + gameDuration(w, WAIT_MINUTES * 60));
}

/**
 * Stop arrival of bus `v` (called once, at the arrival tick, buses in vehicle id order): riders for this
 * stop — or whose stop left the line — move to `alighting`, then up to min(capacity − staying riders, 20)
 * waiters board in FIFO order. Returns the dwell in seconds.
 */
export function busArrive(w: World, v: Vehicle): number {
  const bus = v.bus!;
  bus.atStop = null;
  const line = w.doc.busLines[bus.lineId];
  const stop = line?.stopIds[bus.stopIdx];
  if (!line || stop === undefined || stopNode(w, stop) < 0) return dwellSeconds(0, 0);
  bus.atStop = stop;
  const keep: { slot: number; alight: string }[] = [];
  let alight = 0;
  for (const r of bus.riders) {
    if (r.alight === stop || !line.stopIds.includes(r.alight) || stopNode(w, r.alight) < 0) {
      bus.alighting.push(r.slot);
      alight++;
    } else keep.push(r);
  }
  bus.riders = keep;
  const room = Math.max(0, capacityOf(w.types.get(v.typeId)) - keep.length);
  const n = Math.min(queueOf(w, stop, line.id)?.length ?? 0, room, MAX_BOARD);
  for (const wt of takeFront(w, stop, line.id, n)) {
    const c = w.cz.slots[wt.slot]!;
    if (c.ped >= 0) removePed(w, c.ped);
    c.ped = -1;
    c.ride = v;
    c.leg = Leg.ride;
    // Boarding voids the patience event.
    c.seq++;
    setState(w, c, CitState.riding);
    bus.riders.push({ slot: c.slot, alight: c.alight! });
  }
  return dwellSeconds(alight, n);
}

/** End of the dwell: alighting passengers step onto the sidewalk at the stop and walk to their destination. */
export function busDepart(w: World, v: Vehicle): void {
  const bus = v.bus!;
  const list = bus.alighting;
  bus.alighting = [];
  const node = stopNode(w, bus.atStop);
  bus.atStop = null;
  for (const slot of list) {
    const c = w.cz.slots[slot];
    if (!c || c.ride !== v) continue;
    c.ride = null;
    c.line = null;
    c.board = null;
    c.alight = null;
    if (node < 0) {
      failTrip(w, c);
      continue;
    }
    c.ped = spawnPed(w, node, c.id, c.slot, c.vPref, c.style, 0);
    setState(w, c, CitState.walking);
    walkToDoor(w, c);
  }
}

/**
 * After an edit (derived refresh): waiters of a queue whose stop left its line, or whose line is gone, walk;
 * riders of a line without any served stop left end their trip (counted).
 */
export function syncTransit(w: World): void {
  for (const q of sortedQueues(w)) {
    if (queueValid(w, q.stop, q.line)) continue;
    for (const wt of q.list.slice()) {
      const c = w.cz.slots[wt.slot];
      if (c) leaveStop(w, c);
    }
  }
  for (const v of w.vehicles) {
    if (!v.alive || !v.bus || v.bus.riders.length === 0) continue;
    const line = w.doc.busLines[v.bus.lineId];
    if (line && line.stopIds.some((s) => stopNode(w, s) >= 0)) continue;
    for (const r of v.bus.riders.slice()) {
      const c = w.cz.slots[r.slot];
      if (c && c.ride === v) failTrip(w, c);
    }
  }
}

/** Mode-choice bias of a citizen for mode m (0 walk, 1 bus, 2 car): a fixed hash in [0.85, 1.15). */
const modeBias = (c: Citizen, m: number): number => 0.85 + 0.3 * hash01(c.id, m, 0x6d6f6465);

// ---------- per tick ----------

/** Due events (before vehicles and pedestrians move). */
export function processCitizenEvents(w: World): void {
  const cz = w.cz;
  while (cz.heap.length > 0 && cz.heap[0]!.due <= w.tick) {
    const e = heapPop(cz.heap);
    const c = cz.byId.get(e.pid);
    if (!c || c.seq !== e.seq) continue;
    act(w, c);
  }
}

/** Consequences of this tick's movement: arrivals, failed routes, cars that arrived or vanished. */
export function updateCitizens(w: World): void {
  const cz = w.cz;
  const p = w.peds;
  for (const i of w.ped.failed) {
    const c = cz.slots[p.owner[i]!];
    if (c && c.ped === i) {
      // No walking route to the destination: a direct bus may still connect the two doors (Sol 3b review
      // #8). Without a bus candidate this is exactly the old rule (counted failure).
      if (c.leg === Leg.plan && busInstead(w, c, i)) continue;
      failTrip(w, c);
    } else removePed(w, i);
  }
  for (const i of w.ped.arrived) {
    const c = cz.slots[p.owner[i]!];
    if (!c || c.ped !== i) {
      removePed(w, i);
      continue;
    }
    if (c.leg === Leg.toCar) {
      const r = tryCar(w, c);
      if (r === 'walk') walkToDoor(w, c);
      else if (r === 'wait') c.carWait = 1;
    } else if (c.leg === Leg.toStop) joinStop(w, c);
    else arrive(w, c);
  }
  for (const d of w.arrivedDrivers) {
    const c = cz.slots[d.person];
    if (!c || !c.car) continue;
    c.car = null;
    const ad = access(w, c.dest);
    const lane = w.graph.lanes[d.lane];
    if (!ad || !lane) {
      failTrip(w, c);
      continue;
    }
    // Get out on the curb of the side the car stopped on.
    const side = lane.segmentId === ad.segId ? (lane.dir === 'forward' ? 1 : -1) : ad.side;
    const twoWay = (w.graph.segments.get(ad.segId)?.roadType.lanesBackward ?? 0) > 0;
    let stop = !twoWay ? ad.attach : side === 1 ? ad.stopR : ad.stopL;
    if (stop < 0) stop = ad.attach;
    c.ped = spawnPed(w, stop, c.id, c.slot, c.vPref, c.style, 0);
    c.leg = Leg.fromCar;
    setState(w, c, CitState.walking);
    requestRoute(w, c.ped, ad.door);
  }
  for (const s of w.lostDrivers) {
    const c = cz.slots[s];
    if (c && c.car) {
      c.car = null;
      failTrip(w, c);
    }
  }
  // Mode choice once the walking route is known; curb waits for a car; outdoor states from the pedestrian.
  for (const c of cz.slots) {
    if (!c) continue;
    // The bus this citizen rode vanished (removed, recompiled, line changed or deleted): counted failure.
    if (c.ride && !c.ride.alive) {
      failTrip(w, c);
      continue;
    }
    if (c.ped < 0) continue;
    const i = c.ped;
    if (c.leg === Leg.plan && !p.pending[i]) {
      const route = p.route[i]!;
      let length = 0;
      for (let k = p.ri[i]! + 1; k < route.length; k++) length += w.ped.pg.len[route[k]! >> 1]!;
      const ao = access(w, c.from);
      const ad = access(w, c.dest);
      const bus = ao && ad ? busOption(w, ao.door, ad.door) : null;
      const car = c.hasCar && length > WALK_MAX && ao !== null;
      // No direct bus candidate: exactly the Phase 2b rule. Otherwise the cheapest biased estimate wins
      // (ties walk < bus < car); the car stays limited to the trips that rule would drive.
      let mode = car ? 2 : 0;
      if (bus) {
        const tWalk = (length / ROUTE_SPEED) * modeBias(c, 0);
        const tBus = bus.time * modeBias(c, 1);
        const tCar = car ? (length / EST_SPEED + CAR_WAIT / 2) * modeBias(c, 2) : Infinity;
        mode = tWalk <= tBus && tWalk <= tCar ? 0 : tBus <= tCar ? 1 : 2;
      }
      if (mode === 2) {
        c.leg = Leg.toCar;
        p.doorOnArrive[i] = 0;
        setRoute(w, i, Int32Array.of(ao!.accessEdge * 2));
      } else if (mode === 1) {
        c.leg = Leg.toStop;
        c.line = bus!.line;
        c.board = bus!.board;
        c.alight = bus!.alight;
        p.doorOnArrive[i] = 0;
        requestRoute(w, i, stopNode(w, bus!.board));
      } else c.leg = Leg.walk;
    } else if (c.leg === Leg.toCar && c.carWait > 0) {
      // Standing at the curb until there is room to start the car; walking after CAR_WAIT.
      const r = tryCar(w, c);
      if (r === 'ok') continue;
      if (r === 'walk' || ++c.carWait > CAR_WAIT * w.tickRate) {
        c.carWait = 0;
        walkToDoor(w, c);
      }
    }
    if (c.ped < 0 || c.leg === Leg.wait) continue;
    const st = p.arriving[c.ped] ? CitState.entering : p.timer[c.ped]! > 0 ? CitState.leaving : CitState.walking;
    if (c.state !== st) setState(w, c, st);
  }
}

/** Switch a citizen whose walking route failed to a direct bus, if one connects the doors. */
function busInstead(w: World, c: Citizen, i: number): boolean {
  const ao = access(w, c.from);
  const ad = access(w, c.dest);
  const bus = ao && ad ? busOption(w, ao.door, ad.door) : null;
  if (!bus) return false;
  c.leg = Leg.toStop;
  c.line = bus.line;
  c.board = bus.board;
  c.alight = bus.alight;
  w.peds.doorOnArrive[i] = 0;
  requestRoute(w, i, stopNode(w, bus.board));
  return true;
}

/**
 * After the pedestrian graph was rebuilt: pedestrians that could not be re-projected go home (counted),
 * the others get a new route to their goal on the new graph.
 */
export function retargetCitizens(w: World, lost: Set<number>): void {
  const cz = w.cz;
  for (const c of cz.slots) {
    if (!c || c.ped < 0) continue;
    if (lost.has(c.ped)) {
      cz.failedTrips++;
      removePed(w, c.ped);
      c.ped = -1;
      c.dest = c.home;
      c.purpose = Purpose.home;
      arrive(w, c);
      continue;
    }
    if (c.dest !== null && !w.doc.buildings[c.dest]) {
      c.dest = c.home;
      c.purpose = Purpose.home;
    }
    // Waiting at a stop that is still served (and within reach): stay in the queue at its new node.
    if (c.leg === Leg.wait) {
      const node = stopNode(w, c.board);
      const p = w.peds;
      if (node >= 0 && Math.hypot(w.ped.pg.x[node]! - w.ped.pg.x[p.node[c.ped]!]!, w.ped.pg.z[node]! - w.ped.pg.z[p.node[c.ped]!]!) <= 20 && p.edge[c.ped]! < 0) {
        p.node[c.ped] = node;
        p.state[c.ped] = PedState.busStop;
        continue;
      }
      if (c.board !== null && c.line !== null && dequeue(w, c.board, c.line, c.slot)) c.seq++;
      setState(w, c, CitState.walking);
      p.state[c.ped] = PedState.waiting;
      c.leg = Leg.walk;
      const door = access(w, c.dest)?.door ?? -1;
      if (door < 0) {
        failTrip(w, c);
        continue;
      }
      p.goal[c.ped] = door;
    }
    if (c.leg === Leg.toStop) {
      const node = stopNode(w, c.board);
      if (node >= 0) {
        w.peds.doorOnArrive[c.ped] = 0;
        requestRoute(w, c.ped, node);
        continue;
      }
      c.leg = Leg.walk;
    }
    if (c.leg === Leg.walk && c.board !== null) {
      c.line = null;
      c.board = null;
      c.alight = null;
    }
    // Same goal as the re-projection used (citizenGoal): the curb for a car leg, else the door.
    if (c.leg === Leg.toCar && access(w, c.from)) {
      c.carWait = 0;
      w.peds.doorOnArrive[c.ped] = 0;
    } else {
      if (c.leg === Leg.toCar) c.leg = Leg.walk;
      w.peds.doorOnArrive[c.ped] = 1;
    }
    requestRoute(w, c.ped, w.peds.goal[c.ped]!);
  }
}

/** Building id → index of the current pedestrian graph (before re-projection asks for goals). */
export function refreshBuildingIndex(w: World): void {
  w.cz.bIndex = new Map(w.ped.pg.buildingIds.map((id, i) => [id, i]));
}

/** Node the pedestrian of citizen `slot` heads for on the current graph: curb for a car leg, else the door (−1 = none). */
export function citizenGoal(w: World, slot: number): number {
  const c = w.cz.slots[slot];
  if (!c || c.ped < 0) return -1;
  if (c.leg === Leg.toCar) {
    const ao = access(w, c.from);
    if (ao) return ao.attach;
  }
  if (c.leg === Leg.toStop || c.leg === Leg.wait) {
    const node = stopNode(w, c.board);
    if (node >= 0) return node;
  }
  const dest = c.dest !== null && w.doc.buildings[c.dest] ? c.dest : c.home;
  return access(w, dest)?.door ?? -1;
}

export function citizenStats(w: World): CitizenStats {
  const k = w.cz.counts;
  return {
    total: w.cz.count,
    scale: w.cz.scale,
    home: k[CitState.home]! + k[CitState.displaced]!,
    // Shops count as "at an activity" with work (HUD: 직장·상점).
    atWork: k[CitState.atWork]! + k[CitState.atShop]!,
    walking: k[CitState.leaving]! + k[CitState.walking]! + k[CitState.entering]!,
    driving: k[CitState.driving]!,
    waitingBus: k[CitState.waiting]!,
    riding: k[CitState.riding]!,
  };
}

/** Agents inside each building, in `ids` order. */
export function fillOccupancy(w: World, ids: string[], out: Float32Array): void {
  out.fill(0, 0, ids.length);
  const index = ids === w.ped.pg.buildingIds ? w.cz.bIndex : new Map(ids.map((id, i) => [id, i]));
  for (const c of w.cz.slots) {
    if (!c || c.at === null) continue;
    const i = index.get(c.at);
    if (i !== undefined) out[i]!++;
  }
}
