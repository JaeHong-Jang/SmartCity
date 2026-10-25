// Safe signal plan changes (ADR 0010 §4, all modes). When a rebuild (edit or recompile) gives a junction a
// plan with a different identity (`PlanIdentity.key`: phase approach ids, head lane ids, crosswalk ids and
// the whole timing plan), or takes its signal away, or signalizes it, the junction is not switched at once:
// an edit-time CLEARANCE runs on stable ids only — what was green shows its planned yellow, then the planned
// all-red; every WALK becomes a full CLEARANCE; every lane into the junction is held meanwhile (a junction
// without signal heads shows no yellow, so it is held red for yellow + all-red). Then the new plan starts at
// the beginning of its first phase (offset re-phased, kept across later rebuilds while the plan is
// unchanged), or a junction that lost its signal goes over to its unsignalized control. A rebuild that
// leaves the identity unchanged changes nothing. Purely tick-based. The scenario signal controller
// (scenario/preempt.ts) feeds its own shown state into the same clearance and may take a cleared junction
// over directly (a pending emergency request).
// Mid-block signal crosswalks follow the same principle (keyed by crosswalk id, `MidSignal.key`): switched
// off (or changed) while pedestrians had WALK / CLEARANCE → vehicles stay red and the crosswalk flashes its
// full clearance first, then the crosswalk is unsignalized (vehicles yield to pedestrians) or the new
// signal starts with its vehicle green; switched off during the vehicle green / yellow → unsignalized at
// once (vehicles were not stopped for anyone); switched on (or changed during a vehicle green / yellow) →
// the new signal keeps its own cycle if that shows the vehicle green now, else it starts with its full
// yellow — so vehicles always see a full yellow then red before the first WALK.

import { PedSignal } from '../types.js';
import { clearanceTicks, updateSignals, type MidSignal, type PlanIdentity, type SignalPlan, type SignalSet } from './signals.js';
import type { World } from './world.js';

/** What a junction shows: phase, color (and since when), pedestrian WALK / CLEARANCE ends (ticks). */
export interface PlanShown {
  phase: number;
  color: 'green' | 'yellow' | 'allRed';
  since: number;
  greenStart: number;
  walkEnd: number[];
  clrEnd: number[];
}

/** Edit-time clearance of one junction (stable ids only). */
export interface SignalClearing {
  nodeId: string;
  /** Lanes shown yellow until yellowEnd (lane ids; lanes the edit removed vanish); no lane in is green before allRedEnd. */
  yellowLanes: string[];
  yellowEnd: number;
  allRedEnd: number;
  /** The junction had no signal heads during the yellow (the edit removed its signal): the rest shows red. */
  headless: boolean;
  /** Crosswalks in their flashing clearance from `start` until `end` (extended when an edit lengthens one). */
  peds: { id: string; start: number; end: number }[];
}

/** Edit-time clearance of a mid-block signal crosswalk: vehicles red, CLEARANCE flashing until `until`. */
export interface MidClearing {
  id: string;
  /** Tick the clearance began (end of WALK). */
  start: number;
  until: number;
}

let planCache: { plans: SignalPlan[]; byNode: Map<string, SignalPlan> } | null = null;
let midCache: { mids: MidSignal[]; byId: Map<string, MidSignal> } | null = null;

export function midOf(w: World, id: string): MidSignal | undefined {
  const mids = w.signals.mids;
  if (midCache === null || midCache.mids !== mids) midCache = { mids, byId: new Map(mids.map((m) => [m.id, m])) };
  return midCache.byId.get(id);
}

/**
 * Pedestrian clearance a mid-block signal owes at tick t from what it showed at `at` (null = none: vehicles
 * were green / yellow): WALK on display → it starts now; CLEARANCE → it started when the WALK ended.
 * `clearance` = the clearance owed (the longer of the old and the current crosswalk).
 */
export function midClearanceOwed(m: MidSignal, at: number, t: number, clearance = m.clearance): { start: number; until: number } | null {
  const el = ((at + m.offset) % m.cycle) - m.green - m.yellow;
  if (el < 0) return null;
  const start = el < m.walk ? t : at - el + m.walk;
  return { start, until: start + clearance };
}

