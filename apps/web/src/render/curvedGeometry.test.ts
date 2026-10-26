// Rounded volumes in the baked building mesh (ADR 0012 §4): extruded rounded outline, facade u along
// the arc run, normals averaged only inside a run, flat roof, triangle counts.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { arcSegments, partOutline, partOutlineEdges, type BuildingPart } from '@smartcity/shared';
import { bakeBuildingGeometry } from './buildingGeometry';

const part = (p: Partial<BuildingPart>): BuildingPart => ({
  offset: { x: 0, z: 0 },
  width: 20,
  depth: 20,
  floors: 3,
  floorHeight: 3,
  baseHeight: 0,
  roof: 'flat',
  color: '#cccccc',
  roofColor: '#666666',
  ...p,
});

interface WallVertex {
  x: number;
  z: number;
  u: number;
  w: number;
  nx: number;
  ny: number;
  nz: number;
}

function wallVertices(g: THREE.BufferGeometry): WallVertex[] {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const wall = g.getAttribute('aWall');
  const out: WallVertex[] = [];
  for (let i = 0; i < pos.count; i++) {
    if (wall.getZ(i) <= 0) continue;
    out.push({ x: pos.getX(i), z: pos.getZ(i), u: wall.getX(i), w: wall.getZ(i), nx: nor.getX(i), ny: nor.getY(i), nz: nor.getZ(i) });
  }
  return out;
}

const triangles = (g: THREE.BufferGeometry): number => g.getAttribute('position').count / 3;

