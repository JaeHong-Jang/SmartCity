// One building design (type) baked into a single BufferGeometry in the building's local frame:
// extruded walls from each volume's outline, flat or pitched roofs, and rooftop smart equipment.
// Facade patterns are drawn by the shared material from per-vertex attributes:
//   aWall   = (u, v, w): walls: u = metres along the wall from its corner, v = metres above the
//             volume base, w = wall length (> 0); on a rounded corner the "wall" is the whole run of
//             arc chords (u = length along the arc). Other surfaces: (x, z) local position and a
//             negative surface flag (SURFACE).
//   aFacade = (floorHeight, styleId, windowRatio, groundId); styleId 4/5 = the Korean high-rise
//             residential look (long face / short gable end), chosen per volume by isResidentialHighRise.
//   aTop    = wall height of the volume (m) on those apartment walls, 0 elsewhere (crown band).

import * as THREE from 'three';
import {
  partOutline,
  partOutlineEdges,
  polygonsOverlap,
  signedArea,
  type BuildingPart,
  type BuildingProp,
  type BuildingType,
  type Facade,
  type FacadeStyle,
  type GroundFloor,
  type SmartFeatures,
  type Vec2,
  type Zone,
} from '@smartcity/shared';
import { TONE_GLSL } from './buildingTone';

export const FACADE_STYLE_ID: Record<FacadeStyle, number> = { grid: 0, ribbon: 1, curtain: 2, none: 3 };
/** Shader styles of a residential high-rise volume: balcony face and gable end (측벽). */
export const APT_STYLE = { face: 4, gable: 5 } as const;
/** Floors from which a residential volume gets the high-rise apartment look. */
export const APT_MIN_FLOORS = 10;
/** A wall shorter than this share of the volume's longest wall is a gable end. */
const GABLE_SHARE = 0.7;
export const GROUND_ID: Record<GroundFloor, number> = { none: 0, shop: 1, lobby: 2, pilotis: 3 };
/** Negative aWall.z flags for non-wall surfaces. */
export const SURFACE = { roof: -1, solar: -2, green: -3, pad: -4, mark: -5, prop: -6 } as const;

const DEFAULT_FACADE: Facade = { style: 'grid', windowRatio: 0.45, ground: 'none' };
const SOLAR_COLOR = '#1f3a6e';
const GREEN_COLOR = '#4f8a3c';
const PAD_COLOR = '#30353d';
const PAD_RING = '#facc15';
const PAD_MARK = '#f8fafc';

export const wallHeight = (p: BuildingPart): number => p.floors * p.floorHeight;

/**
 * Korean high-rise residential rule (ADR 0014 §5): a residential volume (its own use, else the design's zone)
 * of APT_MIN_FLOORS+ floors with a punched or ribbon facade is drawn as an apartment block — balcony bands on
 * its long faces, a vertical colour stripe on its gable ends, a crown band on top. Shape only, no preset ids,
 * so designs from the editor follow the same rule.
 */
export function isResidentialHighRise(p: BuildingPart, zone?: Zone): boolean {
  const style = (p.facade ?? DEFAULT_FACADE).style;
  return (p.use ?? zone) === 'residential' && p.floors >= APT_MIN_FLOORS && (style === 'grid' || style === 'ribbon');
}
export const roofHeight = (p: BuildingPart): number =>
  p.roof === 'flat' || (p.footprint && p.footprint.length >= 3)
    ? 0
    : Math.min(p.roof === 'gable' ? 0.42 * Math.min(p.width, p.depth) : 0.55 * Math.min(p.width, p.depth), 14);

type V3 = [number, number, number];

class GeometryBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly wall: number[] = [];
  readonly fac: number[] = [];
  readonly top: number[] = [];
  private readonly c = new THREE.Color();
  private facade: [number, number, number, number] = [3, 0, 0.5, 0];
  private topV = 0;

  color(hex: string): void {
    this.c.set(hex);
  }

  setFacade(f: [number, number, number, number]): void {
    this.facade = f;
  }

  setStyle(id: number): void {
    this.facade = [this.facade[0], id, this.facade[2], this.facade[3]];
  }

  /** aTop of the following vertices (apartment wall height, 0 = none). */
  setTop(h: number): void {
    this.topV = h;
  }

  vertex(p: V3, n: V3, w: V3): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.wall.push(w[0], w[1], w[2]);
    this.fac.push(...this.facade);
    this.top.push(this.topV);
  }

  /** Triangle with a flat normal, flipped if needed so it faces along `want`. aWall = (x, z, flag). */
  tri(a: V3, b: V3, c: V3, want: V3, flag: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
      [b, c] = [c, b];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const n: V3 = [nx, ny, nz];
    for (const p of [a, b, c]) this.vertex(p, n, [p[0], p[2], flag]);
  }

  /** Horizontal rectangle [x0, x1] × [z0, z1] at height y, facing up. */
  quadUp(x0: number, z0: number, x1: number, z1: number, y: number, flag: number): void {
    const up: V3 = [0, 1, 0];
    this.tri([x0, y, z0], [x1, y, z0], [x1, y, z1], up, flag);
    this.tri([x0, y, z0], [x1, y, z1], [x0, y, z1], up, flag);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWall', new THREE.Float32BufferAttribute(this.wall, 3));
    g.setAttribute('aFacade', new THREE.Float32BufferAttribute(this.fac, 4));
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(this.top, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Outline as counter-clockwise (positive signed area in x, z). */
function ccw(poly: readonly Vec2[]): Vec2[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : [...poly];
}

/**
 * Walls along an outline. Edges flagged in `curved` (chords of a rounded corner) form runs of
 * consecutive curved edges: inside a run u is the length from the run's start and w the run's
 * length (window bays spread evenly over the chords, corner pillars only at the run's ends), and a
 * vertex shared by two chords of the run gets their average normal. Elsewhere (flat walls, the ends
 * of a run, roofs, floors) normals stay sharp. Without curved edges the output is unchanged.
 * `apt`: walls of a residential high-rise volume get APT_STYLE.face, or .gable when shorter than
 * GABLE_SHARE of the longest wall (a rounded run counts by its whole length).
 */
function walls(gb: GeometryBuilder, outline: Vec2[], y0: number, h: number, curved: readonly boolean[] = [], apt = false): void {
  const y1 = y0 + h;
  const n = outline.length;
  const len: number[] = [];
  const nor: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    len.push(l);
    // Counter-clockwise in (x, z): the outside is on the right of a → b.
    nor.push(l < 1e-6 ? [0, 0, 0] : [dz / l, 0, -dx / l]);
  }
  const inRun = (i: number): boolean => {
    const k = (i + n) % n;
    return !!curved[k] && len[k]! >= 1e-6;
  };
  const u0 = new Array<number>(n).fill(0);
  const total = len.slice();
  const closed = n > 0 && len.every((_, i) => inRun(i));
  for (let s = 0; s < n; s++) {
    if (!inRun(s) || (!closed && inRun(s - 1)) || (closed && s > 0)) continue;
    const run: number[] = [];
    let acc = 0;
    for (let k = s; inRun(k) && run.length < n; k = (k + 1) % n) {
      run.push(k);
      u0[k] = acc;
      acc += len[k]!;
    }
    for (const k of run) total[k] = acc;
  }
  const longest = Math.max(0, ...total);
  const avg = (p: V3, q: V3): V3 => {
    const x = p[0] + q[0];
    const z = p[2] + q[2];
    const l = Math.hypot(x, z) || 1;
    return [x / l, 0, z / l];
  };
  for (let i = 0; i < n; i++) {
    const l = len[i]!;
    if (l < 1e-6) continue;
    const a = outline[i]!;
    const b = outline[(i + 1) % n]!;
    const own = nor[i]!;
    const na = inRun(i) && inRun(i - 1) ? avg(nor[(i - 1 + n) % n]!, own) : own;
    const nb = inRun(i) && inRun(i + 1) ? avg(own, nor[(i + 1) % n]!) : own;
    const ua = u0[i]!;
    const ub = ua + l;
    const w = total[i]!;
    if (apt) gb.setStyle(w < GABLE_SHARE * longest ? APT_STYLE.gable : APT_STYLE.face);
    const a0: V3 = [a.x, y0, a.z];
    const b0: V3 = [b.x, y0, b.z];
    const a1: V3 = [a.x, y1, a.z];
    const b1: V3 = [b.x, y1, b.z];
    gb.vertex(a0, na, [ua, 0, w]);
    gb.vertex(b1, nb, [ub, h, w]);
    gb.vertex(b0, nb, [ub, 0, w]);
    gb.vertex(a0, na, [ua, 0, w]);
    gb.vertex(a1, na, [ua, h, w]);
    gb.vertex(b1, nb, [ub, h, w]);
  }
}

/** Flat cap over the outline (up = roof, down = underside of a raised volume). */
function cap(gb: GeometryBuilder, outline: Vec2[], y: number, up: boolean): void {
  const contour = outline.map((v) => new THREE.Vector2(v.x, v.z));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const want: V3 = [0, up ? 1 : -1, 0];
  for (const [i, j, k] of tris) {
    const a = outline[i!]!;
    const b = outline[j!]!;
    const c = outline[k!]!;
    gb.tri([a.x, y, a.z], [b.x, y, b.z], [c.x, y, c.z], want, SURFACE.roof);
  }
}

function pitchedRoof(gb: GeometryBuilder, p: BuildingPart, y: number): void {
  const rh = roofHeight(p);
  const cx = p.offset.x;
  const cz = p.offset.z;
  const hw = p.width / 2;
  const hd = p.depth / 2;
  const out = (pts: V3[]): V3 => {
    const m: V3 = [0, 0, 0];
    for (const q of pts) for (let k = 0; k < 3; k++) m[k]! += q[k]! / pts.length;
    return [m[0] - cx, m[1] - y, m[2] - cz];
  };
  const face = (pts: V3[]): void => {
    const w = out(pts);
    gb.tri(pts[0]!, pts[1]!, pts[2]!, w, SURFACE.roof);
    if (pts.length === 4) gb.tri(pts[0]!, pts[2]!, pts[3]!, w, SURFACE.roof);
  };
  const c00: V3 = [cx - hw, y, cz - hd];
  const c10: V3 = [cx + hw, y, cz - hd];
  const c11: V3 = [cx + hw, y, cz + hd];
  const c01: V3 = [cx - hw, y, cz + hd];
  if (p.roof === 'pyramid') {
    gb.color(p.roofColor);
    const apex: V3 = [cx, y + rh, cz];
    face([c00, c10, apex]);
    face([c10, c11, apex]);
    face([c11, c01, apex]);
    face([c01, c00, apex]);
    return;
  }
  // Gable: the ridge follows the longer side.
  if (p.width >= p.depth) {
    const r0: V3 = [cx - hw, y + rh, cz];
    const r1: V3 = [cx + hw, y + rh, cz];
    gb.color(p.roofColor);
    face([c01, c11, r1, r0]);
    face([c10, c00, r0, r1]);
    gb.color(p.color);
    face([c11, c10, r1]);
    face([c00, c01, r0]);
  } else {
    const r0: V3 = [cx, y + rh, cz - hd];
    const r1: V3 = [cx, y + rh, cz + hd];
    gb.color(p.roofColor);
    face([c11, c10, r0, r1]);
    face([c00, c01, r1, r0]);
    gb.color(p.color);
    face([c01, c11, r1]);
    face([c10, c00, r0]);
  }
}

/** x-intervals inside an orthogonal polygon on the horizontal line z. */
function scanline(poly: readonly Vec2[], z: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (Math.min(a.z, b.z) < z && z < Math.max(a.z, b.z)) xs.push(a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z));
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]!, xs[i + 1]!]);
  return out;
}

