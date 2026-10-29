// Test helpers: document builders and physical invariant checks over the simulation internals.

import { applyCommand, createEmptyDoc, type CityDoc, type Command, type Rng } from '@smartcity/shared';
import type { Simulation } from './simulation.js';
import { clearanceTicks, headColor } from './traffic/signals.js';
import type { World } from './traffic/world.js';
import { PedSignal } from './types.js';
import { PREEMPT_MIN_GREEN } from './scenario/preempt.js';

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

/** Straight road `a` → `b` (forward = +x) of the given length, both ends dead ends. Segment id `ab`. */
export function lineDoc(length: number, roadTypeId = 'road-2', cmds: Command[] = []): CityDoc {
  const doc = createEmptyDoc('line', 5);
  return apply(doc, [
    { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
    { type: 'node.add', node: { id: 'b', pos: { x: length, z: 0 } } },
    { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId } },
    ...cmds,
  ]);
}

/**
 * Conflict-zone checks (ADR 0008 §3): (0) every vehicle's route history covers its whole body,
 * (1) every vehicle body inside a zone passage holds that zone,
 * (2) holder counts match the vehicles' reservations, (3) no zone has a vehicle body and a pedestrian on
 * its crossing at the same time, (4) pedestrian holder counts match the pedestrians' grants.
 */
export function checkZoneInvariants(sim: Simulation): string[] {
  const w = internals(sim);
  const net = w.net;
  const nLanes = net.nLanes;
  const nz = w.graph.crossings.length;
  const problems: string[] = [];
  const vehIn = new Int32Array(nz);
  for (const v of w.vehicles) {
    // The route history must reach back to the tail; otherwise a body over a zone could go unseen.
    let covered = v.s;
    for (let j = v.ri - 1; j >= 0 && covered < v.len - 1e-6; j--) covered += net.len[v.route[j]!]!;
    if (covered < v.len - 1e-6) problems.push(`vehicle ${v.id}: body extends ${(v.len - covered).toFixed(2)} m past its route history`);
    let front = v.s;
    for (let j = v.ri; j >= 0; j--) {
      const e = v.route[j]!;
      if (j < v.ri) front += net.len[e]!;
      if (j < v.ri && front - v.len >= net.len[e]!) break;
      const list = e < nLanes ? w.zones.lane[e]! : w.zones.conn[e - nLanes]!;
      for (const p of list) {
        if (front <= p.enterS + 1e-6 || front - v.len >= p.exitS - 1e-6) continue;
        vehIn[p.z]!++;
        if (!v.zones.some((h) => h.z === p.z)) problems.push(`vehicle ${v.id} inside zone ${p.z} without a reservation`);
      }
    }
  }
  const held = new Int32Array(nz);
  for (const v of w.vehicles) for (const h of v.zones) held[h.z]!++;
  for (let z = 0; z < nz; z++) if (held[z] !== w.zs.veh[z]) problems.push(`zone ${z}: vehicle holders ${w.zs.veh[z]} but ${held[z]} reservations`);
  const pedOn = pedestriansOnCrossings(sim);
  const pedHeld = new Int32Array(nz);
  const p = w.peds;
  if (p) for (let i = 0; i < p.hi; i++) if (p.alive[i] && p.grant[i]! >= 0) pedHeld[p.grant[i]!]!++;
  for (let z = 0; z < nz; z++) {
    if (pedHeld[z] !== w.zs.ped[z]) problems.push(`zone ${z}: pedestrian holders ${w.zs.ped[z]} but ${pedHeld[z]} grants`);
    if (pedOn[z]! > 0 && vehIn[z]! > 0) problems.push(`zone ${z} (${w.graph.crossings[z]!.id}): ${vehIn[z]} vehicle bodies and ${pedOn[z]} pedestrians at once`);
    if (pedOn[z]! > 0 && w.zs.veh[z]! > 0) problems.push(`zone ${z}: pedestrians on it while vehicles hold it`);
  }
  return problems;
}