describe('rounded volume geometry', () => {
  it('round 0 bakes exactly like an omitted radius', () => {
    const a = bakeBuildingGeometry({ parts: [part({ width: 10, depth: 8 })] });
    const b = bakeBuildingGeometry({ parts: [part({ width: 10, depth: 8, round: 0 })] });
    for (const name of ['position', 'normal', 'aWall', 'aFacade', 'color']) {
      expect(Array.from(b.getAttribute(name).array)).toEqual(Array.from(a.getAttribute(name).array));
    }
    expect(triangles(a)).toBe(10);
  });

  it('a circle is one closed run: u = length along the arc, w = its whole length, radial normals', () => {
    const p = part({ round: 10 });
    const outline = partOutline(p);
    expect(partOutlineEdges(p).arcCorner.every((c) => c >= 0)).toBe(true);
    const g = bakeBuildingGeometry({ parts: [p] });
    const n = 4 * arcSegments(10);
    // Walls 2 per chord + flat roof fan (n − 2); a ground volume has no underside.
    expect(triangles(g)).toBe(2 * n + (n - 2));
    let perimeter = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      perimeter += Math.hypot(b.x - a.x, b.z - a.z);
    }
    const ws = wallVertices(g);
    expect(ws).toHaveLength(6 * n);
    for (const v of ws) {
      expect(v.w).toBeCloseTo(perimeter, 4);
      expect(v.u).toBeGreaterThanOrEqual(-1e-6);
      expect(v.u).toBeLessThanOrEqual(perimeter + 1e-4);
      // Averaged chord normals of a regular polygon point straight out from the centre.
      const r = Math.hypot(v.x, v.z);
      expect(v.ny).toBe(0);
      expect(v.nx).toBeCloseTo(v.x / r, 5);
      expect(v.nz).toBeCloseTo(v.z / r, 5);
    }
    // u grows by the chord length along each wall quad (uniform bays over the whole run).
    for (let q = 0; q < n; q++) {
      const [a0, b1] = [ws[6 * q]!, ws[6 * q + 1]!];
      expect(b1.u - a0.u).toBeCloseTo(Math.hypot(b1.x - a0.x, b1.z - a0.z), 4);
    }
    // The roof stays sharp: every roof triangle faces straight up.
    const nor = g.getAttribute('normal');
    const wall = g.getAttribute('aWall');
    for (let i = 0; i < nor.count; i++) if (wall.getZ(i) < 0) expect(nor.getY(i)).toBeCloseTo(1, 6);
  });

  it('rounded corners: one run per corner, flat walls and run ends keep their own normals', () => {
    const p = part({ width: 24, depth: 16, round: 3 });
    const k = arcSegments(3);
    const g = bakeBuildingGeometry({ parts: [p] });
    const edges = 4 * (k + 1);
    expect(triangles(g)).toBe(2 * edges + (edges - 2));
    const ws = wallVertices(g);
    const widths = [...new Set(ws.map((v) => Math.round(v.w * 1e4) / 1e4))].sort((a, b) => a - b);
    // Straight walls 18 m and 10 m long; each corner run is k chords of a quarter circle (≈ 4.71 m).
    expect(widths).toHaveLength(3);
    expect(widths[0]).toBeCloseTo((Math.PI / 2) * 3, 1);
    expect(widths[0]).toBeLessThan((Math.PI / 2) * 3);
    expect(widths.slice(1)).toEqual([10, 18]);
    // Straight walls: axis-aligned normals at both ends (the arc's normals do not bleed in).
    for (const v of ws.filter((v) => v.w === 18)) expect([v.nx, v.nz]).toEqual([0, v.z > 0 ? 1 : -1]);
    // A run's first and last vertices use their own chord's normal; inner vertices are averaged (radial).
    const run = ws.filter((v) => Math.abs(v.w - widths[0]!) < 1e-3 && v.x > 0 && v.z > 0);
    const centre = { x: 9, z: 5 };
    for (const v of run) {
      const ends = v.u < 1e-6 || v.u > widths[0]! - 1e-4;
      const radial = { x: (v.x - centre.x) / 3, z: (v.z - centre.z) / 3 };
      const dot = v.nx * radial.x + v.nz * radial.z;
      if (ends) expect(dot).toBeLessThan(1 - 1e-6);
      else expect(dot).toBeCloseTo(1, 5);
    }
  });

  it('a capsule has two half-circle runs and two straight walls; raised volumes add a flat underside', () => {
    const p = part({ width: 30, depth: 10, round: 5, baseHeight: 6 });
    const k = arcSegments(5);
    expect(partOutlineEdges(p).arcCorner.filter((c) => c < 0)).toHaveLength(2);
    const g = bakeBuildingGeometry({ parts: [p] });
    const verts = 4 * k + 2;
    expect(triangles(g)).toBe(2 * verts + 2 * (verts - 2));
    const ws = wallVertices(g);
    const runs = ws.filter((v) => v.w < 20);
    expect(runs.length).toBe(6 * 2 * (2 * k));
    for (const v of runs) expect(v.w).toBeCloseTo(Math.PI * 5, 0);
  });

  it('reports triangle counts of typical rounded designs (instanced: one mesh per design)', () => {
    const counts = {
      box: triangles(bakeBuildingGeometry({ parts: [part({})] })),
      roundedCorners2m: triangles(bakeBuildingGeometry({ parts: [part({ round: 2 })] })),
      tower20m: triangles(bakeBuildingGeometry({ parts: [part({ round: 10 })] })),
      tower60m: triangles(bakeBuildingGeometry({ parts: [part({ width: 60, depth: 60, round: 30 })] })),
    };
    expect(counts).toEqual({ box: 10, roundedCorners2m: 58, tower20m: 94, tower60m: 190 });
  });

  // Sol P5d review #6: straight walls a few centimetres long next to the largest radius stay straight
  // (the arc/straight split comes from how the outline is built, not from a distance tolerance).
  it.each([
    [9.95, 0.1],
    [9.99, 0.02],
  ])('round %f on a 20 m square keeps its %f m straight walls out of the corner runs', (round, side) => {
    const p = part({ round });
    const { outline, arcCorner } = partOutlineEdges(p);
    const straight = arcCorner.flatMap((c, i) => (c < 0 ? [i] : []));
    expect(straight).toHaveLength(4);
    for (const i of straight) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(side, 5);
    }
    const ws = wallVertices(bakeBuildingGeometry({ parts: [p] }));
    const widths = [...new Set(ws.map((v) => Math.round(v.w * 1e4) / 1e4))].sort((x, y) => x - y);
    // Four straight walls of `side` and four corner runs of about a quarter circle each — never one closed run.
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeCloseTo(side, 4);
    expect(widths[1]).toBeCloseTo((Math.PI / 2) * round, 1);
    for (const v of ws.filter((v) => Math.abs(v.w - side) < 1e-4)) expect(Math.abs(v.nx) + Math.abs(v.nz)).toBeCloseTo(1, 9);
  });

  it('round = half the side (the maximum) is one closed run with no straight wall', () => {
    const p = part({ round: 10 });
    expect(partOutlineEdges(p).arcCorner.some((c) => c < 0)).toBe(false);
    const ws = wallVertices(bakeBuildingGeometry({ parts: [p] }));
    expect(new Set(ws.map((v) => Math.round(v.w * 1e4))).size).toBe(1);
  });
});
