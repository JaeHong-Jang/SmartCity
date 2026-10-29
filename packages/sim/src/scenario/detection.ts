// Detection (ADR 0013 §1–§3): when the city learns of an accident or fire. Under `policy.detection` =
// `reports` / `sensors` an event is "tracked" from its start: its candidate detection ticks — the citizen
// report, and (sensors mode) one per covering sensor able to notice that kind and not missing it — are fixed
// at the start from string-key hashes of (seed, event, sensor), so no RNG stream is consumed and adding a
// sensor never changes another candidate. At each tick (after the due inputs, before power) the due
// candidates are taken in (tick, sensors before the report, sensor id) order: a sensor whose mount point is
// in a blackout at that tick is void (the report stays), the first valid one makes the event known — once.
// Known accident → router cost + re-route notices; known fire → dispatch. An event over before that is
// `missed`. `legacy` (omitted) never gets here: events are known at their start, exactly as before.

import { hash01 } from '@smartcity/shared';
import type { DemandModel } from '../traffic/demand.js';
import type { World } from '../traffic/world.js';
import { CLOCK_SCALE, type RoadGraph } from '../types.js';
import { COVERAGE_RADIUS } from './blackout.js';
import { compileSensorCoverage, SENSOR_DETECTS } from './coverage.js';
import { burnOutUnknown, gameMinutes, incidentKnown } from './emergency.js';
import { enqueueAffected } from './reroute.js';
import { compose, logOutcome, type Incident } from './state.js';
import { detectionOf, type DetectionKpi, type ResponseBreakdown, type ScenarioView } from './types.js';
import type { SensorKind } from '@smartcity/shared';

/**
 * Detection model, game seconds (model values, NOT calibrated — research 14 §4.3): a delay of base + u·spread
 * with u = hash01 of the purpose key, and a per-sensor miss chance. Report delays do not depend on traffic,
 * so both runs of a comparison draw the same report tick.
 */
export const REPORT_DELAY: Record<'accident' | 'fire', { base: number; spread: number }> = {
  accident: { base: 60, spread: 240 },
  fire: { base: 120, spread: 480 },
};
export const SENSOR_MODEL: Record<SensorKind, { base: number; spread: number; miss: number }> = {
  cctv: { base: 10, spread: 50, miss: 0.15 },
  radar: { base: 30, spread: 90, miss: 0.1 },
  smartpole: { base: 10, spread: 30, miss: 0.1 },
};
/** hash01 epoch of every detection key (`report|e`, `detect|e|sensor`, `miss|e|sensor`). */
const DETECT_EPOCH = 0x0d37;
/** Accident position tolerance against a coverage interval, m (closed intervals). */
const EPS = 1e-6;

interface Candidate {
  tick: number;
  /** null = the citizen report. */
  sensorId: string | null;
  x: number;
  z: number;
}

export interface PendingDetection {
  eventId: string;
  kind: 'accident' | 'fire';
  startTick: number;
  /** Not yet due or void, sorted (tick, sensors before the report, sensor id). The report is always last of its tick. */
  cand: Candidate[];
  /** Accidents: the lane (stable id) for exposure counting. */
  laneId: string | null;
  /** Vehicles seen on the accident lane while it was not known. */
  exposed: Set<number>;
}

interface SensorHit {
  sensorId: string;
  kind: SensorKind;
  x: number;
  z: number;
}

interface CoverageIndex {
  graph: RoadGraph;
  demand: DemandModel;
  sig: string;
  byLane: Map<string, (SensorHit & { sFrom: number; sTo: number })[]>;
  byBuilding: Map<string, SensorHit[]>;
}

