// DARK signals (ADR 0010 §4, power cut, 4c2-②): the signal-level mechanics; scenario/blackout.ts decides
// which signals are dark. A dark junction runs as an all-way stop: every lane into it needs a full stop
// and is served first come, first served (no turn priority), through the ordinary conflict / exit-space /
// crosswalk-zone reservations — vehicles already inside drain on their grants. Its crosswalks become
// unsignalized (12 s gate), except that a pedestrian WALK / CLEARANCE shown when the power went is served
// in full first (no new crossing meanwhile, as for any signal change). A dark mid-block signal crosswalk
// becomes unsignalized through the mid-block clearance rule (traffic/signalClearing.ts). Restoring power:
// a junction holds every lane red for its planned yellow + all-red (clearing the all-way-stop traffic),
// then starts its plan at its first phase (traffic/signalClearing.ts, or a pending emergency request);
// a mid-block crosswalk switches its signal on (vehicle green kept, else a full yellow first). `World.dark` is null while nothing is dark.

import { PedSignal } from '../types.js';
import { midClearanceOwed, midOf, planOf, switchMidOn, type SignalClearing } from './signalClearing.js';
import type { World } from './world.js';

export interface DarkJunction {
  /** Crosswalks still owed their flashing clearance from before the power cut. */
  peds: SignalClearing['peds'];
  /** Full-stop requirement of the lanes in before they went dark (lane id → value), restored with the power. */
  stopPrev: [string, number][];
}

export interface DarkState {
  junctions: Map<string, DarkJunction>;
  /** Dark mid-block signal crosswalks (crosswalk ids). */
  crossings: Set<string>;
  /** Per net node index: dark (no turn priority at grants). */
  nodeDark: Uint8Array;
}

function enteringLanes(w: World, nodeId: string): number[] {
  const node = w.graph.nodes.get(nodeId);
  if (!node) return [];
  const out: number[] = [];
  for (const segId of node.segments) for (const l of w.graph.segments.get(segId)!.lanes) if (w.graph.lanes[l]!.toNode === nodeId) out.push(l);
  return out;
}

function ensure(w: World): DarkState {
  w.dark ??= { junctions: new Map(), crossings: new Set(), nodeDark: new Uint8Array(w.net.nodeIds.length) };
  return w.dark;
}

function release(w: World): void {
  const d = w.dark;
  if (d && d.junctions.size === 0 && d.crossings.size === 0) w.dark = null;
}

/** Lanes into a dark junction need a full stop; the node loses its turn priority. */
function applyJunction(w: World, nodeId: string, rec: DarkJunction): void {
  const d = w.dark!;
  rec.stopPrev = [];
  for (const l of enteringLanes(w, nodeId)) {
    rec.stopPrev.push([w.graph.lanes[l]!.id, w.laneStopReq[l]!]);
    w.laneStopReq[l] = 1;
  }
  const ni = w.net.nodeIds.indexOf(nodeId);
  if (ni >= 0) d.nodeDark[ni] = 1;
}

/** Power cut at a junction (before updateSignals of tick t). `peds` = clearances it still owes. */
export function darkenJunction(w: World, nodeId: string, peds: SignalClearing['peds']): void {
  const d = ensure(w);
  if (d.junctions.has(nodeId)) return;
  w.signalClearing.delete(nodeId);
  const rec: DarkJunction = { peds, stopPrev: [] };
  d.junctions.set(nodeId, rec);
  applyJunction(w, nodeId, rec);
}

