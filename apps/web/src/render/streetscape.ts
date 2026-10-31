// Street trees and lamps (ADR 0014 §2, P7a): render-only, derived from the doc and the road network,
// never stored and never seen by the sim.
//
// Placement: on every sidewalk, trees every TREE_SPACING m near the curb and lamps every LAMP_SPACING m at
// the curb (both sides, staggered), deterministic (phases, species, size and turn hashed from the segment
// id), clear of junctions, crosswalks, bus stops, sensors and the entrance side of buildings facing the
// road. One species per street (Korean streets are planted with one: ginkgo, zelkova or cherry tones).
//
// Updates: placements are cached per 256 m chunk (the road chunk of the segment's midpoint) and rebuilt
// only for chunks whose segments changed signature — geometry, crossings, the stops and sensors on it and
// the building entrances next to it — on applied commands only (never while dragging: a drag is a preview).
//
// Drawing: per kind a few InstancedMeshes by camera distance (LOD), filled from the chunk cache when the
// camera moved: trees in three LODs (near, middle and far), lamps in two, plus their night glow. The near
// LODs are re-filled exactly after small moves; the far LOD is re-filled after larger moves and cuts the
// near ring out in its vertex shader (same center), so a tree is never drawn twice or missing. The far
// LODs shrink to nothing approaching the distance limit (no popping at the edge). Only near trees cast
// shadows; lamps never do.

import * as THREE from 'three';
import type { RenderQuality } from '../app/quality';
import { bounds, carriagewayWidth, cumulativeLengths, hash01, pointAtLength, rightNormal, tangentAtLength, type CityDoc, type Vec2 } from '@smartcity/shared';
import { design } from './paving';
import type { RoadNetworkGeom, RoadSegGeom } from './roadNetwork';
import { chunkKey, Y_WALK } from './roads';

export const TREE_SPACING = 9;
export const LAMP_SPACING = 27;
/** Distance from the curb line onto the sidewalk, meters. */
export const TREE_INSET = 0.75;
export const LAMP_INSET = 0.35;
/** Clearances along the road, meters: beyond a junction's crosswalk zone, around a crosswalk, a stop, a sensor, an entrance, a lamp. */
export const JUNCTION_CLEAR = 3;
export const CROSSING_CLEAR = 1.5;
export const STOP_CLEAR = 9;
export const SENSOR_CLEAR = 3;
export const ENTRY_CLEAR = 3.5;
const LAMP_TREE_CLEAR = 3;
/** Building fronts this far from the curb (or closer) count as entrances on the sidewalk, meters. */
const ENTRY_DEPTH = 30;
/**
 * LOD per render quality (camera to instance, meters): trees near < treeNear ≤ middle < treeMid ≤ far < limit;
 * lamps near < lampNear ≤ far < lampLimit (thin poles are sub-pixel beyond), their night glow to glowLimit;
 * near trees cast shadows only at 'normal'.
 */
export const STREET_QUALITY: Record<RenderQuality, { treeNear: number; treeMid: number; lampNear: number; lampLimit: number; glowLimit: number; treeShadows: boolean }> = {
  normal: { treeNear: 70, treeMid: 240, lampNear: 140, lampLimit: 600, glowLimit: 1300, treeShadows: true },
  low: { treeNear: 35, treeMid: 120, lampNear: 70, lampLimit: 300, glowLimit: 600, treeShadows: false },
};
export const TREE_NEAR = STREET_QUALITY.normal.treeNear;
/** Re-fill the near LODs / the far LODs after the camera moved this far, meters. */
const FINE_STEP = 6;
const COARSE_STEP = 60;
const BIN = 64;
/**
 * How far around a road its avoiders are looked up, beyond its planting line: at least the largest clear
 * radius (a stop; a crosswalk side is half its 3 m zebra + CROSSING_CLEAR). Fixed, so one edit never widens
 * every road's query.
 */
const AVOID_REACH = Math.max(STOP_CLEAR, SENSOR_CLEAR, 4 + CROSSING_CLEAR);

/** 0 = ginkgo (은행), 1 = zelkova (느티), 2 = cherry (벚). */
export type Species = 0 | 1 | 2;
const SPECIES: { tint: string; wide: number; tall: number }[] = [
  { tint: '#86ad52', wide: 0.78, tall: 1.18 },
  { tint: '#55834a', wide: 1.18, tall: 0.96 },
  { tint: '#6f9550', wide: 1.05, tall: 0.84 },
];

export interface TreeSpot {
  x: number;
  z: number;
  yaw: number;
  scale: number;
  species: Species;
}
export interface LampSpot {
  x: number;
  z: number;
  /** Yaw of the arm (it points over the road). */
  yaw: number;
}
export interface SegmentStreetscape {
  trees: TreeSpot[];
  lamps: LampSpot[];
}

/**
 * Something trees and lamps keep clear of, in world space on the planting line of one sidewalk: a bus stop,
 * a sensor or one side of a mid-block crosswalk. It applies to every road whose sidewalk faces the same way
 * there (`n` = outward normal of that sidewalk), so a stop at the end of one road also clears the start of
 * the road continuing it.
 */