export interface DetectionState {
  /** Sensor coverage of the current graph, buildings and sensors (built at the first sensors-mode event). */
  cov: CoverageIndex | null;
  pending: PendingDetection[];
  tracked: number;
  covered: number;
  detected: number;
  bySensor: number;
  delayTicks: number;
  maxDelayTicks: number;
  missed: number;
  missedDamaged: number;
  exposed: number;
  /** On-site recoveries (scenario/onsite.ts): side steps to the neighbour lane, re-routes before entering the lane. */
  onSiteMoves: number;
  onSiteReroutes: number;
  /** Connectors into each lane of the current graph (on-site observation), built on first use. */
  into: { graph: RoadGraph; list: number[][] } | null;
  // Response stages of arrivals (all modes), ticks.
  arrivals: number;
  detectTicks: number;
  waitTicks: number;
  travelTicks: number;
  workDone: number;
  workTicks: number;
}

/** Ticks of `seconds` game seconds, rounded up (1 sim second = CLOCK_SCALE game seconds), at least 1. */
export const detectionTicks = (w: World, seconds: number): number => Math.max(1, Math.ceil((seconds / CLOCK_SCALE) * w.tickRate - 1e-9));

const draw = (w: World, key: string): number => hash01(w.doc.meta.seed, DETECT_EPOCH, key);

function sensorSig(w: World): string {
  const sensors = w.doc.sensors ?? {};
  let sig = '';
  for (const id of Object.keys(sensors).sort()) {
    const s = sensors[id]!;
    sig += `${id}:${s.kind}:${s.segmentId}:${s.t}:${s.side}:${s.heading}:${s.fov}:${s.range};`;
  }
  return sig;
}

function coverage(w: World): CoverageIndex {
  const det = w.sc!.det;
  const sig = sensorSig(w);
  if (det.cov !== null && det.cov.graph === w.graph && det.cov.demand === w.demand && det.cov.sig === sig) return det.cov;
  const byLane: CoverageIndex['byLane'] = new Map();
  const byBuilding: CoverageIndex['byBuilding'] = new Map();
  for (const c of compileSensorCoverage(w.doc, w.graph)) {
    const hit = { sensorId: c.sensorId, kind: c.kind, x: c.x, z: c.z };
    for (const iv of c.lanes) {
      let list = byLane.get(iv.laneId);
      if (!list) byLane.set(iv.laneId, (list = []));
      list.push({ ...hit, sFrom: iv.sFrom, sTo: iv.sTo });
    }
    for (const b of c.buildings) {
      let list = byBuilding.get(b);
      if (!list) byBuilding.set(b, (list = []));
      list.push(hit);
    }
  }
  det.cov = { graph: w.graph, demand: w.demand, sig, byLane, byBuilding };
  return det.cov;
}

/** Sensors (id order, each once) covering an accident at lane `laneId`, arc length `s`, or a fire at `buildingId`. */
function hits(w: World, kind: 'accident' | 'fire', laneId: string | null, s: number, buildingId: string | null): SensorHit[] {
  const cov = coverage(w);
  const out: SensorHit[] = [];
  const seen = new Set<string>();
  const list = kind === 'accident' ? (cov.byLane.get(laneId!) ?? []).filter((h) => s >= h.sFrom - EPS && s <= h.sTo + EPS) : (cov.byBuilding.get(buildingId!) ?? []);
  for (const h of list) {
    if (seen.has(h.sensorId) || !SENSOR_DETECTS[h.kind]?.[kind]) continue;
    seen.add(h.sensorId);
    out.push(h);
  }
  return out.sort((a, b) => (a.sensorId < b.sensorId ? -1 : 1));
}