/** Clearance the crosswalk `id` needs with its current geometry (0 when it no longer exists). */
export function geometricClearance(w: World, id: string): number {
  const ci = crossingIndex(w, id);
  return ci < 0 ? 0 : clearanceTicks(w.zones.length[ci]!, w.tickRate);
}

/**
 * After a rebuild: every clearance still running (junction clearances, dark junctions, mid-block clearances)
 * lasts at least what its crosswalk needs with the new geometry — an edit that lengthens a crosswalk under
 * pedestrians extends their clearance (ADR 0010 §4: the longer of the old and the new crosswalk).
 */
export function extendClearances(w: World): void {
  const t = w.tick;
  // Only clearances still running: one already served in full is not shown again.
  const extend = (x: { id: string; start: number; end: number }): void => {
    if (x.end > t) x.end = Math.max(x.end, x.start + geometricClearance(w, x.id));
  };
  for (const cl of w.signalClearing.values()) for (const x of cl.peds) extend(x);
  if (w.dark !== null) for (const rec of w.dark.junctions.values()) for (const x of rec.peds) extend(x);
  for (const mc of w.midClearing.values()) if (mc.until > t) mc.until = Math.max(mc.until, mc.start + geometricClearance(w, mc.id));
}

/** Re-phase a mid-block signal so that its green ('green') or its yellow starts at tick t. */
export function startMidAt(w: World, m: MidSignal, phase: 'green' | 'yellow', t: number, write: boolean): void {
  const at = phase === 'green' ? 0 : m.green;
  m.offset = (((at - t) % m.cycle) + m.cycle) % m.cycle;
  m.ctl = null;
  w.signalOffsets.set(`mid:${m.id}`, { key: m.key, offset: m.offset });
  if (write) updateSignals({ plans: [], mids: [m] }, t, w.laneGreen, w.zs.pedSig, w.zs.midColor);
}

/** Vehicles were free (unsignalized, or green / yellow): keep the cycle if it shows green now, else start its full yellow. */
export function switchMidOn(w: World, m: MidSignal, t: number, write: boolean): void {
  if ((t + m.offset) % m.cycle < m.green) return;
  startMidAt(w, m, 'yellow', t, write);
}

function writeMidClearing(w: World, mc: MidClearing): void {
  const ci = crossingIndex(w, mc.id);
  if (ci < 0) return;
  w.zs.midColor[ci] = 0;
  w.zs.pedSig[ci] = PedSignal.clearance;
  const m = midOf(w, mc.id);
  if (m) m.ctl = 'red';
}

/**
 * Per tick: advance mid-block clearances. A finished one starts the crosswalk's (new) signal with its vehicle
 * green, or leaves it unsignalized — unless `dark(id)` (power cut): then the dark state takes it over.
 */
function stepMidClearings(w: World, dark: (id: string) => boolean): void {
  const t = w.tick;
  for (const id of [...w.midClearing.keys()].sort()) {
    const mc = w.midClearing.get(id)!;
    if (t < mc.until) {
      writeMidClearing(w, mc);
      continue;
    }
    w.midClearing.delete(id);
    if (dark(id)) continue;
    const m = midOf(w, id);
    if (m) {
      startMidAt(w, m, 'green', t, true);
      continue;
    }
    const ci = crossingIndex(w, id);
    if (ci >= 0) {
      w.zs.midColor[ci] = 2;
      w.zs.pedSig[ci] = PedSignal.none;
    }
  }
}

export function planOf(w: World, nodeId: string): SignalPlan | undefined {
  const plans = w.signals.plans;
  if (planCache === null || planCache.plans !== plans) planCache = { plans, byNode: new Map(plans.map((p) => [p.nodeId, p])) };
  return planCache.byNode.get(nodeId);
}

/**
 * What the fixed-time plan shows at `tick` (a pure function of the tick). Its interval is on display since its
 * start by the plan clock, but not before `built` (the plans were (re)built then: an edit may have switched
 * the junction just now).
 */
