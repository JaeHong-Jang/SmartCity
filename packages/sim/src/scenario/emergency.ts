// Fires and medical calls (ADR 0010 §3, §8). An incident starts with its input and dispatches one emergency
// vehicle from the facility of the matching service (fire station / hospital) with the shortest free-flow
// route to the building's access point (ties: building id). The vehicle drives under the ordinary IDM and
// junction rules, parks off the network at the scene while it works, then drives back (fire truck) or takes
// the patient to its hospital (ambulance). Nothing here touches the demand or citizen RNG streams, and
// emergency vehicles ignore the vehicle cap (placement still needs free road space). No facility, no route
// or no emergency vehicle type → `dispatch.failed`; the incident itself still runs (a fire burns to 100 %).

import type { FacilityService } from '@smartcity/shared';
import { laneSAtT, originLane, type Access } from '../traffic/demand.js';
import { createVehicle, resolveGoal, routeVehicle } from '../traffic/ops.js';
import { canPlace, despawn, type Goal, type Vehicle, type World } from '../traffic/world.js';
import { logOutcome, type Incident, type Mission } from './state.js';
import { CLOCK_SCALE } from '../types.js';
import { detectionMissed, trackFire } from './detection.js';
import { detectionOf, type ScenarioInput } from './types.js';

/** Defaults in ticks (20 Hz): fire 0 → 100 % in 20 game min, suppression 5 game min, treatment 3 game min. */
export const FIRE_BURN_TICKS = 2400;
export const FIRE_SUPPRESS_TICKS = 600;
export const MEDICAL_TREAT_TICKS = 360;
/** Preferred vehicle type per incident kind; else the first `emergency` type by id. */
export const FIRE_TRUCK_TYPE = 'fire-truck';
export const AMBULANCE_TYPE = 'ambulance';
/** An incident without a vehicle on the way tries to dispatch again this often (5 game min). */
export const DISPATCH_RETRY_TICKS = 600;
/** Emergency placements (route searches) per tick at most. */
const SPAWN_BUDGET = 8;
const SPAWN_MARGIN = 2.5;

const SERVICE: Record<Incident['kind'], FacilityService> = { fire: 'fireStation', medical: 'hospital' };

/** Fire progress 0..100 at tick t (it keeps burning during suppression). */
export const fireProgress = (inc: Incident, t: number): number => Math.min(100, ((t - inc.startTick) * 100) / inc.burnTicks);

const accessGoal = (a: Access): Goal => ({ segId: a.segId, dir: a.dir, anyDir: true, laneIndex: -1, mode: 't', t: a.t });

/** Entry point on the network for an access: rightmost lane of that direction, at the access fraction. */
function placement(w: World, a: Access, len: number): { lane: number; s: number } | null {
  const lane = originLane(w.net, a.segId, a.dir);
  if (lane < 0) return null;
  const L = w.net.len[lane]!;
  if (L < len + 3) return null;
  return { lane, s: Math.max(len + 3, Math.min(L, laneSAtT(w.net, lane, a.t))) };
}

function emergencyType(w: World, kind: Incident['kind']): string | null {
  const want = kind === 'fire' ? FIRE_TRUCK_TYPE : AMBULANCE_TYPE;
  if (w.types.get(want)?.kind === 'emergency') return want;
  for (const id of w.typeIds) if (w.types.get(id)!.kind === 'emergency') return id;
  return null;
}

function log(w: World, inc: Incident, kind: string, note?: string): void {
  logOutcome(w.sc!, { eventId: inc.eventId, tick: w.tick, kind, applied: true, ...(note !== undefined ? { note } : {}) });
}

/** No vehicle could be sent: logged and counted once per incident; the incident retries every DISPATCH_RETRY_TICKS. */
function dispatchFailed(w: World, inc: Incident, reason: string): void {
  inc.mission = null;
  inc.retryAt = w.tick + DISPATCH_RETRY_TICKS;
  if (inc.failed) return;
  inc.failed = true;
  w.sc!.dispatchFailed++;
  log(w, inc, 'dispatch.failed', `출동 불가: ${reason}`);
}

function removeMission(w: World, m: Mission): void {
  const k = w.sc!.missions.indexOf(m);
  if (k >= 0) w.sc!.missions.splice(k, 1);
}