function track(w: World, eventId: string, kind: 'accident' | 'fire', startTick: number, laneId: string | null, s: number, buildingId: string | null): void {
  const sc = w.sc!;
  const det = sc.det;
  const cand: Candidate[] = [];
  if (detectionOf(sc.policy) === 'sensors') {
    const found = hits(w, kind, laneId, s, buildingId);
    if (found.length > 0) det.covered++;
    for (const h of found) {
      const m = SENSOR_MODEL[h.kind];
      if (draw(w, `miss|${eventId}|${h.sensorId}`) < m.miss) continue;
      cand.push({ tick: startTick + detectionTicks(w, m.base + draw(w, `detect|${eventId}|${h.sensorId}`) * m.spread), sensorId: h.sensorId, x: h.x, z: h.z });
    }
  }
  const r = REPORT_DELAY[kind];
  cand.push({ tick: startTick + detectionTicks(w, r.base + draw(w, `report|${eventId}`) * r.spread), sensorId: null, x: 0, z: 0 });
  cand.sort((a, b) => a.tick - b.tick || (a.sensorId === null ? 1 : 0) - (b.sensorId === null ? 1 : 0) || (a.sensorId! < b.sensorId! ? -1 : 1));
  det.tracked++;
  det.pending.push({ eventId, kind, startTick, cand, laneId, exposed: new Set() });
}

/** An accident started under reports / sensors: `s` = the placed obstacle's center on its lane. */
export function trackAccident(w: World, eventId: string, laneId: string, s: number): void {
  track(w, eventId, 'accident', w.tick, laneId, s, null);
}

/** A fire started under reports / sensors: judged at the building's reference point. */
export function trackFire(w: World, inc: Incident): void {
  track(w, inc.eventId, 'fire', inc.startTick, null, 0, inc.buildingId);
}

/** Whether a tracked event is still waiting to be known (false for legacy events). */
export const isPending = (w: World, eventId: string): boolean => w.sc!.det.pending.some((p) => p.eventId === eventId);

/** A tracked event is over before it was known: out of the queue, logged and counted (no-op otherwise). */
export function detectionMissed(w: World, eventId: string, reason: string, damaged = false): void {
  const det = w.sc!.det;
  const k = det.pending.findIndex((p) => p.eventId === eventId);
  if (k < 0) return;
  const p = det.pending.splice(k, 1)[0]!;
  det.missed++;
  if (damaged) det.missedDamaged++;
  det.exposed += p.exposed.size;
  logOutcome(w.sc!, { eventId, tick: w.tick, kind: 'detection.missed', applied: true, note: reason });
}

/** Sensor power (ADR 0013 §3): unpowered when an active blackout covers its mount point (substation areas as for buildings). */
function unpowered(w: World, x: number, z: number): boolean {
  const sc = w.sc!;
  let supplier: string | null | undefined;
  for (const b of sc.blackouts) {
    if (b.substationId === null) {
      if (Math.hypot(x - b.x, z - b.z) <= b.radius) return true;
      continue;
    }
    if (supplier === undefined) {
      supplier = null;
      let bd = Infinity;
      for (const id of Object.keys(w.doc.buildings).sort()) {
        const bl = w.doc.buildings[id]!;
        if (w.doc.buildingTypes[bl.typeId]?.service !== 'substation') continue;
        const d = Math.hypot(bl.pos.x - x, bl.pos.z - z);
        if (d <= COVERAGE_RADIUS && d < bd) {
          bd = d;
          supplier = id;
        }
      }
    }
    if (supplier === b.substationId) return true;
  }
  return false;
}

function known(w: World, p: PendingDetection, c: Candidate): void {
  const sc = w.sc!;
  const det = sc.det;
  det.pending.splice(det.pending.indexOf(p), 1);
  const delay = w.tick - p.startTick;
  det.detected++;
  if (c.sensorId !== null) det.bySensor++;
  det.delayTicks += delay;
  det.maxDelayTicks = Math.max(det.maxDelayTicks, delay);
  det.exposed += p.exposed.size;
  logOutcome(sc, { eventId: p.eventId, tick: w.tick, kind: 'detection.known', applied: true, note: `${c.sensorId === null ? 'report' : `sensor ${c.sensorId}`}, ${gameMinutes(w, delay).toFixed(1)}분` });
  if (p.kind === 'accident') {
    const e = sc.effects.find((x) => x.kind === 'accident' && x.eventId === p.eventId);
    if (!e || e.kind !== 'accident') return;
    e.known = true;
    compose(w);
    const lane = w.graph.laneById.get(e.laneId);
    if (lane !== undefined) enqueueAffected(w, [lane], false);
    return;
  }
  const inc = sc.incidents.find((x) => x.eventId === p.eventId);
  if (inc) incidentKnown(w, inc);
}

