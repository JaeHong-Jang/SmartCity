// Power grid coverage and blackouts (ADR 0010 §3, §8 — "커버리지 기반 공급 모델"). Coverage is derived sim state
// (the document never changes): every signalized junction, mid-block signal crosswalk and building is
// supplied by the closest substation (`service: 'substation'`) within COVERAGE_RADIUS (ties: id); no
// redistribution. Power plants are listed only (no plant does not cut anything: outages are events).
// `blackout.start` cuts a substation's area or a disc (x, z, radius). Unpowered signals go DARK
// (traffic/signalDark.ts: all-way stop, unsignalized crosswalks, safe restore) — unless the response policy's
// signal battery (`ResponsePolicy.battery`, omitted = `reroute`) keeps them on (pre-emption included) for
// BATTERY_TICKS of unpowered time, after which they go dark (`battery.depleted`). The battery refills when
// power returns. DARK outranks PREEMPT: a dark junction takes no request and drops its controller.
// Everything here runs only while a blackout is active or a signal is dark (zero cost otherwise).

import { CLOCK_SCALE } from '../types.js';
import { clearingFrom, planOf, shownAt } from '../traffic/signalClearing.js';
import { darkenCrossing, darkenJunction, restoreCrossing, restoreJunction } from '../traffic/signalDark.js';
import { STOP_SPEED, type World } from '../traffic/world.js';
import { logOutcome } from './state.js';
import { batteryOn, type ScenarioInput } from './types.js';

/** Substation supply radius, m. */
export const COVERAGE_RADIUS = 400;
/** Default blackout length: 30 game min (ticks at 20 Hz). */
export const BLACKOUT_TICKS = 3600;
/** Signal battery: 15 game min of unpowered operation (ticks at 20 Hz). */
export const BATTERY_TICKS = 1800;

export interface Blackout {
  eventId: string;
  /** Substation whose area is cut, or null for a disc (x, z, radius). */
  substationId: string | null;
  x: number;
  z: number;
  radius: number;
  startTick: number;
  endTick: number;
}

export interface PowerCoverage {
  substations: string[];
  powerPlants: string[];
  /** Junction node id / mid-block crosswalk id / building id → supplying substation (only those within reach). */
  junctions: Record<string, string>;
  crossings: Record<string, string>;
  buildings: Record<string, string>;
}

interface Site {
  kind: 'junction' | 'crossing' | 'building';
  id: string;
  x: number;
  z: number;
}

/** Signal ids: `n:<nodeId>` junctions, `c:<crosswalkId>` mid-block signals. */
const sigId = (s: Site): string => (s.kind === 'junction' ? `n:${s.id}` : `c:${s.id}`);

function sites(w: World): Site[] {
  const out: Site[] = [];
  for (const p of w.signals.plans) {
    const n = w.graph.nodes.get(p.nodeId);
    if (n) out.push({ kind: 'junction', id: p.nodeId, x: n.pos.x, z: n.pos.z });
  }
  for (const m of w.signals.mids) {
    const cr = w.graph.crossings[m.ci]!;
    out.push({ kind: 'crossing', id: m.id, x: (cr.a.x + cr.b.x) / 2, z: (cr.a.z + cr.b.z) / 2 });
  }
  for (const id of Object.keys(w.doc.buildings).sort()) {
    const b = w.doc.buildings[id]!;
    out.push({ kind: 'building', id, x: b.pos.x, z: b.pos.z });
  }
  // Dark signals stay listed while they are dark, even when an edit removed their signal meanwhile.
  return out;
}

const serviceOf = (w: World, id: string): string | undefined => {
  const b = w.doc.buildings[id];
  return b ? w.doc.buildingTypes[b.typeId]?.service : undefined;
};