function removeIncident(w: World, inc: Incident): void {
  const k = w.sc!.incidents.indexOf(inc);
  if (k >= 0) w.sc!.incidents.splice(k, 1);
}

const isFacility = (w: World, id: string, service: FacilityService): boolean => {
  const b = w.doc.buildings[id];
  return b !== undefined && w.doc.buildingTypes[b.typeId]?.service === service;
};

const facilitiesOf = (w: World, service: FacilityService): string[] =>
  Object.keys(w.doc.buildings)
    .sort()
    .filter((id) => isFacility(w, id, service));

/**
 * Where the mission's vehicle goes back to from (lane, s): its facility while that still exists, else the
 * remaining facility of the same service with the shortest free-flow route (ties: id), which becomes its
 * facility. Null when there is none (or no route to any).
 */
function homeFor(w: World, m: Mission, lane: number, s: number): Access | null {
  const service = SERVICE[m.incident.kind];
  const own = isFacility(w, m.facilityId, service) ? w.demand.access.get(m.facilityId) : undefined;
  if (own) return own;
  let best: { id: string; acc: Access; cost: number } | null = null;
  for (const id of facilitiesOf(w, service)) {
    const acc = w.demand.access.get(id);
    if (!acc) continue;
    const res = w.router.find(lane, s, resolveGoal(w, accessGoal(acc), false), false, w.sc!.zero);
    if (res && (best === null || res.cost < best.cost)) best = { id, acc, cost: res.cost };
  }
  if (best === null) return null;
  m.facilityId = best.id;
  return best.acc;
}

/** Take a vehicle off the network for good (no way left to go): `dispatch.lost`. */
/**
 * A mission is over for good before it finished (no facility or route left, vehicle removed by an edit). Its
 * incident is resolved so that none is ever left without a way forward: a patient in transport is lost
 * (`medical.end`, reason `patient transport lost`, not counted as completed); a call whose vehicle was
 * lost on the way is dispatched again at once (no vehicle → the retry rule; a fire keeps burning meanwhile).
 */
function lose(w: World, m: Mission, reason: string): void {
  if (m.v !== null && m.v.alive) {
    despawn(w, m.v);
    w.removed++;
  }
  m.v = null;
  removeMission(w, m);
  const inc = m.incident;
  log(w, inc, 'dispatch.lost', reason);
  if (inc.mission !== m) return;
  inc.mission = null;
  if (m.stage === 'transport') {
    removeIncident(w, inc);
    log(w, inc, 'medical.end', 'patient transport lost');
  } else if (m.stage === 'enroute') inc.retryAt = w.tick;
}

/** Send a vehicle on the network home from where it is (`returning`, or `transport` with a patient aboard). */
function redirectHome(w: World, m: Mission): void {
  const v = m.v!;
  const home = homeFor(w, m, v.edge, v.s);
  if (!home) return lose(w, m, m.stage === 'transport' ? '이송할 병원 없음' : '귀소할 시설 없음');
  const goal = v.goal;
  v.goal = accessGoal(home);
  if (!routeVehicle(w, v, w.sc!.zero)) {
    v.goal = goal;
    lose(w, m, m.stage === 'transport' ? '이송 경로 없음' : '귀소 경로 없음');
  }
}

/** Choose the facility and queue the vehicle's departure (placed by processEmergency, this tick if there is room). */
function dispatch(w: World, inc: Incident): void {
  const sc = w.sc!;
  const typeId = emergencyType(w, inc.kind);
  if (typeId === null) return dispatchFailed(w, inc, '긴급 차종 없음');
  const len = w.types.get(typeId)!.length;
  const facilities = facilitiesOf(w, SERVICE[inc.kind]);
  if (facilities.length === 0) return dispatchFailed(w, inc, '시설 없음');
  const scene = w.demand.access.get(inc.buildingId);
  if (!scene) return dispatchFailed(w, inc, '경로 없음');
  const goals = resolveGoal(w, accessGoal(scene), false);
  let best: { id: string; from: Access; cost: number } | null = null;
  for (const id of facilities) {
    const from = w.demand.access.get(id);
    const at = from ? placement(w, from, len) : null;
    if (!from || !at || (sc.ban !== null && sc.ban[at.lane])) continue;
    // Free-flow travel time (the same costs as scenario re-routes); ids ascend, so ties keep the smaller id.
    const res = w.router.find(at.lane, at.s, goals, false, sc.zero);
    if (res && (best === null || res.cost < best.cost)) best = { id, from, cost: res.cost };
  }
  if (best === null) return dispatchFailed(w, inc, '경로 없음');
  const m: Mission = { incident: inc, facilityId: best.id, scene, typeId, stage: 'enroute', v: null, spawn: { from: best.from, goal: accessGoal(scene) }, departTick: -1 };
  inc.mission = m;
  inc.retryAt = -1;
  sc.missions.push(m);
}

