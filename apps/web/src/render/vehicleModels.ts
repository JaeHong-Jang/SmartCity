// Render-only vehicle models (ADR 0010 §7, ADR 0014 §6). Appearance class and color come from an integer
// hash of the snapshot's stable vehicle id, so the same car always looks the same. The sim never sees any
// of this. Models are procedural: a side profile extruded across the width with chamfered, smooth-shaded
// edges, a glass cabin, wheels with hub caps and head/tail lights, at two detail levels (≈300 and ≈80
// triangles) plus one shared far box (12). Body paint and fixed parts live in ONE geometry: the `aMat`
// attribute marks which vertices take the instance color, which glow at night and which are glass.

import * as THREE from 'three';
import { DEFAULT_VEHICLE_TYPES, type VehiclePart, type VehicleType } from '@smartcity/shared';

export const CAR_CLASSES = ['sedan', 'suv', 'hatch', 'van', 'pickup', 'taxi', 'police'] as const;
export type CarClass = (typeof CAR_CLASSES)[number];

/** Default car types drawn by appearance class. */
export type CarGroup = 'sedan' | 'suv';

/**
 * Appearance classes of each default car type, with their share in percent: only classes whose model fits
 * the type's size (a van is drawn for an SUV-sized vehicle, never for a sedan-sized one).
 */
export const CLASS_MIX: Record<CarGroup, readonly (readonly [CarClass, number])[]> = {
  sedan: [['sedan', 70], ['hatch', 18], ['taxi', 8], ['police', 4]],
  suv: [['suv', 65], ['van', 20], ['pickup', 15]],
};

