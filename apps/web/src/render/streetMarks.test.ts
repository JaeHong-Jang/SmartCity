import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MeshBuilder } from './meshBuilder';
import { BUMP_HEIGHT, BUMP_LENGTH, speedBump, zebra, zebraStripes, ZEBRA_GAP, ZEBRA_STRIPE } from './streetMarks';

// A 4 m wide zebra across a 10 m carriageway of a road running along x; walking line along z.
const polygon = [
  { x: 8, z: -5 },
  { x: 12, z: -5 },
  { x: 12, z: 5 },
  { x: 8, z: 5 },
];
const a = { x: 10, z: -5 };
const b = { x: 10, z: 5 };

describe('zebra crossing geometry', () => {
  it('lays 0.5 m stripes 0.5 m apart along the walking line, spanning the polygon', () => {
    const stripes = zebraStripes(polygon, a, b);
    // 10 m: floor((10 + 0.5) / 1.0) = 10 stripes.
    expect(stripes).toHaveLength(10);
    for (const q of stripes) {
      const zs = q.map((p) => p.z);
      const xs = q.map((p) => p.x);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(ZEBRA_STRIPE, 6);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 6);
    }
    const gap = Math.min(...stripes[1]!.map((p) => p.z)) - Math.max(...stripes[0]!.map((p) => p.z));
    expect(gap).toBeCloseTo(ZEBRA_GAP, 6);
    // Centered on the polygon.
    const all = stripes.flat().map((p) => p.z);
    expect((Math.max(...all) + Math.min(...all)) / 2).toBeCloseTo(0, 6);
  });

  it('appends two triangles per stripe to the mesh builder', () => {
    const mb = new MeshBuilder();
    const n = zebra(mb, polygon, a, b, 0.08, new THREE.Color('#fff'));
    expect(n).toBe(10);
    expect(mb.pos.length / 9).toBe(n * 2);
    for (let i = 1; i < mb.pos.length; i += 3) expect(mb.pos[i]).toBeCloseTo(0.08, 6);
  });

  it('yields nothing for degenerate input', () => {
    expect(zebraStripes([], a, b)).toHaveLength(0);
    expect(zebraStripes(polygon, a, a)).toHaveLength(0);
  });
});

describe('speed bump geometry', () => {
  const centerline = [
    { x: 0, z: 0 },
    { x: 100, z: 0 },
  ];

  it('is a low wedge across the carriageway at the given arc length', () => {
    const mb = new MeshBuilder();
    const cells = speedBump(mb, centerline, 40, 3.5, 0.085);
    // 4 cells along × 28 across.
    expect(cells).toBe(4 * 28);
    expect(mb.pos.length / 9).toBe(cells * 2);
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < mb.pos.length; i += 3) {
      xs.push(mb.pos[i]!);
      ys.push(mb.pos[i + 1]!);
      zs.push(mb.pos[i + 2]!);
    }
    expect(Math.min(...xs)).toBeCloseTo(40 - BUMP_LENGTH / 2, 5);
    expect(Math.max(...xs)).toBeCloseTo(40 + BUMP_LENGTH / 2, 5);
    expect(Math.min(...zs)).toBeCloseTo(-3.5, 5);
    expect(Math.max(...zs)).toBeCloseTo(3.5, 5);
    expect(Math.max(...ys)).toBeCloseTo(0.085 + BUMP_HEIGHT, 6);
    expect(Math.min(...ys)).toBeCloseTo(0.085, 6);
  });

  it('with a median (inner half width) covers only the two driving areas', () => {
    const mb = new MeshBuilder();
    // 4 cells along × 10 across on each side (1 … 3.5 m).
    expect(speedBump(mb, centerline, 40, 3.5, 0.085, 1)).toBe(4 * 10 * 2);
    const zs: number[] = [];
    for (let i = 2; i < mb.pos.length; i += 3) zs.push(mb.pos[i]!);
    expect(Math.min(...zs.map(Math.abs))).toBeCloseTo(1, 5);
    expect(Math.max(...zs.map(Math.abs))).toBeCloseTo(3.5, 5);
    expect(zs.some((z) => z < 0) && zs.some((z) => z > 0)).toBe(true);
    // No median: the same triangles as before (inner 0 is the default).
    const plain = new MeshBuilder();
    const zero = new MeshBuilder();
    speedBump(plain, centerline, 40, 3.5, 0.085);
    speedBump(zero, centerline, 40, 3.5, 0.085, 0);
    expect(zero.pos).toEqual(plain.pos);
    expect(zero.col).toEqual(plain.col);
  });

  it('alternates yellow and black bands', () => {
    const mb = new MeshBuilder();
    speedBump(mb, centerline, 40, 3.5, 0.085);
    const colors = new Set<string>();
    for (let i = 0; i < mb.col.length; i += 3) colors.add(`${mb.col[i]!.toFixed(2)},${mb.col[i + 1]!.toFixed(2)},${mb.col[i + 2]!.toFixed(2)}`);
    expect(colors.size).toBe(2);
  });
});