function intersectIntervals(a: [number, number][], b: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi > lo) out.push([lo, hi]);
    }
  }
  return out;
}

/** x-intervals inside the polygon for the whole band z0..z1 (conservative). */
function bandIntervals(poly: readonly Vec2[], z0: number, z1: number): [number, number][] {
  const eps = 1e-4;
  const zs = [z0 + eps, z1 - eps];
  for (const v of poly) if (v.z > z0 && v.z < z1) zs.push(v.z - eps, v.z + eps);
  let cur = scanline(poly, zs[0]!);
  for (let i = 1; i < zs.length && cur.length; i++) cur = intersectIntervals(cur, scanline(poly, zs[i]!));
  return cur;
}

interface RoofRow {
  z0: number;
  z1: number;
  spans: [number, number][];
  area: number;
}

/** Equipment rows of pitch `pitch` across the roof, kept `margin` metres inside the edges. */
export function roofRows(poly: readonly Vec2[], pitch = 2, margin = 0.8): RoofRow[] {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const v of poly) {
    minZ = Math.min(minZ, v.z);
    maxZ = Math.max(maxZ, v.z);
  }
  const rows: RoofRow[] = [];
  for (let z0 = minZ + margin; z0 + pitch <= maxZ - margin + 1e-6; z0 += pitch) {
    const spans = bandIntervals(poly, z0 - margin, z0 + pitch + margin)
      .map(([a, b]) => [a + margin, b - margin] as [number, number])
      .filter(([a, b]) => b - a >= 1.5);
    const area = spans.reduce((s, [a, b]) => s + (b - a) * pitch, 0);
    if (area > 0) rows.push({ z0, z1: z0 + pitch, spans, area });
  }
  return rows;
}

/**
 * Smart equipment on one roof: a drone pad on the back rows, solar panel rows from the back,
 * planting from the front. Shares are of the usable roof rows, so the budget reads 1:1.
 */
