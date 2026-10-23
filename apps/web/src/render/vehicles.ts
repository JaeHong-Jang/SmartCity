// Vehicles: each type's parts are baked into one vertex-colored geometry; one InstancedMesh per type.
// Positions are interpolated by vehicleId between the previous and latest snapshot.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CityDoc, VehiclePart, VehicleType } from '@smartcity/shared';
import { VEHICLE_STRIDE, type SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import { TICK_MS } from '../sim/protocol';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

/** Bake vehicle parts (x forward, y up, z right) into one geometry with vertex colors. */
export function bakeVehicleGeometry(parts: VehiclePart[]): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    const g = new THREE.BoxGeometry(p.length, p.height, p.width).toNonIndexed();
    g.translate(p.offset.x, p.offset.y + p.height / 2, p.offset.z);
    _col.set(p.color);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = _col.r;
      c[i * 3 + 1] = _col.g;
      c[i * 3 + 2] = _col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.deleteAttribute('uv');
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false) ?? new THREE.BoxGeometry(1, 1, 1);
  for (const g of geos) g.dispose();
  return merged;
}

interface TypeMesh {
  sig: string;
  mesh: THREE.InstancedMesh;
  capacity: number;
  count: number;
}

/** Shortest-path angle interpolation. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Interpolation factor for render time = now − one tick interval. */
export function interpAlpha(now: number, prevAt: number, latestAt: number): number {
  const span = latestAt - prevAt;
  if (span <= 0) return 1;
  const t = (now - TICK_MS - prevAt) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export class VehicleLayer {
  readonly group = new THREE.Group();
  private types = new Map<string, TypeMesh>();
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  private prevIndex = new Map<number, number>();
  private indexedSnapshot: SimSnapshot | null = null;
  private typeSlots: (TypeMesh | undefined)[] = [];
  private typeCounts: number[] = [];
  visibleCount = 0;

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'vehicles';
  }

  /** Rebake geometry for types whose parts changed. */
  syncTypes(doc: CityDoc): void {
    for (const [id, tm] of this.types) {
      const vt = doc.vehicleTypes[id];
      if (!vt || JSON.stringify(vt.parts) !== tm.sig) {
        this.group.remove(tm.mesh);
        tm.mesh.geometry.dispose();
        tm.mesh.dispose();
        this.types.delete(id);
      }
    }
    for (const vt of Object.values(doc.vehicleTypes)) if (!this.types.has(vt.id)) this.types.set(vt.id, this.createType(vt, 16));
  }

  private createType(vt: VehicleType, capacity: number, geo?: THREE.BufferGeometry): TypeMesh {
    const mesh = new THREE.InstancedMesh(geo ?? bakeVehicleGeometry(vt.parts), this.mat, capacity);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `vehicles-${vt.id}`;
    this.group.add(mesh);
    return { sig: JSON.stringify(vt.parts), mesh, capacity, count: 0 };
  }

  private grow(id: string, tm: TypeMesh, need: number, doc: CityDoc): TypeMesh {
    let cap = tm.capacity;
    while (cap < need) cap *= 2;
    const vt = doc.vehicleTypes[id];
    if (!vt) return tm;
    this.group.remove(tm.mesh);
    const geo = tm.mesh.geometry;
    tm.mesh.dispose();
    const next = this.createType(vt, cap, geo);
    this.types.set(id, next);
    return next;
  }

  update(now: number, doc: CityDoc): void {
    const cur = this.stream.latest();
    for (const tm of this.types.values()) tm.mesh.count = 0;
    this.visibleCount = 0;
    if (!cur) return;
    const prev = this.stream.previous();
    const usePrev = prev !== null && prev.graphRevision === cur.graphRevision;
    if (usePrev && this.indexedSnapshot !== prev) {
      // Index previous positions by vehicle id once per snapshot pair.
      this.prevIndex.clear();
      const pv = prev.vehicles;
      for (let i = 0; i < prev.vehicleCount; i++) this.prevIndex.set(pv[i * VEHICLE_STRIDE + 5]!, i);
      this.indexedSnapshot = prev;
    }
    const alpha = usePrev ? interpAlpha(now, this.stream.previousAt(), this.stream.latestAt()) : 1;

    // Pass 1: counts per type index, grow meshes if needed.
    const ids = cur.vehicleTypeIds;
    this.typeSlots.length = ids.length;
    this.typeCounts.length = ids.length;
    for (let t = 0; t < ids.length; t++) {
      this.typeSlots[t] = this.types.get(ids[t]!);
      this.typeCounts[t] = 0;
    }
    const v = cur.vehicles;
    for (let i = 0; i < cur.vehicleCount; i++) {
      const t = v[i * VEHICLE_STRIDE + 3]!;
      if (t >= 0 && t < ids.length) this.typeCounts[t]!++;
    }
    for (let t = 0; t < ids.length; t++) {
      const tm = this.typeSlots[t];
      if (tm && this.typeCounts[t]! > tm.capacity) this.typeSlots[t] = this.grow(ids[t]!, tm, this.typeCounts[t]!, doc);
    }

    // Pass 2: write interpolated matrices.
    const pv = usePrev ? prev.vehicles : null;
    for (let i = 0; i < cur.vehicleCount; i++) {
      const o = i * VEHICLE_STRIDE;
      const t = v[o + 3]!;
      const tm = this.typeSlots[t];
      if (!tm) continue;
      let x = v[o]!;
      let z = v[o + 1]!;
      let h = v[o + 2]!;
      if (pv && alpha < 1) {
        const j = this.prevIndex.get(v[o + 5]!);
        if (j !== undefined) {
          const po = j * VEHICLE_STRIDE;
          x = pv[po]! + (x - pv[po]!) * alpha;
          z = pv[po + 1]! + (z - pv[po + 1]!) * alpha;
          h = lerpAngle(pv[po + 2]!, h, alpha);
        }
      }
      _p.set(x, 0.06, z);
      _q.setFromAxisAngle(_up, -h);
      _m.compose(_p, _q, _s);
      tm.mesh.setMatrixAt(tm.mesh.count++, _m);
    }
    for (const tm of this.types.values()) {
      if (tm.mesh.count > 0) tm.mesh.instanceMatrix.needsUpdate = true;
      this.visibleCount += tm.mesh.count;
    }
  }
}

/** Plain mesh for one vehicle type (editor preview). */
export function vehiclePreview(parts: VehiclePart[]): THREE.Mesh {
  return new THREE.Mesh(bakeVehicleGeometry(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 }));
}