export function powerCoverage(w: World): PowerCoverage {
  const ids = Object.keys(w.doc.buildings).sort();
  const subs = ids.filter((id) => serviceOf(w, id) === 'substation');
  const cov: PowerCoverage = { substations: subs, powerPlants: ids.filter((id) => serviceOf(w, id) === 'powerPlant'), junctions: {}, crossings: {}, buildings: {} };
  for (const s of sites(w)) {
    let best: string | null = null;
    let bd = Infinity;
    for (const id of subs) {
      const p = w.doc.buildings[id]!.pos;
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d <= COVERAGE_RADIUS && d < bd) {
        bd = d;
        best = id;
      }
    }
    if (best !== null) (s.kind === 'junction' ? cov.junctions : s.kind === 'crossing' ? cov.crossings : cov.buildings)[s.id] = best;
  }
  return cov;
}

let cache: { signals: unknown; key: string; value: { signals: Map<string, string>; buildings: Set<string> } } | null = null;

/**
 * Unpowered signals (→ the blackout that cut them, smallest eventId) and buildings, over active blackouts.
 * Cached per rebuilt signal set (every edit rebuilds it) and blackout list.
 */
function unpowered(w: World): { signals: Map<string, string>; buildings: Set<string> } {
  const sc = w.sc!;
  const key = sc.blackouts.map((b) => b.eventId).join('|');
  if (cache !== null && cache.signals === w.signals && cache.key === key) return cache.value;
  const value = computeUnpowered(w);
  cache = { signals: w.signals, key, value };
  return value;
}

function computeUnpowered(w: World): { signals: Map<string, string>; buildings: Set<string> } {
  const sc = w.sc!;
  const signals = new Map<string, string>();
  const buildings = new Set<string>();
  if (sc.blackouts.length === 0) return { signals, buildings };
  const cov = sc.blackouts.some((b) => b.substationId !== null) ? powerCoverage(w) : null;
  const order = [...sc.blackouts].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  for (const s of sites(w)) {
    for (const b of order) {
      const hit =
        b.substationId !== null
          ? (s.kind === 'junction' ? cov!.junctions : s.kind === 'crossing' ? cov!.crossings : cov!.buildings)[s.id] === b.substationId
          : Math.hypot(s.x - b.x, s.z - b.z) <= b.radius;
      if (!hit) continue;
      if (s.kind === 'building') buildings.add(s.id);
      else signals.set(sigId(s), b.eventId);
      break;
    }
  }
  return { signals, buildings };
}

function log(w: World, eventId: string, kind: string, note?: string): void {
  logOutcome(w.sc!, { eventId, tick: w.tick, kind, applied: true, ...(note !== undefined ? { note } : {}) });
}

export function startBlackout(w: World, input: ScenarioInput): string | null {
  const sc = w.sc!;
  const t = input.target;
  const p = input.params;
  let b: Blackout;
  if (t.buildingId !== undefined) {
    const sub = w.doc.buildings[t.buildingId];
    if (!sub || serviceOf(w, t.buildingId) !== 'substation') return 'target gone';
    b = { eventId: input.eventId, substationId: t.buildingId, x: sub.pos.x, z: sub.pos.z, radius: COVERAGE_RADIUS, startTick: w.tick, endTick: 0 };
  } else b = { eventId: input.eventId, substationId: null, x: p.x!, z: p.z!, radius: p.radius!, startTick: w.tick, endTick: 0 };
  b.endTick = w.tick + (p.durationTicks ?? BLACKOUT_TICKS);
  sc.blackouts.push(b);
  return null;
}

/** `blackout.end` (by eventId, else the earliest active one of that substation), or the automatic end (`by` null). */
export function endBlackout(w: World, b: Blackout, by: string | null): void {
  const sc = w.sc!;
  sc.blackouts.splice(sc.blackouts.indexOf(b), 1);
  log(w, b.eventId, 'blackout.end', by === null ? 'duration' : `by ${by}`);
}