function roofEquipment(gb: GeometryBuilder, poly: readonly Vec2[], y: number, smart: SmartFeatures): void {
  const rows = roofRows(poly);
  const total = rows.reduce((s, r) => s + r.area, 0);
  if (total <= 0) return;
  const free = rows.map(() => true);

  if (smart.dronePort) {
    const pitch = rows[0]!.z1 - rows[0]!.z0;
    const want = Math.min(16, Math.max(5, Math.sqrt(0.1 * total)));
    const k = Math.min(rows.length, Math.max(1, Math.ceil(want / pitch)));
    let common: [number, number][] = [rows[0]!.spans.reduce((best, s) => (s[1] - s[0] > best[1] - best[0] ? s : best))];
    for (let i = 1; i < k; i++) common = intersectIntervals(common, rows[i]!.spans);
    const span = common.reduce<[number, number] | null>((best, s) => (!best || s[1] - s[0] > best[1] - best[0] ? s : best), null);
    const side = span ? Math.min(want, span[1] - span[0], k * pitch) : 0;
    if (span && side >= 3) {
      for (let i = 0; i < k; i++) free[i] = false;
      const cx = (span[0] + span[1]) / 2;
      const cz = rows[0]!.z0 + (k * pitch) / 2;
      dronePad(gb, cx, cz, side, y);
    }
  }

  // Solar from the back, planting from the front.
  let solarLeft = smart.solarRoof * total;
  gb.color(SOLAR_COLOR);
  for (let i = 0; i < rows.length && solarLeft > 1e-6; i++) {
    if (!free[i]) continue;
    free[i] = false;
    const r = rows[i]!;
    const pitch = r.z1 - r.z0;
    for (const [a, b] of r.spans) {
      if (solarLeft <= 1e-6) break;
      const len = Math.min(b - a, solarLeft / pitch);
      solarLeft -= len * pitch;
      if (len < 0.5) continue;
      gb.quadUp(a, r.z0 + 0.15, a + len, r.z0 + pitch * 0.8, y + 0.35, SURFACE.solar);
    }
  }
  let greenLeft = smart.greenRoof * total;
  gb.color(GREEN_COLOR);
  for (let i = rows.length - 1; i >= 0 && greenLeft > 1e-6; i--) {
    if (!free[i]) continue;
    free[i] = false;
    const r = rows[i]!;
    const pitch = r.z1 - r.z0;
    for (const [a, b] of r.spans) {
      if (greenLeft <= 1e-6) break;
      const len = Math.min(b - a, greenLeft / pitch);
      greenLeft -= len * pitch;
      if (len < 0.5) continue;
      gb.quadUp(a, r.z0, a + len, r.z1, y + 0.12, SURFACE.green);
    }
  }
}

function dronePad(gb: GeometryBuilder, cx: number, cz: number, side: number, y: number): void {
  const h = side / 2;
  gb.color(PAD_COLOR);
  gb.quadUp(cx - h, cz - h, cx + h, cz + h, y + 0.15, SURFACE.pad);
  const ring = Math.max(0.25, side * 0.05);
  gb.color(PAD_RING);
  gb.quadUp(cx - h, cz - h, cx + h, cz - h + ring, y + 0.2, SURFACE.mark);
  gb.quadUp(cx - h, cz + h - ring, cx + h, cz + h, y + 0.2, SURFACE.mark);
  gb.quadUp(cx - h, cz - h + ring, cx - h + ring, cz + h - ring, y + 0.2, SURFACE.mark);
  gb.quadUp(cx + h - ring, cz - h + ring, cx + h, cz + h - ring, y + 0.2, SURFACE.mark);
  // "H" seen from the front (+Z): two bars along Z and a crossbar along X.
  const s = side * 0.28;
  const bar = Math.max(0.3, side * 0.09);
  gb.color(PAD_MARK);
  gb.quadUp(cx - s, cz - s, cx - s + bar, cz + s, y + 0.22, SURFACE.mark);
  gb.quadUp(cx + s - bar, cz - s, cx + s, cz + s, y + 0.22, SURFACE.mark);
  gb.quadUp(cx - s + bar, cz - bar / 2, cx + s - bar, cz + bar / 2, y + 0.22, SURFACE.mark);
}

const hasFootprint = (p: BuildingPart): boolean => !!p.footprint && p.footprint.length >= 3;

/** True if another volume starts on top of this one and overlaps it in plan. */
function roofCovered(type: Pick<BuildingType, 'parts'>, p: BuildingPart): boolean {
  const top = p.baseHeight + wallHeight(p);
  return type.parts.some((q) => q !== p && Math.abs(q.baseHeight - top) < 0.5 && polygonsOverlap(partOutline(p), partOutline(q)));
}

/**
 * Props (studio decorations) from primitives with vertex colors. Local frame of a prop: x along the
 * wall, y up, z out of the wall (wall props start at z = 0) or centred (roof/ground props); rotated
 * by `rot` quarter turns (local +z → (sin, cos) of rot·90°) and widened by `size`.
 */
class PropBaker {
  private fx = 0;
  private fz = 1;
  private s: V3 = [1, 1, 1];
  private o: V3 = [0, 0, 0];

  constructor(private readonly gb: GeometryBuilder) {}

  begin(p: BuildingProp, wide: boolean): void {
    const r = ((Math.round(p.rot) % 4) + 4) % 4;
    this.fx = [0, 1, 0, -1][r]!;
    this.fz = [1, 0, -1, 0][r]!;
    this.s = wide ? [p.size, 1, 1] : [p.size, p.size, p.size];
    this.o = [p.pos.x, p.pos.y, p.pos.z];
  }

  private pt(l: V3): V3 {
    const x = l[0] * this.s[0];
    const z = l[2] * this.s[2];
    return [this.o[0] + x * this.fz + z * this.fx, this.o[1] + l[1] * this.s[1], this.o[2] - x * this.fx + z * this.fz];
  }

  private dir(n: V3): V3 {
    return [n[0] * this.fz + n[2] * this.fx, n[1], -n[0] * this.fx + n[2] * this.fz];
  }

  /** Convex planar face (local points) facing roughly along `want`. */
  face(pts: V3[], want: V3): void {
    const w = this.dir(want);
    const a = this.pt(pts[0]!);
    for (let i = 1; i + 1 < pts.length; i++) this.gb.tri(a, this.pt(pts[i]!), this.pt(pts[i + 1]!), w, SURFACE.prop);
  }

