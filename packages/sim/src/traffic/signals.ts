// Fixed-time signals. The state is a pure function of the tick (no drift, survives recompiles).
// Pedestrian heads (ADR 0008 §3): a junction crossing on leg L shows WALK for 7 s from the start of every
// green phase in which L's entry lanes are red and no green straight connector passes L's zone, then
// CLEARANCE for ⌈length / 1.0 m/s⌉ s, then RED. Phase greens are stretched to max(green, 7 + clearance −
// yellow). Signalized mid-block crossings run their own cycle: vehicles green 30 s, yellow 3 s, WALK 7 s +
// CLEARANCE. Pedestrian-only phase (ADR 0009 §3, `scramble` on a signal of degree 3–4 with ≥ 2 crosswalk
// legs, else ignored): appended after the vehicle phases, every vehicle lane red, no yellow, every crosswalk
// of the junction WALK 7 s then CLEARANCE ⌈longest crossing / 1.0⌉ s; vehicle phases then have no WALK.

import { pointAtLength, tangentAtLength, type CityDoc, type SegmentId, type SignalPhase } from '@smartcity/shared';
import type { ZoneIndex } from '../network/crossings.js';
import type { Net } from '../network/net.js';
import { PedSignal, type SignalColor, type SignalView } from '../types.js';

export const DEFAULT_GREEN = 20;
export const DEFAULT_YELLOW = 3;
export const DEFAULT_ALL_RED = 2;
export const PED_WALK = 7;
/** Design walking speed for the clearance interval, m/s. */
export const PED_DESIGN_SPEED = 1;
export const MID_GREEN = 30;
export const MID_YELLOW = 3;

interface Interval {
  phase: number;
  color: SignalColor | 'allRed';
  start: number;
  end: number;
}

export interface SignalHead {
  lane: number;
  x: number;
  z: number;
  heading: number;
}

export interface PedHead {
  /** Crossing index. */
  ci: number;
  /** Per phase: WALK starts with this phase's green. */
  walks: boolean[];
  walk: number;
  clearance: number;
}

/**
 * A plan in stable ids (computed when the plan is built, against the graph of that moment): what a signal
 * controller or an edit-time clearance (traffic/signalClearing.ts) is bound to instead of bare indices.
 */
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

export interface SignalPlan {
  nodeId: string;
  phases: SignalPhase[];
  intervals: Interval[];
  cycle: number;
  offset: number;
  heads: SignalHead[];
  /** Per head: the approach segment it controls. */
  headSeg: SegmentId[];
  /** Per phase: cycle tick where its green starts. */
  phaseStart: number[];
  peds: PedHead[];
  /** A pedestrian-only phase (the last one) is part of the cycle. */
  scramble: boolean;
  /** Per phase: ticks of its green interval (the pedestrian-only phase: its all-red interval). */
  greenTicks: number[];
  yellowTicks: number;
  allRedTicks: number;
  /** Current state, updated by updateSignals. */
  cur: number;
  remaining: number;
  /**
   * Shown state while the scenario signal controller drives this junction (ADR 0010 §4, scenario/preempt.ts);
   * null = the fixed-time plan above. Written by the controller every tick, cleared when it hands back.
   * `segs` = the approaches the color applies to (every other head is red); `phase` −1 = an edit-time clearance.
   */
  ctl: { phase: number; color: 'green' | 'yellow' | 'allRed'; remaining: number; segs: readonly string[] } | null;
  id: PlanIdentity;
}

/** Signalized mid-block crossing: fixed cycle green → yellow → red (WALK, CLEARANCE). */
export interface MidSignal {
  ci: number;
  green: number;
  yellow: number;
  walk: number;
  clearance: number;
  cycle: number;
  /** One head per lane crossing it, at the stop line. */
  heads: SignalHead[];
  color: SignalColor;
}

export interface SignalSet {
  plans: SignalPlan[];
  mids: MidSignal[];
  /** Tick the plans were (re)built at: what they show is on display since then at the earliest. */
  builtAt?: number;
}

