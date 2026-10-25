// Signal control state machine (ADR 0010 §4). Every signalized junction is driven by exactly one source
// per tick, highest priority first:
//   'dark'    — signal not powered (4c2-②, power outages). Reserved: never produced yet; it will override
//               both sources below and hand back through the same safe transitions.
//   'preempt' — an emergency vehicle requested its approach (policy `preemptOn`).
//   'normal'  — the fixed-time plan (traffic/signals.ts), a pure function of the tick.
// A junction is in NORMAL with no controller record at all: `updateSignals` alone drives it (no cost, and
// a run without emergency vehicles is byte-identical to one without this module).
//
// Safety: a controller only ever shows green to the approaches of ONE plan phase (so movements the plan
// never runs together are never green together), and leaves a green only after the minimum green
// (min(5 s, the phase's planned green)), with every pedestrian head of that phase past its clearance by the
// end of the yellow (steady WALK is cut short, the flashing CLEARANCE always runs in full), then the
// plan's full yellow and all-red. A pedestrian-only (scramble) phase is left only after its clearance. No
// new WALK starts while a controller drives the junction. Requests: an emergency vehicle on a call (to
// the scene, or carrying a patient) whose next signalized stop line is within max(150 m, 15 s × speed) asks
// for the phase of its approach. Per junction requests are served one at a time in ETA order (whole ticks,
// then vehicle id): the vehicle being served keeps the junction until its request disappears — once it is
// past the stop line (on the connector) — so two requests never make the junction switch back and forth.
// Plan clock: the fixed-time clock keeps running underneath; when no request is left the controller ends
// the served green safely and hands back at the START of the plan's next phase, re-phasing the plan's
// offset (kept across rebuilds in `sc.offsets` while the plan is unchanged) — never mid-interval.
//
// Edits: a controller is bound to its plan's identity (`PlanIdentity.key`: phase approach ids, head lane
// ids, crosswalk ids and the whole timing plan), never to bare indices. When an edit or recompile changes
// a driven junction's plan (or removes its signal), the controller turns into an edit-time CLEARANCE that
// works on stable ids only: what was green shows its planned yellow at once (the edit cuts the green: the
// old phase may not exist in the new plan, so no minimum green), then the planned all-red, every WALK
// becomes a full CLEARANCE, and nothing enters (every lane into the junction held) until all of it ran.
// Only then the new plan starts at the beginning of its first phase — or a still-pending request is served
// on the new plan's phases — or, if the junction is no longer signalized, its new control takes over.
// Junctions no controller drives keep the base behaviour on edits (the fixed-time plan switches at once).

import { PedSignal } from '../types.js';
import { updateSignals, type SignalPlan } from '../traffic/signals.js';
import type { World } from '../traffic/world.js';
import { preemptOn } from './types.js';

export type SignalMode = 'normal' | 'preempt' | 'dark';

/** A request reaches this far ahead of the stop line: max(PREEMPT_DISTANCE, PREEMPT_ETA × speed). */
export const PREEMPT_DISTANCE = 150;
export const PREEMPT_ETA = 15;
/** Minimum green before a controller ends a green (capped by the phase's own planned green). */
export const PREEMPT_MIN_GREEN = 5;

/** What a controller is bound to: the plan in stable ids. */
export interface PlanIdentity {
  /** Phase approaches, head lanes, crosswalks, scramble flag and all timings (offset included). */
  key: string;
  yellowTicks: number;
  allRedTicks: number;
  /** Per phase: ids of the lanes whose heads it turns green. */
  phaseLanes: string[][];
  /** Per pedestrian head: crosswalk id and clearance ticks. */
  pedIds: string[];
  pedClearance: number[];
  /** Index of the pedestrian-only phase, −1 = none. */
  scrambleIdx: number;
}

export interface SignalCtl {
  nodeId: string;
  mode: Exclude<SignalMode, 'normal'>;
  id: PlanIdentity;
  /** Phase whose state is shown. */
  phase: number;
  color: 'green' | 'yellow' | 'allRed';
  /** Tick the shown color started, and the tick the current green started. */
  since: number;
  greenStart: number;
  /** Per plan pedestrian head: WALK shown before walkEnd, CLEARANCE before clrEnd (ticks). */
  walkEnd: number[];
  clrEnd: number[];
  /** Request served now (vehicle id, phase), −1 = none: ending the green and handing back to the plan. */
  vehicleId: number;
  target: number;
}