  box(color: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.gb.color(color);
    this.face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]);
    this.face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
    this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
    this.face([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1]);
    this.face([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], [1, 0, 0]);
    this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
  }

  /** Frustum around the local y axis at (cx, cz); r1 = 0 makes a cone. */
  cyl(color: string, cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, n = 8): void {
    this.gb.color(color);
    const ring = (y: number, r: number): V3[] => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, y, cz + Math.sin((i / n) * Math.PI * 2) * r] as V3);
    const lo = ring(y0, r0);
    const hi = ring(y1, r1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const m = ((i + 0.5) / n) * Math.PI * 2;
      const want: V3 = [Math.cos(m), 0.2, Math.sin(m)];
      if (r1 > 1e-6) this.face([lo[i]!, lo[j]!, hi[j]!, hi[i]!], want);
      else this.face([lo[i]!, lo[j]!, hi[0]!], want);
    }
    this.face(lo, [0, -1, 0]);
    if (r1 > 1e-6) this.face(hi, [0, 1, 0]);
  }

  /** Convex cross-section in (z, y) extruded along local x from x0 to x1. */
  extrudeX(color: string, section: [number, number][], x0: number, x1: number): void {
    this.gb.color(color);
    let cz = 0;
    let cy = 0;
    for (const [z, y] of section) {
      cz += z / section.length;
      cy += y / section.length;
    }
    this.face(section.map(([z, y]) => [x0, y, z] as V3), [-1, 0, 0]);
    this.face(section.map(([z, y]) => [x1, y, z] as V3), [1, 0, 0]);
    for (let i = 0; i < section.length; i++) {
      const [za, ya] = section[i]!;
      const [zb, yb] = section[(i + 1) % section.length]!;
      this.face([[x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb]], [0, (ya + yb) / 2 - cy, (za + zb) / 2 - cz]);
    }
  }
}

const PROP_DARK = '#374151';
const PROP_GREEN = '#4f8a3c';
const PROP_LIGHT = '#f8fafc';
/** Props whose `size` widens them only (the rest scale uniformly). */
const WIDE_PROPS = new Set<BuildingProp['kind']>(['balcony', 'awning', 'sign', 'canopy', 'planter', 'solarPanel', 'bench']);

function bakeProp(pb: PropBaker, p: BuildingProp): void {
  pb.begin(p, WIDE_PROPS.has(p.kind));
  const c = p.color;
  switch (p.kind) {
    case 'balcony':
      pb.box(c, -1.6, 0, 0, 1.6, 0.15, 1.2);
      pb.box(c, -1.6, 0.15, 1.12, 1.6, 1.05, 1.2);
      pb.box(c, -1.6, 0.15, 0, -1.52, 1.05, 1.12);
      pb.box(c, 1.52, 0.15, 0, 1.6, 1.05, 1.12);
      break;
    case 'awning':
      pb.extrudeX(c, [[0, 0.62], [0, 0.5], [1.25, 0], [1.25, 0.12]], -1.5, 1.5);
      break;
    case 'sign':
      pb.box(c, -1.2, 0, 0.02, 1.2, 0.9, 0.16);
      pb.box(PROP_LIGHT, -1.02, 0.14, 0.16, 1.02, 0.76, 0.19);
      break;
    case 'ac':
      pb.box(c, -0.45, 0, 0, 0.45, 0.6, 0.45);
      pb.box(PROP_DARK, -0.32, 0.1, 0.45, 0.32, 0.5, 0.48);
      break;
    case 'canopy':
      pb.box(c, -1.5, 2.55, 0, 1.5, 2.75, 1.9);
      pb.box(PROP_DARK, -1.45, 0, 1.72, -1.3, 2.55, 1.87);
      pb.box(PROP_DARK, 1.3, 0, 1.72, 1.45, 2.55, 1.87);
      break;
    case 'antenna':
      pb.box(PROP_DARK, -0.3, 0, -0.3, 0.3, 0.15, 0.3);
      pb.cyl(c, 0, 0, 0.15, 4, 0.07, 0.04, 6);
      pb.box(c, -0.4, 2.8, -0.03, 0.4, 2.86, 0.03);
      pb.box(c, -0.28, 3.4, -0.03, 0.28, 3.46, 0.03);
      break;
    case 'waterTank':
      for (const [x, z] of [[-0.7, -0.7], [0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]] as const) pb.box('#6b7280', x - 0.07, 0, z - 0.07, x + 0.07, 0.6, z + 0.07);
      pb.cyl(c, 0, 0, 0.6, 2, 0.95, 0.95, 10);
      pb.cyl(c, 0, 0, 2, 2.2, 0.95, 0.2, 10);
      break;
    case 'chimney':
      pb.box(c, -0.35, 0, -0.35, 0.35, 1.6, 0.35);
      pb.box(PROP_DARK, -0.42, 1.6, -0.42, 0.42, 1.75, 0.42);
      break;
    case 'planter':
      pb.box(c, -0.8, 0, -0.4, 0.8, 0.5, 0.4);
      pb.box(PROP_GREEN, -0.72, 0.5, -0.32, 0.72, 0.62, 0.32);
      pb.cyl(PROP_GREEN, -0.35, 0, 0.6, 0.9, 0.3, 0.15, 6);
      pb.cyl(PROP_GREEN, 0.35, 0, 0.6, 0.85, 0.28, 0.12, 6);
      break;
    case 'tree':
      pb.cyl('#6b4f3a', 0, 0, 0, 1.3, 0.15, 0.12, 6);
      pb.cyl(c, 0, 0, 1.0, 2.6, 0.9, 1.2);
      pb.cyl(c, 0, 0, 2.6, 4.2, 1.2, 0.15);
      break;
    case 'flag':
      pb.cyl('#d1d5db', -0.6, 0, 0, 4, 0.05, 0.04, 6);
      pb.box(c, -0.55, 3.2, -0.02, 0.65, 3.9, 0.02);
      break;
    case 'solarPanel':
      pb.box(PROP_DARK, -0.95, 0, 0.45, -0.85, 0.78, 0.55);
      pb.box(PROP_DARK, 0.85, 0, 0.45, 0.95, 0.78, 0.55);
      pb.extrudeX(c, [[-0.6, 0.2], [0.6, 0.75], [0.6, 0.82], [-0.6, 0.27]], -1, 1);
      break;
    case 'helipad':
      pb.box(c, -3, 0, -3, 3, 0.15, 3);
      pb.box('#facc15', -2.7, 0.15, -2.7, 2.7, 0.18, -2.4);
      pb.box('#facc15', -2.7, 0.15, 2.4, 2.7, 0.18, 2.7);
      pb.box('#facc15', -2.7, 0.15, -2.4, -2.4, 0.18, 2.4);
      pb.box('#facc15', 2.4, 0.15, -2.4, 2.7, 0.18, 2.4);
      pb.box(PROP_LIGHT, -1.1, 0.15, -1.2, -0.7, 0.19, 1.2);
      pb.box(PROP_LIGHT, 0.7, 0.15, -1.2, 1.1, 0.19, 1.2);
      pb.box(PROP_LIGHT, -0.7, 0.15, -0.2, 0.7, 0.19, 0.2);
      break;
    case 'bench':
      pb.box(c, -0.8, 0.42, -0.22, 0.8, 0.5, 0.22);
      pb.box(c, -0.8, 0.5, -0.26, 0.8, 0.9, -0.18);
      pb.box(PROP_DARK, -0.75, 0, -0.2, -0.65, 0.42, 0.2);
      pb.box(PROP_DARK, 0.65, 0, -0.2, 0.75, 0.42, 0.2);
      break;
  }
}

