// Street furniture geometry baked into the road chunks: zebra crossings and speed bumps.
// Pure functions that append triangles to a MeshBuilder.

import * as THREE from 'three';
import { cumulativeLengths, pointAtLength, rightNormal, tangentAtLength, type Vec2 } from '@smartcity/shared';
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

/**
 * A speed bump across the carriageway at arc length `s` of `centerline`: a low wedge (BUMP_HEIGHT at the
 * crest) with diagonal yellow/black stripes. Returns the cell count.
 */
export function speedBump(b: MeshBuilder, centerline: readonly Vec2[], s: number, halfWidth: number, y: number): number {
  if (centerline.length < 2 || halfWidth <= 0) return 0;
  const cum = cumulativeLengths(centerline);
  const total = cum[cum.length - 1]!;
  const sc = Math.min(Math.max(s, BUMP_LENGTH / 2), total - BUMP_LENGTH / 2);
  const c = pointAtLength(centerline, cum, sc);
  const t = tangentAtLength(centerline, cum, sc);
  const nrm = rightNormal(t);
  const half = BUMP_LENGTH / 2;
  const alongCells = Math.round(BUMP_LENGTH / BUMP_CELL_ALONG);
  const acrossCells = Math.max(1, Math.round((2 * halfWidth) / BUMP_CELL_ACROSS));
  const dAcross = (2 * halfWidth) / acrossCells;
  const height = (x: number): number => BUMP_HEIGHT * (1 - Math.abs(x) / half);
  const px = (x: number, l: number): Vec2 => ({ x: c.x + t.x * x + nrm.x * l, z: c.z + t.z * x + nrm.z * l });
  for (let j = 0; j < alongCells; j++) {
    const x0 = -half + j * BUMP_CELL_ALONG;
    const x1 = x0 + BUMP_CELL_ALONG;
    for (let i = 0; i < acrossCells; i++) {
      const l0 = -halfWidth + i * dAcross;
      const l1 = l0 + dAcross;
      const stripe = Math.floor((l0 + l1 + x0 + x1) / 2 / BUMP_STRIPE);
      const col = (stripe & 1) === 0 ? C_BUMP_YELLOW : C_BUMP_BLACK;
      const a = px(x0, l0), bq = px(x1, l0), cq = px(x1, l1), d = px(x0, l1);
      const h0 = y + height(x0), h1 = y + height(x1);
      b.tri(a.x, h0, a.z, bq.x, h1, bq.z, cq.x, h1, cq.z, col);
      b.tri(a.x, h0, a.z, cq.x, h1, cq.z, d.x, h0, d.z, col);
    }
  }
  return alongCells * acrossCells;
}
