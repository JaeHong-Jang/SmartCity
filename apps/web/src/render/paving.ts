// City ground (ADR 0013 §6, P6c-1): paved concrete under built-up blocks, lots and around buildings,
// lawn on green lots, so buildings no longer stand on one endless lawn. Render-only, derived from
// the doc (never stored, never seen by the sim) and rebuilt only when roads, buildings or lots change.
//
// Blocks are the bounded faces of the road graph (half-edge walk, curves sampled); a block is paved
// when it is built up (building footprints and non-green lots cover at least BUILT_UP of it), so a
// downtown block is concrete while a block of a few houses keeps its yards. Lots are paved by their
// own polygon, green lots get lawn, and every building outside a paved block gets a paved apron
// (footprint box + a few m; inside a paved block it would only be drawn twice). Lawn lies above the
// concrete (Y_LAWN > Y_PAVE), so a park inside a built-up block stays green.

import * as THREE from 'three';
import { bounds, buildingFootprints, buildingMetrics, pointInPolygon, polygonArea, sampleSegmentCurve, signedArea, type Bounds, type BuildingType, type CityDoc, type Vec2 } from '@smartcity/shared';
import { GRID_GLSL, GRID_UNIFORMS } from './ground';
import { MeshBuilder } from './meshBuilder';

/** Largest road-graph face still treated as a city block (bigger ones are open land), m². */
export const MAX_BLOCK_AREA = 250_000;
const MIN_BLOCK_AREA = 50;
/** Share of a block covered by footprints and lots above which the whole block is paved. */
export const BUILT_UP = 0.1;
/** Grid cell for looking up which block a building stands in, m. */
const BIN = 128;
/** Apron around a building: sides and back, and toward the front (+Z local, the road side). */
const APRON_SIDE = 4;
const APRON_FRONT = 7;
/** Ground 0 < concrete < lawn < road surface (0.06): a green lot always shows over block paving. */
export const Y_PAVE = 0.02;
export const Y_LAWN = 0.04;
/** Night: concrete and lawn darken and lose the blue cast of the moonlit ambient light (multiplier). */
const NIGHT_TINT = 'vec3(0.56, 0.55, 0.5)';

interface HalfEdge {
  seg: string;
  from: string;
  to: string;
  angle: number;
  /** Points from `from` to `to`, without the last one. */
  pts: Vec2[];
}

/**
 * Bounded faces of the road graph as polygons (counter-clockwise in x/z, i.e. positive signedArea),
 * each at most MAX_BLOCK_AREA. Dead ends inside a block are walked around (zero-width spikes).
 */
export function blockFaces(doc: CityDoc): Vec2[][] {
  const out = new Map<string, HalfEdge[]>();
  for (const s of Object.values(doc.segments)) {
    const a = doc.nodes[s.a];
    const b = doc.nodes[s.b];
    if (!a || !b || s.a === s.b) continue;
    const curve = sampleSegmentCurve(a.pos, b.pos, s.control, 6);
    const back = curve.slice().reverse();
    const ang = (p: Vec2, q: Vec2): number => Math.atan2(q.z - p.z, q.x - p.x);
    const fwd: HalfEdge = { seg: s.id, from: s.a, to: s.b, angle: ang(curve[0]!, curve[1]!), pts: curve.slice(0, -1) };
    const rev: HalfEdge = { seg: s.id, from: s.b, to: s.a, angle: ang(back[0]!, back[1]!), pts: back.slice(0, -1) };
    for (const e of [fwd, rev]) {
      const list = out.get(e.from);
      if (list) list.push(e);
      else out.set(e.from, [e]);
    }
  }
  for (const list of out.values()) list.sort((p, q) => p.angle - q.angle);
  const used = new Set<HalfEdge>();
  const faces: Vec2[][] = [];
  for (const list of out.values()) {
    for (const start of list) {
      if (used.has(start)) continue;
      const poly: Vec2[] = [];
      let e: HalfEdge = start;
      let guard = 0;
      while (!used.has(e) && guard++ < 100_000) {
        used.add(e);
        poly.push(...e.pts);
        // At the far node, turn to the edge just before the reverse one in angular order: this walks
        // every bounded face counter-clockwise and the outer boundary clockwise.
        const around = out.get(e.to)!;
        const i = around.findIndex((h) => h.seg === e.seg && h.to === e.from);
        e = around[(i - 1 + around.length) % around.length]!;
      }
      if (e !== start || poly.length < 3) continue;
      const area = signedArea(poly);
      if (area >= MIN_BLOCK_AREA && area <= MAX_BLOCK_AREA) faces.push(poly);
    }
  }
  return faces;
}