/** Bake all volumes of a design into one geometry in the building frame (ground at y = 0). */
export function bakeBuildingGeometry(type: Pick<BuildingType, 'parts' | 'smart' | 'props'> & { zone?: Zone }): THREE.BufferGeometry {
  const gb = new GeometryBuilder();
  for (const p of type.parts) {
    const f = p.facade ?? DEFAULT_FACADE;
    const ground = p.baseHeight < 0.5 ? GROUND_ID[f.ground] : 0;
    gb.setFacade([p.floorHeight, FACADE_STYLE_ID[f.style], f.windowRatio, ground]);
    // Rounded outlines are already counter-clockwise, so their per-edge arc flags line up with `outline`.
    const edges = partOutlineEdges(p);
    const outline = ccw(edges.outline);
    const h = wallHeight(p);
    const top = p.baseHeight + h;
    gb.color(p.color);
    const apt = isResidentialHighRise(p, type.zone);
    gb.setTop(apt ? h : 0);
    walls(gb, outline, p.baseHeight, h, outline[0] === edges.outline[0] ? edges.arcCorner.map((c) => c >= 0) : [], apt);
    gb.setTop(0);
    if (apt) gb.setStyle(FACADE_STYLE_ID[f.style]);
    if (p.baseHeight > 0.01) cap(gb, outline, p.baseHeight, false);
    // Drawn footprints always get a flat roof (the contract forbids pitched roofs on them).
    if (p.roof === 'flat' || hasFootprint(p)) {
      gb.color(p.roofColor);
      cap(gb, outline, top, true);
      if (type.smart && !roofCovered(type, p)) roofEquipment(gb, outline, top, type.smart);
    } else {
      pitchedRoof(gb, p, top);
    }
  }
  if (type.props?.length) {
    gb.setFacade([3, FACADE_STYLE_ID.none, 0.1, 0]);
    const pb = new PropBaker(gb);
    for (const pr of type.props) bakeProp(pb, pr);
  }
  return gb.build();
}

/**
 * Shared material for baked building geometry: vertex colors plus the facade shader, a darker band
 * where walls meet the ground (contact shading) and glass that picks up the sky color at grazing angles.
 */