/** Edit-time clearance of a junction whose plan changed under a controller (stable ids only). */
export interface SignalClearing {
  nodeId: string;
  /** Lanes shown yellow until yellowEnd (lane ids; lanes the edit removed vanish); no lane in is green before allRedEnd. */
  yellowLanes: string[];
  yellowEnd: number;
  allRedEnd: number;
  /** The junction had no signal heads during the yellow (the edit removed its signal): the rest shows red. */
  headless: boolean;
  /** Crosswalks in their flashing clearance until `end`. */
  peds: { id: string; end: number }[];
}

interface Request {
  vehicleId: number;
  eta: number;
  phase: number;
}

let planCache: { plans: SignalPlan[]; byNode: Map<string, SignalPlan> } | null = null;

function planOf(w: World, nodeId: string): SignalPlan | undefined {
  const plans = w.signals.plans;
  if (planCache === null || planCache.plans !== plans) planCache = { plans, byNode: new Map(plans.map((p) => [p.nodeId, p])) };
  return planCache.byNode.get(nodeId);
}

function identity(w: World, p: SignalPlan): PlanIdentity {
  const g = w.graph;
  const laneId = (l: number): string => g.lanes[l]!.id;
  const phaseLanes = p.phases.map((ph) => p.heads.filter((_, h) => ph.approaches.includes(p.headSeg[h]!)).map((hd) => laneId(hd.lane)));
  const pedIds = p.peds.map((ph) => g.crossings[ph.ci]!.id);
  const docOffset = Math.max(0, Math.round((w.doc.intersections[p.nodeId]?.offset ?? 0) * w.tickRate));
  const key = JSON.stringify([
    p.phases.map((ph) => ph.approaches),
    p.greenTicks,
    p.yellowTicks,
    p.allRedTicks,
    p.cycle,
    docOffset,
    p.scramble,
    p.heads.map((hd, h) => [laneId(hd.lane), p.headSeg[h]]),
    p.peds.map((ph, k) => [pedIds[k], ph.walks, ph.walk, ph.clearance]),
  ]);
  return { key, yellowTicks: p.yellowTicks, allRedTicks: p.allRedTicks, phaseLanes, pedIds, pedClearance: p.peds.map((ph) => ph.clearance), scrambleIdx: p.scramble ? p.phases.length - 1 : -1 };
}

/** Every emergency vehicle on a call asks its next signalized junction for its approach's phase. */
function collectRequests(w: World): Map<string, Request[]> {
  const out = new Map<string, Request[]>();
  const sc = w.sc!;
  if (!preemptOn(sc.policy)) return out;
  const net = w.net;
  const nLanes = net.nLanes;
  for (const m of sc.missions) {
    const v = m.v;
    if (v === null || !v.alive || (m.stage !== 'enroute' && m.stage !== 'transport')) continue;
    const reach = Math.max(PREEMPT_DISTANCE, PREEMPT_ETA * v.v);
    let e = v.edge;
    let j = v.ri;
    let d = net.len[e]! - v.s;
    while (d <= reach) {
      const nxt = v.route[j + 1];
      if (nxt === undefined) break;
      if (e < nLanes && nxt >= nLanes) {
        const node = net.connNode[nxt - nLanes]!;
        if (net.nodeSignalized[node]) {
          const nodeId = net.nodeIds[node]!;
          const p = planOf(w, nodeId);
          const seg = w.graph.lanes[e]!.segmentId;
          const phase = p ? p.phases.findIndex((ph) => ph.approaches.includes(seg)) : -1;
          if (phase >= 0) {
            const r = { vehicleId: v.id, eta: Math.ceil((d / Math.max(v.v, 1)) * w.tickRate), phase };
            const list = out.get(nodeId);
            if (list) list.push(r);
            else out.set(nodeId, [r]);
          }
          break;
        }
      }
      d += net.len[nxt]!;
      e = nxt;
      j++;
    }
  }
  return out;
}

/**
 * Take over a junction in the state the fixed-time plan shows at tick t (updateSignals ran this tick). Its
 * current interval is on display since its start by the plan clock, but not before the plans were built
 * (an edit may have switched the junction just now): the minimum green and the yellow count from there.
 */