/** Pedestrians physically on each crossing edge. */
export function pedestriansOnCrossings(sim: Simulation): Int32Array {
  const w = internals(sim);
  const out = new Int32Array(w.graph.crossings.length);
  const p = w.peds;
  if (!p) return out;
  for (let i = 0; i < p.hi; i++) {
    if (!p.alive[i] || p.edge[i]! < 0) continue;
    const z = w.ped.pg.crossing[p.edge[i]!]!;
    if (z >= 0) out[z]!++;
  }
  return out;
}

/**
 * Citizen bookkeeping: per-state counts match the citizens, their sum is the total, every outdoor citizen
 * owns exactly one live pedestrian or car (and nothing else does), indoor citizens are in an existing building.
 * Bus passengers (ADR 0009 §2): a waiting citizen keeps its pedestrian and is in exactly one stop queue, a
 * riding one has no pedestrian or car and is in exactly one live bus's riders or alighting list; queues and
 * buses hold no duplicates and no orphans (entries of citizens that are gone or in another state).
 */
export function checkCitizenInvariants(sim: Simulation): string[] {
  const w = internals(sim);
  const cz = w.cz;
  const p = w.peds;
  const problems: string[] = [];
  const counts = new Int32Array(cz.counts.length);
  let n = 0;
  const pedOwner = new Map<number, number>();
  for (const c of cz.slots) {
    if (!c) continue;
    n++;
    counts[c.state]!++;
    const indoor = c.state === 0 || c.state === 5 || c.state === 6;
    if (indoor) {
      if (c.at === null || !w.doc.buildings[c.at]) problems.push(`citizen ${c.id} indoors in a missing building`);
      if (c.ped >= 0 || c.car) problems.push(`citizen ${c.id} indoors with a pedestrian or car`);
    } else if (c.state === 3) {
      if (!c.car || !c.car.alive || c.car.person !== c.slot || c.ped >= 0) problems.push(`citizen ${c.id} driving without its car`);
    } else if (c.state === 9) {
      if (c.ped >= 0 || c.car || !c.ride || !c.ride.alive || !c.ride.bus) problems.push(`citizen ${c.id} riding without a live bus (or with a pedestrian/car)`);
    } else {
      if (c.ped < 0 || !p.alive[c.ped] || p.owner[c.ped] !== c.slot || p.pid[c.ped] !== c.id) problems.push(`citizen ${c.id} outdoors without its pedestrian`);
      if (c.car) problems.push(`citizen ${c.id} walking with a car`);
      pedOwner.set(c.ped, c.slot);
    }
  }
  if (n !== cz.count) problems.push(`count ${cz.count} but ${n} citizens`);
  let sum = 0;
  for (let s = 0; s < counts.length; s++) {
    sum += cz.counts[s]!;
    if (counts[s] !== cz.counts[s]) problems.push(`state ${s}: counted ${cz.counts[s]} but ${counts[s]} citizens`);
  }
  if (sum !== cz.count) problems.push(`state sum ${sum} != total ${cz.count}`);
  const st = sim.stats().citizens;
  if (st.home + st.atWork + st.walking + st.driving + st.waitingBus + st.riding !== st.total) problems.push('stats.citizens does not add up');
  for (let i = 0; i < p.hi; i++) if (p.alive[i] && p.owner[i]! >= 0 && pedOwner.get(i) !== p.owner[i]) problems.push(`pedestrian ${i} owned by citizen slot ${p.owner[i]} that does not own it`);
  for (const v of w.vehicles) if (v.person >= 0 && cz.slots[v.person]?.car !== v) problems.push(`vehicle ${v.id} linked to a citizen that does not drive it`);
  let alive = 0;
  for (let i = 0; i < p.hi; i++) if (p.alive[i]) alive++;
  if (alive !== p.count) problems.push(`pedestrian count ${p.count} but ${alive} alive`);
  // Bus relations: every entry once, matching the citizen's state and references.
  const where = new Map<number, string[]>();
  const note = (slot: number, what: string): void => {
    const l = where.get(slot);
    if (l) l.push(what);
    else where.set(slot, [what]);
  };
  for (const [key, q] of w.transit.queues) {
    if (q.list.length === 0) problems.push(`empty queue ${key} kept`);
    for (let k = 0; k < q.list.length; k++) {
      const wt = q.list[k]!;
      const prev = q.list[k - 1];
      if (prev && (prev.tick > wt.tick || (prev.tick === wt.tick && prev.pid >= wt.pid))) problems.push(`queue ${key} not in (tick, id) order`);
      const c = cz.slots[wt.slot];
      if (!c || c.id !== wt.pid) problems.push(`queue ${key}: orphan entry ${wt.pid}`);
      else if (c.state !== 8 || c.board !== q.stop || c.line !== q.line) problems.push(`queue ${key}: citizen ${c.id} in state ${c.state} (${c.board}|${c.line})`);
      note(wt.slot, `queue ${key}`);
    }
  }
  for (const v of w.vehicles) {
    if (!v.bus) continue;
    for (const r of v.bus.riders) {
      const c = cz.slots[r.slot];
      if (!c || c.state !== 9 || c.ride !== v) problems.push(`bus ${v.id}: rider slot ${r.slot} is not riding it`);
      note(r.slot, `riders of ${v.id}`);
    }
    for (const slot of v.bus.alighting) {
      const c = cz.slots[slot];
      if (!c || c.state !== 9 || c.ride !== v) problems.push(`bus ${v.id}: alighting slot ${slot} is not riding it`);
      note(slot, `alighting of ${v.id}`);
    }
  }
  for (const c of cz.slots) {
    if (!c) continue;
    const n = where.get(c.slot)?.length ?? 0;
    const want = c.state === 8 || c.state === 9 ? 1 : 0;
    if (n !== want) problems.push(`citizen ${c.id} (state ${c.state}) in ${n} bus relations: ${where.get(c.slot)?.join(', ') ?? '-'}`);
    if (c.state === 8 && p.state[c.ped] !== 3) problems.push(`citizen ${c.id} waiting but its pedestrian is not in state busStop`);
  }
  for (const slot of where.keys()) if (!cz.slots[slot]) problems.push(`bus relation of a removed citizen slot ${slot}`);
  return problems;
}