export function createBuildingMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02 });
  mat.customProgramCacheKey = () => 'smartcity-building-v7';
  // uNight (0..1) and uSky (linear color) are shared by reference; set `material.userData.uNight.value` /
  // `uSky.value` each frame.
  const uNight = { value: 0 };
  const uSky = { value: new THREE.Color('#5f8fc2') };
  mat.userData.uNight = uNight;
  mat.userData.uSky = uSky;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.uniforms.uSky = uSky;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aWall;
        attribute vec4 aFacade;
        attribute float aOccupancy;
        attribute vec3 aTone;
        attribute float aTop;
        varying vec3 vTone;
        varying float vTop;
        varying vec3 vWall;
        varying vec4 vFacade;
        varying float vOcc;
        varying float vGroundY;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Instances only turn about Y and stand at y = 0, so this is the height above the ground.
        vGroundY = transformed.y;
        vWall = aWall;
        vFacade = aFacade;
        vOcc = aOccupancy;
        vTone = aTone;
        vTop = aTop;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWall;
        varying vec4 vFacade;
        varying float vOcc;
        varying vec3 vTone;
        varying float vTop;
        varying float vGroundY;
        uniform float uNight;
        uniform vec3 uSky;
        ${TONE_GLSL}
        float bHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float glassMask = 0.0;
        vec3 winGlow = vec3(0.0);
        // Derivatives must be taken in uniform control flow (outside the branches below).
        // Whole number of window bays per wall; the small bias keeps lengths like 24 m / 3.2 m = 7.5
        // from flipping between 7 and 8 bays from pixel to pixel.
        float bayW = max(vWall.z, 1.0) / max(1.0, floor(max(vWall.z, 0.0) / (vFacade.x > 6.0 ? 6.0 : 3.2) + 0.513));
        float blur = clamp(max(fwidth(vWall.x / bayW), fwidth(vWall.y / max(vFacade.x, 0.5))) * 1.2 - 0.2, 0.0, 1.0);
        if (vWall.z > 0.0) {
          float fh = vFacade.x;
          int style = int(vFacade.y + 0.5);
          float ratio = vFacade.z;
          int ground = int(vFacade.w + 0.5);
          float L = vWall.z;
          float u = vWall.x;
          float v = vWall.y;
          float fl = v / fh;
          float floorIdx = floor(fl);
          float inFloor = fract(fl);
          float bw = bayW;
          float bayIdx = floor(u / bw);
          float inBay = fract(u / bw);
          vec3 wallC = toneWall(diffuseColor.rgb, vTone);
          float rnd = bHash(vec2(floorIdx, bayIdx + L));
          vec3 glassC = vec3(0.10, 0.15, 0.21) + 0.07 * rnd + vec3(0.0, 0.02, 0.05) * inFloor;
          float win = 0.0;
          float avg = 0.0;
          if (style == 0) {
            float wy = clamp(sqrt(ratio) * 1.05, 0.3, 0.85);
            float wx = clamp(ratio / wy, 0.15, 0.92);
            win = step(0.5 - wx * 0.5, inBay) * step(inBay, 0.5 + wx * 0.5) * step(0.12, inFloor) * step(inFloor, 0.12 + wy);
            avg = wx * wy;
          } else if (style == 1) {
            float hb = clamp(ratio, 0.15, 0.85);
            float lo = 0.55 - hb * 0.5;
            win = step(lo, inFloor) * step(inFloor, lo + hb) * step(0.05, fract(u / 1.6));
            avg = hb;
          } else if (style == 2) {
            float solid = 1.0 - ratio;
            float mw = clamp(solid * 0.5, 0.03, 0.3);
            float slab = step(inFloor, max(0.04, solid * 0.5));
            win = step(mw, fract(u / 1.5)) * (1.0 - slab);
            glassC = mix(glassC, wallC * 0.55 + vec3(0.04, 0.07, 0.11), 0.35);
            // Panels differ slightly in tint, as real insulated glass units do.
            glassC *= 0.92 + 0.16 * bHash(vec2(floor(u / 1.5), floorIdx + L));
            avg = ratio;
          } else if (style >= 4) {
            // Korean high-rise apartment (ADR 0014 §5). One muted accent colour per volume (the same on all of
            // its walls: hashed from its height and the instance's tone shift), used by the gable stripe and the crown.
            float pick = bHash(vec2(floor(vTop * 7.0) + vTone.x, 4.7));
            vec3 accent = pick < 0.34 ? vec3(0.08, 0.2, 0.29) : (pick < 0.67 ? vec3(0.36, 0.13, 0.07) : vec3(0.12, 0.22, 0.13));
            if (style == 4) {
              // Balcony face: a light railing band at the foot of every floor, recessed glass above it with
              // white frames, and a solid party wall (pier) every three bays.
              float pier = step(fract(u / (bw * 3.0)), 0.07);
              float hi = 0.36 + 0.55 * clamp(ratio / 0.5, 0.6, 1.0);
              float glass = step(0.36, inFloor) * step(inFloor, hi);
              float frame = step(fract(u / 1.6), 0.05);
              win = glass * (1.0 - frame) * (1.0 - pier);
              float rail = step(inFloor, 0.3);
              wallC = mix(wallC, wallC * 1.06 + 0.03, rail * (1.0 - pier));
              // Shadow under the balcony slab.
              wallC *= 1.0 - 0.3 * step(0.3, inFloor) * step(inFloor, 0.36) * (1.0 - pier);
              glassC = vec3(0.07, 0.1, 0.13) + 0.06 * rnd;
              avg = (hi - 0.36) * 0.92 * 0.93;
            } else {
              // Gable end (측벽): solid, a narrow column of small windows in the middle and a full-height
              // accent stripe with a thin companion line towards one corner.
              float c = abs(u - L * 0.5);
              win = step(c, 0.55) * step(0.35, inFloor) * step(inFloor, 0.8);
              float stripe = step(L * 0.12, u) * step(u, L * 0.12 + max(1.5, L * 0.12));
              float line = step(L * 0.12 + max(1.5, L * 0.12) + 0.6, u) * step(u, L * 0.12 + max(1.5, L * 0.12) + 1.0);
              wallC = mix(wallC, accent, clamp(stripe + line, 0.0, 1.0) * step(v, vTop - fh * 1.5));
              avg = 0.04;
            }
            // Crown band (옥탑) over the top one and a half floors: solid, an accent band and a light coping line.
            float crown = step(vTop - fh * 1.5, v);
            float band = step(vTop - fh * 1.05, v) * step(v, vTop - fh * 0.45);
            win *= 1.0 - crown;
            wallC = mix(wallC, mix(wallC * 1.04 + 0.02, accent, band), crown);
            wallC = mix(wallC, wallC * 1.12 + 0.05, step(vTop - 0.25, v));
          }
          if (ground > 0 && floorIdx < 0.5) {
            if (ground == 1) {
              float m = fract(u / 4.0);
              win = step(0.05, inFloor) * step(inFloor, 0.76) * step(0.04, m) * step(m, 0.96);
              glassC = vec3(0.34, 0.36, 0.32) + 0.14 * rnd;
              wallC = mix(wallC, wallC * 0.4, step(0.8, inFloor) * step(inFloor, 0.95));
            } else if (ground == 2) {
              win = step(inFloor, 0.86) * step(0.05, fract(u / 2.2));
              glassC = vec3(0.26, 0.31, 0.35);
            } else {
              float col = step(inBay, 0.1) + step(0.9, inBay);
              wallC = mix(vec3(0.05, 0.055, 0.06), wallC * 0.85, clamp(col, 0.0, 1.0));
              win = 0.0;
            }
            avg = win;
          } else {
            // Far away, fade the pattern to its average so it does not shimmer.
            win = mix(win, avg, blur);
          }
          // Keep the corners solid.
          win *= step(0.25, u) * step(u, L - 0.25);
          float slabLine = (1.0 - step(0.035, inFloor)) * step(0.5, v) * (style == 3 ? 0.5 : 1.0);
          diffuseColor.rgb = mix(wallC, glassC, win) * (1.0 - slabLine * 0.12);
          glassMask = win;
          // Night: a share of the windows proportional to the building's occupancy glows warm.
          float litP = vOcc > 0.0 ? 0.2 + 0.8 * vOcc : 0.0;
          float lit = mix(step(bHash(vec2(floorIdx * 1.7 + 3.1, bayIdx * 2.3 + L)), litP), litP, blur);
          winGlow = vec3(1.0, 0.76, 0.42) * (0.55 + 0.45 * rnd) * win * lit * uNight;
        } else if (vWall.z < -1.5 && vWall.z > -2.5) {
          vec2 cell = fract(vWall.xy / vec2(1.0, 0.65));
          float line = clamp(step(cell.x, 0.05) + step(cell.y, 0.06), 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.9 + 0.04, line);
          glassMask = 0.7;
        } else if (vWall.z < -2.5 && vWall.z > -3.5) {
          float n = bHash(floor(vWall.xy * 1.3));
          diffuseColor.rgb *= 0.8 + 0.4 * n;
        }
        // Contact shading: the bottom ~3.5 m is up to 20 % darker (cheap ambient occlusion).
        diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, 3.5, vGroundY));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.25, glassMask);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += winGlow * 1.1;
        // Glass reflects a sky gradient along the reflection vector (no environment map): hazy near the
        // horizon, deeper at the zenith, the darker ground below; more at grazing angles (Schlick-like), less at night.
        vec3 toEye = normalize(vViewPosition);
        float ry = dot(reflect(-toEye, normal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
        vec3 horizonC = mix(uSky, vec3(1.0), 0.4);
        vec3 skyRefl = ry >= 0.0 ? mix(horizonC, uSky * 0.8, sqrt(clamp(ry, 0.0, 1.0))) : mix(horizonC * 0.6, vec3(0.1, 0.11, 0.11), smoothstep(0.0, 0.5, -ry));
        float skyFres = pow(1.0 - clamp(dot(normal, toEye), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += skyRefl * glassMask * (0.06 + 0.32 * skyFres) * (1.0 - 0.75 * uNight);`,
      );
  };
  return mat;
}
