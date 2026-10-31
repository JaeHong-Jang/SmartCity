// Street furniture geometry baked into the road chunks: zebra crossings and speed bumps.
// Pure functions that append triangles to a MeshBuilder.

import * as THREE from 'three';
import { add, bumpSpans, cumulativeLengths, normalize, pointAtLength, rightNormal, scale, sub, type Vec2 } from '@smartcity/shared';
import type { MeshBuilder } from './meshBuilder';

export const ZEBRA_STRIPE = 0.5;
export const ZEBRA_GAP = 0.5;
export const BUMP_LENGTH = 2;
export const BUMP_HEIGHT = 0.1;
const BUMP_CELL_ALONG = 0.5;
const BUMP_CELL_ACROSS = 0.25;
const BUMP_STRIPE = 0.5;

const C_BUMP_YELLOW = new THREE.Color('#f2c230');
const C_BUMP_BLACK = new THREE.Color('#202226');

export type Quad = [Vec2, Vec2, Vec2, Vec2];

/**
 * White stripes of a zebra crossing. `a`→`b` is the walking line; stripes are ZEBRA_STRIPE wide along it,
 * ZEBRA_GAP apart, and span the polygon's extent along the road.
 */
export function zebraStripes(polygon: readonly Vec2[], a: Vec2, b: Vec2): Quad[] {
  if (polygon.length < 3) return [];
  let ux = b.x - a.x;
  let uz = b.z - a.z;
  const ul = Math.hypot(ux, uz);
  if (ul < 1e-6) return [];
  ux /= ul;
  uz /= ul;
  const vx = -uz;
  const vz = ux;
  let cx = 0;
  let cz = 0;
  for (const p of polygon) {
    cx += p.x;
    cz += p.z;
  }
  cx /= polygon.length;
  cz /= polygon.length;
  let hl = 0;
  let hv = 0;
  for (const p of polygon) {
    hl = Math.max(hl, Math.abs((p.x - cx) * ux + (p.z - cz) * uz));
    hv = Math.max(hv, Math.abs((p.x - cx) * vx + (p.z - cz) * vz));
  }
  const pitch = ZEBRA_STRIPE + ZEBRA_GAP;
  const n = Math.floor((2 * hl + ZEBRA_GAP) / pitch);
  if (n < 1 || hv < 0.1) return [];
  const start = -(n * pitch - ZEBRA_GAP) / 2;
  const at = (u: number, v: number): Vec2 => ({ x: cx + ux * u + vx * v, z: cz + uz * u + vz * v });
  const out: Quad[] = [];
  for (let k = 0; k < n; k++) {
    const u0 = start + k * pitch;
    const u1 = u0 + ZEBRA_STRIPE;
    out.push([at(u0, -hv), at(u1, -hv), at(u1, hv), at(u0, hv)]);
  }
  return out;
}

/** Append a crossing's zebra stripes; returns the stripe count. */
export function zebra(b: MeshBuilder, polygon: readonly Vec2[], a: Vec2, bb: Vec2, y: number, color: THREE.Color): number {
  const stripes = zebraStripes(polygon, a, bb);
  for (const [p0, p1, p2, p3] of stripes) {
    b.tri(p0.x, y, p0.z, p1.x, y, p1.z, p2.x, y, p2.z, color);
    b.tri(p0.x, y, p0.z, p2.x, y, p2.z, p3.x, y, p3.z, color);
  }
  return stripes.length;
}

/** Bump cells with a corner closer than `inner` − this to the center line are left out (float tolerance), meters. */
const MEDIAN_CLIP_EPS = 1e-4;

/** Point-to-chord distance evaluations of the median clip since the last reset (a deterministic work measure for tests). */
let clipChecks = 0;
export const medianClipChecks = (): number => clipChecks;
export const resetMedianClipChecks = (): void => {
  clipChecks = 0;
};

/** Whether `p` is closer than `d` to one of the chords. */
function nearerThan(chords: readonly Vec2[][], p: Vec2, d: number): boolean {
  const d2 = d * d;
  for (const [a, b] of chords) {
    clipChecks++;
    const ux = b!.x - a!.x, uz = b!.z - a!.z;
    const len2 = ux * ux + uz * uz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a!.x) * ux + (p.z - a!.z) * uz) / len2)) : 0;
    const dx = p.x - (a!.x + ux * t), dz = p.z - (a!.z + uz * t);
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

/**
 * A speed bump across the carriageway at arc length `s` of `centerline`: a low wedge (BUMP_HEIGHT at the
 * crest) with diagonal yellow/black stripes, over `bumpSpans(halfWidth, inner)` (never across a median).
 * Its cross-sections follow the curve (offsets between the center line's mitred vertex normals). With a
 * median, any cell with a corner closer than `inner` to the whole center line (true point-to-polyline
 * distance) is left out, so on a hairpin, where the offsets fold over other parts of the curve, the bump
 * still never enters the median. Straight roads lose no cell. Returns the cell count.
 */
