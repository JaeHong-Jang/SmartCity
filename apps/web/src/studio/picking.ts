// Studio picking without three.js: walk the cell grid along the ray (Amanatides–Woo DDA), so
// thousands of cells cost only the cells the ray crosses. Ghost meshes are never involved.

import { VOXEL_LIMITS } from '@smartcity/shared';

export type V3 = [number, number, number];

export interface CellHit {
  kind: 'cell';
  i: number;
  j: number;
  k: number;
  /** Outward normal of the face that was hit. */
  normal: V3;
  t: number;
  point: V3;
}

/** The ray reached the working plane (ground, or the base of the current floor) in an empty cell. */
export interface PlaneHit {
  kind: 'plane';
  i: number;
  j: number;
  /** Floor of the plane: a new cell here goes on floor k. */
  k: number;
  normal: V3;
  t: number;
  point: V3;
}

export type VoxelHit = CellHit | PlaneHit;

export interface PickOptions {
  cell: number;
  floorHeight: number;
  has(i: number, j: number, k: number): boolean;
  /** Working plane floor (0 = ground). Cells below it are not reached from above. */
  level?: number;
  half?: number;
  floors?: number;
}

/** First occupied cell or working-plane cell along the ray o + t·d (t ≥ 0), or null. */
export function pickVoxel(o: V3, d: V3, opt: PickOptions): VoxelHit | null {
  const half = opt.half ?? VOXEL_LIMITS.halfExtent;
  const floors = opt.floors ?? VOXEL_LIMITS.floors;
  const level = opt.level ?? 0;
  const s: V3 = [opt.cell, opt.floorHeight, opt.cell];
  // Grid space: one unit per cell / floor. t is unchanged by per-axis scaling.
  const go: V3 = [o[0] / s[0], o[1] / s[1], o[2] / s[2]];
  const gd: V3 = [d[0] / s[0], d[1] / s[1], d[2] / s[2]];
  const lo: V3 = [-half, level, -half];
  const hi: V3 = [half, floors, half];

  // Slab test against the working box.
  let t0 = 0;
  let t1 = Infinity;
  let entryAxis = -1;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(gd[a]!) < 1e-12) {
      if (go[a]! < lo[a]! || go[a]! > hi[a]!) return null;
      continue;
    }
    let ta = (lo[a]! - go[a]!) / gd[a]!;
    let tb = (hi[a]! - go[a]!) / gd[a]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) {
      t0 = ta;
      entryAxis = a;
    }
    t1 = Math.min(t1, tb);
  }
  if (t0 > t1) return null;

  const at = (t: number): V3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  const eps = 1e-9;
  const p = [go[0] + gd[0] * (t0 + eps), go[1] + gd[1] * (t0 + eps), go[2] + gd[2] * (t0 + eps)];
  const c = [Math.floor(p[0]!), Math.floor(p[1]!), Math.floor(p[2]!)];
  for (let a = 0; a < 3; a++) c[a] = Math.min(hi[a]! - 1, Math.max(lo[a]!, c[a]!));
  const step = [Math.sign(gd[0]), Math.sign(gd[1]), Math.sign(gd[2])];
  const tMax = [0, 0, 0];
  const tDelta = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (step[a] === 0) {
      tMax[a] = Infinity;
      tDelta[a] = Infinity;
    } else {
      const next = step[a]! > 0 ? c[a]! + 1 : c[a]!;
      tMax[a] = (next - go[a]!) / gd[a]!;
      tDelta[a] = Math.abs(1 / gd[a]!);
    }
  }
  let axis = entryAxis;
  let t = t0;
  for (let guard = 0; guard < 4 * (2 * half + floors) + 8; guard++) {
    if (c[1]! < level) {
      // Crossed the working plane through its top: a plane hit if we came down onto it.
      if (axis === 1 && step[1]! < 0) return { kind: 'plane', i: c[0]!, j: c[2]!, k: level, normal: [0, 1, 0], t, point: at(t) };
      return null;
    }
    if (c[0]! < lo[0] || c[0]! >= hi[0] || c[1]! >= hi[1] || c[2]! < lo[2] || c[2]! >= hi[2]) return null;
    if (opt.has(c[0]!, c[2]!, c[1]!)) {
      const n: V3 = [0, 0, 0];
      if (axis >= 0) n[axis] = -step[axis]!;
      else n[1] = 1;
      return { kind: 'cell', i: c[0]!, j: c[2]!, k: c[1]!, normal: n, t, point: at(t) };
    }
    // Advance to the next cell boundary.
    axis = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : tMax[1]! < tMax[2]! ? 1 : 2;
    t = tMax[axis]!;
    if (t > t1 + 1e-9 && !(axis === 1 && step[1]! < 0 && c[1]! - 1 < level)) return null;
    c[axis] = c[axis]! + step[axis]!;
    tMax[axis] = tMax[axis]! + tDelta[axis]!;
  }
  return null;
}

/** Cell (i, j) where the ray meets the horizontal plane y (null when parallel or behind). */
export function planeCell(o: V3, d: V3, y: number, cell: number): { i: number; j: number; point: V3 } | null {
  if (Math.abs(d[1]) < 1e-9) return null;
  const t = (y - o[1]) / d[1];
  if (t < 0) return null;
  const x = o[0] + d[0] * t;
  const z = o[2] + d[2] * t;
  return { i: Math.floor(x / cell), j: Math.floor(z / cell), point: [x, y, z] };
}

/** Distance along the ray to an axis-aligned box, or null when missed. */
export function rayBox(o: V3, d: V3, min: V3, max: V3): number | null {
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]!) < 1e-12) {
      if (o[a]! < min[a]! || o[a]! > max[a]!) return null;
      continue;
    }
    let ta = (min[a]! - o[a]!) / d[a]!;
    let tb = (max[a]! - o[a]!) / d[a]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
