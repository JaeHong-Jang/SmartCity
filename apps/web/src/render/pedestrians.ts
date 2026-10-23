// Pedestrians: a procedural box person (torso, head, 2 arms, 2 legs) baked into one vertex-colored
// geometry, drawn as a single InstancedMesh. Limb swing runs in the vertex shader from the snapshot's
// gait phase, so no per-frame CPU animation. Positions are interpolated by citizen id between the
// previous and latest snapshot (no interpolation across a graph revision or a >5 m jump).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PED_STRIDE, type SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import { interpAlpha, lerpAngle } from './vehicles';

/** A step longer than this between snapshots is a teleport (re-projection, door), not walking. */
export const PED_JUMP = 5;
/** Beyond this camera distance the pedestrians are hidden (sub-pixel anyway). */
export const PED_HIDE_DISTANCE = 900;
/** Shirt colors, indexed by the snapshot's style (0..15). */
export const PED_PALETTE = [
  '#d94f4f', '#e8883a', '#e3c443', '#7bbf4a', '#3f9e6a', '#3fa3b5', '#4a7fd1', '#6a58c9',
  '#b455b8', '#e07aa5', '#f1f1ec', '#8d9299', '#3b3f46', '#8a5a3c', '#2f5d8c', '#a3b844',
] as const;
const SWING = 0.65;
const REFERENCE_SPEED = 1.4;
const PIVOT_HIP = 0.82;
const PIVOT_SHOULDER = 1.38;
const GROUND_MIN = 0.06;

const SKIN = new THREE.Color('#e0b48e');
const PANTS = new THREE.Color('#2f3441');
const WHITE = new THREE.Color('#ffffff');

/**
 * Interpolated state of one pedestrian. Returns false when the step is a jump (the caller keeps the
 * latest values); otherwise writes the blend into `out` = [x, z, heading, gaitPhase].
 */
export function lerpPedestrian(
  prev: ArrayLike<number>,
  po: number,
  cur: ArrayLike<number>,
  co: number,
  alpha: number,
  out: Float32Array | number[],
): boolean {
  const dx = cur[co]! - prev[po]!;
  const dz = cur[co + 1]! - prev[po + 1]!;
  if (dx * dx + dz * dz > PED_JUMP * PED_JUMP) return false;
  out[0] = prev[po]! + dx * alpha;
  out[1] = prev[po + 1]! + dz * alpha;
  out[2] = lerpAngle(prev[po + 2]!, cur[co + 2]!, alpha);
  out[3] = prev[po + 4]! + (cur[co + 4]! - prev[po + 4]!) * alpha;
  return true;
}

/** Swing amplitude (radians) for a walking speed; 0 when standing still. */
export const swingAmplitude = (speed: number): number => (speed < 0.05 ? 0 : SWING * Math.min(1, speed / REFERENCE_SPEED));

interface Box {
  w: number; // x (forward)
  h: number; // y
  d: number; // z (sideways)
  x: number;
  y: number; // bottom
  z: number;
  color: THREE.Color;
  /** Swing direction (+1/-1) around `pivot`, 0 = rigid. */
  swing: number;
  pivot: number;
  /** 1 = takes the per-instance shirt color. */
  tint: number;
}

/** The person model: facing +x, standing on y = 0, ~1.7 m tall. */
export function bakePedestrianGeometry(): THREE.BufferGeometry {
  const boxes: Box[] = [
    { w: 0.2, h: 0.82, d: 0.17, x: 0, y: 0, z: 0.1, color: PANTS, swing: 1, pivot: PIVOT_HIP, tint: 0 },
    { w: 0.2, h: 0.82, d: 0.17, x: 0, y: 0, z: -0.1, color: PANTS, swing: -1, pivot: PIVOT_HIP, tint: 0 },
    { w: 0.26, h: 0.58, d: 0.42, x: 0, y: 0.8, z: 0, color: WHITE, swing: 0, pivot: 0, tint: 1 },
    { w: 0.22, h: 0.24, d: 0.22, x: 0.01, y: 1.4, z: 0, color: SKIN, swing: 0, pivot: 0, tint: 0 },
    { w: 0.12, h: 0.56, d: 0.11, x: 0, y: PIVOT_SHOULDER - 0.56, z: 0.27, color: WHITE, swing: -1, pivot: PIVOT_SHOULDER, tint: 1 },
    { w: 0.12, h: 0.56, d: 0.11, x: 0, y: PIVOT_SHOULDER - 0.56, z: -0.27, color: WHITE, swing: 1, pivot: PIVOT_SHOULDER, tint: 1 },
  ];
  const geos: THREE.BufferGeometry[] = [];
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d).toNonIndexed();
    g.translate(b.x, b.y + b.h / 2, b.z);
    g.deleteAttribute('uv');
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    const limb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = b.color.r;
      col[i * 3 + 1] = b.color.g;
      col[i * 3 + 2] = b.color.b;
      limb[i * 3] = b.swing;
      limb[i * 3 + 1] = b.pivot;
      limb[i * 3 + 2] = b.tint;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aLimb', new THREE.BufferAttribute(limb, 3));
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  return merged;
}

function createPedestrianMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  mat.customProgramCacheKey = () => 'smartcity-pedestrian-v1';
  const palette = PED_PALETTE.map((c) => {
    const col = new THREE.Color(c);
    return `vec3(${col.r.toFixed(4)}, ${col.g.toFixed(4)}, ${col.b.toFixed(4)})`;
  }).join(', ');
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aLimb;
        attribute vec3 aGait;
        const vec3 PED_PALETTE[16] = vec3[16](${palette});`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float ang = aLimb.x * sin(aGait.x) * aGait.y;
          float ca = cos(ang);
          float sa = sin(ang);
          float dy = transformed.y - aLimb.y;
          float lx = transformed.x;
          transformed.x = lx * ca - dy * sa;
          transformed.y = aLimb.y + lx * sa + dy * ca;
        }`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_COLOR
          vColor.rgb = mix(vColor.rgb, PED_PALETTE[int(aGait.z + 0.5) & 15], aLimb.z);
        #endif`,
      );
  };
  return mat;
}

export class PedestrianLayer {
  readonly group = new THREE.Group();
  private mesh!: THREE.InstancedMesh;
  private gait!: THREE.InstancedBufferAttribute;
  private capacity = 0;
  private readonly geo = bakePedestrianGeometry();
  private readonly mat = createPedestrianMaterial();
  private prevIndex = new Map<number, number>();
  private indexedSnapshot: SimSnapshot | null = null;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _out = new Float32Array(4);
  visibleCount = 0;

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'pedestrians';
    this.allocate(256);
  }

  private allocate(capacity: number): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
    }
    this.capacity = capacity;
    this.gait = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.gait.setUsage(THREE.DynamicDrawUsage);
    const geo = this.geo;
    geo.setAttribute('aGait', this.gait);
    const mesh = new THREE.InstancedMesh(geo, this.mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.name = 'pedestrians-mesh';
    this.mesh = mesh;
    this.group.add(mesh);
  }

  update(now: number, cameraDistance: number): void {
    this.mesh.count = 0;
    this.visibleCount = 0;
    const cur = this.stream.latest();
    if (!cur || !cur.pedestrians || cameraDistance > PED_HIDE_DISTANCE) return;
    const n = cur.pedestrianCount ?? 0;
    if (n <= 0) return;
    if (n > this.capacity) {
      let cap = this.capacity;
      while (cap < n) cap *= 2;
      this.allocate(cap);
    }
    const prev = this.stream.previous();
    const usePrev = prev !== null && !!prev.pedestrians && prev.graphRevision === cur.graphRevision;
    if (usePrev && this.indexedSnapshot !== prev) {
      this.prevIndex.clear();
      const ids = prev.pedestrianIds;
      for (let i = 0; i < prev.pedestrianCount; i++) this.prevIndex.set(ids[i]!, i);
      this.indexedSnapshot = prev;
    }
    const alpha = usePrev ? interpAlpha(now, this.stream.previousAt(), this.stream.latestAt()) : 1;
    const a = cur.pedestrians;
    const ids = cur.pedestrianIds;
    const pa = usePrev ? prev.pedestrians : null;
    const out = this._out;
    const gait = this.gait.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const o = i * PED_STRIDE;
      out[0] = a[o]!;
      out[1] = a[o + 1]!;
      out[2] = a[o + 2]!;
      out[3] = a[o + 4]!;
      if (pa && alpha < 1) {
        const j = this.prevIndex.get(ids[i]!);
        if (j !== undefined) lerpPedestrian(pa, j * PED_STRIDE, a, o, alpha, out);
      }
      this._p.set(out[0]!, Math.max(GROUND_MIN, a[o + 7]!), out[1]!);
      this._q.setFromAxisAngle(this._up, -out[2]!);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
      gait[i * 3] = out[3]!;
      gait[i * 3 + 1] = swingAmplitude(a[o + 3]!);
      gait[i * 3 + 2] = a[o + 5]!;
    }
    this.mesh.count = n;
    this.visibleCount = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.gait.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