function takeOver(w: World, p: SignalPlan, t: number): SignalCtl {
  const tc = (t + p.offset) % p.cycle;
  const iv = p.intervals[p.cur]!;
  const built = w.signals.builtAt ?? 0;
  const ws = t - (tc - p.phaseStart[iv.phase]!);
  const walkEnd: number[] = [];
  const clrEnd: number[] = [];
  for (const ph of p.peds) {
    const walks = ph.walks[iv.phase]!;
    walkEnd.push(walks ? ws + ph.walk : -1);
    clrEnd.push(walks ? ws + ph.walk + ph.clearance : -1);
  }
  const color = iv.color === 'green' || iv.color === 'yellow' ? iv.color : 'allRed';
  return { nodeId: p.nodeId, mode: 'preempt', id: identity(w, p), phase: iv.phase, color, since: Math.max(built, t - (tc - iv.start)), greenStart: Math.max(built, ws), walkEnd, clrEnd, vehicleId: -1, target: -1 };
}

/** Pedestrian heads of the shown phase: cut a steady WALK short (CLEARANCE then runs in full). */
function cutWalk(p: SignalPlan, c: SignalCtl, t: number): void {
  for (let k = 0; k < p.peds.length; k++) {
    if (c.walkEnd[k]! > t) {
      c.walkEnd[k] = t;
      c.clrEnd[k] = t + p.peds[k]!.clearance;
    }
  }
}

const lastClearance = (c: SignalCtl): number => {
  let m = -1;
  for (const x of c.clrEnd) m = Math.max(m, x);
  return m;
};

/** Advance one tick. Returns false when the controller hands the junction back to the plan at tick t. */
function advance(p: SignalPlan, c: SignalCtl, t: number, minGreen: number): boolean {
  // Zero-length intervals (yellow / all-red 0 in a custom control) pass within the same tick.
  for (let guard = 0; guard < 4; guard++) {
    if (c.color === 'green') {
      if (c.target === c.phase) return true;
      if (c.target >= 0) cutWalk(p, c, t);
      if (t - c.greenStart < Math.min(minGreen, p.greenTicks[c.phase]!)) return true;
      if (lastClearance(c) > t + p.yellowTicks) return true;
      c.color = 'yellow';
      c.since = t;
      continue;
    }
    if (c.color === 'yellow') {
      if (t - c.since < p.yellowTicks) return true;
      c.color = 'allRed';
      c.since = t;
      continue;
    }
    if (c.phase === c.id.scrambleIdx) {
      if (c.target >= 0) cutWalk(p, c, t);
      if (lastClearance(c) > t) return true;
    } else if (t - c.since < p.allRedTicks) return true;
    if (c.target < 0) return false;
    c.phase = c.target;
    c.color = 'green';
    c.since = t;
    c.greenStart = t;
    return true;
  }
  return true;
}

/** Shown state → lane greens, pedestrian heads and the plan's display override. */
function write(w: World, p: SignalPlan, c: SignalCtl): void {
  const t = w.tick;
  const segs = p.phases[c.phase]!.approaches;
  const green = c.color === 'green';
  for (let h = 0; h < p.heads.length; h++) w.laneGreen[p.heads[h]!.lane] = green && segs.includes(p.headSeg[h]!) ? 1 : 0;
  for (let k = 0; k < p.peds.length; k++) w.zs.pedSig[p.peds[k]!.ci] = t < c.walkEnd[k]! ? PedSignal.walk : t < c.clrEnd[k]! ? PedSignal.clearance : PedSignal.red;
  const left = c.color === 'yellow' ? p.yellowTicks - (t - c.since) : c.color === 'allRed' && c.phase !== c.id.scrambleIdx ? p.allRedTicks - (t - c.since) : 0;
  p.ctl = { phase: c.phase, color: c.color, remaining: Math.max(0, left), segs };
}

