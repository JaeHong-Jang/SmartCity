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

import { PedSignal } from '../types.js';
import { updateSignals, type PlanIdentity, type SignalPlan, type SignalSet } from './signals.js';
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
  /** Crosswalks in their flashing clearance until `end`. */
  peds: { id: string; end: number }[];
}

let planCache: { plans: SignalPlan[]; byNode: Map<string, SignalPlan> } | null = null;

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
    if (t < s.walkEnd[k]!) peds.push({ id: id.pedIds[k]!, end: t + id.pedClearance[k]! });
    else if (t < s.clrEnd[k]!) peds.push({ id: id.pedIds[k]!, end: s.clrEnd[k]! });
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
export function stepClearings(w: World, take?: (p: SignalPlan) => boolean): void {
  const t = w.tick;
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
}

/**
 * Right after buildSignals, before updateSignals: keep re-phased offsets of unchanged plans; start a clearance
 * at every junction whose plan identity changed, that lost or gained its signal — except junctions already
 * clearing or driven by a controller (`driven`; the scenario controller converts those itself).
 */
export function reconcileSignals(w: World, old: SignalSet, driven: (nodeId: string) => boolean): void {
  if (old.builtAt === undefined) return;
  for (const [nodeId, o] of [...w.signalOffsets]) {
    const p = planOf(w, nodeId);
    if (p && p.id.key === o.key) p.offset = o.offset % p.cycle;
    else w.signalOffsets.delete(nodeId);
  }
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
}
