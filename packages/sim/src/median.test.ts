// Median roads in the simulation (ADR 0014 §4): lanes start at the median edge, junction connectors
// join the shifted lanes, crosswalks and their vehicle conflict zones span curb to curb (median included,
// crossed in one go), and sidewalks sit at the outer curbs.

import { describe, expect, it } from 'vitest';
import { carriagewayWidth, closestPointOnPolyline, createEmptyDoc, dist, SIDEWALK_WIDTH, type Command } from '@smartcity/shared';
import { compileNetwork } from './network/compile.js';
import { buildZones } from './network/crossings.js';
import { buildNet } from './network/net.js';
import { buildPedGraph, PedEdgeKind } from './network/pedGraph.js';
import { PedRouter } from './network/pedQuery.js';
import { Simulation } from './simulation.js';
import { apply, checkInvariants, checkZoneInvariants, crossDoc, gridDoc } from './testkit.js';

const M6 = createEmptyDoc().roadTypes['road-6-median']!;

/** Lateral distance of a lane's middle point from its segment's centerline. */
function lateral(g: ReturnType<typeof compileNetwork>, lane: number): number {
  const l = g.lanes[lane]!;
  const mid = l.points[l.points.length >> 1]!;
  const seg = g.segments.get(l.segmentId)!;
  return dist(mid, closestPointOnPolyline(seg.centerline, mid).point);
}