export interface Avoider {
  x: number;
  z: number;
  nx: number;
  nz: number;
  /** Clear radius = `half` + `clear` (lamps: `clear` × LAMP_SCALE), meters. */
  half: number;
  clear: number;
}

/** A building's entrance: middle of its road-facing (+Z local) side and the direction it faces. */
export interface Entry {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** Everything around a segment its placement depends on (and nothing else: see segmentSig). */
export interface SegmentContext {
  /** Number of roads at each end and whether the end is a smooth joint (the road continues). */
  degA: number;
  degB: number;
  jointA: boolean;
  jointB: boolean;
  /** Stops, sensors and crosswalk sides near this road (any road's), and building entrances near it. */
  avoiders: Avoider[];
  entries: Entry[];
}

/** Lamps keep a shorter clearance than trees from sensors, crosswalks and entrances. */
const LAMP_SCALE = 0.7;

/** Usable stretch of a sidewalk from one end (arc length clear of the junction there). */
function endClear(g: RoadSegGeom, atA: boolean, deg: number, joint: boolean): number {
  if (joint) return 0.5;
  if (deg <= 1) return 1.5;
  return (atA ? g.laneStartA : g.laneStartB) + JUNCTION_CLEAR;
}

/** Whether a spot at (x, z) on a sidewalk facing (nx, nz) is too close to an avoider or in front of an entrance. */
function blockedAt(ctx: SegmentContext, x: number, z: number, nx: number, nz: number, scale: number): boolean {
  for (const a of ctx.avoiders) {
    if (a.nx * nx + a.nz * nz <= 0) continue;
    const r = a.half + a.clear * scale;
    if ((a.x - x) ** 2 + (a.z - z) ** 2 < r * r) return true;
  }
  for (const e of ctx.entries) {
    // In front of the entrance, on the sidewalk next to it (facing back toward the building).
    if (e.dx * nx + e.dz * nz > -0.5) continue;
    const f = (x - e.x) * e.dx + (z - e.z) * e.dz;
    const lat = (x - e.x) * -e.dz + (z - e.z) * e.dx;
    if (f > 0 && f <= ENTRY_DEPTH && Math.abs(lat) < ENTRY_CLEAR * scale) return true;
  }
  return false;
}

/** Trees and lamps of one segment (pure, deterministic). Roads without sidewalks get none. */
export function placeSegment(g: RoadSegGeom, ctx: SegmentContext): SegmentStreetscape {
  const out: SegmentStreetscape = { trees: [], lamps: [] };
  const rt = g.roadType;
  if (!rt.sidewalk || g.centerline.length < 2) return out;
  const u0 = endClear(g, true, ctx.degA, ctx.jointA);
  const u1 = g.length - endClear(g, false, ctx.degB, ctx.jointB);
  if (u1 - u0 < 2) return out;
  const cum = cumulativeLengths(g.centerline);
  const curb = carriagewayWidth(rt) / 2;
  /** Spot `offset` m to the side of arc length `s`, the outward normal of that sidewalk and the yaw toward the road. */
  const at = (s: number, offset: number): { p: Vec2; n: Vec2; yaw: number } => {
    const p = pointAtLength(g.centerline, cum, s);
    const t = tangentAtLength(g.centerline, cum, Math.min(Math.max(s, 0.01), g.length - 0.01));
    const r = rightNormal(t);
    const k = Math.sign(offset);
    // Yaw that turns local +x toward the road (−side · right normal).
    return { p: { x: p.x + r.x * offset, z: p.z + r.z * offset }, n: { x: r.x * k, z: r.z * k }, yaw: Math.atan2(-r.z * k, -r.x * k) };
  };
  const h = (key: string): number => hash01(0, 0, `${g.id}:${key}`);
  const lampS: Record<number, number[]> = { 1: [], [-1]: [] };
  for (const side of [1, -1] as const) {
    const phase = (h('lamp') + (side < 0 ? 0.5 : 0)) % 1;
    for (let s = u0 + phase * LAMP_SPACING; s <= u1; s += LAMP_SPACING) {
      const { p, n, yaw } = at(s, side * (curb + LAMP_INSET));
      if (blockedAt(ctx, p.x, p.z, n.x, n.z, LAMP_SCALE)) continue;
      out.lamps.push({ x: p.x, z: p.z, yaw });
      lampS[side]!.push(s);
    }
  }
  const species = Math.floor(h('species') * 3) as Species;
  const spacing = TREE_SPACING * (0.95 + 0.1 * h('spacing'));
  for (const side of [1, -1] as const) {
    let k = 0;
    for (let s = u0 + h(`tree${side}`) * spacing * 0.5 + 0.5; s <= u1; s += spacing, k++) {
      if (lampS[side]!.some((l) => Math.abs(l - s) < LAMP_TREE_CLEAR)) continue;
      const { p, n } = at(s, side * (curb + TREE_INSET));
      if (blockedAt(ctx, p.x, p.z, n.x, n.z, 1)) continue;
      const r = h(`t${side}:${k}`);
      out.trees.push({ x: p.x, z: p.z, yaw: r * Math.PI * 2, scale: 0.88 + 0.24 * h(`s${side}:${k}`), species });
    }
  }
  return out;
}

const binKey = (x: number, z: number): string => `${Math.floor(x / BIN)},${Math.floor(z / BIN)}`;

function binPush<T extends { x: number; z: number }>(bins: Map<string, T[]>, item: T): void {
  const k = binKey(item.x, item.z);
  const list = bins.get(k);
  if (list) list.push(item);
  else bins.set(k, [item]);
}

/** Items of `bins` inside the box of `pts` grown by `m` (bin order, then insertion order: deterministic). */
function gather<T extends { x: number; z: number }>(bins: Map<string, T[]>, pts: readonly Vec2[], m: number): T[] {
  const out: T[] = [];
  if (bins.size === 0) return out;
  const box = bounds(pts);
  for (let bx = Math.floor((box.minX - m) / BIN); bx <= Math.floor((box.maxX + m) / BIN); bx++) {
    for (let bz = Math.floor((box.minZ - m) / BIN); bz <= Math.floor((box.maxZ + m) / BIN); bz++) {
      for (const it of bins.get(`${bx},${bz}`) ?? []) {
        if (it.x >= box.minX - m && it.x <= box.maxX + m && it.z >= box.minZ - m && it.z <= box.maxZ + m) out.push(it);
      }
    }
  }
  return out;
}

/** Context of every segment: avoiders and entrances found by a spatial query around it (any road's). */
export function segmentContexts(doc: CityDoc, net: RoadNetworkGeom): Map<string, SegmentContext> {
  const avoiders = new Map<string, Avoider[]>();
  /** An avoider on the planting line of `side` of segment `segId` at arc length `s`. */
  const mark = (segId: string, s: number, side: 1 | -1, half: number, clear: number): void => {
    const g = net.segments.get(segId);
    if (!g || g.centerline.length < 2) return;
    const cum = cumulativeLengths(g.centerline);
    const at = Math.min(Math.max(s, 0), g.length);
    const p = pointAtLength(g.centerline, cum, at);
    const r = rightNormal(tangentAtLength(g.centerline, cum, Math.min(Math.max(at, 0.01), g.length - 0.01)));
    const off = carriagewayWidth(g.roadType) / 2 + TREE_INSET;
    binPush(avoiders, { x: p.x + r.x * side * off, z: p.z + r.z * side * off, nx: r.x * side, nz: r.z * side, half, clear });
  };
  for (const id of Object.keys(doc.busStops).sort()) {
    const st = doc.busStops[id]!;
    const g = net.segments.get(st.segmentId);
    if (g) mark(st.segmentId, st.t * g.length, st.dir === 'forward' ? 1 : -1, STOP_CLEAR, 0);
  }
  for (const id of Object.keys(doc.sensors ?? {}).sort()) {
    const sn = doc.sensors[id]!;
    const g = net.segments.get(sn.segmentId);
    if (g) mark(sn.segmentId, sn.t * g.length, sn.side === 'right' ? 1 : -1, 0, SENSOR_CLEAR);
  }
  for (const c of net.crossings) {
    for (const side of [1, -1] as const) mark(c.segmentId, c.s, side, c.width / 2, CROSSING_CLEAR);
  }
  const entries = new Map<string, Entry[]>();
  for (const id of Object.keys(doc.buildings).sort()) {
    const b = doc.buildings[id]!;
    const t = doc.buildingTypes[b.typeId];
    if (!t) continue;
    const { box } = design(t);
    const c = Math.cos(b.rotation);
    const s = Math.sin(b.rotation);
    const lx = (box.minX + box.maxX) / 2;
    // Local (x, z) → world: (x·c + z·s, −x·s + z·c), as paving.ts; local +Z (the front) → (s, c).
    binPush(entries, { x: b.pos.x + lx * c + box.maxZ * s, z: b.pos.z - lx * s + box.maxZ * c, dx: s, dz: c });
  }
  const out = new Map<string, SegmentContext>();
  for (const g of net.segments.values()) {
    const na = net.nodes.get(g.a);
    const nb = net.nodes.get(g.b);
    // Every avoider or entrance that can reach a spot on this road's sidewalks.
    const reach = carriagewayWidth(g.roadType) / 2 + TREE_INSET + 1;
    out.set(g.id, {
      degA: na?.segments.length ?? 1,
      degB: nb?.segments.length ?? 1,
      jointA: !!na?.joint,
      jointB: !!nb?.joint,
      avoiders: g.roadType.sidewalk ? gather(avoiders, g.centerline, reach + AVOID_REACH) : [],
      entries: g.roadType.sidewalk ? gather(entries, g.centerline, reach + Math.hypot(ENTRY_DEPTH, ENTRY_CLEAR)) : [],
    });
  }
  return out;
}

/**
 * Everything `placeSegment` reads, lossless (full float precision), so an equal signature means equal
 * placements and any input change, however small, rebuilds the chunk.
 */
export function segmentSig(g: RoadSegGeom, ctx: SegmentContext): string {
  const rt = g.roadType;
  return [
    g.id, g.centerline.map((p) => `${p.x},${p.z}`).join(';'), g.length, g.laneStartA, g.laneStartB, carriagewayWidth(rt), rt.sidewalk,
    ctx.degA, ctx.degB, ctx.jointA, ctx.jointB,
    ctx.avoiders.map((a) => `${a.x},${a.z},${a.nx},${a.nz},${a.half},${a.clear}`).join(';'),
    ctx.entries.map((e) => `${e.x},${e.z},${e.dx},${e.dz}`).join(';'),
  ].join('|');
}

// ---- models (local: +y up, +x = toward the road; trees at the origin) ----

class PartBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  /** 1 = tinted by the instance color (foliage), 0 = own color. */
  tint: number[] = [];
  /** 1 = lit at night (lamp head). */
  glow: number[] = [];

