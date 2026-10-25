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
    else if (inc.retryAt < 0) problems.push(`incident ${inc.eventId}: no vehicle and no dispatch retry`);
  }
  if (new Set(sc.missions).size !== sc.missions.length) problems.push('mission listed twice');
  for (const m of sc.missions) if (!live(m)) problems.push(`mission of ${m.incident.eventId} (${m.stage}) has no vehicle, departure or incident`);
  for (const v of w.vehicles) if (v.alive && v.em !== null && !sc.missions.includes(v.em)) problems.push(`emergency vehicle ${v.id} without a listed mission`);
  return problems;
}
