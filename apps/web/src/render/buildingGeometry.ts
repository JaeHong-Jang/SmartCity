// One building design (type) baked into a single BufferGeometry in the building's local frame:
// extruded walls from each volume's outline, flat or pitched roofs, and rooftop smart equipment.
// Facade patterns are drawn by the shared material from per-vertex attributes:
//   aWall   = (u, v, w): walls: u = metres along the wall from its corner, v = metres above the
//             volume base, w = wall length (> 0). Other surfaces: (x, z) local position and a
//             negative surface flag (SURFACE).
//   aFacade = (floorHeight, styleId, windowRatio, groundId).

import * as THREE from 'three';
import {
  partOutline,
  polygonsOverlap,
  signedArea,
  type BuildingPart,
  type BuildingType,
  type Facade,
  type FacadeStyle,
  type GroundFloor,
  type SmartFeatures,
  type Vec2,
} from '@smartcity/shared';

export const FACADE_STYLE_ID: Record<FacadeStyle, number> = { grid: 0, ribbon: 1, curtain: 2, none: 3 };
export const GROUND_ID: Record<GroundFloor, number> = { none: 0, shop: 1, lobby: 2, pilotis: 3 };
/** Negative aWall.z flags for non-wall surfaces. */
export const SURFACE = { roof: -1, solar: -2, green: -3, pad: -4, mark: -5 } as const;

const DEFAULT_FACADE: Facade = { style: 'grid', windowRatio: 0.45, ground: 'none' };
const SOLAR_COLOR = '#1f3a6e';
const GREEN_COLOR = '#4f8a3c';
const PAD_COLOR = '#30353d';
const PAD_RING = '#facc15';
const PAD_MARK = '#f8fafc';

export const wallHeight = (p: BuildingPart): number => p.floors * p.floorHeight;
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
  private readonly c = new THREE.Color();
  private facade: [number, number, number, number] = [3, 0, 0.5, 0];

  color(hex: string): void {
    this.c.set(hex);
  }

  setFacade(f: [number, number, number, number]): void {
    this.facade = f;
  }

  vertex(p: V3, n: V3, w: V3): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.wall.push(w[0], w[1], w[2]);
    this.fac.push(...this.facade);
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
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Outline as counter-clockwise (positive signed area in x, z). */
function ccw(poly: readonly Vec2[]): Vec2[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : [...poly];
}

function walls(gb: GeometryBuilder, outline: Vec2[], y0: number, h: number): void {
  const y1 = y0 + h;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    // Counter-clockwise in (x, z): the outside is on the right of a → b.
    const n: V3 = [dz / len, 0, -dx / len];
    const a0: V3 = [a.x, y0, a.z];
    const b0: V3 = [b.x, y0, b.z];
    const a1: V3 = [a.x, y1, a.z];
    const b1: V3 = [b.x, y1, b.z];
    gb.vertex(a0, n, [0, 0, len]);
    gb.vertex(b1, n, [len, h, len]);
    gb.vertex(b0, n, [len, 0, len]);
    gb.vertex(a0, n, [0, 0, len]);
    gb.vertex(a1, n, [0, h, len]);
    gb.vertex(b1, n, [len, h, len]);
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

/** Bake all volumes of a design into one geometry in the building frame (ground at y = 0). */
export function bakeBuildingGeometry(type: Pick<BuildingType, 'parts' | 'smart'>): THREE.BufferGeometry {
  const gb = new GeometryBuilder();
  for (const p of type.parts) {
    const f = p.facade ?? DEFAULT_FACADE;
    const ground = p.baseHeight < 0.5 ? GROUND_ID[f.ground] : 0;
    gb.setFacade([p.floorHeight, FACADE_STYLE_ID[f.style], f.windowRatio, ground]);
    const outline = ccw(partOutline(p));
    const h = wallHeight(p);
    const top = p.baseHeight + h;
    gb.color(p.color);
    walls(gb, outline, p.baseHeight, h);
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
  return gb.build();
}

/** Shared material for baked building geometry: vertex colors plus the facade shader. */
export function createBuildingMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02 });
  mat.customProgramCacheKey = () => 'smartcity-building-v2';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aWall;
        attribute vec4 aFacade;
        varying vec3 vWall;
        varying vec4 vFacade;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWall = aWall;
        vFacade = aFacade;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWall;
        varying vec4 vFacade;
        float bHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float glassMask = 0.0;
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
          vec3 wallC = diffuseColor.rgb;
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
            avg = ratio;
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
        } else if (vWall.z < -1.5 && vWall.z > -2.5) {
          vec2 cell = fract(vWall.xy / vec2(1.0, 0.65));
          float line = clamp(step(cell.x, 0.05) + step(cell.y, 0.06), 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.9 + 0.04, line);
          glassMask = 0.7;
        } else if (vWall.z < -2.5 && vWall.z > -3.5) {
          float n = bHash(floor(vWall.xy * 1.3));
          diffuseColor.rgb *= 0.8 + 0.4 * n;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.25, glassMask);`,
      );
  };
  return mat;
}