export function startIncident(w: World, input: ScenarioInput): void {
  const fire = input.kind === 'fire.start';
  const p = input.params;
  const inc: Incident = {
    kind: fire ? 'fire' : 'medical',
    eventId: input.eventId,
    buildingId: input.target.buildingId!,
    startTick: w.tick,
    burnTicks: fire ? (p.burnTicks ?? FIRE_BURN_TICKS) : 0,
    workTicks: fire ? (p.suppressTicks ?? FIRE_SUPPRESS_TICKS) : (p.treatTicks ?? MEDICAL_TREAT_TICKS),
    state: fire ? 'burning' : 'waiting',
    workEnd: -1,
    mission: null,
    retryAt: -1,
    failed: false,
    knownTick: w.tick,
    arriveTick: -1,
  };
  w.sc!.incidents.push(inc);
  // ADR 0013: a fire under reports / sensors waits for detection (no dispatch, no retry until then).
  if (fire && detectionOf(w.sc!.policy) !== 'legacy') {
    inc.knownTick = -1;
    trackFire(w, inc);
    return;
  }
  dispatch(w, inc);
}

/** The city learned of a tracked fire (scenario/detection.ts): dispatch now. */
export function incidentKnown(w: World, inc: Incident): void {
  inc.knownTick = w.tick;
  dispatch(w, inc);
}

/** Leave the scene (or turn back): queue the trip from the scene to the facility; `transport` carries the patient. */
function leaveScene(w: World, m: Mission, stage: 'transport' | 'returning'): void {
  m.stage = stage;
  const type = w.types.get(m.typeId);
  const at = type ? placement(w, m.scene, type.length) : null;
  const home = at ? homeFor(w, m, at.lane, at.s) : null;
  if (!home) {
    const none = facilitiesOf(w, SERVICE[m.incident.kind]).length === 0;
    return lose(w, m, stage === 'transport' ? (none ? '이송할 병원 없음' : '이송 경로 없음') : none ? '귀소할 시설 없음' : '귀소 경로 없음');
  }
  m.spawn = { from: m.scene, goal: accessGoal(home) };
}

/** The incident is over (extinguished, damaged, ended): its vehicle goes home. */
function recall(w: World, inc: Incident): void {
  const m = inc.mission;
  inc.mission = null;
  if (m === null) return;
  if (m.stage === 'working') return leaveScene(w, m, 'returning');
  if (m.stage === 'transport') {
    m.stage = 'returning';
    return;
  }
  if (m.stage !== 'enroute') return;
  if (m.v === null) {
    removeMission(w, m);
    log(w, inc, 'dispatch.cancel', 'incident over');
    return;
  }
  // Turn back from the current position; if no route home exists it drives on to the scene and returns from there.
  const home = homeFor(w, m, m.v.edge, m.v.s);
  if (!home) return;
  const goal = m.v.goal;
  m.v.goal = accessGoal(home);
  if (routeVehicle(w, m.v, w.sc!.zero)) m.stage = 'returning';
  else m.v.goal = goal;
}

/** `fire.end` / `medical.end`: the earliest-started active incident of that kind (by eventId, else on the building). */
export function endIncident(w: World, input: ScenarioInput): string | null {
  const kind = input.kind === 'fire.end' ? 'fire' : 'medical';
  const t = input.target;
  const inc = w.sc!.incidents.find((x) => x.kind === kind && (t.eventId !== undefined ? x.eventId === t.eventId : x.buildingId === t.buildingId));
  if (!inc) return t.eventId !== undefined ? `event ${t.eventId} not active (unknown, not started yet or already ended)` : 'no active event on target';
  removeIncident(w, inc);
  log(w, inc, `${kind}.end`, `by ${input.eventId}`);
  detectionMissed(w, inc.eventId, 'ended before detection');
  recall(w, inc);
  return null;
}