  /** Adds a (non-indexed) geometry moved by `m`; `smooth` = normals radial from its center (round foliage). */
  add(src: THREE.BufferGeometry, m: THREE.Matrix4, color: string, opts: { tint?: number; glow?: number; smooth?: boolean; shadeY?: [number, number] } = {}): void {
    const g = src.index ? src.toNonIndexed() : src;
    const p = g.getAttribute('position');
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const c = new THREE.Color(color);
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (opts.smooth) n.copy(v).normalize();
      else n.fromBufferAttribute(g.getAttribute('normal'), i);
      // Foliage darker underneath (self shadowing), from shadeY[0] at the bottom to shadeY[1] at the top.
      const k = opts.shadeY ? opts.shadeY[0] + (opts.shadeY[1] - opts.shadeY[0]) * Math.min(1, Math.max(0, v.y * 0.5 + 0.5)) : 1;
      v.applyMatrix4(m);
      n.applyMatrix3(nm).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(c.r * k, c.g * k, c.b * k);
      this.tint.push(opts.tint ?? 0);
      this.glow.push(opts.glow ?? 0);
    }
    if (g !== src) g.dispose();
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    geo.computeBoundingSphere();
    return geo;
  }
}

const TRUNK = '#5a4535';
const FOLIAGE = '#ffffff';
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const at = (x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Matrix4 => _m4.compose(_v.set(x, y, z), _q.identity(), _s.set(sx, sy, sz));

/** Tree of the given LOD (0 = near … 2 = far), about 8 m tall, crown base at ~3.5 m (clear of buses). */
export function treeModel(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const b = new PartBuilder();
  const shade: [number, number] = [0.62, 1.05];
  if (lod === 0) {
    const trunk = new THREE.CylinderGeometry(0.11, 0.17, 3.9, 6, 1, true);
    b.add(trunk, at(0, 1.95, 0, 1, 1, 1), TRUNK);
    trunk.dispose();
    const big = new THREE.IcosahedronGeometry(1, 1);
    const small = new THREE.IcosahedronGeometry(1, 0);
    b.add(big, at(0, 5.6, 0, 2.3, 2.0, 2.3), FOLIAGE, { tint: 1, smooth: true, shadeY: shade });
    b.add(small, at(0.95, 4.8, 0.5, 1.5, 1.3, 1.5), FOLIAGE, { tint: 1, smooth: true, shadeY: shade });
    b.add(small, at(-0.85, 5.0, -0.6, 1.6, 1.35, 1.6), FOLIAGE, { tint: 1, smooth: true, shadeY: shade });
    b.add(small, at(0.1, 7.0, -0.1, 1.45, 1.25, 1.45), FOLIAGE, { tint: 1, smooth: true, shadeY: shade });
    big.dispose();
    small.dispose();
  } else if (lod === 1) {
    const trunk = new THREE.CylinderGeometry(0.12, 0.16, 3.9, 4, 1, true);
    b.add(trunk, at(0, 1.95, 0, 1, 1, 1), TRUNK);
    trunk.dispose();
    const crown = new THREE.IcosahedronGeometry(1, 0);
    b.add(crown, at(0, 5.7, 0, 2.5, 2.4, 2.5), FOLIAGE, { tint: 1, smooth: true, shadeY: shade });
    crown.dispose();
  } else {
    const crown = new THREE.OctahedronGeometry(1, 0);
    b.add(crown, at(0, 5.7, 0, 2.6, 2.5, 2.6), FOLIAGE, { tint: 1, smooth: true, shadeY: shade });
    crown.dispose();
  }
  return b.build();
}

/** Lamp head position (local), for the night glow. */
export const LAMP_HEAD = new THREE.Vector3(1.75, 7.72, 0);
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): [THREE.BufferGeometry, THREE.Matrix4] => [
  new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0),
  at((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 1, 1, 1).clone(),
];

