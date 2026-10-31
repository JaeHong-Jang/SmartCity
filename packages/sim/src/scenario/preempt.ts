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
// new WALK starts while a controller drives the junction. This is the single safety executor of ADR 0015
// §2: its only input is a target phase per junction (control/a4Emergency.ts `signalTargets`: an emergency
// vehicle on a call — to the scene, or carrying a patient — whose next signalized stop line is within
// max(150 m, 15 s × speed) asks for the phase of its approach; A0 keeps one request per junction, the one
// being served, else ETA in whole ticks then vehicle id). The vehicle being served keeps the junction until
// its request disappears — once it is past the stop line (on the connector) — so two requests never make
// the junction switch back and forth.
// Plan clock: the fixed-time clock keeps running underneath; when no request is left the controller ends
// the served green safely and hands back at the START of the plan's next phase, re-phasing the plan's
// offset (kept across rebuilds in `sc.offsets` while the plan is unchanged) — never mid-interval.
//
// Edits: a controller is bound to its plan's identity (`PlanIdentity.key`: phase approach ids, head lane
// ids, crosswalk ids and the whole timing plan), never to bare indices. When an edit or recompile changes
// a driven junction's plan (or removes its signal), the controller turns into the edit-time CLEARANCE of
// traffic/signalClearing.ts — the one every junction gets in every mode — started from what the controller
// shows; it works on stable ids only: what was green shows its planned yellow at once (the edit cuts the green: the
// old phase may not exist in the new plan, so no minimum green), then the planned all-red, every WALK
// becomes a full CLEARANCE, and nothing enters (every lane into the junction held) until all of it ran.
// Only then the new plan starts at the beginning of its first phase — or a still-pending request is served
// on the new plan's phases — or, if the junction is no longer signalized, its new control takes over.

import { PedSignal } from '../types.js';
import { clearingFrom, planOf, shownAt, startPlanAt, stepClearings, type PlanShown } from '../traffic/signalClearing.js';
import type { PlanIdentity, SignalPlan } from '../traffic/signals.js';
import type { World } from '../traffic/world.js';
import { signalTargets } from './controlAdapter.js';

export type SignalMode = 'normal' | 'preempt' | 'dark';

/** Minimum green before a controller ends a green (capped by the phase's own planned green). */
export const PREEMPT_MIN_GREEN = 5;

export interface SignalCtl extends PlanShown {
  nodeId: string;
  mode: Exclude<SignalMode, 'normal'>;
  /** The plan it drives (a rebuilt plan with another key ends the control: traffic/signalClearing.ts). */
  id: PlanIdentity;
  /** Request served now (vehicle id, phase), −1 = none: ending the green and handing back to the plan. */
  vehicleId: number;
  target: number;
}

/** Take over a junction in the state the fixed-time plan shows at tick t (updateSignals ran this tick). */
function takeOver(w: World, p: SignalPlan, t: number): SignalCtl {
  return { ...shownAt(p, t, w.signals.builtAt ?? 0), nodeId: p.nodeId, mode: 'preempt', id: p.id, vehicleId: -1, target: -1 };
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

const darkCrossing = (w: World) => (id: string): boolean => w.dark !== null && w.dark.crossings.has(id);

/**
 * Per tick, after updateSignals: the signal stage's target phases (A4 → A0), then clearances, then targets →
 * controllers (create, advance, hand back) → outputs.
 */
export function updatePreemption(w: World): void {
  const sc = w.sc!;
  const minGreen = Math.round(PREEMPT_MIN_GREEN * w.tickRate);
  const targets = signalTargets(w);
  const t = w.tick;
  // A finished clearance goes to a pending request on the new plan's phases at once, else to the plan.
  const clearing = new Set(w.signalClearing.keys());
  stepClearings(w, (p) => {
    const r = targets.get(p.nodeId);
    if (r === undefined) return false;
    const c: SignalCtl = { nodeId: p.nodeId, mode: 'preempt', id: p.id, phase: r.phase, color: 'green', since: t, greenStart: t, walkEnd: p.peds.map(() => -1), clrEnd: p.peds.map(() => -1), vehicleId: r.vehicleId, target: r.phase };
    sc.ctl.set(p.nodeId, c);
    write(w, p, c);
    return true;
  }, darkCrossing(w));
  const nodes = new Set<string>([...targets.keys(), ...sc.ctl.keys()]);
  for (const nodeId of [...nodes].sort()) {
    if (clearing.has(nodeId)) continue;
    const p = planOf(w, nodeId);
    if (p === undefined) continue;
    let c = sc.ctl.get(nodeId);
    const r = targets.get(nodeId);
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
    startPlanAt(w, p, (c.phase + 1) % p.phases.length, t);
  }
}

/**
 * Right after buildSignals (an edit or recompile), before reconcileSignals: a controller whose plan changed
 * (identity key) or vanished becomes the edit-time clearance, started from what it shows.
 */
export function rebindSignalControl(w: World): void {
  const sc = w.sc!;
  for (const [nodeId, c] of [...sc.ctl]) {
    const p = planOf(w, nodeId);
    if (p && p.id.key === c.id.key) continue;
    sc.ctl.delete(nodeId);
    w.signalClearing.set(nodeId, clearingFrom(nodeId, c.id, c, w.tick));
  }
}

/** After a rebuild's updateSignals: show the driven junctions again. */
export function writeSignalControl(w: World): void {
  for (const [nodeId, c] of w.sc!.ctl) write(w, planOf(w, nodeId)!, c);
}

/** Junctions a controller or a clearance drives now (ScenarioView.preempted), node id order. */
export function controlledJunctions(w: World): { nodeId: string; vehicleId: number; phase: number; color: 'green' | 'yellow' | 'red' }[] {
  const out: { nodeId: string; vehicleId: number; phase: number; color: 'green' | 'yellow' | 'red' }[] = [];
  for (const c of w.sc!.ctl.values()) out.push({ nodeId: c.nodeId, vehicleId: c.vehicleId, phase: c.phase, color: c.color === 'allRed' ? 'red' : c.color });
  for (const cl of w.signalClearing.values()) out.push({ nodeId: cl.nodeId, vehicleId: -1, phase: -1, color: w.tick < cl.yellowEnd && cl.yellowLanes.length > 0 && !cl.headless ? 'yellow' : 'red' });
  return out.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}
