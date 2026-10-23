import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type Command } from '@smartcity/shared';
import { compileNetwork } from '../network/compile.js';
import { buildPedGraph, PedEdgeKind } from '../network/pedGraph.js';
import { PedRouter } from '../network/pedQuery.js';
import { Simulation } from '../simulation.js';
import { apply, checkInvariants, checkZoneInvariants, crossDoc, internals, lineDoc, pedestriansOnCrossings } from '../testkit.js';
import { PedSignal } from '../types.js';
import { PED_SPACING, routeLength, setRoute, spawnWalker } from './peds.js';

const opts = { demand: false, citizens: false };
const zoneOf = (sim: Simulation, id: string): number => sim.graph.crossings.find((c) => c.id === id)!.index;
const laneIdx = (sim: Simulation, id: string): number => sim.graph.laneById.get(id)!;
const view = (sim: Simulation, id: number) => sim.vehicles().find((v) => v.id === id);

/** Both curb nodes of a crossing's edge. */
function ends(sim: Simulation, z: number): [number, number] {
  const pg = internals(sim).ped.pg;
  const e = pg.crossingEdge[z]!;
  return [pg.from[e]!, pg.to[e]!];
}

/** Pedestrians in one band closer than the spacing. */
function spacingProblems(sim: Simulation): string[] {
  const p = internals(sim).peds;
  const out: string[] = [];
  p.bands.forEach((list, b) => {
    for (let k = 1; k < list.length; k++) {
      const gap = p.pos[list[k - 1]!]! - p.pos[list[k]!]!;
      if (gap < PED_SPACING - 1e-9) out.push(`band ${b}: gap ${gap.toFixed(3)}`);
    }
  });
  return out;
}