function finishFire(w: World, inc: Incident, damaged: boolean): void {
  const sc = w.sc!;
  removeIncident(w, inc);
  workDone(w, inc);
  if (damaged) {
    let k = 0;
    while (k < sc.damaged.length && sc.damaged[k]! < inc.buildingId) k++;
    if (sc.damaged[k] !== inc.buildingId) sc.damaged.splice(k, 0, inc.buildingId);
    log(w, inc, 'fire.damaged');
    detectionMissed(w, inc.eventId, 'burned before detection', true);
  } else {
    sc.extinguished++;
    log(w, inc, 'fire.extinguished', `${fireProgress(inc, w.tick).toFixed(1)}%`);
  }
  recall(w, inc);
}

/**
 * After every edit or recompile (Simulation.refreshDerived). An incident whose building is gone ends
 * (`fire.end` / `medical.end`, reason `target gone`; no arrival, damage or extinguish is counted for it): a
 * vehicle not out yet is cancelled, one on its way or at the scene is cancelled and returns
 * (`dispatch.cancel`). A patient already aboard is still taken to the hospital. A deleted facility: a
 * vehicle waiting to leave it is cancelled and the incident dispatched again from the remaining facilities;
 * vehicles heading back to it (or carrying a patient to it) are redirected to the closest remaining one of
 * the same service; one still on its way to the scene picks its new facility when it leaves the scene. No
 * facility left → `dispatch.lost` (the vehicle leaves the network).
 */
export function recheckIncidents(w: World): void {
  const sc = w.sc!;
  for (const inc of sc.incidents.slice()) {
    if (inc.state === 'transport' || w.doc.buildings[inc.buildingId]) continue;
    removeIncident(w, inc);
    log(w, inc, `${inc.kind}.end`, 'target gone');
    detectionMissed(w, inc.eventId, 'target gone');
    const m = inc.mission;
    inc.mission = null;
    if (m === null) continue;
    log(w, inc, 'dispatch.cancel', 'target gone');
    if (m.stage === 'working') leaveScene(w, m, 'returning');
    else if (m.v === null) removeMission(w, m);
    else {
      m.stage = 'returning';
      redirectHome(w, m);
    }
  }
  for (const m of sc.missions.slice()) {
    if (isFacility(w, m.facilityId, SERVICE[m.incident.kind])) continue;
    if (m.stage === 'enroute' && m.v === null) {
      removeMission(w, m);
      log(w, m.incident, 'dispatch.cancel', 'facility gone');
      if (m.incident.mission === m) {
        m.incident.mission = null;
        dispatch(w, m.incident);
      }
    } else if (m.v !== null && m.v.alive && m.stage !== 'enroute') redirectHome(w, m);
    else if (m.spawn !== null && m.stage !== 'enroute') {
      const type = w.types.get(m.typeId);
      const at = type ? placement(w, m.scene, type.length) : null;
      const home = at ? homeFor(w, m, at.lane, at.s) : null;
      if (home) m.spawn.goal = accessGoal(home);
      else lose(w, m, m.stage === 'transport' ? '이송할 병원 없음' : '귀소할 시설 없음');
    }
  }
}

export const gameMinutes = (w: World, ticks: number): number => (ticks / w.tickRate) * (CLOCK_SCALE / 60);