/** Street lamp: pole, arm over the road and head (lit at night); LOD 1: a 3-sided pole and one box for arm and head. */
export function lampModel(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PartBuilder();
  const metal = '#4b525b';
  const pole = new THREE.CylinderGeometry(0.075, 0.1, 7.9, lod === 0 ? 6 : 3, 1, true);
  b.add(pole, at(0, 3.95, 0, 1, 1, 1), metal);
  pole.dispose();
  const parts: [THREE.BufferGeometry, THREE.Matrix4, string, number][] = [];
  if (lod === 0) {
    const base = new THREE.CylinderGeometry(0.15, 0.17, 0.7, 6, 1, false);
    b.add(base, at(0, 0.35, 0, 1, 1, 1), metal);
    base.dispose();
  }
  if (lod === 0) {
    parts.push([...box(-0.05, 7.82, -0.05, 1.5, 7.92, 0.05), metal, 0]);
    parts.push([...box(1.25, 7.78, -0.17, 2.1, 7.95, 0.17), '#3d434b', 0]);
    parts.push([...box(1.3, 7.7, -0.13, 2.05, 7.78, 0.13), '#fff2d6', 1]);
  } else {
    // Arm and head as one box, lit underneath at night.
    parts.push([...box(-0.05, 7.72, -0.12, 2.05, 7.92, 0.12), '#fff2d6', 1]);
  }
  for (const [g, m, c, glow] of parts) {
    b.add(g, m, c, { glow });
    g.dispose();
  }
  return b.build();
}