export interface PavingShapes {
  paved: Vec2[][];
  lawn: Vec2[][];
}

/** Local footprint box (rotation 0) and ground footprint area of a design, cached per design object. */
const designInfo = new WeakMap<BuildingType, { box: Bounds; area: number }>();
export function design(t: BuildingType): { box: Bounds; area: number } {
  let d = designInfo.get(t);
  if (!d) designInfo.set(t, (d = { box: bounds(buildingFootprints({ pos: { x: 0, z: 0 }, rotation: 0 }, t).flat()), area: buildingMetrics(t).footprintArea }));
  return d;
}

export function pavingShapes(doc: CityDoc): PavingShapes {
  const paved: Vec2[][] = [];
  const lawn: Vec2[][] = [];
  /** Built-up things with a point inside their block, the ground area they cover and the block found (-1 = none). */
  const anchors: { p: Vec2; area: number; face: number }[] = [];
  const builds: { b: (typeof doc.buildings)[string]; box: Bounds; anchor: number }[] = [];
  for (const b of Object.values(doc.buildings)) {
    const t = doc.buildingTypes[b.typeId];
    if (!t) continue;
    const { box, area } = design(t);
    builds.push({ b, box, anchor: anchors.length });
    anchors.push({ p: b.pos, area, face: -1 });
  }
  for (const id of Object.keys(doc.parcels).sort()) {
    const pc = doc.parcels[id]!;
    if (pc.zone === 'green') {
      lawn.push(pc.polygon);
    } else {
      paved.push(pc.polygon);
      let x = 0;
      let z = 0;
      for (const p of pc.polygon) {
        x += p.x;
        z += p.z;
      }
      anchors.push({ p: { x: x / pc.polygon.length, z: z / pc.polygon.length }, area: polygonArea(pc.polygon), face: -1 });
    }
  }
  let pavedFace: boolean[] = [];
  if (anchors.length > 0) {
    // Faces binned on a coarse grid by their boxes; each anchor tests only the faces of its cell.
    const faces = blockFaces(doc);
    const boxes = faces.map(bounds);
    const built = new Float64Array(faces.length);
    const bins = new Map<string, number[]>();
    const key = (x: number, z: number): string => `${Math.floor(x / BIN)},${Math.floor(z / BIN)}`;
    boxes.forEach((b, i) => {
      for (let x = Math.floor(b.minX / BIN); x <= Math.floor(b.maxX / BIN); x++) {
        for (let z = Math.floor(b.minZ / BIN); z <= Math.floor(b.maxZ / BIN); z++) {
          const k = `${x},${z}`;
          const list = bins.get(k);
          if (list) list.push(i);
          else bins.set(k, [i]);
        }
      }
    });
    for (const a of anchors) {
      const { p } = a;
      for (const i of bins.get(key(p.x, p.z)) ?? []) {
        const b = boxes[i]!;
        if (p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ && pointInPolygon(p, faces[i]!)) {
          built[i]! += a.area;
          a.face = i;
          break;
        }
      }
    }
    pavedFace = faces.map((face, i) => built[i]! >= BUILT_UP * polygonArea(face));
    faces.forEach((face, i) => {
      if (pavedFace[i]) paved.push(face);
    });
  }
  for (const { b, box, anchor } of builds) {
    const face = anchors[anchor]!.face;
    if (face >= 0 && pavedFace[face]) continue;
    const c = Math.cos(b.rotation);
    const s = Math.sin(b.rotation);
    const corner = (x: number, z: number): Vec2 => ({ x: b.pos.x + x * c + z * s, z: b.pos.z - x * s + z * c });
    const x0 = box.minX - APRON_SIDE;
    const x1 = box.maxX + APRON_SIDE;
    const z0 = box.minZ - APRON_SIDE;
    const z1 = box.maxZ + APRON_FRONT;
    paved.push([corner(x0, z0), corner(x1, z0), corner(x1, z1), corner(x0, z1)]);
  }
  return { paved, lawn };
}