/** Approaches of a node = segments with lanes entering it, with their outward angle. */
function approaches(net: Net, nodeId: string): { seg: SegmentId; angle: number; lanes: number[] }[] {
  const node = net.graph.nodes.get(nodeId)!;
  const out: { seg: SegmentId; angle: number; lanes: number[] }[] = [];
  for (const segId of node.segments) {
    const cs = net.graph.segments.get(segId)!;
    const lanes = cs.lanes.filter((l) => net.graph.lanes[l]!.toNode === nodeId);
    if (lanes.length === 0) continue;
    const p = net.graph.lanes[lanes[0]!]!.points;
    const end = p[p.length - 1]!;
    const prev = p[p.length - 2]!;
    // Outward direction from the node = reverse of the travel direction at the stop line.
    out.push({ seg: segId, angle: Math.atan2(prev.z - end.z, prev.x - end.x), lanes });
  }
  return out;
}

function autoPhases(list: { seg: SegmentId; angle: number }[]): SegmentId[][] {
  const sorted = list.slice().sort((p, q) => p.angle - q.angle || (p.seg < q.seg ? -1 : 1));
  const n = sorted.length;
  const opposition = (i: number, j: number): number => {
    let d = Math.abs(sorted[i]!.angle - sorted[j]!.angle) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return Math.PI - d;
  };
  if (n === 3 || n === 4 || n === 2) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const o = opposition(i, j);
        if (o < best - 1e-9) {
          best = o;
          bi = i;
          bj = j;
        }
      }
    if (n === 2 && best > Math.PI / 6) return sorted.map((a) => [a.seg]);
    const pair = [sorted[bi]!.seg, sorted[bj]!.seg];
    const rest = sorted.filter((_, k) => k !== bi && k !== bj).map((a) => a.seg);
    return rest.length ? [pair, rest] : [pair];
  }
  return sorted.map((a) => [a.seg]);
}