export function speedBump(b: MeshBuilder, centerline: readonly Vec2[], s: number, halfWidth: number, y: number, inner = 0): number {
  if (centerline.length < 2 || halfWidth <= 0) return 0;
  const cum = cumulativeLengths(centerline);
  const total = cum[cum.length - 1]!;
  const half = BUMP_LENGTH / 2;
  const sc = Math.min(Math.max(s, half), total - half);
  // Cross-sections: every BUMP_CELL_ALONG, plus the center line's own vertices under the bump (so no cell
  // spans a vertex and cuts its corner).
  const xs: number[] = [];
  for (let j = 0; j <= Math.round(BUMP_LENGTH / BUMP_CELL_ALONG); j++) xs.push(-half + j * BUMP_CELL_ALONG);
  for (let i = 1; i < centerline.length - 1; i++) {
    const x = cum[i]! - sc;
    if (x > -half && x < half && !xs.some((q) => Math.abs(q - x) < 1e-6)) xs.push(x);
  }
  xs.sort((p, q) => p - q);
  // Offset direction per vertex, scaled so that c + N·l lies on the offset lines (distance l) of both chords
  // meeting there (the miter; the plain normal at the ends). Between two vertices it is interpolated, so a
  // lateral offset l runs along the chord's offset line between the miter points: never closer than l to the
  // center line, on either side of a curve.
  const chordN = (i: number): Vec2 => rightNormal(normalize(sub(centerline[i + 1]!, centerline[i]!)));
  const vertexN = (i: number): Vec2 => {
    if (i === 0) return chordN(0);
    if (i === centerline.length - 1) return chordN(i - 1);
    const n0 = chordN(i - 1);
    const m = normalize(add(n0, chordN(i)));
    return scale(m, 1 / Math.max(0.5, m.x * n0.x + m.z * n0.z));
  };
  const frames = xs.map((x) => {
    const at = sc + x;
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < at) i++;
    const len = cum[i]! - cum[i - 1]!;
    const u = len > 0 ? Math.min(1, Math.max(0, (at - cum[i - 1]!) / len)) : 0;
    const n0 = vertexN(i - 1);
    const n1 = vertexN(i);
    return { c: pointAtLength(centerline, cum, at), n: { x: n0.x + (n1.x - n0.x) * u, z: n0.z + (n1.z - n0.z) * u } };
  });
  const height = (x: number): number => BUMP_HEIGHT * (1 - Math.abs(x) / half);
  const px = (j: number, l: number): Vec2 => ({ x: frames[j]!.c.x + frames[j]!.n.x * l, z: frames[j]!.c.z + frames[j]!.n.z * l });
  // Only center line chords within `inner` of the bump can be closer than `inner` to one of its corners:
  // keep those whose box meets the bump's box grown by `inner` (exact, and no whole-line scan per corner).
  let near: Vec2[][] | null = null;
  if (inner > 0) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let j = 0; j < xs.length; j++) {
      for (const l of [-halfWidth, halfWidth]) {
        const q = px(j, l);
        minX = Math.min(minX, q.x);
        maxX = Math.max(maxX, q.x);
        minZ = Math.min(minZ, q.z);
        maxZ = Math.max(maxZ, q.z);
      }
    }
    // Offsets are linear in l, so the corners at ±halfWidth bound every grid corner of a section.
    near = [];
    for (let i = 1; i < centerline.length; i++) {
      const p = centerline[i - 1]!, q = centerline[i]!;
      if (Math.max(p.x, q.x) < minX - inner || Math.min(p.x, q.x) > maxX + inner || Math.max(p.z, q.z) < minZ - inner || Math.min(p.z, q.z) > maxZ + inner) continue;
      near.push([p, q]);
    }
  }
  let cells = 0;
  for (const [from, to] of bumpSpans(halfWidth, inner)) {
    const acrossCells = Math.max(1, Math.round((to - from) / BUMP_CELL_ACROSS));
    const dAcross = (to - from) / acrossCells;
    // Grid corners inside the median (only computed with one).
    const inMedian = near ? xs.map((_, j) => Array.from({ length: acrossCells + 1 }, (_, i) => nearerThan(near, px(j, from + i * dAcross), inner - MEDIAN_CLIP_EPS))) : null;
    for (let j = 0; j + 1 < xs.length; j++) {
      const x0 = xs[j]!;
      const x1 = xs[j + 1]!;
      for (let i = 0; i < acrossCells; i++) {
        if (inMedian && (inMedian[j]![i] || inMedian[j]![i + 1] || inMedian[j + 1]![i] || inMedian[j + 1]![i + 1])) continue;
        const l0 = from + i * dAcross;
        const l1 = l0 + dAcross;
        const stripe = Math.floor((l0 + l1 + x0 + x1) / 2 / BUMP_STRIPE);
        const col = (stripe & 1) === 0 ? C_BUMP_YELLOW : C_BUMP_BLACK;
        const a = px(j, l0), bq = px(j + 1, l0), cq = px(j + 1, l1), d = px(j, l1);
        const h0 = y + height(x0), h1 = y + height(x1);
        b.tri(a.x, h0, a.z, bq.x, h1, bq.z, cq.x, h1, cq.z, col);
        b.tri(a.x, h0, a.z, cq.x, h1, cq.z, d.x, h0, d.z, col);
        cells++;
      }
    }
  }
  return cells;
}