/** Start an edit-time clearance from what controller c shows (its last output was at tick t − 1). */
function toClearing(c: SignalCtl, t: number): SignalClearing {
  const id = c.id;
  let yellowLanes: string[] = [];
  let yellowEnd = t;
  let allRedEnd = t;
  if (c.color === 'green' || c.color === 'yellow') {
    yellowLanes = id.phaseLanes[c.phase]!;
    yellowEnd = c.color === 'green' ? t + id.yellowTicks : c.since + id.yellowTicks;
    allRedEnd = yellowEnd + id.allRedTicks;
  } else if (c.phase !== id.scrambleIdx) allRedEnd = c.since + id.allRedTicks;
  const peds: SignalClearing['peds'] = [];
  for (let k = 0; k < id.pedIds.length; k++) {
    if (t < c.walkEnd[k]!) peds.push({ id: id.pedIds[k]!, end: t + id.pedClearance[k]! });
    else if (t < c.clrEnd[k]!) peds.push({ id: id.pedIds[k]!, end: c.clrEnd[k]! });
  }
  return { nodeId: c.nodeId, yellowLanes, yellowEnd, allRedEnd, headless: false, peds };
}

/** Lanes entering a node on the current graph. */
function enteringLanes(w: World, nodeId: string): number[] {
  const node = w.graph.nodes.get(nodeId);
  if (!node) return [];
  const out: number[] = [];
  for (const segId of node.segments) for (const l of w.graph.segments.get(segId)!.lanes) if (w.graph.lanes[l]!.toNode === nodeId) out.push(l);
  return out;
}

const crossingIndex = (w: World, id: string): number => w.graph.crossings.findIndex((cr) => cr.id === id);

/** Clearance output: every lane in held, yellow heads for what was green, flashing clearance for what walked. */
function writeClearing(w: World, cl: SignalClearing): void {
  const t = w.tick;
  for (const l of enteringLanes(w, cl.nodeId)) w.laneGreen[l] = 0;
  const p = planOf(w, cl.nodeId);
  const flashing = new Set(cl.peds.filter((x) => t < x.end).map((x) => x.id));
  if (!p && t < cl.yellowEnd) cl.headless = true;
  if (p) {
    for (const ph of p.peds) w.zs.pedSig[ph.ci] = flashing.has(w.graph.crossings[ph.ci]!.id) ? PedSignal.clearance : PedSignal.red;
    const segs: string[] = [];
    if (t < cl.yellowEnd && !cl.headless) for (let h = 0; h < p.heads.length; h++) if (cl.yellowLanes.includes(w.graph.lanes[p.heads[h]!.lane]!.id) && !segs.includes(p.headSeg[h]!)) segs.push(p.headSeg[h]!);
    const yellow = segs.length > 0;
    p.ctl = { phase: -1, color: yellow ? 'yellow' : 'allRed', remaining: Math.max(0, (yellow ? cl.yellowEnd : cl.allRedEnd) - t), segs };
  }
  // Crosswalks without a signal head now (the junction lost its signal): no new crossing until cleared.
  for (const id of flashing) {
    const ci = crossingIndex(w, id);
    if (ci >= 0 && (!p || !p.peds.some((ph) => ph.ci === ci))) w.zs.pedSig[ci] = PedSignal.clearance;
  }
}

const clearingDone = (cl: SignalClearing, t: number): boolean => t >= cl.yellowEnd && t >= cl.allRedEnd && cl.peds.every((x) => x.end <= t);

/** Re-phase a plan so that its phase `phase` starts at tick t, remembered while the plan is unchanged. */
function startPlanAt(w: World, p: SignalPlan, phase: number, t: number, key: string): void {
  const offset = (((p.phaseStart[phase]! - t) % p.cycle) + p.cycle) % p.cycle;
  p.offset = offset;
  w.sc!.offsets.set(p.nodeId, { key, offset });
  p.ctl = null;
  updateSignals({ plans: [p], mids: [] }, t, w.laneGreen, w.zs.pedSig, w.zs.midColor);
}

/** The clearance ran out: the new plan (or a pending request on it, or the junction's new control) takes over. */
function endClearing(w: World, cl: SignalClearing, r: Request | undefined): void {
  const sc = w.sc!;
  const t = w.tick;
  sc.clearing.delete(cl.nodeId);
  const p = planOf(w, cl.nodeId);
  if (!p) {
    // No signal any more: the junction's own (unsignalized) control, as after any rebuild.
    for (const l of enteringLanes(w, cl.nodeId)) w.laneGreen[l] = 1;
    for (const x of cl.peds) {
      const ci = crossingIndex(w, x.id);
      if (ci >= 0) w.zs.pedSig[ci] = PedSignal.none;
    }
    return;
  }
  const id = identity(w, p);
  if (r === undefined) return startPlanAt(w, p, 0, t, id.key);
  const c: SignalCtl = { nodeId: cl.nodeId, mode: 'preempt', id, phase: r.phase, color: 'green', since: t, greenStart: t, walkEnd: p.peds.map(() => -1), clrEnd: p.peds.map(() => -1), vehicleId: r.vehicleId, target: r.phase };
  sc.ctl.set(cl.nodeId, c);
  write(w, p, c);
}