export function buildSignals(doc: CityDoc, net: Net, zones: ZoneIndex, tickRate: number): SignalSet {
  const plans: SignalPlan[] = [];
  const g = net.graph;
  const ticks = (sec: number): number => Math.max(0, Math.round(sec * tickRate));
  const clearanceOf = (ci: number): number => Math.ceil(zones.length[ci]! / PED_DESIGN_SPEED);
  const crossingsAt = new Map<string, number[]>();
  for (const cr of g.crossings) {
    if (cr.kind !== 'junction') continue;
    const l = crossingsAt.get(cr.nodeId!);
    if (l) l.push(cr.index);
    else crossingsAt.set(cr.nodeId!, [cr.index]);
  }
  for (let ni = 0; ni < net.nodeIds.length; ni++) {
    if (!net.nodeSignalized[ni]) continue;
    const nodeId = net.nodeIds[ni]!;
    const ctrl = doc.intersections[nodeId];
    const apps = approaches(net, nodeId);
    if (apps.length === 0) continue;
    const atNode = new Set(g.nodes.get(nodeId)!.segments);
    let phases: SignalPhase[] = [];
    if (ctrl?.phases) {
      for (const ph of ctrl.phases) {
        const a = ph.approaches.filter((s) => atNode.has(s));
        if (a.length) phases.push({ approaches: a, green: ph.green });
      }
      if (phases.length) {
        const covered = new Set(phases.flatMap((p) => p.approaches));
        for (const ap of apps) if (!covered.has(ap.seg)) phases.push({ approaches: [ap.seg], green: DEFAULT_GREEN });
      }
    }
    if (phases.length === 0) phases = autoPhases(apps).map((a) => ({ approaches: a, green: DEFAULT_GREEN }));
    const yellow = ctrl ? ctrl.yellow : DEFAULT_YELLOW;
    const allRed = ctrl ? ctrl.allRed : DEFAULT_ALL_RED;
    const cross = crossingsAt.get(nodeId) ?? [];
    const degree = g.nodes.get(nodeId)!.segments.length;
    const scramble = ctrl?.kind === 'signal' && ctrl.scramble === true && degree >= 3 && degree <= 4 && new Set(cross.map((ci) => g.crossings[ci]!.segmentId)).size >= 2;
    // Pedestrian-only phase: every crosswalk walks at once, only there.
    const scrambleClr = scramble ? Math.max(...cross.map(clearanceOf)) : 0;
    const peds: PedHead[] = [];
    if (scramble) {
      const nVeh = phases.length;
      phases.push({ approaches: [], green: PED_WALK + scrambleClr });
      for (const ci of cross) peds.push({ ci, walks: phases.map((_, k) => k === nVeh), walk: ticks(PED_WALK), clearance: ticks(scrambleClr) });
    }
    // Pedestrian heads: walk with a phase where the leg is red and no green straight movement crosses it.
    for (const ci of scramble ? [] : cross) {
      const leg = g.crossings[ci]!.segmentId;
      const passes = (k: number): boolean => {
        const green = phases[k]!.approaches;
        for (const p of zones.byZone[ci]!) {
          const c = g.connectors[p.edge - net.nLanes]!;
          if (c.turn === 'straight' && green.includes(g.lanes[c.fromLane]!.segmentId)) return true;
        }
        return false;
      };
      let walks = phases.map((ph, k) => !ph.approaches.includes(leg) && !passes(k));
      // Custom phases may leave no such phase: fall back to "leg red".
      if (!walks.some(Boolean)) walks = phases.map((ph) => !ph.approaches.includes(leg));
      peds.push({ ci, walks, walk: ticks(PED_WALK), clearance: ticks(clearanceOf(ci)) });
    }
    const intervals: Interval[] = [];
    const phaseStart: number[] = [];
    const greenTicks: number[] = [];
    let t = 0;
    phases.forEach((ph, i) => {
      let green = ph.green;
      for (const p of peds) if (p.walks[i]) green = Math.max(green, PED_WALK + clearanceOf(p.ci) - yellow);
      phaseStart.push(t);
      // The pedestrian-only phase: vehicles red throughout (an all-red interval), no yellow.
      const parts: [Interval['color'], number][] =
        scramble && i === phases.length - 1
          ? [['allRed', ticks(ph.green)]]
          : [
              ['green', Math.max(1, ticks(green))],
              ['yellow', ticks(yellow)],
              ['allRed', ticks(allRed)],
            ];
      greenTicks.push(parts[0]![1]);
      for (const [color, d] of parts) {
        if (d <= 0) continue;
        intervals.push({ phase: i, color, start: t, end: t + d });
        t += d;
      }
    });
    const heads: SignalHead[] = [];
    const headSeg: SegmentId[] = [];
    for (const ap of apps)
      for (const l of ap.lanes) {
        const p = g.lanes[l]!.points;
        const end = p[p.length - 1]!;
        const prev = p[p.length - 2]!;
        heads.push({ lane: l, x: end.x, z: end.z, heading: Math.atan2(end.z - prev.z, end.x - prev.x) });
        headSeg.push(ap.seg);
      }
    const offset = ticks(ctrl?.offset ?? 0);
    const laneId = (l: number): string => g.lanes[l]!.id;
    const pedIds = peds.map((ph) => g.crossings[ph.ci]!.id);
    const id: PlanIdentity = {
      key: JSON.stringify([
        phases.map((ph) => ph.approaches),
        greenTicks,
        ticks(yellow),
        ticks(allRed),
        t,
        offset,
        scramble,
        heads.map((hd, h) => [laneId(hd.lane), headSeg[h]]),
        peds.map((ph, k) => [pedIds[k], ph.walks, ph.walk, ph.clearance]),
      ]),
      yellowTicks: ticks(yellow),
      allRedTicks: ticks(allRed),
      phaseLanes: phases.map((ph) => heads.filter((_, h) => ph.approaches.includes(headSeg[h]!)).map((hd) => laneId(hd.lane))),
      pedIds,
      pedClearance: peds.map((ph) => ph.clearance),
      scrambleIdx: scramble ? phases.length - 1 : -1,
    };
    plans.push({
      nodeId,
      phases,
      intervals,
      cycle: t,
      offset,
      heads,
      headSeg,
      phaseStart,
      peds,
      scramble,
      greenTicks,
      yellowTicks: ticks(yellow),
      allRedTicks: ticks(allRed),
      cur: 0,
      remaining: 0,
      ctl: null,
      id,
    });
  }
  const mids: MidSignal[] = [];
  for (const cr of g.crossings) {
    if (cr.kind !== 'midblock' || !cr.signal) continue;
    const heads: SignalHead[] = [];
    for (const { edge, p } of zones.byZone[cr.index]!) {
      const l = g.lanes[edge]!;
      const pos = pointAtLength(l.points, l.cum, p.enterS);
      const tan = tangentAtLength(l.points, l.cum, Math.max(1e-6, p.enterS));
      heads.push({ lane: edge, x: pos.x, z: pos.z, heading: Math.atan2(tan.z, tan.x) });
    }
    const green = ticks(MID_GREEN);
    const yellow = ticks(MID_YELLOW);
    const walk = ticks(PED_WALK);
    const clearance = ticks(clearanceOf(cr.index));
    mids.push({ ci: cr.index, green, yellow, walk, clearance, cycle: green + yellow + walk + clearance, heads, color: 'green' });
  }
  return { plans, mids };
}