describe('median roads in the simulation', () => {
  it('offsets every lane by half the median: ±(2 + (i + 0.5) · 3.5) m on a 4 m median', () => {
    expect(M6.median).toEqual({ width: 4, planted: true });
    const g = compileNetwork(crossDoc(150, 'road-6-median'));
    const W = g.segments.get('W')!;
    expect(W.lanes).toHaveLength(6);
    const side = (id: number): number => Math.sign(g.lanes[id]!.points[1]!.z);
    for (const id of W.lanes) {
      const l = g.lanes[id]!;
      expect(lateral(g, id)).toBeCloseTo(2 + (l.laneIndex + 0.5) * 3.5, 6);
      // The two directions lie on opposite sides of the median.
      expect(side(id)).toBe(l.dir === 'forward' ? side(W.lanes[0]!) : -side(W.lanes[0]!));
    }
    // The same road without a median keeps its old offsets (golden path).
    const plain = compileNetwork(crossDoc(150, 'road-6'));
    for (const id of plain.segments.get('W')!.lanes) expect(lateral(plain, id)).toBeCloseTo((plain.lanes[id]!.laneIndex + 0.5) * 3.5, 6);
    // Setback grows with the wider road (half width 25 / 2 + 2.5 = 15, plus 1 m).
    expect(W.halfWidth).toBe(15);
    expect(W.setbackB).toBe(16);
  });

  it('junction connectors join the shifted lane ends; straight ones keep the lane and its offset through the junction', () => {
    const g = compileNetwork(crossDoc(150, 'road-6-median'));
    const atC = g.connectors.filter((k) => k.nodeId === 'c');
    expect(atC.length).toBeGreaterThan(0);
    for (const k of atC) {
      const from = g.lanes[k.fromLane]!;
      const to = g.lanes[k.toLane]!;
      expect(dist(k.points[0]!, from.points[from.points.length - 1]!)).toBeLessThan(1e-6);
      expect(dist(k.points[k.points.length - 1]!, to.points[0]!)).toBeLessThan(1e-6);
    }
    // Every incoming lane of W (forward, towards c) can leave the junction.
    const W = g.segments.get('W')!;
    for (const id of W.lanes.filter((i) => g.lanes[i]!.dir === 'forward')) expect(g.lanes[id]!.out.length).toBeGreaterThan(0);
    // W → E straight: lane i continues as lane i, crossing x = 0 at |z| = 2 + (i + 0.5) · 3.5.
    const straight = atC.filter((k) => k.turn === 'straight' && g.lanes[k.fromLane]!.segmentId === 'W' && g.lanes[k.toLane]!.segmentId === 'E');
    expect(straight.length).toBeGreaterThanOrEqual(3);
    for (const k of straight.filter((c) => g.lanes[c.fromLane]!.laneIndex === g.lanes[c.toLane]!.laneIndex)) {
      const mid = k.points.reduce((best, p) => (Math.abs(p.x) < Math.abs(best.x) ? p : best));
      expect(Math.abs(mid.z)).toBeCloseTo(2 + (g.lanes[k.fromLane]!.laneIndex + 0.5) * 3.5, 1);
    }
  });

  it('crosswalks span curb to curb (median included) and every lane of the leg passes their conflict zone', () => {
    const doc = crossDoc(150, 'road-6-median');
    const net = buildNet(compileNetwork(doc));
    const zones = buildZones(net);
    const g = net.graph;
    expect(g.crossings.map((c) => c.id)).toEqual(['c|E', 'c|N', 'c|S', 'c|W']);
    for (const cr of g.crossings) {
      expect(dist(cr.a, cr.b)).toBeCloseTo(carriagewayWidth(M6), 9);
      expect(carriagewayWidth(M6)).toBe(25);
      expect(zones.length[cr.index]).toBeCloseTo(25, 9);
      // Every connector entering or leaving this leg crosses the zone — the inner lanes next to the median too.
      const seg = g.segments.get(cr.segmentId)!;
      const legLanes = new Set(seg.lanes);
      const through = new Set(zones.byZone[cr.index]!.map((x) => x.edge));
      const legConns = g.connectors.filter((k) => k.nodeId === cr.nodeId && (legLanes.has(k.fromLane) || legLanes.has(k.toLane)));
      expect(legConns.length).toBeGreaterThan(0);
      for (const k of legConns) expect(through.has(net.nLanes + k.index), k.id).toBe(true);
    }
    // A mid-block crosswalk: one crossing over all six lanes and the median, every lane stops for it.
    const line = apply(createEmptyDoc('m', 1), [
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 300, z: 0 } } },
      { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-6-median' } },
      { type: 'feature.upsert', feature: { id: 'x', segmentId: 'ab', kind: 'crosswalk', t: 0.5 } },
    ]);
    const lnet = buildNet(compileNetwork(line));
    const lz = buildZones(lnet);
    expect(lnet.graph.crossings).toHaveLength(1);
    const mid = lnet.graph.crossings[0]!;
    expect(dist(mid.a, mid.b)).toBeCloseTo(25, 9);
    expect(lz.stopLanes).toEqual(lnet.graph.segments.get('ab')!.lanes.slice().sort((p, q) => p - q));
  });

  it('puts the sidewalks at the outer curbs and links them by one crossing per leg', () => {
    const doc = crossDoc(150, 'road-6-median');
    const g = compileNetwork(doc);
    const pg = buildPedGraph(doc, g);
    const off = 25 / 2 + SIDEWALK_WIDTH / 2;
    for (let e = 0; e < pg.nEdges; e++) {
      if (pg.kind[e] === PedEdgeKind.sidewalk) for (const p of pg.pts[e]!) expect(Math.min(Math.abs(p.x), Math.abs(p.z))).toBeCloseTo(off, 5);
      if (pg.kind[e] === PedEdgeKind.corner) for (const p of pg.pts[e]!) expect(Math.hypot(p.x, p.z)).toBeGreaterThan(off - 1e-6);
    }
    expect(Array.from(pg.crossingEdge).every((e) => e >= 0)).toBe(true);
    for (const e of pg.crossingEdge) expect(pg.len[e]).toBeCloseTo(2 * off, 5);
    const r = new PedRouter(pg);
    for (let n = 1; n < pg.nNodes; n++) expect(r.find(0, n)).not.toBeNull();
  });

  it('runs traffic on a median grid with the physical invariants holding', () => {
    const sim = new Simulation(gridDoc(3, 200, 'road-6-median'));
    for (let t = 0; t < 1500; t++) {
      sim.step();
      if (t > 20 && t % 10 === 0) {
        expect(checkInvariants(sim)).toEqual([]);
        expect(checkZoneInvariants(sim)).toEqual([]);
      }
    }
    expect(sim.stats().vehicles).toBeGreaterThan(0);
    for (const v of sim.vehicles()) expect(Number.isFinite(v.pos.x) && Number.isFinite(v.pos.z)).toBe(true);
  });

  it('a median road type edited back to no median compiles exactly like the original road', () => {
    const cmds: Command[] = [{ type: 'roadType.upsert', roadType: { ...M6, id: 'road-6' } }];
    const withMedian = compileNetwork(apply(crossDoc(150, 'road-6'), cmds));
    const { median: _m, ...noMedian } = M6;
    const back = compileNetwork(apply(crossDoc(150, 'road-6'), [...cmds, { type: 'roadType.upsert', roadType: { ...noMedian, id: 'road-6', name: '6차선 대로', speedLimit: createEmptyDoc().roadTypes['road-6']!.speedLimit } }]));
    const plain = compileNetwork(crossDoc(150, 'road-6'));
    expect(JSON.stringify(withMedian.lanes.map((l) => l.points))).not.toBe(JSON.stringify(plain.lanes.map((l) => l.points)));
    expect(JSON.stringify(back.lanes.map((l) => l.points))).toBe(JSON.stringify(plain.lanes.map((l) => l.points)));
    expect(JSON.stringify(back.crossings)).toBe(JSON.stringify(plain.crossings));
  });
});