/** World-space value noise for the ground materials (concrete and lawn tone variation). */
const NOISE_GLSL = `
float pvHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float pvNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pvHash(i), pvHash(i + vec2(1.0, 0.0)), u.x), mix(pvHash(i + vec2(0.0, 1.0)), pvHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

/**
 * Ground material with large and small scale tone variation in world space (no texture); `uNight` is shared.
 * The editing grid (ground.ts) is drawn on it while an editing tool is active.
 */
function groundMaterial(color: string, key: string, big: number, small: number, tint: string, offset: number, uNight: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.96, metalness: 0, polygonOffset: true, polygonOffsetFactor: -offset, polygonOffsetUnits: -2 * offset });
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    Object.assign(shader.uniforms, GRID_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPaveXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaveXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vPaveXZ;\nuniform float uNight;\n${NOISE_GLSL}\n${GRID_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float n1 = pvNoise(vPaveXZ / 70.0);
          float n2 = pvNoise(vPaveXZ / 9.0 + 17.0);
          diffuseColor.rgb *= 1.0 + (n1 - 0.5) * ${big.toFixed(3)} + (n2 - 0.5) * ${small.toFixed(3)};
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * ${tint}, smoothstep(0.6, 0.9, n1));
          diffuseColor.rgb *= mix(vec3(1.0), ${NIGHT_TINT}, uNight);
          diffuseColor.rgb = cityGrid(diffuseColor.rgb, vec3(vPaveXZ.x, 0.0, vPaveXZ.y), uGrid * uGridPave, uGridPave, 0.6);
        }`,
      );
  };
  return mat;
}

export class PavingLayer {
  readonly group = new THREE.Group();
  private readonly paved: THREE.Mesh;
  private readonly lawn: THREE.Mesh;
  private readonly white = new THREE.Color(1, 1, 1);
  private readonly uNight = { value: 0 };

  constructor() {
    this.group.name = 'paving';
    this.paved = new THREE.Mesh(new THREE.BufferGeometry(), groundMaterial('#8e8c86', 'smartcity-pave-v3', 0.22, 0.08, 'vec3(1.05, 1.0, 0.93)', 0.5, this.uNight));
    this.lawn = new THREE.Mesh(new THREE.BufferGeometry(), groundMaterial('#5a7843', 'smartcity-lawn-v3', 0.22, 0.1, 'vec3(1.08, 1.04, 0.86)', 0.75, this.uNight));
    this.paved.name = 'paving-concrete';
    this.lawn.name = 'paving-lawn';
    for (const m of [this.paved, this.lawn]) {
      m.receiveShadow = true;
      m.visible = false;
      // After roads and buildings, before the ground: hidden pixels fail the depth test early.
      m.renderOrder = 1;
      this.group.add(m);
    }
  }

  /** 0 = day … 1 = night. */
  setNight(night: number): void {
    this.uNight.value = night;
  }

  update(doc: CityDoc): void {
    const shapes = pavingShapes(doc);
    this.set(this.paved, shapes.paved, Y_PAVE);
    this.set(this.lawn, shapes.lawn, Y_LAWN);
  }

  private set(mesh: THREE.Mesh, polys: Vec2[][], y: number): void {
    const b = new MeshBuilder();
    for (const p of polys) b.polygon(p, y, this.white);
    mesh.geometry.dispose();
    mesh.geometry = b.empty ? new THREE.BufferGeometry() : b.build();
    mesh.visible = !b.empty;
  }

  dispose(): void {
    for (const m of [this.paved, this.lawn]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