/**
 * Sets laneGreen for every lane entering a signalized node (other lanes stay 1), the pedestrian signal of
 * every signalized crossing (others keep PedSignal.none) and the vehicle color of mid-block signals
 * (`midColor`, 2 = green also for crossings without a signal).
 */
export function updateSignals(set: SignalSet, tick: number, laneGreen: Uint8Array, pedSig: Uint8Array, midColor: Uint8Array): void {
  for (const p of set.plans) {
    const tc = (tick + p.offset) % p.cycle;
    let i = 0;
    while (i < p.intervals.length - 1 && tc >= p.intervals[i]!.end) i++;
    p.cur = i;
    p.remaining = p.intervals[i]!.end - tc;
    const iv = p.intervals[i]!;
    const green = iv.color === 'green' ? p.phases[iv.phase]!.approaches : null;
    for (let h = 0; h < p.heads.length; h++) laneGreen[p.heads[h]!.lane] = green && green.includes(p.headSeg[h]!) ? 1 : 0;
    for (const ph of p.peds) {
      let sig: number = PedSignal.red;
      if (ph.walks[iv.phase]) {
        const el = tc - p.phaseStart[iv.phase]!;
        sig = el < ph.walk ? PedSignal.walk : el < ph.walk + ph.clearance ? PedSignal.clearance : PedSignal.red;
      }
      pedSig[ph.ci] = sig;
    }
  }
  for (const m of set.mids) {
    const tc = tick % m.cycle;
    m.color = tc < m.green ? 'green' : tc < m.green + m.yellow ? 'yellow' : 'red';
    midColor[m.ci] = m.color === 'green' ? 2 : m.color === 'yellow' ? 1 : 0;
    const el = tc - m.green - m.yellow;
    pedSig[m.ci] = el < 0 ? PedSignal.red : el < m.walk ? PedSignal.walk : PedSignal.clearance;
  }
}

/** Color shown to an approach: its phase's color while that phase runs, red otherwise. */
export function headColor(p: SignalPlan, h: number): SignalColor {
  if (p.ctl) return p.ctl.color !== 'allRed' && p.ctl.segs.includes(p.headSeg[h]!) ? p.ctl.color : 'red';
  const iv = p.intervals[p.cur]!;
  if (iv.color === 'allRed') return 'red';
  return p.phases[iv.phase]!.approaches.includes(p.headSeg[h]!) ? iv.color : 'red';
}

export function signalView(p: SignalPlan, tickRate: number): SignalView {
  const iv = p.ctl ?? p.intervals[p.cur]!;
  return {
    nodeId: p.nodeId,
    phaseIndex: iv.phase,
    color: iv.color === 'allRed' ? 'red' : iv.color,
    remaining: (p.ctl ? p.ctl.remaining : p.remaining) / tickRate,
    greenApproaches: iv.color !== 'green' ? [] : p.ctl ? p.ctl.segs.slice() : p.phases[iv.phase]!.approaches.slice(),
    cycle: p.cycle / tickRate,
    scramble: p.scramble,
  };
}