/** Power back at a junction (before updateSignals of tick t): all red for yellow + all-red, then its plan. */
export function restoreJunction(w: World, nodeId: string): void {
  const d = w.dark;
  const rec = d?.junctions.get(nodeId);
  if (!d || !rec) return;
  d.junctions.delete(nodeId);
  for (const [id, v] of rec.stopPrev) {
    const l = w.graph.laneById.get(id);
    if (l !== undefined) w.laneStopReq[l] = v;
  }
  const ni = w.net.nodeIds.indexOf(nodeId);
  if (ni >= 0) d.nodeDark[ni] = 0;
  const p = planOf(w, nodeId);
  const t = w.tick;
  const peds = rec.peds.filter((x) => x.end > t);
  if (p) w.signalClearing.set(nodeId, { nodeId, yellowLanes: [], yellowEnd: t, allRedEnd: t + p.yellowTicks + p.allRedTicks, headless: false, peds });
  // No signal any more (an edit while dark): owed clearances still run (lanes held), else plain unsignalized crosswalks.
  else if (peds.length > 0) w.signalClearing.set(nodeId, { nodeId, yellowLanes: [], yellowEnd: t, allRedEnd: t, headless: true, peds });
  else for (const cr of w.graph.crossings) if (cr.nodeId === nodeId) w.zs.pedSig[cr.index] = PedSignal.none;
  release(w);
}

/** Power cut at a mid-block signal crosswalk: a WALK / CLEARANCE on display is served in full first. */
export function darkenCrossing(w: World, id: string): void {
  const d = ensure(w);
  if (d.crossings.has(id)) return;
  d.crossings.add(id);
  const m = midOf(w, id);
  if (!m || w.midClearing.has(id)) return;
  const t = w.tick;
  const owed = midClearanceOwed(m, Math.max(t - 1, w.signals.builtAt ?? 0), t);
  if (owed !== null && owed.until > t) w.midClearing.set(id, { id, start: owed.start, until: owed.until });
}

/** Power back at a mid-block signal crosswalk: its signal restarts with its yellow (vehicles were free). */
export function restoreCrossing(w: World, id: string): void {
  const d = w.dark;
  if (!d || !d.crossings.delete(id)) return;
  const m = midOf(w, id);
  // Still clearing from the power cut: the clearance ends into the signal (its green) as usual.
  if (m && !w.midClearing.has(id)) {
    m.ctl = null;
    switchMidOn(w, m, w.tick, false);
  }
  release(w);
}

/** After a rebuild (recompile: new lane and node indexes): apply the dark state to the new network again. */
export function reapplyDark(w: World): void {
  const d = w.dark;
  if (!d) return;
  d.nodeDark = new Uint8Array(w.net.nodeIds.length);
  for (const [nodeId, rec] of d.junctions) applyJunction(w, nodeId, rec);
}

/** Per tick, after updateSignals and the controllers: dark junctions and crosswalks show no signal. */
export function writeDark(w: World): void {
  const d = w.dark!;
  const t = w.tick;
  const crossingsAt = new Map<string, number[]>();
  for (const cr of w.graph.crossings) {
    if (cr.nodeId === undefined || !d.junctions.has(cr.nodeId)) continue;
    const l = crossingsAt.get(cr.nodeId);
    if (l) l.push(cr.index);
    else crossingsAt.set(cr.nodeId, [cr.index]);
  }
  for (const [nodeId, rec] of d.junctions) {
    for (const l of enteringLanes(w, nodeId)) w.laneGreen[l] = 1;
    const flashing = new Set(rec.peds.filter((x) => t < x.end).map((x) => x.id));
    for (const ci of crossingsAt.get(nodeId) ?? []) w.zs.pedSig[ci] = flashing.has(w.graph.crossings[ci]!.id) ? PedSignal.clearance : PedSignal.none;
    const p = planOf(w, nodeId);
    if (p) p.ctl = { phase: -1, color: 'off', remaining: 0, segs: [] };
  }
  for (const id of d.crossings) {
    if (w.midClearing.has(id)) continue;
    const m = midOf(w, id);
    const ci = m ? m.ci : w.graph.crossings.findIndex((cr) => cr.id === id);
    if (ci < 0) continue;
    w.zs.midColor[ci] = 2;
    w.zs.pedSig[ci] = PedSignal.none;
    if (m) m.ctl = 'off';
  }
}