/** Per tick (after surges): incident clocks, vehicles lost to edits, then queued departures in mission order. */
export function processEmergency(w: World): void {
  const sc = w.sc!;
  const t = w.tick;
  for (const inc of sc.incidents.slice()) {
    if (inc.kind === 'fire') {
      // Reaching 100 % wins a tie with the end of suppression.
      if (t >= inc.startTick + inc.burnTicks) finishFire(w, inc, true);
      else if (inc.state === 'suppressing' && t >= inc.workEnd) finishFire(w, inc, false);
    } else if (inc.state === 'treating' && t >= inc.workEnd) {
      workDone(w, inc);
      inc.state = 'transport';
      leaveScene(w, inc.mission!, 'transport');
    }
    // No vehicle on the way (state burning / waiting): try again (failures stay silent after the first).
    if (inc.mission === null && inc.retryAt >= 0 && t >= inc.retryAt && sc.incidents.includes(inc)) dispatch(w, inc);
  }
  let budget = SPAWN_BUDGET;
  for (const m of sc.missions.slice()) {
    if (m.v !== null) {
      if (m.v.alive) continue;
      // Removed by an edit (recompile, type change) before it arrived.
      lose(w, m, '차량 소멸');
      continue;
    }
    if (m.spawn === null || budget <= 0) continue;
    const type = w.types.get(m.typeId);
    const at = type ? placement(w, m.spawn.from, type.length) : null;
    // No room yet (or the entry lane is closed): wait.
    if (type && at && ((sc.ban !== null && sc.ban[at.lane]) || !canPlace(w, at.lane, at.s, type.length, SPAWN_MARGIN))) continue;
    budget--;
    const v = type && at ? createVehicle(w, m.typeId, at.lane, at.s, m.spawn.goal, null) : null;
    if (v === null) {
      if (m.stage === 'enroute') {
        removeMission(w, m);
        if (m.incident.mission === m) dispatchFailed(w, m.incident, type ? '경로 없음' : '긴급 차종 없음');
      } else lose(w, m, m.stage === 'transport' ? '이송 경로 없음' : '귀소 경로 없음');
      continue;
    }
    v.em = m;
    m.v = v;
    m.spawn = null;
    if (m.stage === 'enroute') {
      m.departTick = w.tick;
      log(w, m.incident, 'dispatch.start', `vehicle ${v.id} from ${m.facilityId}`);
    }
  }
}

/**
 * Before the due detections (ADR 0013 §3, same tie rule as accident expiry): a fire the city does not know of
 * that reaches 100 % this tick burns down first — missed (`burned before detection`, counted as damage), so a
 * report or sensor due at the same tick never dispatches to a building that is already gone.
 */
export function burnOutUnknown(w: World): void {
  for (const inc of w.sc!.incidents.slice()) if (inc.kind === 'fire' && inc.knownTick < 0 && w.tick >= inc.startTick + inc.burnTicks) finishFire(w, inc, true);
}

/** On-scene work of an incident ended (extinguished, burned down during suppression, treated): response breakdown. */
function workDone(w: World, inc: Incident): void {
  if (inc.arriveTick < 0) return;
  const det = w.sc!.det;
  det.workDone++;
  det.workTicks += w.tick - inc.arriveTick;
}

/** finalize(): an emergency vehicle reached its destination (it leaves the network like any arrival). */
export function emergencyArrived(w: World, v: Vehicle): void {
  const sc = w.sc!;
  const m = v.em!;
  const inc = m.incident;
  m.v = null;
  // Its incident ended while no route home existed: it drove on to the scene and turns back here.
  if (m.stage === 'enroute' && inc.mission !== m) return leaveScene(w, m, 'returning');
  if (m.stage === 'enroute') {
    const ticks = w.tick + 1 - inc.startTick;
    sc.responses++;
    sc.responseTicks += ticks;
    sc.maxResponseTicks = Math.max(sc.maxResponseTicks, ticks);
    // Response stages (ADR 0013 §5): detection + waiting to dispatch + travel = ticks.
    const det = sc.det;
    inc.arriveTick = w.tick + 1;
    det.arrivals++;
    det.detectTicks += inc.knownTick - inc.startTick;
    det.waitTicks += m.departTick - inc.knownTick;
    det.travelTicks += w.tick + 1 - m.departTick;
    log(w, inc, 'dispatch.arrive', `${gameMinutes(w, ticks).toFixed(1)}분`);
    m.stage = 'working';
    inc.state = inc.kind === 'fire' ? 'suppressing' : 'treating';
    inc.workEnd = w.tick + 1 + inc.workTicks;
    return;
  }
  removeMission(w, m);
  if (m.stage === 'transport') {
    sc.medicalCompleted++;
    inc.mission = null;
    removeIncident(w, inc);
    log(w, inc, 'medical.complete');
  } else log(w, inc, 'dispatch.return');
}

