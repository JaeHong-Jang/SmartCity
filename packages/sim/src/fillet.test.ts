// Filleted corners (ADR 0012 §1): the lanes follow the doc curve, connectors join the new degree-2
// nodes, and traffic over them keeps every collision invariant. Docs without fillets are covered by
// golden.test.ts (unchanged hashes).

import { describe, expect, it } from 'vitest';
import { applyCommand, checkFillet, cloneJson, type CityDoc, type Command, type Vec2 } from '@smartcity/shared';
import { compileNetwork } from './network/compile.js';
import { Simulation } from './simulation.js';
import { checkInvariants, gridDoc } from './testkit.js';

/** Smallest radius through three consecutive points over the polyline interior (circumradius). */
function minPolylineRadius(pts: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (area2 > 1e-12) best = Math.min(best, (ab * bc * ca) / (2 * area2));
  }
  return best;
}

const CORNERS = ['n_0_0', 'n_2_0', 'n_0_2', 'n_2_2'];

/** 3×3 grid of 2-lane roads with all four outer corners rounded. */
function filletedGrid(): { doc: CityDoc; radius: number } {
  const doc = gridDoc(3, 150, 'road-2', 11);
  let radius = Infinity;
  for (const [i, nodeId] of CORNERS.entries()) {
    const r = checkFillet(doc, nodeId);
    if (!r.ok) throw new Error(r.error);
    radius = Math.min(radius, r.geometry.radius);
    const cmd: Command = { type: 'road.fillet', nodeId, ids: { a: `fa${i}`, b: `fb${i}`, seg: `fc${i}` } };
    const res = applyCommand(doc, cmd);
    if (!res.ok) throw new Error(res.error);
  }
  return { doc, radius };
}

describe('filleted corners in the simulation', () => {
  it('lanes follow the curve with at least the planned radius; new nodes are plain continuations', () => {
    const { doc, radius } = filletedGrid();
    expect(radius).toBeCloseTo(15, 9);
    const g = compileNetwork(doc);
    for (let i = 0; i < CORNERS.length; i++) {
      const seg = g.segments.get(`fc${i}`)!;
      expect(minPolylineRadius(seg.centerline)).toBeGreaterThanOrEqual(radius * 0.99);
      for (const laneIndex of seg.lanes) {
        const lane = g.lanes[laneIndex]!;
        // Lanes sit 1.75 m left or right of the center line: radius − 1.75 on the inside.
        expect(minPolylineRadius(lane.points)).toBeGreaterThanOrEqual((radius - 1.75) * 0.99);
      }
      for (const nodeId of [`fa${i}`, `fb${i}`]) {
        const node = g.nodes.get(nodeId)!;
        expect(node.segments).toHaveLength(2);
        expect(node.signalized).toBe(false);
        // Setback of a continuation (1 m), not a junction cut.
        for (const sid of node.segments) {
          const s = g.segments.get(sid)!;
          expect(doc.segments[sid]!.a === nodeId ? s.setbackA : s.setbackB).toBe(1);
        }
        // Every lane arriving at the node continues across it.
        const arriving = g.lanes.filter((l) => l.toNode === nodeId);
        expect(arriving).toHaveLength(2);
        for (const l of arriving) {
          expect(l.out.length).toBeGreaterThan(0);
          for (const c of l.out) expect(g.connectors[c]!.turn).toBe('straight');
        }
      }
    }
  });

  it('is deterministic: compiling the same filleted doc twice gives identical lanes', () => {
    const a = compileNetwork(filletedGrid().doc);
    const b = compileNetwork(filletedGrid().doc);
    expect(JSON.stringify(a.lanes.map((l) => [l.id, l.points]))).toBe(JSON.stringify(b.lanes.map((l) => [l.id, l.points])));
    expect(a.connectors.map((c) => c.id)).toEqual(b.connectors.map((c) => c.id));
  });

  it('traffic over the curves keeps the invariants every tick (no overlaps or conflicting occupancy)', () => {
    const { doc } = filletedGrid();
    const sim = new Simulation(doc);
    sim.applyCommand({ type: 'meta.update', trafficDensity: 2 });
    const g = compileNetwork(doc);
    const curveLanes = new Set<number>();
    for (let i = 0; i < CORNERS.length; i++) for (const l of g.segments.get(`fc${i}`)!.lanes) curveLanes.add(l);
    const problems: string[] = [];
    let onCurve = 0;
    for (let t = 0; t < 3600; t++) {
      sim.step();
      const p = checkInvariants(sim);
      if (p.length) problems.push(`tick ${t}: ${p.slice(0, 3).join('; ')}`);
      if (problems.length > 5) break;
      if (t % 10 === 0) for (const v of sim.vehicles()) if (v.edge.kind === 'lane' && curveLanes.has(v.edge.index)) onCurve++;
    }
    expect(problems).toEqual([]);
    expect(onCurve).toBeGreaterThan(0);
    expect(sim.stats().arrived).toBeGreaterThan(10);
  }, 120_000);

  it('a fillet applied while the sim runs recompiles the network', () => {
    const doc = gridDoc(3, 150, 'road-2', 11);
    const sim = new Simulation(cloneJson(doc));
    for (let t = 0; t < 400; t++) sim.step();
    expect(sim.applyCommand({ type: 'road.fillet', nodeId: 'n_0_0', ids: { a: 'fa', b: 'fb', seg: 'fc' } })).toEqual({ ok: true });
    const problems: string[] = [];
    for (let t = 0; t < 600; t++) {
      sim.step();
      problems.push(...checkInvariants(sim));
    }
    expect(problems).toEqual([]);
    expect(sim.vehicles().length).toBeGreaterThan(0);
  });
});