/** Murmur3 finalizer: well-mixed unsigned 32-bit hash of an integer id. */
export function hashId(id: number): number {
  let h = id | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const MIX_INDEX: Record<CarGroup, [number, number][]> = {
  sedan: CLASS_MIX.sedan.map(([c, p]) => [CAR_CLASSES.indexOf(c), p]),
  suv: CLASS_MIX.suv.map(([c, p]) => [CAR_CLASSES.indexOf(c), p]),
};

/** Class index into CAR_CLASSES for a vehicle id of a default car type. */
export function carClassOf(id: number, group: CarGroup = 'sedan'): number {
  const mix = MIX_INDEX[group];
  const u = (hashId(id) / 4294967296) * 100;
  let acc = 0;
  for (const [cls, pct] of mix) {
    acc += pct;
    if (u < acc) return cls;
  }
  return mix[0]![0];
}

interface Swatch {
  color: string;
  weight: number;
}

const PASSENGER_PALETTE: Swatch[] = [
  { color: '#f2f2f0', weight: 24 }, // white
  { color: '#1c1d20', weight: 20 }, // black
  { color: '#b8bcc2', weight: 17 }, // silver
  { color: '#6b7078', weight: 14 }, // gray
  { color: '#1f3566', weight: 8 }, // navy
  { color: '#b3262d', weight: 8 }, // red
  { color: '#6fa8d6', weight: 4 }, // sky blue
  { color: '#2f6b4a', weight: 3 }, // green
  { color: '#c9b79a', weight: 2 }, // beige
];
const WORK_PALETTE: Swatch[] = [
  { color: '#f2f2f0', weight: 55 },
  { color: '#b8bcc2', weight: 15 },
  { color: '#6b7078', weight: 10 },
  { color: '#1f3566', weight: 10 },
  { color: '#b3262d', weight: 10 },
];
const TAXI_PALETTE: Swatch[] = [{ color: '#f2c200', weight: 1 }];
const POLICE_PALETTE: Swatch[] = [{ color: '#f4f5f7', weight: 1 }];

const PALETTES: Swatch[][] = [PASSENGER_PALETTE, PASSENGER_PALETTE, PASSENGER_PALETTE, WORK_PALETTE, WORK_PALETTE, TAXI_PALETTE, POLICE_PALETTE];

/** Palette color (hex) for a vehicle id and class, independent of the class hash bits. */
export function carColorOf(id: number, cls: number): string {
  const pal = PALETTES[cls]!;
  let total = 0;
  for (const s of pal) total += s.weight;
  const u = (hashId(id ^ 0x9e3779b9) / 4294967296) * total;
  let acc = 0;
  for (const s of pal) {
    acc += s.weight;
    if (u < acc) return s.color;
  }
  return pal[0]!.color;
}

/** Physical size of a model: x length, z width, y height (m). */
export interface Envelope {
  length: number;
  width: number;
  height: number;
}

/** Fitted kinds: built at the vehicle type's own envelope (bus, truck, emergency vehicles). */
export type FitKind = 'bus' | 'truck' | 'ambulance' | 'fire';

/** Fixed body color of a dispatched fire engine / ambulance (the vehicle type's own color is not used). */
export const DISPATCH_COLOR: Record<'fire' | 'ambulance', string> = { fire: '#c81e1e', ambulance: '#f4f4f4' };

// ---------------------------------------------------------------------------------------------------------
// Mesh building

type V3 = [number, number, number];
type P2 = [number, number];

/** Vertex style: color, and the aMat flags (paint = take the instance color, lamp = glow code, glass). */
interface Style {
  color: string;
  paint?: number;
  /** 0 none · 1 lit at night (head/tail lights, signs) · 2 / 3 beacon flashing in phase A / B. */
  lamp?: number;
  glass?: number;
}

const PAINT: Style = { color: '#ffffff', paint: 1 };
const GLASS: Style = { color: '#1d2733', glass: 1 };
const TIRE: Style = { color: '#16171a' };
const HUB: Style = { color: '#b9bec6' };
const DARK: Style = { color: '#24272c' };
const HEAD: Style = { color: '#f4f1e6', lamp: 1 };
const TAIL: Style = { color: '#b3121b', lamp: 1 };

/** Accumulates non-indexed triangles with position, normal, color and aMat. */
class Mesher {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly col: number[] = [];
  private readonly mat: number[] = [];
  private readonly c = new THREE.Color();
  private s: Style = PAINT;

  style(s: Style): void {
    this.s = s;
    this.c.set(s.color);
  }

  private vert(p: V3, n: V3): void {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0] / l, n[1] / l, n[2] / l);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.mat.push(this.s.paint ?? 0, this.s.lamp ?? 0, this.s.glass ?? 0);
  }

  /** One triangle, wound so its face points the way its vertex normals do; degenerate ones are dropped. */
  tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * fx + fy * fy + fz * fz < 1e-12) return;
    const dot = fx * (na[0] + nb[0] + nc[0]) + fy * (na[1] + nb[1] + nc[1]) + fz * (na[2] + nb[2] + nc[2]);
    this.vert(a, na);
    if (dot >= 0) {
      this.vert(b, nb);
      this.vert(c, nc);
    } else {
      this.vert(c, nc);
      this.vert(b, nb);
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, na: V3, nb: V3, nc: V3, nd: V3): void {
    this.tri(a, b, c, na, nb, nc);
    this.tri(a, c, d, na, nc, nd);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const signedArea = (prof: P2[]): number => {
  let a = 0;
  for (let i = 0; i < prof.length; i++) {
    const p = prof[i]!;
    const q = prof[(i + 1) % prof.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

/** Outward unit normal of profile edge e (p_e → p_e+1). */
function edgeNormal(prof: P2[], e: number, sgn = Math.sign(signedArea(prof)) || 1): P2 {
  const p = prof[e]!;
  const q = prof[(e + 1) % prof.length]!;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const l = Math.hypot(dx, dy) || 1;
  return [(dy / l) * sgn, (-dx / l) * sgn];
}

const SHARP = Math.cos((50 * Math.PI) / 180);

/**
 * Extrude a closed side profile (x forward, y up) between z0 and z1. The long edges are chamfered with
 * radius r in `seg` steps (0 = square edges) and shaded smooth across, and profile corners sharper than
 * 50° keep a hard crease. `edge` may style each profile edge, and its chamfered (arc) part apart from the
 * flat middle (pillars around glass). Side caps (z0, z1) take `cap`.
 */
function extrude(m: Mesher, prof: P2[], z0: number, z1: number, r: number, seg: number, edge: Style | ((e: number, arc: boolean) => Style), cap?: Style): void {
  const n = prof.length;
  const sgn = Math.sign(signedArea(prof)) || 1;
  const styleOf = typeof edge === 'function' ? edge : () => edge;
  if (seg === 0) r = 0;
  const en: P2[] = [];
  for (let e = 0; e < n; e++) en.push(edgeNormal(prof, e, sgn));
  const miter: P2[] = [];
  const sharp: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = en[(i - 1 + n) % n]!;
    const b = en[i]!;
    const mx = a[0] + b[0];
    const my = a[1] + b[1];
    const l = Math.hypot(mx, my) || 1;
    miter.push([mx / l, my / l]);
    sharp.push(a[0] * b[0] + a[1] * b[1] < SHARP);
  }
  const ring = 2 * seg + 2;
  // Ring point k: left arc (k ≤ seg, φ from 90° down to 0°) then right arc (φ from 0° up to 90°).
  const phi = (k: number): number => (seg === 0 ? 0 : k <= seg ? ((seg - k) / seg) * (Math.PI / 2) : ((k - seg - 1) / seg) * (Math.PI / 2));
  const pos = (i: number, k: number): V3 => {
    const p = prof[i]!;
    const mt = miter[i]!;
    const f = phi(k);
    const cx = p[0] - r * mt[0];
    const cy = p[1] - r * mt[1];
    const z = k <= seg ? z0 + r - r * Math.sin(f) : z1 - r + r * Math.sin(f);
    return [cx + r * Math.cos(f) * mt[0], cy + r * Math.cos(f) * mt[1], z];
  };
  const nrm = (k: number, sh: P2): V3 => {
    const f = phi(k);
    return [Math.cos(f) * sh[0], Math.cos(f) * sh[1], k <= seg ? -Math.sin(f) : Math.sin(f)];
  };
  for (let e = 0; e < n; e++) {
    const i = e;
    const j = (e + 1) % n;
    const si = sharp[i] ? en[e]! : miter[i]!;
    const sj = sharp[j] ? en[e]! : miter[j]!;
    for (let k = 0; k < ring - 1; k++) {
      m.style(styleOf(e, k !== seg));
      m.quad(pos(i, k), pos(j, k), pos(j, k + 1), pos(i, k + 1), nrm(k, si), nrm(k, sj), nrm(k + 1, sj), nrm(k + 1, si));
    }
  }
  m.style(cap ?? styleOf(0, false));
  const inset = prof.map((p, i) => new THREE.Vector2(p[0] - r * miter[i]![0], p[1] - r * miter[i]![1]));
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(inset, [])) {
    const A = inset[a!]!, B = inset[b!]!, C = inset[c!]!;
    m.tri([A.x, A.y, z1], [B.x, B.y, z1], [C.x, C.y, z1], [0, 0, 1], [0, 0, 1], [0, 0, 1]);
    m.tri([A.x, A.y, z0], [B.x, B.y, z0], [C.x, C.y, z0], [0, 0, -1], [0, 0, -1], [0, 0, -1]);
  }
}

/** Axis-aligned box (12 triangles). */
function box(m: Mesher, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, s: Style): void {
  extrude(m, [[x1, y0], [x1, y1], [x0, y1], [x0, y0]], z0, z1, 0, 0, s);
}

/** Flat polygon (convex, fan) on both sides at z = ±z, facing out. */
function sidePoly(m: Mesher, pts: P2[], z: number, s: Style): void {
  m.style(s);
  for (const side of [1, -1]) {
    const n: V3 = [0, 0, side];
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = pts[0]!, b = pts[i]!, c = pts[i + 1]!;
      m.tri([a[0], a[1], side * z], [b[0], b[1], side * z], [c[0], c[1], side * z], n, n, n);
    }
  }
}

const sideRect = (m: Mesher, x0: number, x1: number, y0: number, y1: number, z: number, s: Style): void =>
  sidePoly(m, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z, s);

/** Quad in the plane x = x facing `dir` (+1 forward, −1 back), mirrored to −z when `mirror`. */
function endRect(m: Mesher, x: number, dir: number, y0: number, y1: number, z0: number, z1: number, s: Style, mirror = true): void {
  m.style(s);
  const n: V3 = [dir, 0, 0];
  for (const k of mirror ? [1, -1] : [1]) m.quad([x, y0, k * z0], [x, y0, k * z1], [x, y1, k * z1], [x, y1, k * z0], n, n, n, n);
}

/** Quad lying on profile edge e between fractions t0..t1, from z0 to z1 (mirrored to −z), lifted off the surface. */
function edgeRect(m: Mesher, prof: P2[], e: number, t0: number, t1: number, z0: number, z1: number, s: Style, mirror = true): void {
  const p = prof[e]!;
  const q = prof[(e + 1) % prof.length]!;
  const nn = edgeNormal(prof, e);
  const lift = 0.012;
  const at = (t: number): P2 => [p[0] + (q[0] - p[0]) * t + nn[0] * lift, p[1] + (q[1] - p[1]) * t + nn[1] * lift];
  const a = at(t0);
  const b = at(t1);
  const n: V3 = [nn[0], nn[1], 0];
  m.style(s);
  for (const k of mirror ? [1, -1] : [1]) m.quad([a[0], a[1], k * z0], [b[0], b[1], k * z0], [b[0], b[1], k * z1], [a[0], a[1], k * z1], n, n, n, n);
}

/** Pair of wheels on one axle: tire tread, outer face and hub cap (LOD 0), or one dark axle box (LOD 1). */
function axle(m: Mesher, x: number, rw: number, halfW: number, tw: number, lod: number, segs = 8): void {
  if (lod > 0) {
    box(m, x - rw * 0.86, x + rw * 0.86, 0, rw * 1.7, -(halfW - 0.04), halfW - 0.04, TIRE);
    return;
  }
  for (const side of [1, -1]) {
    const zo = side * (halfW - 0.04);
    const zi = side * (halfW - 0.04 - tw);
    const at = (k: number, rad: number, z: number): V3 => [x + rad * Math.cos((k / segs) * Math.PI * 2), rw + rad * Math.sin((k / segs) * Math.PI * 2), z];
    m.style(TIRE);
    for (let k = 0; k < segs; k++) {
      const n0: V3 = [Math.cos((k / segs) * Math.PI * 2), Math.sin((k / segs) * Math.PI * 2), 0];
      const n1: V3 = [Math.cos(((k + 1) / segs) * Math.PI * 2), Math.sin(((k + 1) / segs) * Math.PI * 2), 0];
      m.quad(at(k, rw, zo), at(k + 1, rw, zo), at(k + 1, rw, zi), at(k, rw, zi), n0, n1, n1, n0);
    }
    const out: V3 = [0, 0, side];
    for (let k = 1; k + 1 < segs; k++) m.tri(at(0, rw, zo), at(k, rw, zo), at(k + 1, rw, zo), out, out, out);
    m.style(HUB);
    const zh = zo + side * 0.008;
    for (let k = 1; k + 1 < 6; k++) {
      const h = (j: number): V3 => [x + rw * 0.6 * Math.cos((j / 6) * Math.PI * 2 + 0.5), rw + rw * 0.6 * Math.sin((j / 6) * Math.PI * 2 + 0.5), zh];
      m.tri(h(0), h(k), h(k + 1), out, out, out);
    }
  }
}

/** Front axle and one or two rear axles; at LOD 1 a tandem pair is one box. `tandemSegs` sides per tandem wheel at LOD 0. */
function tandem(m: Mesher, rear: number[], fx: number, rw: number, hw: number, lod: number, tandemSegs = 8): void {
  axle(m, fx, rw, hw, 0.32, lod);
  if (lod > 0 && rear.length > 1) box(m, rear[0]! - rw * 0.86, rear[rear.length - 1]! + rw * 0.86, 0, rw * 1.7, -(hw - 0.04), hw - 0.04, TIRE);
  else for (const x of rear) axle(m, x, rw, hw, 0.32, lod, rear.length > 1 ? tandemSegs : 8);
}

/** Wheel arch notch (5 points, rear to front) for a wheel at x, from the underbody height `clear`. */
function arch(x: number, rw: number, clear: number): P2[] {
  const ar = rw + 0.09;
  const c = Math.SQRT1_2;
  return [
    [x - ar, clear],
    [x - ar * c, rw + ar * c],
    [x, rw + ar],
    [x + ar * c, rw + ar * c],
    [x + ar, clear],
  ];
}

// ---------------------------------------------------------------------------------------------------------
// Passenger cars (variety classes)

interface CarSpec {
  L: number;
  W: number;
  /** Roof height (accessories may stand above it). */
  H: number;
  rw: number;
  /** Axle x offset from the center (±). */
  axle: number;
  clear: number;
  bumper: number;
  hood: number;
  belt: number;
  cowlX: number;
  roofF: number;
  roofR: number;
  tailX: number;
  deck: number;
  tumble: number;
}

const SEDAN: CarSpec = { L: 4.5, W: 1.8, H: 1.45, rw: 0.32, axle: 1.38, clear: 0.18, bumper: 0.45, hood: 0.74, belt: 0.86, cowlX: 0.95, roofF: 0.18, roofR: -0.98, tailX: -1.5, deck: 0.92, tumble: 0.12 };
const CAR_SPECS: Record<CarClass, CarSpec> = {
  sedan: SEDAN,
  suv: { L: 4.7, W: 1.9, H: 1.72, rw: 0.36, axle: 1.42, clear: 0.24, bumper: 0.55, hood: 0.92, belt: 1.02, cowlX: 1.12, roofF: 0.35, roofR: -1.95, tailX: -2.12, deck: 1.05, tumble: 0.12 },
  hatch: { L: 3.95, W: 1.76, H: 1.45, rw: 0.31, axle: 1.25, clear: 0.17, bumper: 0.45, hood: 0.74, belt: 0.86, cowlX: 0.8, roofF: 0.05, roofR: -1.55, tailX: -1.8, deck: 0.9, tumble: 0.12 },
  van: { L: 4.9, W: 1.95, H: 1.75, rw: 0.34, axle: 1.5, clear: 0.22, bumper: 0.55, hood: 0.9, belt: 1.0, cowlX: 1.7, roofF: 1.05, roofR: -2.26, tailX: -2.3, deck: 1.07, tumble: 0.1 },
  pickup: { L: 4.9, W: 1.9, H: 1.75, rw: 0.37, axle: 1.55, clear: 0.25, bumper: 0.55, hood: 0.98, belt: 1.05, cowlX: 1.05, roofF: 0.55, roofR: -0.45, tailX: -0.55, deck: 1.1, tumble: 0.12 },
  // Roof lowered so roof sign / light bar stay within the sedan type's 1.45 m.
  taxi: { ...SEDAN, H: 1.32 },
  police: { ...SEDAN, H: 1.34 },
};
const TAXI_SIGN = 0.13;
const POLICE_BAR = 0.11;

/** Model size of a variety class (accessories included). */
export function carClassSize(cls: number): Envelope {
  const name = CAR_CLASSES[cls]!;
  const s = CAR_SPECS[name];
  const extra = name === 'taxi' ? TAXI_SIGN : name === 'police' ? POLICE_BAR : 0;
  return { length: s.L, width: s.W, height: s.H + extra };
}

/** Longest side (m) of a class model along x. */
export function carClassLength(cls: number): number {
  return carClassSize(cls).length;
}

function buildCar(name: CarClass, lod: number): THREE.BufferGeometry {
  const s = CAR_SPECS[name];
  const m = new Mesher();
  const f = s.L / 2;
  const b = -s.L / 2;
  const hw = s.W / 2;
  let lower: P2[];
  let nose: number;
  let tail: number;
  if (lod === 0) {
    // Front bottom, bumper, nose, hood, cowl | belt, tail top, rear upper, rear bumper, rear bottom | arches.
    lower = [
      [f - 0.12, s.clear],
      [f, s.bumper],
      [f - 0.06, s.hood - 0.08],
      [f - 0.32, s.hood],
      [s.cowlX, s.belt],
      [s.tailX, s.belt],
      [b + 0.12, s.deck],
      [b, s.deck - 0.18],
      [b + 0.02, s.bumper],
      [b + 0.14, s.clear],
      ...arch(-s.axle, s.rw, s.clear),
      ...arch(s.axle, s.rw, s.clear),
    ];
    nose = 1;
    tail = 6;
    extrude(m, lower, -hw, hw, 0.1, 1, PAINT);
  } else {
    const bottom = Math.max(s.clear, s.rw);
    lower = [
      [f, bottom],
      [f, s.bumper],
      [f - 0.3, s.hood],
      [s.cowlX, s.belt],
      [s.tailX, s.belt],
      [b, s.deck],
      [b, bottom],
    ];
    nose = 1;
    tail = 5;
    extrude(m, lower, -hw, hw, 0, 0, PAINT);
  }
  // Glass cabin: painted roof and pillars (the chamfers around the windshield and rear window).
  const ghw = hw - s.tumble;
  const cabin: P2[] = [
    [s.cowlX + 0.04, s.belt - 0.03],
    [s.roofF, s.H],
    [s.roofR, s.H - 0.02],
    [s.tailX - 0.02, s.belt - 0.03],
  ];
  extrude(m, cabin, -ghw, ghw, 0.08, lod === 0 ? 1 : 0, (e, arc) => (e === 1 || (arc && (e === 0 || e === 2)) ? PAINT : GLASS), GLASS);
  if (lod === 0) {
    // B-pillar.
    const xb = s.roofF - (s.roofF - s.roofR) * 0.45;
    sideRect(m, xb - 0.05, xb + 0.05, s.belt, s.H - 0.03, ghw + 0.004, PAINT);
  }
  // Lights and grille.
  edgeRect(m, lower, nose, 0.45, 0.95, hw - 0.42, hw - 0.13, HEAD);
  if (lod === 0) edgeRect(m, lower, nose, 0.2, 0.8, -0.3, 0.3, DARK, false);
  edgeRect(m, lower, tail, 0.1, 0.9, hw - 0.45, hw - 0.13, TAIL);
  for (const x of [-s.axle, s.axle]) axle(m, x, s.rw, hw, 0.22, lod);
  const mid = (s.roofF + s.roofR) / 2;
  if (name === 'taxi') box(m, mid - 0.27, mid + 0.27, s.H - 0.02, s.H + TAXI_SIGN, -0.16, 0.16, { color: '#f5d76e', lamp: 1 });
  if (name === 'police') {
    box(m, mid - 0.15, mid + 0.15, s.H - 0.02, s.H + POLICE_BAR, -0.56, 0, { color: '#dc2626' });
    box(m, mid - 0.15, mid + 0.15, s.H - 0.02, s.H + POLICE_BAR, 0, 0.56, { color: '#2563eb' });
    // Navy door band between the wheel arches.
    const ar = s.rw + 0.09;
    sideRect(m, -s.axle + ar + 0.05, s.axle - ar - 0.05, s.clear + 0.24, s.belt - 0.08, hw + 0.006, { color: '#1e3a8a' });
  }
  if (name === 'pickup') edgeRect(m, lower, lod === 0 ? 5 : 4, 0.06, 0.94, -(hw - 0.14), hw - 0.14, DARK, false);
  return m.geometry();
}

// ---------------------------------------------------------------------------------------------------------
// Fitted kinds: bus, truck, ambulance, fire engine (built at the given envelope)

function buildBus(env: Envelope, lod: number): THREE.BufferGeometry {
  const { length: L, width: W, height: H } = env;
  const m = new Mesher();
  const f = L / 2;
  const b = -L / 2;
  const hw = W / 2;
  const rw = Math.min(0.5, H * 0.16);
  const fx = f - L * 0.22;
  const rx = b + L * 0.27;
  const clear = 0.32;
  const top = H - 0.22; // roof; the AC unit stands on it up to H
  const bottom = lod === 0 ? clear : rw;
  const body: P2[] = [[f, bottom], [f, top - 0.3], [f - 0.15, top], [b + 0.1, top], [b, top - 0.15], [b, bottom]];
  if (lod === 0) body.push(...arch(rx, rw, clear), ...arch(fx, rw, clear));
  extrude(m, body, -hw, hw, 0.14, lod === 0 ? 1 : 0, PAINT);
  // Side window row with pillars (no advertising panels), windshield, destination sign, rear window.
  const wy0 = 1.25;
  const wy1 = top - 0.35;
  sideRect(m, b + 0.45, f - 0.35, wy0, wy1, hw + 0.006, GLASS);
  if (lod === 0) {
    const n = Math.max(3, Math.round(L / 2.1));
    for (let i = 1; i < n; i++) {
      const x = b + 0.45 + ((f - 0.8 - b) * i) / n;
      sideRect(m, x - 0.07, x + 0.07, wy0, wy1, hw + 0.012, PAINT);
    }
    // Doors on the right (+z, curb side): front and middle.
    m.style(GLASS);
    for (const [x0, x1] of [[f - 1.35, f - 0.35], [-0.6, 0.6]] as const) {
      const n: V3 = [0, 0, 1];
      m.quad([x0, 0.45, hw + 0.006], [x1, 0.45, hw + 0.006], [x1, wy0, hw + 0.006], [x0, wy0, hw + 0.006], n, n, n, n);
    }
    endRect(m, b - 0.006, -1, top - 1.1, top - 0.4, 0.1, hw - 0.25, GLASS);
    box(m, -1.2, 1.0, top - 0.02, H, -0.7, 0.7, { color: '#c9ccd1' });
  }
  endRect(m, f + 0.006, 1, 0.95, top - 0.68, 0, hw - 0.18, GLASS);
  endRect(m, f + 0.006, 1, top - 0.62, top - 0.36, 0, hw - 0.25, { color: '#ffb020', lamp: 1 });
  endRect(m, f + 0.008, 1, 0.55, 0.75, hw - 0.45, hw - 0.15, HEAD);
  endRect(m, b - 0.008, -1, 0.6, 1.1, hw - 0.3, hw - 0.12, TAIL);
  for (const x of [rx, fx]) axle(m, x, rw, hw, 0.3, lod);
  return m.geometry();
}

function buildTruck(env: Envelope, lod: number): THREE.BufferGeometry {
  const { length: L, width: W, height: H } = env;
  const m = new Mesher();
  const f = L / 2;
  const b = -L / 2;
  const hw = W / 2;
  const rw = Math.min(0.48, H * 0.15);
  const cabL = Math.min(2.2, L * 0.3);
  const cabTop = H * 0.8;
  const fx = f - cabL * 0.55;
  const rear = L > 7 ? [b + L * 0.2, b + L * 0.36] : [b + L * 0.22];
  const clear = 0.45;
  const cab: P2[] = [[f, lod === 0 ? clear : rw], [f, cabTop - 0.35], [f - 0.22, cabTop], [f - cabL, cabTop], [f - cabL, lod === 0 ? clear : rw]];
  if (lod === 0) cab.push(...arch(fx, rw, clear));
  extrude(m, cab, -hw, hw, 0.1, lod === 0 ? 1 : 0, PAINT);
  endRect(m, f + 0.006, 1, cabTop - 1.05, cabTop - 0.38, 0, hw - 0.12, GLASS);
  endRect(m, f + 0.008, 1, 0.6, 0.8, hw - 0.5, hw - 0.15, HEAD);
  const boxBottom = 2 * rw + 0.18;
  extrude(m, [[f - cabL - 0.12, boxBottom], [f - cabL - 0.12, H], [b, H], [b, boxBottom]], -hw, hw, 0.05, lod === 0 ? 1 : 0, { color: '#e4e4e0' });
  if (lod === 0) {
    sideRect(m, f - 1.05, f - 0.15, cabTop - 1.0, cabTop - 0.3, hw + 0.006, GLASS);
    endRect(m, f + 0.008, 1, 0.95, 1.3, -0.7, 0.7, DARK, false);
    box(m, b + 0.2, f - cabL, 0.62, boxBottom, -0.55, 0.55, DARK);
    box(m, b, b + 0.15, 0.5, 0.75, -(hw - 0.1), hw - 0.1, DARK);
  }
  endRect(m, b - 0.008, -1, lod === 0 ? 0.52 : boxBottom + 0.05, lod === 0 ? 0.73 : boxBottom + 0.3, hw - 0.4, hw - 0.12, TAIL);
  tandem(m, rear, fx, rw, hw, lod);
  return m.geometry();
}

/** Roof beacons: red on the left, blue on the right (flash codes when `flash`). */
function beacons(m: Mesher, x0: number, x1: number, y0: number, y1: number, half: number, flash: boolean, lod: number): void {
  if (lod > 0) {
    box(m, x0, x1, y0, y1, -half, half, { color: '#dc2626', lamp: flash ? 2 : 0 });
    return;
  }
  box(m, x0, x1, y0, y1, -half, -0.06, { color: '#ef4444', lamp: flash ? 2 : 0 });
  box(m, x0, x1, y0, y1, 0.06, half, { color: '#3b82f6', lamp: flash ? 3 : 0 });
}

function buildAmbulance(env: Envelope, lod: number, flash: boolean): THREE.BufferGeometry {
  const { length: L, width: W, height: H } = env;
  const m = new Mesher();
  const f = L / 2;
  const b = -L / 2;
  const hw = W / 2;
  const rw = Math.min(0.38, H * 0.15);
  const fx = f - L * 0.17;
  const rx = b + L * 0.21;
  const clear = 0.25;
  const top = H - 0.22; // the light bar stands up to H
  const cowl: P2 = [f - 0.7, H * 0.45];
  const bottom = lod === 0 ? clear : rw;
  const body: P2[] = [[f - 0.1, bottom], [f, H * 0.24], [f - 0.08, H * 0.365], cowl, [f - 1.45, top - 0.3], [f - 1.62, top], [b + 0.08, top], [b, top - 0.12], [b, bottom]];
  if (lod === 0) body.push(...arch(rx, rw, clear), ...arch(fx, rw, clear));
  extrude(m, body, -hw, hw, 0.1, lod === 0 ? 1 : 0, PAINT);
  edgeRect(m, body, 3, 0.04, 0.96, 0, hw - 0.14, GLASS);
  edgeRect(m, body, 1, 0.3, 0.9, hw - 0.45, hw - 0.13, HEAD);
  endRect(m, b - 0.008, -1, H * 0.29, H * 0.48, hw - 0.25, hw - 0.08, TAIL);
  const archTop = rw + rw + 0.09;
  const sy0 = Math.max(archTop + 0.05, cowl[1] - 0.25);
  sideRect(m, b + 0.03, f - 0.75, sy0, sy0 + 0.2, hw + 0.006, { color: '#d32f2f' });
  if (lod === 0) {
    const wy0 = cowl[1] + 0.04;
    const wy1 = top - 0.55;
    const slope = (f - 1.45 - cowl[0]) / (top - 0.3 - cowl[1]);
    sidePoly(m, [[f - 1.95, wy0], [cowl[0] - 0.16, wy0], [cowl[0] - 0.16 + slope * (wy1 - wy0), wy1], [f - 1.95, wy1]], hw + 0.006, GLASS);
    sideRect(m, -0.6, 0.4, wy0 + 0.3, wy1, hw + 0.006, { color: '#9aa7b4', glass: 1 });
    // Red cross on the patient compartment.
    const cx = b + L * 0.18;
    const cy = (sy0 + 0.2 + top) / 2;
    const cross: Style = { color: '#d32f2f' };
    sideRect(m, cx - 0.32, cx + 0.32, cy - 0.1, cy + 0.1, hw + 0.006, cross);
    sideRect(m, cx - 0.1, cx + 0.1, cy - 0.32, cy + 0.32, hw + 0.008, cross);
    endRect(m, b - 0.006, -1, wy0 + 0.25, wy1, 0.08, hw - 0.25, GLASS);
  }
  beacons(m, f - 1.95, f - 1.55, top - 0.02, H, hw - 0.1, flash, lod);
  for (const x of [rx, fx]) axle(m, x, rw, hw, 0.24, lod);
  return m.geometry();
}

function buildFire(env: Envelope, lod: number, flash: boolean): THREE.BufferGeometry {
  const { length: L, width: W, height: H } = env;
  const m = new Mesher();
  const f = L / 2;
  const b = -L / 2;
  const hw = W / 2;
  const rw = Math.min(0.5, H * 0.15);
  const cabL = L * 0.27;
  const cabTop = H * 0.8;
  const fx = f - cabL * 0.5;
  const rear = L >= 8 ? [b + L * 0.18, b + L * 0.32] : [b + L * 0.22];
  const clear = 0.4;
  const bottom = lod === 0 ? clear : rw;
  const cab: P2[] = [[f, bottom], [f, cabTop - 0.4], [f - 0.25, cabTop], [f - cabL, cabTop], [f - cabL, bottom]];
  if (lod === 0) cab.push(...arch(fx, rw, clear));
  extrude(m, cab, -hw, hw, 0.1, lod === 0 ? 1 : 0, PAINT);
  endRect(m, f + 0.006, 1, cabTop - 0.95, cabTop - 0.4, 0, hw - 0.12, GLASS);
  endRect(m, f + 0.008, 1, 0.55, 0.75, hw - 0.45, hw - 0.12, HEAD);
  const bodyBottom = 2 * rw + 0.1;
  const bodyTop = H - 0.32;
  extrude(m, [[f - cabL - 0.08, bodyBottom], [f - cabL - 0.08, bodyTop], [b, bodyTop], [b, bodyBottom]], -hw, hw, 0.05, lod === 0 ? 1 : 0, PAINT);
  // Reflective stripe along the equipment body and the cab.
  const sy = bodyBottom + 0.12;
  sideRect(m, b + 0.02, f - cabL - 0.1, sy, sy + 0.16, hw + 0.006, { color: '#facc15' });
  endRect(m, b - 0.008, -1, bodyBottom + 0.05, bodyBottom + 0.35, hw - 0.3, hw - 0.08, TAIL);
  if (lod === 0) {
    sideRect(m, f - cabL + 0.15, f - 0.15, sy, sy + 0.16, hw + 0.006, { color: '#facc15' });
    sideRect(m, f - cabL * 0.62, f - 0.18, cabTop - 0.9, cabTop - 0.35, hw + 0.006, GLASS);
    // Equipment compartments (roller doors).
    const span = f - cabL - 0.25 - (b + 0.15);
    for (let i = 0; i < 2; i++) sideRect(m, b + 0.15 + (span * i) / 2 + 0.05, b + 0.15 + (span * (i + 1)) / 2 - 0.05, sy + 0.24, bodyTop - 0.15, hw + 0.006, { color: '#cfd4da' });
    endRect(m, f + 0.008, 1, 0.9, 1.25, -0.6, 0.6, DARK, false);
    // Ladder: two rails and rungs, on a pedestal over the cab end.
    const lx0 = b + 0.05;
    const lx1 = f - cabL * 0.7;
    const ly0 = H - 0.22;
    const ly1 = H - 0.06;
    const ladder: Style = { color: '#d1d5db' };
    box(m, lx0, lx1, ly0, ly1, -0.46, -0.38, ladder);
    box(m, lx0, lx1, ly0, ly1, 0.38, 0.46, ladder);
    box(m, f - cabL - 0.5, f - cabL - 0.1, bodyTop - 0.02, ly0, -0.3, 0.3, DARK);
    m.style(ladder);
    const up: V3 = [0, 1, 0];
    const rungs = Math.max(4, Math.round((lx1 - lx0) / 1.3));
    for (let i = 0; i <= rungs; i++) {
      const x = lx0 + 0.1 + ((lx1 - lx0 - 0.2) * i) / rungs;
      m.quad([x - 0.04, ly1 - 0.03, -0.38], [x + 0.04, ly1 - 0.03, -0.38], [x + 0.04, ly1 - 0.03, 0.38], [x - 0.04, ly1 - 0.03, 0.38], up, up, up, up);
    }
  } else {
    box(m, b + 0.05, f - cabL * 0.7, H - 0.2, H - 0.06, -0.46, 0.46, { color: '#d1d5db' });
  }
  // Light bar across the cab roof, in front of the ladder.
  beacons(m, f - cabL * 0.6, f - 0.3, cabTop - 0.02, Math.min(H, cabTop + 0.24), hw - 0.12, flash, lod);
  tandem(m, rear, fx, rw, hw, lod, 6);
  return m.geometry();
}

/** Squeeze a model into its size exactly (decals stand a few mm proud of the body): x ±length/2, z ±width/2, y 0…height. */
function fitInto(g: THREE.BufferGeometry, size: Envelope): THREE.BufferGeometry {
  const bb = g.boundingBox!;
  const fx = Math.min(1, size.length / 2 / Math.max(-bb.min.x, bb.max.x));
  const fy = Math.min(1, size.height / bb.max.y);
  const fz = Math.min(1, size.width / 2 / Math.max(-bb.min.z, bb.max.z));
  if (fx < 1 || fy < 1 || fz < 1) {
    g.scale(fx, fy, fz);
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
  return g;
}

/** Geometry of a variety class at LOD 0 (≈300 triangles) or 1 (≈80). */
export function carClassGeometry(cls: number, lod: 0 | 1): THREE.BufferGeometry {
  return fitInto(buildCar(CAR_CLASSES[cls]!, lod), carClassSize(cls));
}

/**
 * Nominal size each fitted model is built at. A vehicle is drawn scaled per axis from this size to its
 * type's length, width and height, so any allowed type size is respected (the fire engine is sized near the
 * ambulance type the sim dispatches when a document has no fire-truck type).
 */
export const FIT_SIZE: Record<FitKind, Envelope> = {
  bus: { length: 11.5, width: 2.5, height: 3.2 },
  truck: { length: 8.5, width: 2.5, height: 3.3 },
  ambulance: { length: 6.0, width: 2.1, height: 2.6 },
  fire: { length: 6.8, width: 2.3, height: 2.9 },
};

/** Geometry of a fitted kind at its nominal size; `flash` = beacons flash (a dispatched vehicle). */
export function fittedGeometry(kind: FitKind, lod: 0 | 1, flash = false): THREE.BufferGeometry {
  const env = FIT_SIZE[kind];
  const build = { bus: () => buildBus(env, lod), truck: () => buildTruck(env, lod), ambulance: () => buildAmbulance(env, lod, flash), fire: () => buildFire(env, lod, flash) }[kind];
  return fitInto(build(), env);
}

/** Far LOD shared by every model: a painted box (12 triangles) spanning y 0.1…0.95 of a unit size. */
export function farBoxGeometry(): THREE.BufferGeometry {
  const m = new Mesher();
  box(m, -0.5, 0.5, 0.1, 0.95, -0.5, 0.5, PAINT);
  return m.geometry();
}

/**
 * Vehicle material: vertex colors, the instance color only where aMat.x (paint) is set, dark reflective
 * glass (aMat.z) and lamps (aMat.y) that glow by `uNight` or flash by `uFlash`.
 */
export function createVehicleMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
  const uNight = { value: 0 };
  const uFlash = { value: 0 };
  mat.userData.uNight = uNight;
  mat.userData.uFlash = uFlash;
  mat.customProgramCacheKey = () => 'smartcity-vehicle-v1';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.uniforms.uFlash = uFlash;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMat;\nvarying vec3 vMat;')
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
        vColor.rgb *= color;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aMat.x);
        #endif
        vMat = aMat;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uFlash;\nvarying vec3 vMat;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, vMat.z);\nmetalnessFactor = mix(metalnessFactor, 0.0, vMat.z);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vMat.z > 0.5) {
          // Dark glass reflecting a sky tint, stronger at grazing angles.
          float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.36, 0.46, 0.56), vec3(0.02, 0.03, 0.06), uNight), 0.12 + 0.6 * fres);
        }
        float lampOn = vMat.y < 0.5 ? 0.0 : vMat.y < 1.5 ? uNight : (vMat.y < 2.5 ? uFlash : 1.0 - uFlash) * (0.8 + uNight);
        totalEmissiveRadiance += vColor.rgb * lampOn * 1.6;`,
      );
  };
  return mat;
}

// ---------------------------------------------------------------------------------------------------------
// Which model a vehicle type gets

const DEFAULT_MODEL: Record<string, CarGroup | FitKind> = { sedan: 'sedan', suv: 'suv', truck: 'truck', 'city-bus': 'bus', ambulance: 'ambulance' };
const DEFAULTS = new Map(DEFAULT_VEHICLE_TYPES.filter((t) => t.id in DEFAULT_MODEL).map((t) => [t.id, t]));
const modelCache = new WeakMap<VehicleType, CarGroup | FitKind | null>();

/** Same parts, field by field and in the same order (object key order does not matter; a reordered part list is an edit). */
function sameParts(a: VehiclePart[], b: VehiclePart[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (!p || !p.offset) return false;
    if (p.offset.x !== q.offset.x || p.offset.y !== q.offset.y || p.offset.z !== q.offset.z) return false;
    if (p.length !== q.length || p.width !== q.width || p.height !== q.height || p.color !== q.color) return false;
  }
  return true;
}

/**
 * Model for a shared default vehicle type whose kind, color and parts are unchanged: an appearance class
 * group (default sedan/suv, class picked from the vehicle id) or a fitted kind. Null = an edited or custom
 * type, drawn from its own parts. Size edits keep the model (it is scaled to the type's size).
 */
export function defaultModelOf(vt: VehicleType): CarGroup | FitKind | null {
  let r = modelCache.get(vt);
  if (r === undefined) {
    const d = DEFAULTS.get(vt.id);
    r = d && vt.kind === d.kind && vt.color === d.color && sameParts(vt.parts, d.parts) ? DEFAULT_MODEL[vt.id]! : null;
    modelCache.set(vt, r);
  }
  return r;
}
