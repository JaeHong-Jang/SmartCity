// Prop placement in the studio (pure): snap a prop onto the face under the cursor, mirror it, and
// approximate its box for picking. Stored props are in metres (BuildingProp), never in cells.

import type { BuildingProp, PropKind, VoxelModel } from '@smartcity/shared';
import { PROP_INFO } from './palette';
import type { VoxelHit, V3 } from './picking';
import { cellBounds, type Symmetry } from './voxelEdit';

/** Quarter turn whose facing (+z rotated by rot·90° about y) matches a horizontal normal. */
export function rotForNormal(n: V3): number {
  if (n[2] > 0.5) return 0;
  if (n[0] > 0.5) return 1;
  if (n[2] < -0.5) return 2;
  return 3;
}

/** Facing direction of a quarter turn: 0 = +z (front), 1 = +x, 2 = −z, 3 = −x. */
export const ROT_DIR: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

const r2 = (v: number): number => Math.round(v * 100) / 100;

export type PropSnap = { ok: true; prop: BuildingProp } | { ok: false; prop: BuildingProp | null; reason: string };

/**
 * Snap a prop to a hit: wall props on side faces (facing out), top props on up-facing faces
 * (roofs or the ground near the building). `rot` is the user's turn for top props.
 */
export function snapProp(model: VoxelModel, hit: VoxelHit, kind: PropKind, rot: number, size: number, color: string): PropSnap {
  const info = PROP_INFO[kind];
  const { cell, floorHeight: fh } = model;
  const cx = (hit.i + 0.5) * cell;
  const cz = (hit.j + 0.5) * cell;
  if (info.mount === 'wall') {
    if (hit.kind !== 'cell' || hit.normal[1] !== 0) return { ok: false, prop: null, reason: `${info.label}은(는) 벽면에 붙입니다` };
    const n = hit.normal;
    const prop: BuildingProp = {
      kind,
      pos: { x: r2(n[0] !== 0 ? (hit.i + (n[0] > 0 ? 1 : 0)) * cell : cx), y: r2(hit.k * fh + info.yFrac * fh), z: r2(n[2] !== 0 ? (hit.j + (n[2] > 0 ? 1 : 0)) * cell : cz) },
      rot: rotForNormal(n),
      size,
      color,
    };
    return { ok: true, prop };
  }
  if (hit.normal[1] !== 1) return { ok: false, prop: null, reason: `${info.label}은(는) 옥상이나 바닥 위에 놓습니다` };
  const y = hit.kind === 'cell' ? (hit.k + 1) * fh : hit.k * fh;
  const prop: BuildingProp = { kind, pos: { x: r2(cx), y: r2(y), z: r2(cz) }, rot: ((rot % 4) + 4) % 4, size, color };
  if (hit.kind === 'plane') {
    const why = outOfReach(model, prop);
    if (why) return { ok: false, prop, reason: why };
  }
  return { ok: true, prop };
}

/** Why a prop would be rejected by the server bounds (plan extent ± 2 m, height ≤ top + 6 m), or null. */
export function outOfReach(model: VoxelModel, prop: BuildingProp): string | null {
  const b = cellBounds(model);
  if (!b) return '먼저 블록을 쌓아야 장식을 붙일 수 있습니다';
  const c = model.cell;
  const { x, y, z } = prop.pos;
  if (x < b.i0 * c - 2 || x > (b.i1 + 1) * c + 2 || z < b.j0 * c - 2 || z > (b.j1 + 1) * c + 2) return '장식은 건물에서 2m 이내에만 둘 수 있습니다';
  if (y > (b.k1 + 1) * model.floorHeight + 6) return '장식이 건물 꼭대기보다 너무 높습니다';
  return null;
}

/** Mirror images of a prop for the symmetry toggles (positions mirrored across x = 0 / z = 0). */
export function mirrorProps(p: BuildingProp, sym: Symmetry): BuildingProp[] {
  const out: BuildingProp[] = [p];
  const mx = (q: BuildingProp): BuildingProp => ({ ...q, pos: { ...q.pos, x: r2(-q.pos.x) }, rot: [0, 3, 2, 1][q.rot]! });
  const mz = (q: BuildingProp): BuildingProp => ({ ...q, pos: { ...q.pos, z: r2(-q.pos.z) }, rot: [2, 1, 0, 3][q.rot]! });
  if (sym.x) out.push(mx(p));
  if (sym.z) out.push(mz(p));
  if (sym.x && sym.z) out.push(mz(mx(p)));
  const seen = new Set<string>();
  return out.filter((q) => {
    const k = `${q.pos.x},${q.pos.y},${q.pos.z},${q.rot}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Rough local size (width along the wall / x, height, depth out of the wall / z) for picking. */
const PROP_BOX: Record<PropKind, { w: number; h: number; d: number; wide: boolean }> = {
  balcony: { w: 3.2, h: 1.1, d: 1.3, wide: true },
  awning: { w: 3, h: 0.7, d: 1.3, wide: true },
  sign: { w: 2.4, h: 0.9, d: 0.2, wide: true },
  ac: { w: 0.9, h: 0.65, d: 0.5, wide: false },
  canopy: { w: 3, h: 2.8, d: 2, wide: true },
  antenna: { w: 0.8, h: 4, d: 0.8, wide: false },
  waterTank: { w: 2, h: 2.2, d: 2, wide: false },
  chimney: { w: 0.8, h: 1.8, d: 0.8, wide: false },
  planter: { w: 1.6, h: 0.9, d: 0.8, wide: true },
  tree: { w: 2.4, h: 4.2, d: 2.4, wide: false },
  flag: { w: 1.4, h: 4, d: 0.3, wide: false },
  solarPanel: { w: 2, h: 0.8, d: 1.3, wide: true },
  helipad: { w: 6, h: 0.3, d: 6, wide: false },
  bench: { w: 1.6, h: 0.9, d: 0.6, wide: true },
};

/** Axis-aligned box of a prop in the building frame (approximate, for picking and highlights). */
export function propBox(p: BuildingProp): { min: V3; max: V3 } {
  const b = PROP_BOX[p.kind];
  const wall = PROP_INFO[p.kind].mount === 'wall';
  const w = b.w * p.size;
  const h = b.wide ? b.h : b.h * p.size;
  const d = b.wide ? b.d : b.d * p.size;
  // Local x ∈ [−w/2, w/2], z ∈ [0, d] for wall props (out of the wall) or [−d/2, d/2] for top props.
  const z0 = wall ? 0 : -d / 2;
  const z1 = wall ? d : d / 2;
  const [fx, fz] = ROT_DIR[p.rot] ?? [0, 1];
  // Local +z maps to (fx, fz); local +x maps to (fz, −fx).
  const xs = [-w / 2, w / 2];
  const zs = [z0, z1];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const lx of xs) {
    for (const lz of zs) {
      const x = p.pos.x + lx * fz + lz * fx;
      const z = p.pos.z - lx * fx + lz * fz;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  return { min: [minX, p.pos.y, minZ], max: [maxX, p.pos.y + h, maxZ] };
}