/** 3 × 3 grid (spacing m, road-2) with homes, offices and shops placed inside the blocks. */
export function cityDoc(spacing = 150, seed = 7): CityDoc {
  const doc = gridDoc(3, spacing, 'road-2', seed);
  const h = spacing;
  const place = (id: string, typeId: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
  return apply(doc, [
    place('apt1', 'apartment', -h / 2, -h + 20),
    place('apt2', 'apartment', -h / 2, h - 20),
    place('house1', 'house', -h + 15, -h / 2),
    place('house2', 'house', h - 15, h / 2),
    place('office1', 'office-tower', h / 2, -h / 2),
    place('shop1', 'shop', h / 2, h - 15),
    place('shop2', 'shop', -15, 15),
  ]);
}

/** Overlaps between scenario obstacles and vehicle bodies (bodies walked back along the route, as in checkInvariants). */
export function checkObstacleOverlaps(sim: Simulation): string[] {
  const w = internals(sim);
  const obs = w.sc?.obs;
  if (!obs) return [];
  const problems: string[] = [];
  const check = (id: number, e: number, a: number, b: number): void => {
    if (e >= w.net.nLanes) return;
    for (const o of obs[e]!) if (a < o.rear + o.len - 1e-6 && b > o.rear + 1e-6) problems.push(`vehicle ${id} [${a.toFixed(2)},${b.toFixed(2)}] overlaps obstacle ${o.eventId} on lane ${e}`);
  };
  for (const v of w.vehicles) {
    check(v.id, v.edge, Math.max(0, v.s - v.len), v.s);
    let over = v.len - v.s;
    for (let j = v.ri - 1; j >= 0 && over > 1e-6; j--) {
      const e = v.route[j]!;
      const L = w.net.len[e]!;
      check(v.id, e, Math.max(0, L - over), L);
      over -= L;
    }
  }
  return problems;
}

/**
 * Emergency bookkeeping (ADR 0010 §3): no orphans. Every active incident either has its mission (listed,
 * pointing back at it, with a vehicle on the network, a departure waiting for room, or parked at the scene
 * while it works) or is in a state that progresses on its own — burning (fire) / waiting for a vehicle —
 * with a dispatch retry scheduled. Every mission is listed once and has a vehicle, a pending departure or
 * (working) its incident; vehicles marked as emergency belong to a listed mission.
 */
export function checkIncidentInvariants(sim: Simulation): string[] {
  const w = internals(sim);
  const sc = w.sc;
  if (!sc) return [];
  const problems: string[] = [];
  const live = (m: NonNullable<(typeof sc.incidents)[number]['mission']>): boolean =>
    (m.v !== null && m.v.alive && m.v.em === m) || (m.v === null && m.spawn !== null) || (m.v === null && m.stage === 'working' && m.incident.mission === m);
  for (const inc of sc.incidents) {
    const m = inc.mission;
    if (m !== null) {
      if (!sc.missions.includes(m) || m.incident !== inc) problems.push(`incident ${inc.eventId}: mission not listed`);
      else if (!live(m)) problems.push(`incident ${inc.eventId}: mission ${m.stage} has no vehicle, departure or parking`);
      continue;
    }
    if (inc.state !== 'burning' && inc.state !== 'waiting') problems.push(`incident ${inc.eventId}: orphan in state ${inc.state}`);
    // Not known yet (ADR 0013): it waits for its detection, which is always scheduled (the report).
    else if (inc.knownTick < 0) {
      if (!sc.det.pending.some((p) => p.eventId === inc.eventId)) problems.push(`incident ${inc.eventId}: unknown and not awaiting detection`);
    } else if (inc.retryAt < 0) problems.push(`incident ${inc.eventId}: no vehicle and no dispatch retry`);
  }
  if (new Set(sc.missions).size !== sc.missions.length) problems.push('mission listed twice');
  for (const m of sc.missions) if (!live(m)) problems.push(`mission of ${m.incident.eventId} (${m.stage}) has no vehicle, departure or incident`);
  for (const v of w.vehicles) if (v.alive && v.em !== null && !sc.missions.includes(v.em)) problems.push(`emergency vehicle ${v.id} without a listed mission`);
  return problems;
}

type Shown = { kind: 'G' | 'Y' | 'R' | 'F'; key: string; since: number; need: number; yellow: number; allRed: number; redNeed: number; dark: boolean; fromDark: boolean };

/**
 * Observes every junction that is (or was) signalized, tick by tick, by stable ids, and reports safety
 * violations — across edits and recompiles too:
 * - green only to the approaches of one plan phase (no conflicting movements of different phases at once);
 * - green → (≥ yellow) yellow → (≥ all-red) all red → another green; never green → green of other approaches;
 *   a junction that lost its signal ('F' = unsignalized operation) holds every lane ≥ yellow + all-red first;
 * - every green lasts ≥ min(5 s, the phase's planned green), except a green an edit cut (`edited`);
 * - a pedestrian WALK or CLEARANCE never shows while its leg's entry lanes or a straight movement across the
 *   crosswalk is green (scramble junctions: while any lane is green); WALK always ends in a full CLEARANCE.
 */
export class SignalWatch {
  private shown = new Map<string, Shown>();
  private ped = new Map<string, { sig: number; since: number; clearance: number }>();
  private edits = new Map<string, number>();
  private mid = new Map<string, { color: number; since: number; yellow: number }>();
  /** Crosswalks that left WALK: when, and the most clearance their geometry required while flashing. */
  private exit = new Map<string, { start: number; need: number }>();
  /** WALK exits whose clearance was checked against the crosswalk's (current, longest) length. */
  clearanceChecks = 0;
  /** Junction-ticks and crosswalk-ticks seen dark. */
  darkTicks = 0;
  readonly problems: string[] = [];
  controlledTicks = 0;
  clearingTicks = 0;
  /** Phase changes seen while a controller drove the junction (entries into a new green). */
  controlledGreens = 0;
  private conflictLanes = new Map<string, Set<number>>();

  constructor(private readonly sim: Simulation) {}

  /** An edit applied now that may change this junction's plan (a green it cuts short is not a min-green fault). */
  edited(nodeId: string): void {
    this.edits.set(nodeId, internals(this.sim).tick);
  }


  private lanesAgainst(ci: number, scramble: boolean, node: string): Set<number> {
    const w = internals(this.sim);
    const k = `${w.graphRevision}|${ci}|${scramble}`;
    let set = this.conflictLanes.get(k);
    if (set) return set;
    set = new Set<number>();
    const cr = w.graph.crossings[ci]!;
    for (const l of w.graph.lanes) if (l.toNode === node && (scramble || l.segmentId === cr.segmentId)) set.add(l.index);
    for (const p of w.zones.byZone[ci]!) {
      if (p.edge < w.net.nLanes) continue;
      const c = w.graph.connectors[p.edge - w.net.nLanes]!;
      if (c.turn === 'straight') set.add(c.fromLane);
    }
    this.conflictLanes.set(k, set);
    return set;
  }

  observe(): void {
    const w = internals(this.sim);
    const t = w.tick - 1;
    const minGreen = Math.round(PREEMPT_MIN_GREEN * w.tickRate);
    const plans = new Map(w.signals.plans.map((p) => [p.nodeId, p]));
    const nodes = new Set([...plans.keys(), ...this.shown.keys()]);
    for (const nodeId of nodes) {
      const p = plans.get(nodeId);
      if (w.sc !== null && w.sc.ctl.has(nodeId)) this.controlledTicks++;
      if (w.signalClearing.has(nodeId)) this.clearingTicks++;
      const green = new Set<string>();
      const yellow = new Set<string>();
      // Dark (power cut): the junction runs as an all-way stop ('F'); a power cut may end any interval at once.
      const dark = p?.ctl?.color === 'off' || (w.dark !== null && w.dark.junctions.has(nodeId));
      if (dark) this.darkTicks++;
      let free = dark;
      if (p && !dark) {
        for (let h = 0; h < p.heads.length; h++) {
          if (w.laneGreen[p.heads[h]!.lane]) green.add(p.headSeg[h]!);
          if (headColor(p, h) === 'yellow') yellow.add(p.headSeg[h]!);
        }
      } else if (w.graph.nodes.has(nodeId)) {
        for (const l of w.graph.lanes) if (l.toNode === nodeId && w.laneGreen[l.index]) free = true;
      }
      const where = `${nodeId}@${t}`;
      const phaseOf = (segs: Set<string>): number => (p ? p.phases.findIndex((ph) => [...segs].every((s) => ph.approaches.includes(s))) : -1);
      if (green.size > 0 && phaseOf(green) < 0) this.problems.push(`${where}: green ${[...green]} spans phases`);
      const kind = green.size > 0 ? 'G' : yellow.size > 0 ? 'Y' : free ? 'F' : 'R';
      const key = [...(kind === 'G' ? green : yellow)].sort().join(',');
      const prev = this.shown.get(nodeId);
      // An edit removed approaches during a yellow: the rest of them stays yellow (same interval).
      if (prev && prev.kind === 'Y' && kind === 'Y' && key.split(',').every((s) => prev.key.split(',').includes(s))) prev.key = key;
      else if (!prev || prev.kind !== kind || prev.key !== key) {
        const timing = { yellow: p?.yellowTicks ?? prev?.yellow ?? 0, allRed: p?.allRedTicks ?? prev?.allRed ?? 0 };
        let redNeed = timing.allRed;
        if (prev) {
          const run = t - prev.since;
          if (prev.kind === 'G') {
            if (kind === 'G' || (kind === 'F' && !dark)) this.problems.push(`${where}: green ${prev.key} → ${kind} ${key} without clearance`);
            // An edit or a power cut may end a green early.
            const cut = (this.edits.get(nodeId) ?? -1) >= prev.since || (kind === 'F' && dark);
            if (run < prev.need && !cut) this.problems.push(`${where}: green ${prev.key} lasted ${run} ticks`);
            if (kind === 'R' && prev.yellow > 0) {
              // Yellow can only be shown on signal heads: a junction (or approach) that lost them must hold red for yellow + all-red.
              if (p && prev.key.split(',').some((seg) => p.headSeg.includes(seg))) this.problems.push(`${where}: green ${prev.key} → red without yellow`);
              else redNeed = prev.yellow + prev.allRed;
            }
          }
          if (prev.kind === 'Y') {
            if (kind !== 'R' && !(kind === 'F' && dark)) this.problems.push(`${where}: yellow → ${kind}`);
            // Signal heads gone mid-yellow: the rest of the yellow must be held as red.
            if (run < prev.yellow && p && !dark) this.problems.push(`${where}: yellow lasted ${run} ticks`);
          }
          // All-way stop (dark) → all red → unsignalized again (an edit removed the signal while dark): no green involved.
          if (prev.kind === 'R' && (kind === 'G' || (kind === 'F' && !dark && !prev.fromDark)) && run < prev.redNeed) this.problems.push(`${where}: all red lasted ${run} ticks before ${kind}`);
          if (prev.kind === 'Y' || prev.kind === 'G') timing.yellow = prev.yellow;
          if (prev.kind === 'Y' || prev.kind === 'G') timing.allRed = prev.allRed;
          if (prev.kind === 'Y') redNeed = prev.allRed + (p ? 0 : Math.max(0, prev.yellow - (t - prev.since)));
          // Power back: the all-way-stop traffic is cleared under all red (yellow + all-red) before any green.
          if (prev.kind === 'F' && kind === 'R') redNeed = timing.yellow + timing.allRed;
        }
        if (kind === 'G' && w.sc !== null && w.sc.ctl.has(nodeId)) this.controlledGreens++;
        const ph = phaseOf(green);
        const need = kind === 'G' && p && ph >= 0 ? Math.min(minGreen, p.greenTicks[ph]!) : 0;
        this.shown.set(nodeId, { fromDark: kind === 'R' && prev?.kind === 'F' && prev.dark === true, dark, kind, key, since: t, need, yellow: kind === 'G' && p ? p.yellowTicks : timing.yellow, allRed: kind === 'G' && p ? p.allRedTicks : timing.allRed, redNeed });
      }
      const heads = new Map<number, number>();
      if (p) for (const hd of p.peds) heads.set(hd.ci, hd.clearance);
      for (let ci = 0; ci < w.graph.crossings.length; ci++) {
        const cr = w.graph.crossings[ci]!;
        if (cr.nodeId !== nodeId) continue;
        const sig = w.zs.pedSig[ci]!;
        // At a dark junction no lane has a signal green (laneGreen = all-way stop): nothing to check against.
        if ((sig === PedSignal.walk || sig === PedSignal.clearance) && !dark) {
          for (const l of this.lanesAgainst(ci, p?.scramble ?? false, nodeId)) if (w.laneGreen[l]) this.problems.push(`${where}: crossing ${cr.id} ${sig === PedSignal.walk ? 'WALK' : 'CLEARANCE'} with lane ${l} green`);
        }
        const pp = this.ped.get(cr.id);
        this.sufficient(w, cr.id, ci, pp?.sig, sig, t, where);
        if (!pp || pp.sig !== sig) {
          if (pp && pp.sig === PedSignal.walk && sig !== PedSignal.clearance) this.problems.push(`${where}: crossing ${cr.id} WALK → ${sig} without clearance`);
          if (pp && pp.sig === PedSignal.clearance && t - pp.since < pp.clearance) this.problems.push(`${where}: crossing ${cr.id} clearance lasted ${t - pp.since} ticks`);
          // The clearance owed is the one of the plan that showed the WALK (the crossing's own length).
          const owed = pp && pp.sig === PedSignal.walk ? pp.clearance : (heads.get(ci) ?? pp?.clearance ?? 0);
          this.ped.set(cr.id, { sig, since: t, clearance: sig === PedSignal.walk ? (heads.get(ci) ?? owed) : owed });
        }
      }
    }
    this.observeMids(w, t);
  }

  /**
   * Clearance sufficiency: a crosswalk that left WALK flashes CLEARANCE for at least ⌈length / 1.0 m/s⌉ of its
   * longest geometry during the clearance (edits may lengthen it) before it turns red / unsignalized. Together
   * with "no conflicting green during WALK / CLEARANCE" this is the clearance-before-conflicting-green rule.
   */
  private sufficient(w: World, id: string, ci: number, prev: number | undefined, sig: number, t: number, where: string): void {
    const geo = clearanceTicks(w.zones.length[ci]!, w.tickRate);
    const x = this.exit.get(id);
    if (sig === PedSignal.clearance) {
      if (x) x.need = Math.max(x.need, geo);
      else if (prev === PedSignal.walk) this.exit.set(id, { start: t, need: geo });
      return;
    }
    // Any exit from the clearance — to red, unsignalized, or straight back to WALK — is checked.
    if (!x) return;
    this.clearanceChecks++;
    if (t - x.start < x.need) this.problems.push(`${where}: crosswalk ${id} cleared ${t - x.start} ticks, its length needs ${x.need} (then ${sig === PedSignal.walk ? 'WALK' : sig === PedSignal.none ? 'unsignalized' : 'red'})`);
    this.exit.delete(id);
  }

  /**
   * Mid-block crosswalks (signalized or not, by id): WALK and CLEARANCE only with vehicles red; vehicles go
   * green → yellow (≥ its yellow) → red, never green → red; WALK ends in a full CLEARANCE (the longer of the
   * old and new crosswalk's when an edit changed it).
   */
  private observeMids(w: World, t: number): void {
    const mids = new Map(w.signals.mids.map((m) => [m.id, m]));
    for (const cr of w.graph.crossings) {
      if (cr.kind !== 'midblock') continue;
      const ci = cr.index;
      const color = w.zs.midColor[ci]!;
      const sig = w.zs.pedSig[ci]!;
      const m = mids.get(cr.id);
      if (m?.ctl === 'off') this.darkTicks++;
      if (w.midClearing.has(cr.id)) this.clearingTicks++;
      const where = `${cr.id}@${t}`;
      if ((sig === PedSignal.walk || sig === PedSignal.clearance) && color !== 0) this.problems.push(`${where}: ${sig === PedSignal.walk ? 'WALK' : 'CLEARANCE'} with vehicles ${color === 2 ? 'green' : 'yellow'}`);
      const prev = this.mid.get(cr.id);
      if (!prev || prev.color !== color) {
        if (prev && prev.color === 2 && color === 0) this.problems.push(`${where}: vehicles green → red without yellow`);
        // A yellow must run in full before red; it may end early only into unsignalized operation (switched off / dark).
        if (prev && prev.color === 1 && color === 0 && t - prev.since < prev.yellow) this.problems.push(`${where}: yellow lasted ${t - prev.since} ticks`);
        if (prev && prev.color === 1 && color === 2 && m && m.ctl !== 'off') this.problems.push(`${where}: yellow → green`);
        this.mid.set(cr.id, { color, since: t, yellow: m?.yellow ?? prev?.yellow ?? 0 });
      }
      const pp = this.ped.get(cr.id);
      this.sufficient(w, cr.id, ci, pp?.sig, sig, t, where);
      if (!pp || pp.sig !== sig) {
        if (pp && pp.sig === PedSignal.walk && sig !== PedSignal.clearance) this.problems.push(`${where}: WALK → ${sig} without clearance`);
        if (pp && pp.sig === PedSignal.clearance && t - pp.since < pp.clearance) this.problems.push(`${where}: clearance lasted ${t - pp.since} ticks`);
        const owed = pp && pp.sig === PedSignal.walk ? Math.max(pp.clearance, m?.clearance ?? 0) : (m?.clearance ?? pp?.clearance ?? 0);
        this.ped.set(cr.id, { sig, since: t, clearance: sig === PedSignal.walk ? (m?.clearance ?? owed) : owed });
      }
    }
  }
}

/**
 * A random plan or network edit for junction `node` (state: which edits were made once). Plan edits: back to
 * signal, reversed phases, one phase per approach (added), automatic phases (removed), scramble toggled,
 * allStop / uncontrolled, the approach `deletable` deleted, a mid-block signal crosswalk `mx` on `far` switched
 * on / off; unrelated recompiles / rebuilds: a mid-block
 * crosswalk on `far`, a building and a road far away.
 */
export function randomPlanEdit(w: World, rng: Rng, node: string, deletable: string, far: string, state: { deleted: boolean; n: number }): [string, Command] {
  const p = w.signals.plans.find((x) => x.nodeId === node);
  const ctrl = (extra: object): Command => ({ type: 'intersection.set', control: { nodeId: node, kind: 'signal', yellow: 3, allRed: 2, offset: 0, ...extra } }) as Command;
  const r = rng.int(10);
  const k = state.n++;
  if (!p || r === 0) return ['signal', ctrl({})];
  if (r === 1) return ['reverse', ctrl({ phases: p.phases.filter((ph) => ph.approaches.length > 0).reverse().map((ph) => ({ approaches: ph.approaches.slice(), green: 20 })) })];
  if (r === 2) return ['split', ctrl({ phases: p.phases.flatMap((ph) => ph.approaches.map((a) => ({ approaches: [a], green: 12 }))) })];
  if (r === 3) return ['auto', { type: 'intersection.reset', nodeId: node }];
  if (r === 4) return ['scramble', ctrl({ scramble: !p.scramble })];
  if (r === 5) {
    const kind = rng.next() < 0.5 ? 'allStop' : 'uncontrolled';
    return [kind, { type: 'intersection.set', control: { nodeId: node, kind, yellow: 3, allRed: 2, offset: 0 } } as Command];
  }
  if (r === 6 && !state.deleted) {
    state.deleted = true;
    return [`delete ${deletable}`, { type: 'segment.remove', id: deletable }];
  }
  if (r === 9 && rng.next() < 0.3) {
    // Widen / narrow an approach: its crosswalks get longer / shorter (possibly under pedestrians).
    const seg = w.graph.segments.get(far);
    const wide = seg?.roadType.id === 'road-6';
    return [wide ? 'narrow' : 'widen', { type: 'segment.setType', id: far, roadTypeId: wide ? 'road-2' : 'road-6' }];
  }
  if (r === 9 && rng.next() < 0.5) {
    const on = !w.signals.mids.some((m) => m.id === 'mx');
    return [on ? 'mid signal on' : 'mid signal off', { type: 'feature.upsert', feature: { id: 'mx', segmentId: far, kind: 'crosswalk', t: 0.5, signal: on } }];
  }
  if (r === 7) return ['far building', { type: 'building.place', building: { id: `fb${k}`, typeId: 'house', pos: { x: 1500 + 30 * (k % 20), z: 1500 + 30 * Math.floor(k / 20) }, rotation: 0 } }];
  if (r === 8)
    return [
      'far road',
      {
        type: 'batch',
        commands: [
          { type: 'node.add', node: { id: `fa${k}`, pos: { x: -1500, z: -1500 + 40 * k } } },
          { type: 'node.add', node: { id: `fz${k}`, pos: { x: -1300, z: -1500 + 40 * k } } },
          { type: 'segment.add', segment: { id: `fr${k}`, a: `fa${k}`, b: `fz${k}`, roadTypeId: 'road-2' } },
        ],
      },
    ];
  return ['recompile', { type: 'feature.upsert', feature: { id: `x${k}`, segmentId: far, kind: 'crosswalk', t: 0.3 + 0.02 * (k % 20) } }];
}