export function shownAt(p: SignalPlan, tick: number, built: number): PlanShown {
  const tc = (tick + p.offset) % p.cycle;
  let i = 0;
  while (i < p.intervals.length - 1 && tc >= p.intervals[i]!.end) i++;
  const iv = p.intervals[i]!;
  const ws = tick - (tc - p.phaseStart[iv.phase]!);
  const walkEnd: number[] = [];
  const clrEnd: number[] = [];
  for (const ph of p.peds) {
    const walks = ph.walks[iv.phase]!;
    walkEnd.push(walks ? ws + ph.walk : -1);
    clrEnd.push(walks ? ws + ph.walk + ph.clearance : -1);
  }
  const color = iv.color === 'green' || iv.color === 'yellow' ? iv.color : 'allRed';
  return { phase: iv.phase, color, since: Math.max(built, tick - (tc - iv.start)), greenStart: Math.max(built, ws), walkEnd, clrEnd };
}

/** Clearance starting at tick t from what a plan of identity `id` showed (its last output was before t). */
export function clearingFrom(nodeId: string, id: PlanIdentity, s: PlanShown, t: number): SignalClearing {
  let yellowLanes: string[] = [];
  let yellowEnd = t;
  let allRedEnd = t;
  if (s.color === 'green' || s.color === 'yellow') {
    yellowLanes = id.phaseLanes[s.phase]!;
    yellowEnd = s.color === 'green' ? t + id.yellowTicks : s.since + id.yellowTicks;
    allRedEnd = yellowEnd + id.allRedTicks;
  } else if (s.phase !== id.scrambleIdx) allRedEnd = s.since + id.allRedTicks;
  const peds: SignalClearing['peds'] = [];
  for (let k = 0; k < id.pedIds.length; k++) {
    if (t < s.walkEnd[k]!) peds.push({ id: id.pedIds[k]!, start: t, end: t + id.pedClearance[k]! });
    else if (t < s.clrEnd[k]!) peds.push({ id: id.pedIds[k]!, start: s.clrEnd[k]! - id.pedClearance[k]!, end: s.clrEnd[k]! });
  }
  return { nodeId, yellowLanes, yellowEnd, allRedEnd, headless: false, peds };
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
export function startPlanAt(w: World, p: SignalPlan, phase: number, t: number): void {
  const offset = (((p.phaseStart[phase]! - t) % p.cycle) + p.cycle) % p.cycle;
  p.offset = offset;
  w.signalOffsets.set(p.nodeId, { key: p.id.key, offset });
  p.ctl = null;
  updateSignals({ plans: [p], mids: [] }, t, w.laneGreen, w.zs.pedSig, w.zs.midColor);
}

/**
 * Per tick, after updateSignals: advance every clearance (node id order). A finished one hands the junction
 * to `take` if given and it accepts (it then writes the junction), else to the new plan from its first
 * phase, else (no signal any more) to its unsignalized control.
 */
export function stepClearings(w: World, take?: (p: SignalPlan) => boolean, dark: (id: string) => boolean = () => false): void {
  const t = w.tick;
  if (w.midClearing.size > 0) stepMidClearings(w, dark);
  for (const nodeId of [...w.signalClearing.keys()].sort()) {
    const cl = w.signalClearing.get(nodeId)!;
    if (!clearingDone(cl, t)) {
      writeClearing(w, cl);
      continue;
    }
    w.signalClearing.delete(nodeId);
    const p = planOf(w, nodeId);
    if (!p) {
      for (const l of enteringLanes(w, nodeId)) w.laneGreen[l] = 1;
      for (const x of cl.peds) {
        const ci = crossingIndex(w, x.id);
        if (ci >= 0) w.zs.pedSig[ci] = PedSignal.none;
      }
      continue;
    }
    if (take && take(p)) continue;
    startPlanAt(w, p, 0, t);
  }
}

/** After a rebuild's updateSignals: show the clearances again. */
export function writeClearings(w: World): void {
  for (const cl of w.signalClearing.values()) writeClearing(w, cl);
  for (const mc of w.midClearing.values()) writeMidClearing(w, mc);
}

/**
 * Right after buildSignals, before updateSignals: keep re-phased offsets of unchanged plans; start a clearance
 * at every junction whose plan identity changed, that lost or gained its signal — except junctions already
 * clearing or driven by a controller (`driven`; the scenario controller converts those itself).
 */
export function reconcileSignals(w: World, old: SignalSet, driven: (nodeId: string) => boolean, darkCrossing: (id: string) => boolean = () => false): void {
  if (old.builtAt === undefined) return;
  for (const [nodeId, o] of [...w.signalOffsets]) {
    if (nodeId.startsWith('mid:')) {
      const m = midOf(w, nodeId.slice(4));
      if (m && m.key === o.key) m.offset = o.offset % m.cycle;
      else w.signalOffsets.delete(nodeId);
      continue;
    }
    const p = planOf(w, nodeId);
    if (p && p.id.key === o.key) p.offset = o.offset % p.cycle;
    else w.signalOffsets.delete(nodeId);
  }
  reconcileMids(w, old, darkCrossing);
  const t = w.tick;
  const oldBy = new Map(old.plans.map((p) => [p.nodeId, p]));
  const nodes = new Set([...oldBy.keys(), ...w.signals.plans.map((p) => p.nodeId)]);
  for (const nodeId of [...nodes].sort()) {
    if (w.signalClearing.has(nodeId) || driven(nodeId)) continue;
    const o = oldBy.get(nodeId);
    const p = planOf(w, nodeId);
    if (o && p && o.id.key === p.id.key) continue;
    if (o) {
      // Its last output: the previous tick, or this one if the old plan was itself built at this tick.
      const at = Math.max(t - 1, old.builtAt);
      w.signalClearing.set(nodeId, clearingFrom(nodeId, o.id, shownAt(o, at, old.builtAt), t));
    } else if (p) {
      // Newly signalized: every lane in was free (unsignalized control) — treat them as green.
      const yellowEnd = t + p.yellowTicks;
      const yellowLanes = enteringLanes(w, nodeId).map((l) => w.graph.lanes[l]!.id);
      w.signalClearing.set(nodeId, { nodeId, yellowLanes, yellowEnd, allRedEnd: yellowEnd + p.allRedTicks, headless: false, peds: [] });
    }
  }
  extendClearances(w);
}

/** Mid-block signal crosswalks of a rebuild, by crosswalk id: off / on / changed are switched safely. */
function reconcileMids(w: World, old: SignalSet, dark: (id: string) => boolean): void {
  const t = w.tick;
  const at = Math.max(t - 1, old.builtAt ?? 0);
  const oldBy = new Map(old.mids.map((m) => [m.id, m]));
  const ids = new Set([...oldBy.keys(), ...w.signals.mids.map((m) => m.id)]);
  for (const id of [...ids].sort()) {
    if (w.midClearing.has(id) || dark(id)) continue;
    const o = oldBy.get(id);
    const n = midOf(w, id);
    if (o && n && o.key === n.key) continue;
    // A crosswalk an edit made longer owes its new, longer clearance (the current geometry, signal or not).
    const owed = o ? midClearanceOwed(o, at, t, Math.max(o.clearance, geometricClearance(w, id))) : null;
    // Pedestrians had WALK / CLEARANCE: vehicles stay red until it is served in full.
    if (owed !== null && owed.until > t) w.midClearing.set(id, { id, start: owed.start, until: owed.until });
    else if (n) {
      // Vehicles were free (unsignalized) or had green; a yellow on display goes on into a full new yellow;
      // or the pedestrians' clearance ends just now.
      const tc = o ? (at + o.offset) % o.cycle : -1;
      if (owed !== null) startMidAt(w, n, 'green', t, false);
      else if (o && tc >= o.green) startMidAt(w, n, 'yellow', t, false);
      else switchMidOn(w, n, t, false);
    }
  }
}