export function findBlackout(w: World, input: ScenarioInput): Blackout | undefined {
  const t = input.target;
  return w.sc!.blackouts.find((b) => (t.eventId !== undefined ? b.eventId === t.eventId : b.substationId === t.buildingId));
}

/** Pedestrian clearances a junction owes at a power cut, from what it shows (controller, clearance or plan). */
function owedPeds(w: World, nodeId: string): ReturnType<typeof clearingFrom>['peds'] {
  const sc = w.sc!;
  const t = w.tick;
  const c = sc.ctl.get(nodeId);
  if (c) {
    sc.ctl.delete(nodeId);
    return clearingFrom(nodeId, c.id, c, t).peds;
  }
  const cl = w.signalClearing.get(nodeId);
  if (cl) return cl.peds.filter((x) => x.end > t);
  const p = planOf(w, nodeId);
  if (!p) return [];
  const built = w.signals.builtAt ?? 0;
  return clearingFrom(nodeId, p.id, shownAt(p, Math.max(t - 1, built), built), t).peds;
}

/**
 * Per tick, at the start (after inputs, before updateSignals): unpowered set → battery → DARK / restore
 * transitions with their outcomes, and the blackout KPIs.
 */
export function updatePower(w: World): void {
  const sc = w.sc!;
  const t = w.tick;
  const { signals, buildings } = unpowered(w);
  sc.unpoweredBuildings = [...buildings].sort();
  sc.unpoweredSignals = signals.size;
  const battery = batteryOn(sc.policy);
  // Signals that should be dark now, with the blackout responsible.
  const dark = new Map<string, string>();
  for (const id of [...signals.keys()].sort()) {
    const ev = signals.get(id)!;
    const charge = sc.battery.get(id) ?? BATTERY_TICKS;
    if (battery && charge > 0) {
      sc.battery.set(id, charge - 1);
      if (id.startsWith('n:')) sc.batteryTicks++;
      if (charge - 1 === 0) log(w, ev, 'battery.depleted', id.slice(2));
      continue;
    }
    dark.set(id, ev);
  }
  // Power back: the battery is full again.
  for (const id of [...sc.battery.keys()]) if (!signals.has(id)) sc.battery.delete(id);
  const cur = new Set<string>();
  if (w.dark) {
    for (const n of w.dark.junctions.keys()) cur.add(`n:${n}`);
    for (const c of w.dark.crossings) cur.add(`c:${c}`);
  }
  for (const id of [...cur].sort()) {
    if (dark.has(id)) continue;
    if (id.startsWith('n:')) restoreJunction(w, id.slice(2));
    else restoreCrossing(w, id.slice(2));
    log(w, sc.darkBy.get(id) ?? '', 'signal.restored', id.slice(2));
    sc.darkBy.delete(id);
  }
  for (const [id, ev] of dark) {
    if (cur.has(id)) continue;
    if (id.startsWith('n:')) darkenJunction(w, id.slice(2), owedPeds(w, id.slice(2)));
    else darkenCrossing(w, id.slice(2));
    sc.darkBy.set(id, ev);
    log(w, ev, 'signal.dark', id.slice(2));
  }
  if (w.dark) {
    sc.darkJunctionTicks += w.dark.junctions.size;
    // Delay at dark junctions: vehicles stopped on the lanes into them.
    for (const nodeId of w.dark.junctions.keys()) {
      const node = w.graph.nodes.get(nodeId);
      if (!node) continue;
      for (const segId of node.segments)
        for (const l of w.graph.segments.get(segId)!.lanes) {
          if (w.graph.lanes[l]!.toNode !== nodeId) continue;
          for (const v of w.onEdge[l]!) if (v.v < STOP_SPEED) sc.darkQueueTicks++;
        }
    }
  }
}

/** Game minutes of `ticks` junction-ticks (or vehicle-ticks). */
export const minutesOf = (w: World, ticks: number): number => (ticks / w.tickRate) * (CLOCK_SCALE / 60);
