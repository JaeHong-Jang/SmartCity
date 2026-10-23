// Fixed-time signals. The state is a pure function of the tick (no drift, survives recompiles).

import type { CityDoc, SegmentId, SignalPhase } from '@smartcity/shared';
import type { Net } from '../network/net.js';
import type { SignalColor, SignalView } from '../types.js';

export const DEFAULT_GREEN = 20;
export const DEFAULT_YELLOW = 3;
export const DEFAULT_ALL_RED = 2;

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

export interface SignalPlan {
  nodeId: string;
  phases: SignalPhase[];
  intervals: Interval[];
  cycle: number;
  offset: number;
  heads: SignalHead[];
  /** Per head: the approach segment it controls. */
  headSeg: SegmentId[];
  /** Current state, updated by updateSignals. */
  cur: number;
  remaining: number;
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

export function buildSignals(doc: CityDoc, net: Net, tickRate: number): SignalPlan[] {
  const plans: SignalPlan[] = [];
  for (let ni = 0; ni < net.nodeIds.length; ni++) {
    if (!net.nodeSignalized[ni]) continue;
    const nodeId = net.nodeIds[ni]!;
    const ctrl = doc.intersections[nodeId];
    const apps = approaches(net, nodeId);
    if (apps.length === 0) continue;
    const atNode = new Set(net.graph.nodes.get(nodeId)!.segments);
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
    const ticks = (sec: number): number => Math.max(0, Math.round(sec * tickRate));
    const intervals: Interval[] = [];
    let t = 0;
    phases.forEach((ph, i) => {
      const parts: [Interval['color'], number][] = [
        ['green', Math.max(1, ticks(ph.green))],
        ['yellow', ticks(yellow)],
        ['allRed', ticks(allRed)],
      ];
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
        const p = net.graph.lanes[l]!.points;
        const end = p[p.length - 1]!;
        const prev = p[p.length - 2]!;
        heads.push({ lane: l, x: end.x, z: end.z, heading: Math.atan2(end.z - prev.z, end.x - prev.x) });
        headSeg.push(ap.seg);
      }
    plans.push({ nodeId, phases, intervals, cycle: t, offset: ticks(ctrl?.offset ?? 0), heads, headSeg, cur: 0, remaining: 0 });
  }
  return plans;
}

/** Sets laneGreen for every lane entering a signalized node; other lanes stay 1. */
export function updateSignals(plans: SignalPlan[], tick: number, laneGreen: Uint8Array): void {
  for (const p of plans) {
    const tc = (tick + p.offset) % p.cycle;
    let i = 0;
    while (i < p.intervals.length - 1 && tc >= p.intervals[i]!.end) i++;
    p.cur = i;
    p.remaining = p.intervals[i]!.end - tc;
    const iv = p.intervals[i]!;
    const green = iv.color === 'green' ? p.phases[iv.phase]!.approaches : null;
    for (let h = 0; h < p.heads.length; h++) laneGreen[p.heads[h]!.lane] = green && green.includes(p.headSeg[h]!) ? 1 : 0;
  }
}

/** Color shown to an approach: its phase's color while that phase runs, red otherwise. */
export function headColor(p: SignalPlan, h: number): SignalColor {
  const iv = p.intervals[p.cur]!;
  if (iv.color === 'allRed') return 'red';
  return p.phases[iv.phase]!.approaches.includes(p.headSeg[h]!) ? iv.color : 'red';
}

export function signalView(p: SignalPlan, tickRate: number): SignalView {
  const iv = p.intervals[p.cur]!;
  return {
    nodeId: p.nodeId,
    phaseIndex: iv.phase,
    color: iv.color === 'allRed' ? 'red' : iv.color,
    remaining: p.remaining / tickRate,
    greenApproaches: iv.color === 'green' ? p.phases[iv.phase]!.approaches.slice() : [],
  };
}