// ---- materials ----

/** Instance origin, its distance to the camera and to the LOD center (all in world space: model matrix = identity). */
const LOD_VERTEX = `
  vec3 lodOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float lodKeep = step(uLodInner, distance(lodOrigin, uLodCenter)) * (1.0 - smoothstep(uLodFar * 0.82, uLodFar, distance(lodOrigin, cameraPosition)));
  transformed *= lodKeep;`;

interface LodUniforms {
  uLodCenter: { value: THREE.Vector3 };
  uLodInner: { value: number };
  uLodFar: { value: number };
}

function lodUniforms(): LodUniforms {
  return { uLodCenter: { value: new THREE.Vector3() }, uLodInner: { value: 0 }, uLodFar: { value: 1e9 } };
}

/**
 * Lambert material for the instanced models: foliage takes the instance color (trunks keep theirs),
 * lamp heads glow at night, and (`lod`) the far-LOD inner cut and distance shrink.
 */
function streetMaterial(key: string, uNight: { value: number }, lod: LodUniforms | null): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    if (lod) Object.assign(shader.uniforms, lod);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aTint;\nattribute float aGlow;\nvarying float vGlow;\n${lod ? 'uniform vec3 uLodCenter;\nuniform float uLodInner;\nuniform float uLodFar;' : ''}`)
      .replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\nvColor.rgb = color.rgb * mix(vec3(1.0), instanceColor.rgb, aTint);\n#endif')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvGlow = aGlow;${lod ? LOD_VERTEX : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.82, 0.55) * 2.4 * uNight * vGlow;\ndiffuseColor.rgb *= mix(vec3(1.0), vec3(0.62, 0.6, 0.56), uNight * (1.0 - vGlow));');
  };
  return mat;
}

/** Soft additive glow around each lamp head at night (camera-facing quads, faded by the fog). */
function glowMaterial(uNight: { value: number }, lod: LodUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uNight, ...lod, uHead: { value: LAMP_HEAD } },
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      uniform vec3 uHead;
      uniform float uLodFar;
      varying vec2 vCorner;
      #include <fog_pars_vertex>
      void main() {
        vCorner = position.xy;
        vec4 head = instanceMatrix * vec4(uHead, 1.0);
        float keep = 1.0 - smoothstep(uLodFar * 0.82, uLodFar, distance(head.xyz, cameraPosition));
        vec4 mvPosition = modelViewMatrix * head;
        mvPosition.xy += position.xy * 2.6 * keep;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uNight;
      varying vec2 vCorner;
      #include <fog_pars_fragment>
      void main() {
        float r = length(vCorner);
        float a = exp(-r * r * 5.0) * (1.0 - smoothstep(0.85, 1.0, r));
        #ifdef USE_FOG
          a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        gl_FragColor = vec4(vec3(1.0, 0.78, 0.5) * a * 0.75 * uNight, 1.0);
      }`,
  });
}

// ---- layer ----

interface ChunkData {
  /** Instance matrices (16 floats each) and foliage colors (3 floats each). */
  trees: Float32Array;
  treeColors: Float32Array;
  lamps: Float32Array;
  /** Box around the instances (x/z), for whole-chunk distance tests. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface ItemRecord {
  sig: string;
  chunk: string;
}

export interface StreetscapeStats {
  trees: number;
  lamps: number;
  chunks: number;
  /** Chunks rebuilt by the last update. */
  lastRebuilt: number;
  drawn: { tree0: number; tree1: number; tree2: number; lamp0: number; lamp1: number; glow: number };
  glowVisible: boolean;
  night: number;
  quality: RenderQuality;
  /** Near trees cast shadows (only at 'normal' quality). */
  treeShadows: boolean;
}