describe('pedestrian graph', () => {
  it('derives sidewalks, corners, caps and crossings from a 4-way junction', () => {
    const doc = crossDoc(120);
    const g = compileNetwork(doc);
    const pg = buildPedGraph(doc, g);
    const count = (k: number): number => Array.from(pg.kind).filter((x) => x === k).length;
    expect(count(PedEdgeKind.sidewalk)).toBe(8);
    expect(count(PedEdgeKind.crossing)).toBe(4);
    // 4 corners around c plus a cap around each of the 4 dead ends.
    expect(count(PedEdgeKind.corner)).toBe(8);
    expect(Array.from(pg.crossingEdge).every((e) => e >= 0)).toBe(true);
    // Sidewalks run 3.5 + 1.25 m from the centerline; corners never cut through the junction.
    for (let e = 0; e < pg.nEdges; e++) {
      if (pg.kind[e] === PedEdgeKind.corner) {
        for (const p of pg.pts[e]!) expect(Math.hypot(p.x, p.z)).toBeGreaterThan(4.7);
      }
      if (pg.kind[e] === PedEdgeKind.sidewalk) {
        for (const p of pg.pts[e]!) expect(Math.min(Math.abs(p.x), Math.abs(p.z))).toBeCloseTo(4.75, 5);
      }
    }
    // Every node reaches every other node.
    const r = new PedRouter(pg);
    for (let n = 1; n < pg.nNodes; n++) expect(r.find(0, n)).not.toBeNull();
    // Crossing a leg goes over its crossing, going around the junction uses corners only.
    const e = pg.crossingEdge[0]!;
    const path = r.find(pg.from[e]!, pg.to[e]!)!;
    expect(Array.from(path.path)).toEqual([e * 2]);
  });

  it('gives buildings a door on the face toward the sidewalk and never connects across a carriageway', () => {
    const doc = apply(createEmptyDoc('b', 1), [
      { type: 'node.add', node: { id: 'a', pos: { x: -100, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
      { type: 'node.add', node: { id: 'c', pos: { x: -100, z: 20 } } },
      { type: 'node.add', node: { id: 'd', pos: { x: 100, z: 20 } } },
      { type: 'roadType.upsert', roadType: { id: 'alley', name: 'alley', lanesForward: 1, lanesBackward: 1, laneWidth: 3, speedLimit: 8, sidewalk: false, busOnlyRightLane: false } },
      { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'cd', a: 'c', b: 'd', roadTypeId: 'alley' } },
      { type: 'building.place', building: { id: 'near', typeId: 'house', pos: { x: 0, z: -15 }, rotation: 0 } },
      // North of the alley: the only sidewalk is beyond the alley's carriageway.
      { type: 'building.place', building: { id: 'far', typeId: 'house', pos: { x: 0, z: 35 }, rotation: 0 } },
    ]);
    const pg = buildPedGraph(doc, compileNetwork(doc));
    expect(pg.buildingIds).toEqual(['far', 'near']);
    expect(pg.access[0]).toBeNull();
    const a = pg.access[1]!;
    // House 10 × 9 at z = −15: the face toward the road is z = −10.5; ab runs +x so −z is its left side.
    expect(pg.z[a.door]).toBeCloseTo(-10.5);
    expect(pg.x[a.door]).toBeCloseTo(0);
    expect(a.side).toBe(-1);
    expect(pg.z[a.attach]).toBeCloseTo(-4.75);
    expect(a.stopL).toBe(a.attach);
    expect(pg.z[a.stopR]).toBeCloseTo(4.75);
    expect(pg.kind[a.accessEdge]).toBe(PedEdgeKind.access);
    expect(a.s).toBeCloseTo(100);
  });

  it('splits the sidewalks at a mid-block crosswalk', () => {
    const doc = lineDoc(300, 'road-2', [{ type: 'feature.upsert', feature: { id: 'x', segmentId: 'ab', kind: 'crosswalk', t: 0.5 } }]);
    const pg = buildPedGraph(doc, compileNetwork(doc));
    const e = pg.crossingEdge[0]!;
    expect(pg.kind[e]).toBe(PedEdgeKind.crossing);
    expect(pg.x[pg.from[e]!]).toBeCloseTo(150);
    expect(pg.z[pg.from[e]!]).toBeCloseTo(4.75);
    expect(pg.z[pg.to[e]!]).toBeCloseTo(-4.75);
    expect(Array.from(pg.kind).filter((k) => k === PedEdgeKind.sidewalk).length).toBe(4);
  });
});

describe('pedestrians and vehicles at crossings', () => {
  it('a pedestrian waiting at red does not hold up green traffic', () => {
    const run = (withWalker: boolean): number => {
      const sim = new Simulation(crossDoc(120), opts);
      const w = internals(sim);
      expect(sim.signals()[0]!.greenApproaches.sort()).toEqual(['N', 'S']);
      const zn = zoneOf(sim, 'c|N');
      const [a, b] = ends(sim, zn);
      const walker = withWalker ? spawnWalker(w, a, b) : -1;
      const L = sim.graph.lanes[laneIdx(sim, 'N|f|0')]!.length;
      const id = sim.spawnVehicle('sedan', 'N|f|0', 'S|b|0', L - 25)!;
      let entered = -1;
      for (let t = 0; t < 20 * 15 && entered < 0; t++) {
        sim.step();
        expect(w.zs.pedSig[zn]).toBe(PedSignal.red);
        expect(pedestriansOnCrossings(sim)[zn]).toBe(0);
        expect(checkZoneInvariants(sim)).toEqual([]);
        if (view(sim, id)!.edge.kind === 'connector') entered = t;
      }
      if (withWalker) expect(w.peds.state[walker]).toBe(1);
      return entered;
    };
    const alone = run(false);
    expect(alone).toBeGreaterThan(0);
    // Exactly as fast as without anyone waiting at the (red) crosswalk it passes.
    expect(run(true)).toBe(alone);
  });

  it('pedestrians cross on WALK and a turning car yields to them', () => {
    const sim = new Simulation(crossDoc(120), opts);
    const w = internals(sim);
    const zw = zoneOf(sim, 'c|W');
    const [a, b] = ends(sim, zw);
    for (let k = 0; k < 3; k++) spawnWalker(w, k % 2 ? b : a, k % 2 ? a : b);
    // Southbound right turn N → W crosses the W crosswalk while N/S have green and W walks.
    const L = sim.graph.lanes[laneIdx(sim, 'N|f|0')]!.length;
    const id = sim.spawnVehicle('sedan', 'N|f|0', 'W|b|0', L - 15)!;
    let pedsOn = -1;
    let lastPedTick = -1;
    let carIn = -1;
    for (let t = 0; t < 20 * 40; t++) {
      sim.step();
      expect(checkZoneInvariants(sim)).toEqual([]);
      expect(checkInvariants(sim)).toEqual([]);
      const on = pedestriansOnCrossings(sim)[zw]!;
      if (on > 0) {
        if (pedsOn < 0) {
          pedsOn = t;
          expect(w.zs.pedSig[zw]).toBe(PedSignal.walk);
        }
        lastPedTick = t;
      }
      const v = view(sim, id);
      if (carIn < 0 && v && v.edge.kind === 'connector') carIn = t;
    }
    expect(pedsOn).toBeGreaterThanOrEqual(0);
    expect(pedsOn).toBeLessThan(20 * 2);
    // The car went only once the crosswalk was clear (and the pedestrians all made it across).
    expect(carIn).toBeGreaterThan(lastPedTick);
    expect(w.peds.count).toBe(0);
  });

  it('keeps 0.7 m between pedestrians walking in the same band', () => {
    const sim = new Simulation(crossDoc(120), opts);
    const w = internals(sim);
    const pg = w.ped.pg;
    const [a] = ends(sim, zoneOf(sim, 'c|W'));
    const [, far] = ends(sim, zoneOf(sim, 'c|E'));
    let spawned = 0;
    let maxBand = 0;
    for (let t = 0; t < 20 * 120; t++) {
      if (t % 3 === 0 && t < 20 * 20 && spawnWalker(w, a, far, 0.8 + (t % 7) * 0.15) >= 0) spawned++;
      sim.step();
      expect(spacingProblems(sim)).toEqual([]);
      for (const l of w.peds.bands) maxBand = Math.max(maxBand, l.length);
    }
    expect(spawned).toBeGreaterThan(100);
    expect(maxBand).toBeGreaterThan(5);
    expect(pg.nEdges).toBeGreaterThan(0);
  });

  it('unsignalized crosswalk: pedestrians first, but a waiting car gets through after 12 s of continuous use', () => {
    const sim = new Simulation(lineDoc(300, 'road-2', [{ type: 'feature.upsert', feature: { id: 'x', segmentId: 'ab', kind: 'crosswalk', t: 0.5 } }]), opts);
    const w = internals(sim);
    const [a, b] = ends(sim, 0);
    for (let t = 0; t < 20 * 3; t++) {
      if (t % 10 === 0) spawnWalker(w, a, b);
      sim.step();
    }
    const id = sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 110)!;
    let firstWait = -1;
    let passed = -1;
    let gated = false;
    for (let t = 0; t < 20 * 60; t++) {
      if (t % 10 === 0) spawnWalker(w, t % 20 ? a : b, t % 20 ? b : a);
      sim.step();
      expect(checkZoneInvariants(sim)).toEqual([]);
      const v = view(sim, id);
      if (firstWait < 0 && v && v.v < 0.5) firstWait = t;
      if (w.zs.gate[0]) gated = true;
      if (passed < 0 && (!v || v.s > w.zones.lane[laneIdx(sim, 'ab|f|0')]![0]!.exitS)) passed = t;
    }
    expect(firstWait).toBeGreaterThanOrEqual(0);
    expect(gated).toBe(true);
    expect(passed).toBeGreaterThan(firstWait + 20 * 10);
    expect(passed - firstWait).toBeLessThan(20 * 30);
  });

  it('signalized mid-block crosswalk: pedestrians enter only on WALK, vehicles only on green', () => {
    const sim = new Simulation(lineDoc(300, 'road-2', [{ type: 'feature.upsert', feature: { id: 'x', segmentId: 'ab', kind: 'crosswalk', t: 0.5, signal: true } }]), opts);
    const w = internals(sim);
    const [a, b] = ends(sim, 0);
    const lane = laneIdx(sim, 'ab|f|0');
    const p = w.zones.lane[lane]![0]!;
    let prevOn = 0;
    let crossed = 0;
    let vehiclesPassed = 0;
    for (let t = 0; t < 20 * 150; t++) {
      if (t % 40 === 0) spawnWalker(w, t % 80 ? a : b, t % 80 ? b : a);
      if (t % 100 === 0) sim.spawnVehicle('sedan', 'ab|f|0', 'ab|f|0', 40);
      const before = new Map(w.vehicles.map((v) => [v.id, v.s]));
      sim.step();
      expect(checkZoneInvariants(sim)).toEqual([]);
      const on = pedestriansOnCrossings(sim)[0]!;
      if (on > prevOn) {
        crossed++;
        // A new pedestrian stepped on: WALK now or a moment ago (grant came on WALK).
        expect([PedSignal.walk, PedSignal.clearance]).toContain(w.zs.pedSig[0]);
      }
      prevOn = on;
      for (const v of w.vehicles) {
        const s0 = before.get(v.id);
        if (v.edge === lane && s0 !== undefined && s0 <= p.enterS && v.s > p.enterS) {
          vehiclesPassed++;
          expect(v.zones.some((h) => h.z === 0)).toBe(true);
        }
      }
    }
    expect(crossed).toBeGreaterThan(5);
    expect(vehiclesPassed).toBeGreaterThan(5);
  });
});

describe('pedestrians on edits', () => {
  it('re-projects pedestrians when the network changes and drops nothing silently', () => {
    const sim = new Simulation(crossDoc(120), opts);
    const w = internals(sim);
    const zs = ['c|W', 'c|E', 'c|N', 'c|S'].map((id) => zoneOf(sim, id));
    for (let k = 0; k < 20; k++) {
      const [a, b] = ends(sim, zs[k % 4]!);
      spawnWalker(w, k % 2 ? a : b, k % 2 ? b : a);
    }
    for (let t = 0; t < 40; t++) sim.step();
    const cmds: Command[] = [
      { type: 'feature.upsert', feature: { id: 'x', segmentId: 'W', kind: 'crosswalk', t: 0.5 } },
      { type: 'intersection.set', control: { nodeId: 'c', kind: 'uncontrolled', crosswalkLegs: ['N', 'S'], yellow: 3, allRed: 2, offset: 0 } },
      { type: 'segment.remove', id: 'E' },
      { type: 'building.place', building: { id: 'h', typeId: 'house', pos: { x: -60, z: 20 }, rotation: 0 } },
    ];
    for (const cmd of cmds) {
      expect(sim.applyCommand(cmd).ok).toBe(true);
      for (let t = 0; t < 100; t++) {
        sim.step();
        expect(checkZoneInvariants(sim)).toEqual([]);
        expect(spacingProblems(sim)).toEqual([]);
      }
    }
    for (let t = 0; t < 20 * 120; t++) sim.step();
    expect(w.peds.count).toBe(0);
    expect(Array.from(w.zs.ped)).toEqual(new Array(w.graph.crossings.length).fill(0));
  });
});

describe('review regressions (Sol 2026-10-23)', () => {
  it('#1 keeps the tail zone reservation across back-to-back recompiles', () => {
    const doc = apply(crossDoc(120), [{ type: 'intersection.set', control: { nodeId: 'c', kind: 'uncontrolled', yellow: 3, allRed: 2, offset: 0 } }]);
    const sim = new Simulation(doc, opts);
    const w = internals(sim);
    const L = sim.graph.lanes[laneIdx(sim, 'N|f|0')]!.length;
    const bus = sim.spawnVehicle('city-bus', 'N|f|0', 'W|b|0', L - 15)!;
    const zw = zoneOf(sim, 'c|W');
    const out = laneIdx(sim, 'W|b|0');
    for (let t = 0; t < 20 * 30; t++) {
      sim.step();
      const v = view(sim, bus)!;
      if (v.edge.kind === 'lane' && v.edge.index === out) break;
    }
    const v0 = view(sim, bus)!;
    expect(v0.edge).toEqual({ kind: 'lane', index: out });
    expect(v0.s).toBeLessThan(2);
    expect(w.zs.veh[zw]).toBe(1);
    // Two recompiles on consecutive ticks while the tail is still on the connector over the W crosswalk.
    expect(sim.applyCommand({ type: 'segment.setSchoolZone', id: 'E', schoolZone: true }).ok).toBe(true);
    sim.step();
    expect(sim.applyCommand({ type: 'segment.setSchoolZone', id: 'E', schoolZone: false }).ok).toBe(true);
    sim.step();
    expect(w.zs.veh[zw]).toBe(1);
    const conn = sim.graph.connectors.find((c) => c.id === 'N|f|0>W|b|0')!;
    const pass = w.zones.conn[conn.index]!.find((p) => p.z === zw)!;
    const [a, b] = ends(sim, zw);
    spawnWalker(w, b, a);
    spawnWalker(w, a, b);
    let crossed = false;
    for (let t = 0; t < 20 * 30; t++) {
      sim.step();
      expect(checkZoneInvariants(sim)).toEqual([]);
      // Independent of any route: the tail sits on the connector at length − (busLength − s).
      const v = w.vehicles.find((x) => x.id === bus);
      const tailInZone = !!v && v.edge === out && v.s < v.len && conn.length - (v.len - v.s) < pass.exitS;
      const peds = pedestriansOnCrossings(sim)[zw]!;
      if (tailInZone) expect(peds).toBe(0);
      if (peds > 0) crossed = true;
    }
    expect(crossed).toBe(true);
  });

  it('#2 reserves the far-side place with the crossing: a crosser is never stuck on the carriageway', () => {
    const doc = lineDoc(300, 'road-2', [
      { type: 'feature.upsert', feature: { id: 'x1', segmentId: 'ab', kind: 'crosswalk', t: 0.5 } },
      { type: 'feature.upsert', feature: { id: 'x2', segmentId: 'ab', kind: 'crosswalk', t: 0.52, signal: true } },
    ]);
    const sim = new Simulation(doc, opts);
    const w = internals(sim);
    const pg = w.ped.pg;
    const [r150, l150] = ends(sim, 0);
    const [r156, l156] = ends(sim, 1);
    let side = -1;
    for (let e = 0; e < pg.nEdges; e++) if (pg.from[e] === l150 && pg.to[e] === l156) side = e;
    expect(side).toBeGreaterThanOrEqual(0);
    expect(pg.len[side]).toBeCloseTo(6, 1);
    const c1 = pg.crossingEdge[0]!;
    const c2 = pg.crossingEdge[1]!;
    // First pedestrian: crossing 1 → 6 m of sidewalk → crossing 2 (red for the first 33 s).
    const first = spawnWalker(w, r150, l156);
    setRoute(w, first, Int32Array.of(c1 * 2, side * 2, c2 * 2 + 1));
    sim.step();
    sim.step();
    expect(w.peds.grant[first]).toBe(0);
    // Then a crowd fills the same 6 m of sidewalk from the other end and queues at the red light.
    const others: number[] = [];
    for (let k = 0; k < 12; k++) {
      const i = spawnWalker(w, l150, r156);
      setRoute(w, i, Int32Array.of(side * 2, c2 * 2 + 1));
      others.push(i);
    }
    let onSidewalk = -1;
    for (let t = 0; t < 20 * 25; t++) {
      sim.step();
      expect(spacingProblems(sim)).toEqual([]);
      expect(w.peds.bands[side * 2]!.length + w.peds.bandRes[side * 2]!).toBeLessThanOrEqual(Math.floor(6 / PED_SPACING) + 1);
      if (onSidewalk < 0 && w.peds.edge[first] === side) onSidewalk = t;
    }
    expect(w.zs.pedSig[1]).toBe(PedSignal.red);
    // Reached the sidewalk right after crossing (≈ 9.5 m at 1.3 m/s), crossing 1 is free again.
    expect(onSidewalk).toBeGreaterThan(0);
    expect(onSidewalk).toBeLessThan(20 * 9);
    expect(w.zs.ped[0]).toBe(0);
    expect(pedestriansOnCrossings(sim)[0]).toBe(0);
    // The crowd took the rest of the sidewalk; the remainder waits at the node.
    expect(w.peds.bands[side * 2]!.length).toBe(Math.floor(6 / PED_SPACING) + 1);
    expect(others.some((i) => w.peds.edge[i] === -1)).toBe(true);
  });

  it('#3 re-projects at most 20 m and only into the goal\'s walkable component, else sends people home', () => {
    // Main road a → b along z = 0, and a separate short road p → q beside it (Sol's layout).
    const doc = lineDoc(300, 'road-2', [
      { type: 'node.add', node: { id: 'p', pos: { x: 150, z: 14 } } },
      { type: 'node.add', node: { id: 'q', pos: { x: 150, z: 24 } } },
      { type: 'segment.add', segment: { id: 'pq', a: 'p', b: 'q', roadTypeId: 'road-2' } },
    ]);
    const sim = new Simulation(doc, opts);
    const w = internals(sim);
    const pg = w.ped.pg;
    const mainComp = pg.comp[pg.crossingEdge.length ? 0 : 0]!;
    const small: number[] = [];
    for (let n = 0; n < pg.nNodes; n++) if (pg.comp[n] !== pg.comp[0] && Math.abs(pg.x[n]! - 150) < 10) small.push(n);
    expect(small.length).toBeGreaterThan(2);
    expect(mainComp).toBe(pg.comp[0]);
    let spawned = 0;
    for (let k = 0; k < 40 && spawned < 10; k++) if (spawnWalker(w, small[k % small.length]!, small[(k * 3 + 1) % small.length]!) >= 0) spawned++;
    expect(spawned).toBe(10);
    for (let t = 0; t < 50; t++) sim.step();
    const before = sim.snapshot();
    const pos = new Map<number, [number, number]>();
    for (let k = 0; k < before.pedestrianCount; k++) pos.set(before.pedestrianIds[k]!, [before.pedestrians[k * 8]!, before.pedestrians[k * 8 + 1]!]);
    expect(pos.size).toBe(10);
    expect(sim.applyCommand({ type: 'segment.remove', id: 'pq' }).ok).toBe(true);
    sim.step();
    const after = sim.snapshot();
    for (let k = 0; k < after.pedestrianCount; k++) {
      const old = pos.get(after.pedestrianIds[k]!);
      if (!old) continue;
      expect(Math.hypot(after.pedestrians[k * 8]! - old[0], after.pedestrians[k * 8 + 1]! - old[1])).toBeLessThanOrEqual(20.5);
    }
    // Their goals vanished with the road (no node within 20 m): nobody is teleported along the main road.
    expect(after.pedestrianCount).toBe(0);
  });

  it('#3 citizens: re-projected next to where they were, or home (counted) when that fails', () => {
    const doc = lineDoc(300, 'road-2', [
      { type: 'node.add', node: { id: 'p', pos: { x: 150, z: 14 } } },
      { type: 'node.add', node: { id: 'q', pos: { x: 150, z: 320 } } },
      { type: 'segment.add', segment: { id: 'pq', a: 'p', b: 'q', roadTypeId: 'road-2' } },
      // Homes at the far end of the side road, the office near the main road: a 250 m walk to work.
      { type: 'building.place', building: { id: 'h1', typeId: 'apartment', pos: { x: 172, z: 290 }, rotation: Math.PI / 2 } },
      { type: 'building.place', building: { id: 'o1', typeId: 'office-tower', pos: { x: 180, z: 45 }, rotation: 0 } },
    ]);
    const sim = new Simulation(doc, { demand: false });
    const w = internals(sim);
    for (let t = 0; t < 20 * 360 * 2 && sim.stats().citizens.walking < 30; t++) sim.step();
    expect(sim.stats().citizens.walking).toBeGreaterThanOrEqual(30);
    const before = sim.snapshot();
    const pos = new Map<number, [number, number]>();
    for (let k = 0; k < before.pedestrianCount; k++) pos.set(before.pedestrianIds[k]!, [before.pedestrians[k * 8]!, before.pedestrians[k * 8 + 1]!]);
    const failed = w.cz.failedTrips;
    expect(sim.applyCommand({ type: 'segment.remove', id: 'pq' }).ok).toBe(true);
    sim.step();
    const after = sim.snapshot();
    let kept = 0;
    for (let k = 0; k < after.pedestrianCount; k++) {
      const old = pos.get(after.pedestrianIds[k]!);
      if (!old) continue;
      kept++;
      expect(Math.hypot(after.pedestrians[k * 8]! - old[0], after.pedestrians[k * 8 + 1]! - old[1])).toBeLessThanOrEqual(20.5);
    }
    const sent = pos.size - kept;
    expect(sent).toBeGreaterThan(0);
    // Everyone not re-projected went home and was counted.
    expect(w.cz.failedTrips - failed).toBeGreaterThanOrEqual(sent);
    expect(checkZoneInvariants(sim)).toEqual([]);
  });

  it('R1 a recompile while crossing keeps the place reserved beyond the crossing', () => {
    const doc = lineDoc(300, 'road-2', [
      { type: 'feature.upsert', feature: { id: 'x1', segmentId: 'ab', kind: 'crosswalk', t: 0.5 } },
      { type: 'feature.upsert', feature: { id: 'x2', segmentId: 'ab', kind: 'crosswalk', t: 0.52, signal: true } },
    ]);
    const sim = new Simulation(doc, opts);
    const w = internals(sim);
    const sidewalk = (): number => {
      const pg = w.ped.pg;
      const [, l150] = ends(sim, 0);
      const [, l156] = ends(sim, 1);
      for (let e = 0; e < pg.nEdges; e++) if (pg.from[e] === l150 && pg.to[e] === l156) return e;
      return -1;
    };
    const [r150, l150] = ends(sim, 0);
    const [, l156] = ends(sim, 1);
    const first = spawnWalker(w, r150, l156);
    setRoute(w, first, Int32Array.of(w.ped.pg.crossingEdge[0]! * 2, sidewalk() * 2, w.ped.pg.crossingEdge[1]! * 2 + 1));
    for (let t = 0; t < 40 && w.peds.edge[first] !== w.ped.pg.crossingEdge[0]; t++) sim.step();
    expect(w.peds.edge[first]).toBe(w.ped.pg.crossingEdge[0]);
    expect(w.peds.resBand[first]).toBe(sidewalk() * 2);
    // Recompile in the middle of the crossing.
    expect(sim.applyCommand({ type: 'segment.setSchoolZone', id: 'ab', schoolZone: true }).ok).toBe(true);
    sim.step();
    const side = sidewalk();
    const c2 = w.ped.pg.crossingEdge[1]!;
    expect(w.peds.edge[first]).toBe(w.ped.pg.crossingEdge[0]);
    expect(w.peds.grant[first]).toBe(0);
    expect(w.peds.resBand[first]).toBe(side * 2);
    // Twelve more head for the same 6 m of sidewalk, toward the red second crossing.
    const [r156b, l156b] = ends(sim, 1);
    const [, l150b] = ends(sim, 0);
    expect(l156b).toBe(w.ped.pg.to[side]);
    for (let k = 0; k < 12; k++) {
      const i = spawnWalker(w, l150b, r156b);
      setRoute(w, i, Int32Array.of(side * 2, c2 * 2 + 1));
    }
    let onSidewalk = -1;
    for (let t = 0; t < 20 * 25; t++) {
      sim.step();
      expect(spacingProblems(sim)).toEqual([]);
      if (onSidewalk < 0 && w.peds.edge[first] === side) onSidewalk = t;
    }
    expect(w.zs.pedSig[1]).toBe(PedSignal.red);
    expect(onSidewalk).toBeGreaterThan(0);
    expect(onSidewalk).toBeLessThan(20 * 9);
    expect(w.zs.ped[0]).toBe(0);
    expect(pedestriansOnCrossings(sim)[0]).toBe(0);
    expect(w.peds.bands[side * 2]!.length).toBe(Math.floor(6 / PED_SPACING) + 1);
    expect(l150).toBe(l150b);
  });

  it('R2 a moved crossing with the same id does not carry pedestrians more than 20 m', () => {
    const sim = new Simulation(lineDoc(300, 'road-2', [{ type: 'feature.upsert', feature: { id: 'x', segmentId: 'ab', kind: 'crosswalk', t: 0.5 } }]), opts);
    const w = internals(sim);
    const pg = w.ped.pg;
    const [r150, l150] = ends(sim, 0);
    // The far end of the left sidewalk (x = 300, z = −4.75).
    let far = -1;
    for (let n = 0; n < pg.nNodes; n++) if (Math.abs(pg.x[n]! - 300) < 1e-6 && Math.abs(pg.z[n]! + 4.75) < 1e-6) far = n;
    expect(far).toBeGreaterThanOrEqual(0);
    const id = spawnWalker(w, r150, far);
    expect(id).toBeGreaterThanOrEqual(0);
    // Over the crosswalk, then along the far sidewalk.
    const rest = routeLength(w, l150, far)!.path;
    setRoute(w, id, Int32Array.of(pg.crossingEdge[0]! * 2, ...rest));
    for (let t = 0; t < 40; t++) sim.step();
    expect(pedestriansOnCrossings(sim)[0]).toBe(1);
    const before = sim.snapshot();
    const x0 = before.pedestrians[0]!;
    const z0 = before.pedestrians[1]!;
    const pid = before.pedestrianIds[0]!;
    expect(sim.applyCommand({ type: 'feature.upsert', feature: { id: 'x', segmentId: 'ab', kind: 'crosswalk', t: 0.7 } }).ok).toBe(true);
    sim.step();
    const after = sim.snapshot();
    for (let k = 0; k < after.pedestrianCount; k++) {
      if (after.pedestrianIds[k] !== pid) continue;
      expect(Math.hypot(after.pedestrians[k * 8]! - x0, after.pedestrians[k * 8 + 1]! - z0)).toBeLessThanOrEqual(20.5);
    }
    // It was not left on the (moved) crossing, and it still gets where it was going.
    expect(pedestriansOnCrossings(sim)[0]).toBe(0);
    expect(checkZoneInvariants(sim)).toEqual([]);
    for (let t = 0; t < 20 * 400 && w.peds.count > 0; t++) sim.step();
    expect(w.peds.count).toBe(0);
  });
});