/** Per tick, after updateSignals: requests → controllers and clearances (create, advance, hand back) → outputs. */
export function updatePreemption(w: World): void {
  const sc = w.sc!;
  const minGreen = Math.round(PREEMPT_MIN_GREEN * w.tickRate);
  const reqs = collectRequests(w);
  const nodes = new Set<string>([...reqs.keys(), ...sc.ctl.keys(), ...sc.clearing.keys()]);
  const t = w.tick;
  for (const nodeId of [...nodes].sort()) {
    const p = planOf(w, nodeId);
    const list = reqs.get(nodeId);
    let c = sc.ctl.get(nodeId);
    let r: Request | undefined = c !== undefined && list !== undefined ? list.find((x) => x.vehicleId === c!.vehicleId) : undefined;
    if (r === undefined && list !== undefined) for (const x of list) if (r === undefined || x.eta < r.eta || (x.eta === r.eta && x.vehicleId < r.vehicleId)) r = x;
    const cl = sc.clearing.get(nodeId);
    if (cl !== undefined) {
      if (clearingDone(cl, t)) endClearing(w, cl, r);
      else writeClearing(w, cl);
      continue;
    }
    if (p === undefined) continue;
    if (c === undefined) {
      if (r === undefined) continue;
      c = takeOver(w, p, t);
      sc.ctl.set(nodeId, c);
    }
    c.vehicleId = r ? r.vehicleId : -1;
    c.target = r ? r.phase : -1;
    if (advance(p, c, t, minGreen)) {
      write(w, p, c);
      continue;
    }
    // Hand back at the start of the plan's next phase.
    sc.ctl.delete(nodeId);
    startPlanAt(w, p, (c.phase + 1) % p.phases.length, t, c.id.key);
  }
}

/**
 * Right after buildSignals (an edit or recompile), before updateSignals: a controller whose plan changed
 * (identity key) becomes an edit-time clearance; re-phased offsets are kept only for an unchanged plan.
 */
export function rebindSignalControl(w: World): void {
  const sc = w.sc!;
  const t = w.tick;
  for (const [nodeId, c] of [...sc.ctl]) {
    const p = planOf(w, nodeId);
    if (p && identity(w, p).key === c.id.key) continue;
    sc.ctl.delete(nodeId);
    sc.clearing.set(nodeId, toClearing(c, t));
  }
  for (const [nodeId, o] of [...sc.offsets]) {
    const p = planOf(w, nodeId);
    if (p && identity(w, p).key === o.key) p.offset = o.offset % p.cycle;
    else sc.offsets.delete(nodeId);
  }
}

/** After a rebuild's updateSignals: show the driven junctions and the clearances again. */
export function writeSignalControl(w: World): void {
  const sc = w.sc!;
  for (const [nodeId, c] of sc.ctl) write(w, planOf(w, nodeId)!, c);
  for (const cl of sc.clearing.values()) writeClearing(w, cl);
}

/** Junctions a controller or a clearance drives now (ScenarioView.preempted), node id order. */
export function controlledJunctions(w: World): { nodeId: string; vehicleId: number; phase: number; color: 'green' | 'yellow' | 'red' }[] {
  const sc = w.sc!;
  const out: { nodeId: string; vehicleId: number; phase: number; color: 'green' | 'yellow' | 'red' }[] = [];
  for (const c of sc.ctl.values()) out.push({ nodeId: c.nodeId, vehicleId: c.vehicleId, phase: c.phase, color: c.color === 'allRed' ? 'red' : c.color });
  for (const cl of sc.clearing.values()) out.push({ nodeId: cl.nodeId, vehicleId: -1, phase: -1, color: w.tick < cl.yellowEnd && cl.yellowLanes.length > 0 ? 'yellow' : 'red' });
  return out.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}