/** One LOD: an InstancedMesh re-created with more room when needed. */
class Lod {
  mesh: THREE.InstancedMesh;
  constructor(
    private readonly group: THREE.Group,
    private readonly geo: THREE.BufferGeometry,
    private readonly mat: THREE.Material,
    private readonly name: string,
    private readonly colors: boolean,
    private shadow: boolean,
  ) {
    this.mesh = this.make(16);
  }

  private make(capacity: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geo, this.mat, capacity);
    m.name = this.name;
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = this.shadow;
    m.receiveShadow = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.colors) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.group.add(m);
    return m;
  }

  setShadow(on: boolean): void {
    this.shadow = on;
    this.mesh.castShadow = on;
  }

  /** Room for `n` instances (contents are refilled by the caller afterwards). */
  reserve(n: number): void {
    if (this.mesh.instanceMatrix.count >= n) return;
    const old = this.mesh;
    this.group.remove(old);
    old.dispose();
    this.mesh = this.make(Math.max(n, old.instanceMatrix.count * 2));
    this.mesh.visible = old.visible;
    this.mesh.renderOrder = old.renderOrder;
  }

  get matrices(): Float32Array {
    return this.mesh.instanceMatrix.array as Float32Array;
  }

  get colorArray(): Float32Array | null {
    return (this.mesh.instanceColor?.array as Float32Array | undefined) ?? null;
  }

  /** Upload the first `n` instances. */
  commit(n: number): void {
    const m = this.mesh;
    m.count = n;
    m.instanceMatrix.clearUpdateRanges();
    m.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) {
      m.instanceColor.clearUpdateRanges();
      m.instanceColor.addUpdateRange(0, Math.max(1, n) * 3);
      m.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

/** Nearest and farthest distance from `c` to a chunk's instances' box (y from the sidewalk to the crown top). */
function chunkRange(d: ChunkData, c: THREE.Vector3): [number, number] {
  const nx = Math.max(d.minX - c.x, 0, c.x - d.maxX);
  const nz = Math.max(d.minZ - c.z, 0, c.z - d.maxZ);
  const ny = Math.max(Y_WALK - c.y, 0, c.y - 9);
  const fx = Math.max(Math.abs(c.x - d.minX), Math.abs(c.x - d.maxX));
  const fz = Math.max(Math.abs(c.z - d.minZ), Math.abs(c.z - d.maxZ));
  const fy = Math.max(Math.abs(c.y - Y_WALK), Math.abs(c.y - 9));
  return [Math.hypot(nx, ny, nz), Math.hypot(fx, fy, fz)];
}

/**
 * Copy the instances of `src` (16 floats each, colors 3) whose distance to `c` is in [lo, hi) into `dst`
 * from index `n`; whole chunks inside the band are copied in one go. Returns the new count.
 */
function fill(chunks: Iterable<ChunkData>, pick: (d: ChunkData) => Float32Array, colors: ((d: ChunkData) => Float32Array) | null, dst: Lod, c: THREE.Vector3, lo: number, hi: number): number {
  let n = 0;
  const mats = dst.matrices;
  const cols = dst.colorArray;
  for (const d of chunks) {
    const src = pick(d);
    const count = src.length / 16;
    if (count === 0) continue;
    const [near, far] = chunkRange(d, c);
    if (near >= hi || far < lo) continue;
    const srcCol = colors ? colors(d) : null;
    if (near >= lo && far < hi) {
      mats.set(src, n * 16);
      if (cols && srcCol) cols.set(srcCol, n * 3);
      n += count;
      continue;
    }
    for (let i = 0; i < count; i++) {
      const k = i * 16;
      const dist = Math.hypot(src[k + 12]! - c.x, src[k + 13]! - c.y, src[k + 14]! - c.z);
      if (dist < lo || dist >= hi) continue;
      mats.set(src.subarray(k, k + 16), n * 16);
      if (cols && srcCol) cols.set(srcCol.subarray(i * 3, i * 3 + 3), n * 3);
      n++;
    }
  }
  return n;
}

const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const SPECIES_COLORS = SPECIES.map((s) => new THREE.Color(s.tint));

export class StreetscapeLayer {
  readonly group = new THREE.Group();
  private records = new Map<string, ItemRecord>();
  private chunks = new Map<string, ChunkData>();
  private segsByChunk = new Map<string, string[]>();
  private totals = { trees: 0, lamps: 0 };
  private readonly uNight = { value: 0 };
  /** Far LODs: inner cut around the center of the last near fill. */
  private readonly treeFar = lodUniforms();
  private readonly lampFar = lodUniforms();
  private readonly glowFar = lodUniforms();
  private readonly tree: Lod[];
  private readonly lamp: Lod[];
  private readonly glow: Lod;
  private readonly geos: THREE.BufferGeometry[];
  private readonly mats: THREE.Material[];
  /** Camera position and distance limit of the last near / far fill (null = refill on the next frame). */
  private fineAt: THREE.Vector3 | null = null;
  private coarseAt: THREE.Vector3 | null = null;
  private coarseLimit = 0;
  private quality: RenderQuality = 'normal';
  lastRebuilt = 0;

  constructor() {
    this.group.name = 'streetscape';
    const t0 = treeModel(0);
    const t1 = treeModel(1);
    const t2 = treeModel(2);
    const l0 = lampModel(0);
    const l1 = lampModel(1);
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geos = [t0, t1, t2, l0, l1, quad];
    const near = streetMaterial('smartcity-street-near-v1', this.uNight, null);
    const treeFarMat = streetMaterial('smartcity-street-tree-far-v1', this.uNight, this.treeFar);
    const lampFarMat = streetMaterial('smartcity-street-lamp-far-v1', this.uNight, this.lampFar);
    const glowMat = glowMaterial(this.uNight, this.glowFar);
    this.mats = [near, treeFarMat, lampFarMat, glowMat];
    this.tree = [
      // Only near trees cast shadows (the shadow map is sharp only near the view target anyway).
      new Lod(this.group, t0, near, 'street-trees-0', true, true),
      new Lod(this.group, t1, near, 'street-trees-1', true, false),
      new Lod(this.group, t2, treeFarMat, 'street-trees-2', true, false),
    ];
    this.lamp = [new Lod(this.group, l0, near, 'street-lamps-0', false, false), new Lod(this.group, l1, lampFarMat, 'street-lamps-1', false, false)];
    this.glow = new Lod(this.group, quad, glowMat, 'street-lamp-glow', false, false);
    this.glow.mesh.visible = false;
    this.glow.mesh.renderOrder = 4;
  }

  /** Roads, stops, sensors, buildings or lots changed: rebuild the chunks whose segments changed. */
  update(doc: CityDoc, net: RoadNetworkGeom): void {
    const ctxs = segmentContexts(doc, net);
    const next = new Map<string, ItemRecord>();
    const dirty = new Set<string>();
    for (const g of net.segments.values()) {
      const rec = { sig: segmentSig(g, ctxs.get(g.id)!), chunk: chunkKey(g.centerline[g.centerline.length >> 1]!) };
      next.set(g.id, rec);
      const old = this.records.get(g.id);
      if (!old || old.sig !== rec.sig || old.chunk !== rec.chunk) {
        dirty.add(rec.chunk);
        if (old) dirty.add(old.chunk);
      }
    }
    for (const [id, old] of this.records) if (!next.has(id)) dirty.add(old.chunk);
    this.records = next;
    this.segsByChunk = new Map();
    for (const [id, rec] of next) {
      const list = this.segsByChunk.get(rec.chunk);
      if (list) list.push(id);
      else this.segsByChunk.set(rec.chunk, [id]);
    }
    this.lastRebuilt = dirty.size;
    if (dirty.size === 0) return;
    for (const key of dirty) this.rebuildChunk(key, net, ctxs);
    let trees = 0;
    let lamps = 0;
    for (const d of this.chunks.values()) {
      trees += d.trees.length / 16;
      lamps += d.lamps.length / 16;
    }
    this.totals = { trees, lamps };
    for (const l of this.tree) l.reserve(trees);
    for (const l of this.lamp) l.reserve(lamps);
    this.glow.reserve(lamps);
    this.fineAt = null;
    this.coarseAt = null;
  }

  private rebuildChunk(key: string, net: RoadNetworkGeom, ctxs: Map<string, SegmentContext>): void {
    this.chunks.delete(key);
    const trees: TreeSpot[] = [];
    const lamps: LampSpot[] = [];
    for (const id of this.segsByChunk.get(key) ?? []) {
      const p = placeSegment(net.segments.get(id)!, ctxs.get(id)!);
      trees.push(...p.trees);
      lamps.push(...p.lamps);
    }
    if (trees.length === 0 && lamps.length === 0) return;
    const d: ChunkData = { trees: new Float32Array(trees.length * 16), treeColors: new Float32Array(trees.length * 3), lamps: new Float32Array(lamps.length * 16), minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const grow = (x: number, z: number): void => {
      d.minX = Math.min(d.minX, x - 4);
      d.maxX = Math.max(d.maxX, x + 4);
      d.minZ = Math.min(d.minZ, z - 4);
      d.maxZ = Math.max(d.maxZ, z + 4);
    };
    trees.forEach((t, i) => {
      const sp = SPECIES[t.species]!;
      _mat.compose(_pos.set(t.x, Y_WALK, t.z), _rot.setFromAxisAngle(_yAxis, t.yaw), _scl.set(sp.wide * t.scale, sp.tall * t.scale, sp.wide * t.scale));
      _mat.toArray(d.trees, i * 16);
      // Slight per-tree tone variation.
      const v = 0.9 + 0.2 * ((Math.sin(t.yaw * 7.3) + 1) / 2);
      _col.copy(SPECIES_COLORS[t.species]!).multiplyScalar(v);
      d.treeColors[i * 3] = _col.r;
      d.treeColors[i * 3 + 1] = _col.g;
      d.treeColors[i * 3 + 2] = _col.b;
      grow(t.x, t.z);
    });
    lamps.forEach((l, i) => {
      // Local +x → the arm direction: rotation about y by −yaw (three's y rotation turns +x toward −z).
      _mat.compose(_pos.set(l.x, Y_WALK, l.z), _rot.setFromAxisAngle(_yAxis, -l.yaw), _scl.set(1, 1, 1));
      _mat.toArray(d.lamps, i * 16);
      grow(l.x, l.z);
    });
    this.chunks.set(key, d);
  }

  /** Render quality: LOD distances and tree shadows (STREET_QUALITY); the instances are re-distributed on the next frame. */
  setQuality(quality: RenderQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.tree[0]!.setShadow(STREET_QUALITY[quality].treeShadows);
    this.fineAt = null;
    this.coarseAt = null;
  }

  /** 0 = day … 1 = night: lamp heads and their glow light up, foliage darkens. */
  setNight(night: number): void {
    this.uNight.value = night;
    this.glow.mesh.visible = night > 0.02;
  }

  /**
   * Distribute the instances to the LODs for a camera at `cam` viewing from `viewDistance` (distance to
   * its target): far trees are kept out to a limit that grows with it (overview: the whole city).
   */
  frame(cam: THREE.Vector3, viewDistance: number): void {
    const q = STREET_QUALITY[this.quality];
    const limit = Math.min(4000, Math.max(1100, viewDistance * 1.8));
    const chunks = (): IterableIterator<ChunkData> => this.chunks.values();
    if (!this.fineAt || this.fineAt.distanceTo(cam) > FINE_STEP) {
      this.fineAt = cam.clone();
      this.tree[0]!.commit(fill(chunks(), (d) => d.trees, (d) => d.treeColors, this.tree[0]!, cam, 0, q.treeNear));
      this.tree[1]!.commit(fill(chunks(), (d) => d.trees, (d) => d.treeColors, this.tree[1]!, cam, q.treeNear, q.treeMid));
      this.lamp[0]!.commit(fill(chunks(), (d) => d.lamps, null, this.lamp[0]!, cam, 0, q.lampNear));
      this.treeFar.uLodCenter.value.copy(cam);
      this.treeFar.uLodInner.value = q.treeMid;
      this.lampFar.uLodCenter.value.copy(cam);
      this.lampFar.uLodInner.value = q.lampNear;
    }
    if (!this.coarseAt || this.coarseAt.distanceTo(cam) > COARSE_STEP || Math.abs(limit - this.coarseLimit) > this.coarseLimit * 0.05) {
      this.coarseAt = cam.clone();
      this.coarseLimit = limit;
      // The inner cut uses the near fill's center (at most FINE_STEP + COARSE_STEP away from this one).
      const margin = FINE_STEP + COARSE_STEP;
      const lampLimit = Math.min(limit, q.lampLimit);
      this.tree[2]!.commit(fill(chunks(), (d) => d.trees, (d) => d.treeColors, this.tree[2]!, cam, q.treeMid - margin, limit * 1.05 + COARSE_STEP));
      this.lamp[1]!.commit(fill(chunks(), (d) => d.lamps, null, this.lamp[1]!, cam, q.lampNear - margin, lampLimit * 1.05 + COARSE_STEP));
      this.glow.commit(fill(chunks(), (d) => d.lamps, null, this.glow, cam, 0, Math.min(limit, q.glowLimit) * 1.05 + COARSE_STEP));
    }
    this.treeFar.uLodFar.value = limit;
    this.lampFar.uLodFar.value = Math.min(limit, q.lampLimit);
    this.glowFar.uLodFar.value = Math.min(limit, q.glowLimit);
  }

  stats(): StreetscapeStats {
    return {
      ...this.totals,
      chunks: this.chunks.size,
      lastRebuilt: this.lastRebuilt,
      drawn: { tree0: this.tree[0]!.mesh.count, tree1: this.tree[1]!.mesh.count, tree2: this.tree[2]!.mesh.count, lamp0: this.lamp[0]!.mesh.count, lamp1: this.lamp[1]!.mesh.count, glow: this.glow.mesh.count },
      glowVisible: this.glow.mesh.visible,
      night: this.uNight.value,
      quality: this.quality,
      treeShadows: this.tree[0]!.mesh.castShadow,
    };
  }

  /** Test/debug: placed trees and lamps within `r` m of (x, z). */
  near(x: number, z: number, r: number): { trees: Vec2[]; lamps: Vec2[] } {
    const out = { trees: [] as Vec2[], lamps: [] as Vec2[] };
    for (const d of this.chunks.values()) {
      if (d.minX > x + r || d.maxX < x - r || d.minZ > z + r || d.maxZ < z - r) continue;
      for (const [src, list] of [
        [d.trees, out.trees],
        [d.lamps, out.lamps],
      ] as const) {
        for (let k = 0; k < src.length; k += 16) if (Math.hypot(src[k + 12]! - x, src[k + 14]! - z) <= r) list.push({ x: src[k + 12]!, z: src[k + 14]! });
      }
    }
    return out;
  }

  dispose(): void {
    for (const l of [...this.tree, ...this.lamp, this.glow]) l.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.chunks.clear();
  }
}

