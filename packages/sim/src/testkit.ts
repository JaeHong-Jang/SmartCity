// Test helpers: document builders and physical invariant checks over the simulation internals.

import { applyCommand, createEmptyDoc, type CityDoc, type Command } from '@smartcity/shared';
import type { Simulation } from './simulation.js';
import type { World } from './traffic/world.js';

export function apply(doc: CityDoc, cmds: Command[]): CityDoc {
  const r = applyCommand(doc, { type: 'batch', commands: cmds });
  if (!r.ok) throw new Error(r.error);
  return doc;
}

/** n × n grid of nodes `n_i_j` (x = i·spacing), segments `h_i_j` (i→i+1) and `v_i_j` (j→j+1). */
export function gridDoc(n: number, spacing: number, roadTypeId = 'road-4', seed = 7): CityDoc {
  const doc = createEmptyDoc('grid', seed);
  const cmds: Command[] = [];
  const off = ((n - 1) * spacing) / 2;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) cmds.push({ type: 'node.add', node: { id: `n_${i}_${j}`, pos: { x: i * spacing - off, z: j * spacing - off } } });
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) cmds.push({ type: 'segment.add', segment: { id: `h_${i}_${j}`, a: `n_${i}_${j}`, b: `n_${i + 1}_${j}`, roadTypeId } });
      if (j + 1 < n) cmds.push({ type: 'segment.add', segment: { id: `v_${i}_${j}`, a: `n_${i}_${j}`, b: `n_${i}_${j + 1}`, roadTypeId } });
    }
  for (let k = 0; k < cmds.length; k += 1000) apply(doc, cmds.slice(k, k + 1000));
  return doc;
}

/**
 * Four-arm crossing around node `c` at the origin. Arm nodes `n` (z −), `s` (z +), `w` (x −), `e` (x +).
 * Segments `N`, `S`, `W`, `E` run from the arm node to the center (forward = towards the center).
 */
export function crossDoc(arm: number, roadTypeId = 'road-2'): CityDoc {
  const doc = createEmptyDoc('cross', 3);
  const pos: Record<string, { x: number; z: number }> = { n: { x: 0, z: -arm }, s: { x: 0, z: arm }, w: { x: -arm, z: 0 }, e: { x: arm, z: 0 } };
  const cmds: Command[] = [{ type: 'node.add', node: { id: 'c', pos: { x: 0, z: 0 } } }];
  for (const k of Object.keys(pos)) cmds.push({ type: 'node.add', node: { id: k, pos: pos[k]! } });
  for (const k of Object.keys(pos)) cmds.push({ type: 'segment.add', segment: { id: k.toUpperCase(), a: k, b: 'c', roadTypeId } });
  return apply(doc, cmds);
}

export const internals = (sim: Simulation): World => (sim as unknown as { w: World }).w;

/**
 * Physical checks: (1) no two vehicle bodies overlap on any edge (bodies are walked back along the
 * route so overhanging tails count), (2) no two conflicting connectors are physically occupied by
 * different vehicles, (3) every physically occupied connector is held. Returns problems found.
 */
export function checkInvariants(sim: Simulation): string[] {
  const w = internals(sim);
  const net = w.net;
  const problems: string[] = [];
  const intervals = new Map<number, { a: number; b: number; id: number }[]>();
  const occ = new Map<number, Set<number>>();
  const add = (e: number, a: number, b: number, id: number): void => {
    let l = intervals.get(e);
    if (!l) intervals.set(e, (l = []));
    l.push({ a, b, id });
    if (e >= net.nLanes) {
      const c = e - net.nLanes;
      let set = occ.get(c);
      if (!set) occ.set(c, (set = new Set()));
      set.add(id);
    }
  };
  for (const v of w.vehicles) {
    add(v.edge, Math.max(0, v.s - v.len), v.s, v.id);
    let over = v.len - v.s;
    for (let j = v.ri - 1; j >= 0 && over > 1e-6; j--) {
      const e = v.route[j]!;
      const L = net.len[e]!;
      add(e, Math.max(0, L - over), L, v.id);
      over -= L;
    }
  }
  for (const [e, list] of intervals) {
    list.sort((p, q) => p.a - q.a);
    for (let i = 1; i < list.length; i++)
      if (list[i]!.a < list[i - 1]!.b - 1e-6 && list[i]!.id !== list[i - 1]!.id)
        problems.push(`overlap on edge ${e}: ${list[i - 1]!.id} [${list[i - 1]!.a.toFixed(2)},${list[i - 1]!.b.toFixed(2)}] vs ${list[i]!.id} [${list[i]!.a.toFixed(2)},${list[i]!.b.toFixed(2)}]`);
  }
  const held = new Int32Array(w.holders.length);
  for (const v of w.vehicles) for (const h of v.held) held[h.c]!++;
  for (let c = 0; c < held.length; c++) if (held[c] !== w.holders[c]) problems.push(`holder count mismatch on connector ${c}`);
  for (const [c, ids] of occ) {
    if (w.holders[c]! < ids.size) problems.push(`connector ${c} occupied by ${ids.size} vehicles but held ${w.holders[c]}`);
    for (const k of w.graph.connectors[c]!.conflicts) {
      const other = occ.get(k);
      if (other) problems.push(`conflicting connectors ${c} [${[...ids]}] and ${k} [${[...other]}] both occupied`);
    }
  }
  return problems;
}