/** Per tick, after the due inputs and before power: due candidates → known (once), then exposure of the rest. */
export function processDetections(w: World): void {
  const det = w.sc!.det;
  if (det.pending.length === 0) return;
  const t = w.tick;
  // Burn-out wins a tie with detection (like accident expiry, which already ran before the inputs).
  burnOutUnknown(w);
  const due = det.pending
    .filter((p) => p.cand[0]!.tick <= t)
    .sort((a, b) => a.cand[0]!.tick - b.cand[0]!.tick || a.startTick - b.startTick || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  for (const p of due) {
    while (p.cand.length > 0 && p.cand[0]!.tick <= t) {
      const c = p.cand.shift()!;
      if (c.sensorId !== null && unpowered(w, c.x, c.z)) {
        logOutcome(w.sc!, { eventId: p.eventId, tick: t, kind: 'detection.unpowered', applied: false, note: c.sensorId });
        continue;
      }
      known(w, p, c);
      break;
    }
  }
  for (const p of det.pending) {
    if (p.laneId === null) continue;
    const lane = w.graph.laneById.get(p.laneId);
    if (lane !== undefined) for (const v of w.onEdge[lane]!) p.exposed.add(v.id);
  }
}

export function detectionKpi(w: World): DetectionKpi {
  const det = w.sc!.det;
  let sum = 0;
  let oldest = 0;
  let exposedNow = 0;
  for (const p of det.pending) {
    const min = gameMinutes(w, w.tick - p.startTick);
    sum += min;
    oldest = Math.max(oldest, min);
    exposedNow += p.exposed.size;
  }
  return {
    tracked: det.tracked,
    covered: det.covered,
    detected: det.detected,
    bySensor: det.bySensor,
    avgDelay: det.detected > 0 ? gameMinutes(w, det.delayTicks / det.detected) : 0,
    maxDelay: gameMinutes(w, det.maxDelayTicks),
    undetectedNow: det.pending.length,
    undetectedElapsedSum: sum,
    oldestUndetectedMinutes: oldest,
    missed: det.missed,
    missedDamaged: det.missedDamaged,
    exposedVehicles: det.exposed + exposedNow,
    onSiteRecoveries: det.onSiteMoves + det.onSiteReroutes,
  };
}

export function responseBreakdown(w: World): ResponseBreakdown {
  const det = w.sc!.det;
  const avg = (ticks: number, n: number): number => (n > 0 ? gameMinutes(w, ticks / n) : 0);
  return {
    arrivals: det.arrivals,
    detect: avg(det.detectTicks, det.arrivals),
    dispatchWait: avg(det.waitTicks, det.arrivals),
    travel: avg(det.travelTicks, det.arrivals),
    workDone: det.workDone,
    work: avg(det.workTicks, det.workDone),
  };
}

export const emptyDetectionKpi = (): DetectionKpi => ({
  tracked: 0,
  covered: 0,
  detected: 0,
  bySensor: 0,
  avgDelay: 0,
  maxDelay: 0,
  undetectedNow: 0,
  undetectedElapsedSum: 0,
  oldestUndetectedMinutes: 0,
  missed: 0,
  missedDamaged: 0,
  exposedVehicles: 0,
  onSiteRecoveries: 0,
});

export const emptyResponseBreakdown = (): ResponseBreakdown => ({ arrivals: 0, detect: 0, dispatchWait: 0, travel: 0, workDone: 0, work: 0 });

export function undetectedView(w: World): ScenarioView['undetected'] {
  return w
    .sc!.det.pending.map((p) => ({ eventId: p.eventId, kind: p.kind, startTick: p.startTick }))
    .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}
