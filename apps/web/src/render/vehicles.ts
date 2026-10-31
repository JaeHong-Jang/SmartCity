// Vehicles (ADR 0014 §6): unchanged default types and dispatched fire engines / ambulances are drawn with
// the procedural models of vehicleModels.ts, one InstancedMesh per model and detail level (body and fixed
// parts in one geometry) plus one far box shared by all models; each vehicle goes to a level by its
// distance from the camera every frame. Edited or custom types keep their own parts, baked into one
// vertex-colored geometry with one InstancedMesh per type. Positions are interpolated by vehicleId between
// the previous and latest snapshot.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CityDoc, VehiclePart, VehicleType } from '@smartcity/shared';
import { VEHICLE_STRIDE, type SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import { TICK_MS } from '../sim/protocol';
import {
  CAR_CLASSES,
  CLASS_MIX,
  DISPATCH_COLOR,
  FIT_SIZE,
  carClassGeometry,
  carClassOf,
  carClassSize,
  carColorOf,
  createVehicleMaterial,
  defaultModelOf,
  farBoxGeometry,
  fittedGeometry,
  type Envelope,
  type FitKind,
} from './vehicleModels';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _s1 = new THREE.Vector3(1, 1, 1);
const _size = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

/** THREE.Color per hex string, cached so per-frame coloring never allocates. */
const colorCache = new Map<string, THREE.Color>();
function paletteColor(hex: string): THREE.Color {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new THREE.Color(hex)));
  return c;
}

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

/** Camera distance (m) below which a 4.5 m car uses LOD 0, and LOD 1; beyond, the far box. */
export const LOD_DIST = [80, 280] as const;
/** Hysteresis (m): a vehicle leaves its detail level only this far past the boundary (no flicker at the line). */
export const LOD_HYSTERESIS = 8;

/**
 * Detail level for a squared camera distance and a model length (longer models keep detail farther).
 * `prev` = the vehicle's level last frame (−1: none): it moves to a coarser level only beyond boundary + 8 m
 * and back to a finer one only inside boundary − 8 m.
 */
export function lodFor(dist2: number, length: number, prev = -1): 0 | 1 | 2 {
  const k = Math.min(2.5, Math.max(1, length / 4.5));
  const h = LOD_HYSTERESIS * k;
  const b0 = LOD_DIST[0] * k + (prev < 0 ? 0 : prev === 0 ? h : -h);
  if (dist2 < b0 * b0) return 0;
  const b1 = LOD_DIST[1] * k + (prev < 0 ? 0 : prev <= 1 ? h : -h);
  return dist2 < b1 * b1 ? 1 : 2;
}

/** One procedural model: meshes for LOD 0 and 1 (created on first use) and its nominal size. */
interface ModelEntry {
  name: string;
  build: (lod: 0 | 1) => THREE.BufferGeometry;
  lods: [TypeMesh | null, TypeMesh | null];
  /** Appearance class index (palette color per vehicle, never scaled above the type's size), or −1 for a fitted model (scaled to the type's size). */
  cls: number;
  /** Fitted kind, for releasing models no type uses any more. */
  kind: FitKind | null;
  flash: boolean;
  length: number;
  width: number;
  height: number;
  /** Body color of fitted models (classes take the per-vehicle palette color). */
  color: THREE.Color | null;
}

/** Plan per snapshot type index: parts path, appearance classes (sedan / suv mix), or a model entry index (≥ 0). */
const PARTS = -2;
const MIX_SEDAN = -3;
const MIX_SUV = -4;
/** Per-vehicle slot code: skipped (unknown type). */
const SKIP = -1;

export class VehicleLayer {
  readonly group = new THREE.Group();
  private types = new Map<string, TypeMesh>();
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  private readonly modelMat = createVehicleMaterial();
  private prevIndex = new Map<number, number>();
  private indexedSnapshot: SimSnapshot | null = null;
  private typeSlots: (TypeMesh | undefined)[] = [];
  private typeCounts: number[] = [];
  private typePlan: number[] = [];
  /** Type size per snapshot type index: length, width, height. */
  private typeSize: number[] = [];
  /** Appearance classes (one entry per class) and fitted models (one per kind and beacon flashing): a fixed, bounded set. */
  private entries: ModelEntry[] = [];
  private fitted = new Map<string, number>();
  /** Needed instances per entry and LOD (index entry·2 + lod). */
  private need: number[] = [];
  private far: TypeMesh;
  private farNeed = 0;
  /** Per vehicle (snapshot order): model entry (or PARTS / SKIP), LOD and per-axis scale. */
  private slotEntry = new Int32Array(0);
  private slotLod = new Uint8Array(0);
  private slotScale = new Float32Array(0);
  /** Snapshot whose vehicle order `slotLod` follows, and the levels of the snapshot before it (hysteresis across snapshots). */
  private lodSnapshot: SimSnapshot | null = null;
  private slotLodOld = new Uint8Array(0);
  private dispatchKind = new Map<number, 'fire' | 'medical'>();
  private dispatchSnapshot: SimSnapshot | null = null;
  visibleCount = 0;
  /** Vehicles drawn at LOD 0 / 1 / 2 in the last frame. */
  readonly lodCounts = [0, 0, 0];

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'vehicles';
    CAR_CLASSES.forEach((name, i) => {
      const s = carClassSize(i);
      this.addEntry(`car-${name}`, (lod) => carClassGeometry(i, lod), i, null, false, s, null);
    });
    this.far = this.makeMesh('vehicles-far', farBoxGeometry(), this.modelMat, 64);
  }

  /** Number of model entries (bounded: one per class plus at most one per fitted kind and flashing). */
  get modelEntryCount(): number {
    return this.entries.length;
  }

  private addEntry(name: string, build: ModelEntry['build'], cls: number, kind: FitKind | null, flash: boolean, size: Envelope, color: string | null): number {
    this.entries.push({ name, build, lods: [null, null], cls, kind, flash, length: size.length, width: size.width, height: size.height, color: color ? new THREE.Color(color) : null });
    this.need.push(0, 0);
    return this.entries.length - 1;
  }

  /** Entry of a fitted model (one per kind and flashing; the vehicle's own size comes from its instance scale). */
  private fittedEntry(kind: FitKind, flash: boolean): number {
    const key = `${kind}${flash ? '-dispatch' : ''}`;
    let e = this.fitted.get(key);
    if (e === undefined) {
      e = this.addEntry(key, (lod) => fittedGeometry(kind, lod, flash), -1, kind, flash, FIT_SIZE[kind], flash ? DISPATCH_COLOR[kind === 'fire' ? 'fire' : 'ambulance'] : null);
      this.fitted.set(key, e);
    }
    return e;
  }

  /** Free an entry's meshes (geometry and instance buffers); they are rebuilt if the model is needed again. */
  private release(en: ModelEntry): void {
    for (let lod = 0; lod < 2; lod++) {
      const tm = en.lods[lod];
      if (!tm) continue;
      this.group.remove(tm.mesh);
      tm.mesh.geometry.dispose();
      tm.mesh.dispose();
      en.lods[lod] = null;
    }
  }

  private makeMesh(name: string, geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): TypeMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.count = 0;
    // Small and moving: no shadow-pass draw (ADR 0013 §6).
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.name = name;
    this.group.add(mesh);
    return { sig: '', mesh, capacity, count: 0 };
  }

  /** Same geometry, a bigger instance buffer. */
  private regrow(tm: TypeMesh, need: number): TypeMesh {
    let cap = tm.capacity;
    while (cap < need) cap *= 2;
    this.group.remove(tm.mesh);
    const geo = tm.mesh.geometry;
    tm.mesh.dispose();
    const next = this.makeMesh(tm.mesh.name, geo, tm.mesh.material as THREE.Material, cap);
    next.sig = tm.sig;
    return next;
  }

  /** Rebake geometry for types whose parts changed; free models no vehicle type of `doc` uses. */
  syncTypes(doc: CityDoc): void {
    for (const [id, tm] of this.types) {
      const vt = doc.vehicleTypes[id];
      if (!vt || defaultModelOf(vt) !== null || JSON.stringify(vt.parts) !== tm.sig) {
        this.group.remove(tm.mesh);
        tm.mesh.geometry.dispose();
        tm.mesh.dispose();
        this.types.delete(id);
      }
    }
    const used = new Set<string>();
    for (const vt of Object.values(doc.vehicleTypes)) {
      const model = defaultModelOf(vt);
      if (model === null) {
        if (!this.types.has(vt.id)) this.types.set(vt.id, this.createType(vt, 16));
      } else used.add(model);
    }
    for (const en of this.entries) {
      if (en.flash) continue; // dispatched models: freed when no dispatch is out
      const inUse = en.kind !== null ? used.has(en.kind) : (used.has('sedan') && CLASS_MIX.sedan.some(([c]) => CAR_CLASSES[en.cls] === c)) || (used.has('suv') && CLASS_MIX.suv.some(([c]) => CAR_CLASSES[en.cls] === c));
      if (!inUse) this.release(en);
    }
  }

  private createType(vt: VehicleType, capacity: number, geo?: THREE.BufferGeometry): TypeMesh {
    const tm = this.makeMesh(`vehicles-${vt.id}`, geo ?? bakeVehicleGeometry(vt.parts), this.mat, capacity);
    tm.sig = JSON.stringify(vt.parts);
    return tm;
  }

  private dispatches(cur: SimSnapshot): Map<number, 'fire' | 'medical'> {
    if (this.dispatchSnapshot !== cur) {
      this.dispatchSnapshot = cur;
      this.dispatchKind.clear();
      for (const d of cur.scenario?.dispatches ?? []) if (d.vehicleId !== null) this.dispatchKind.set(d.vehicleId, d.kind);
      if (this.dispatchKind.size === 0) for (const en of this.entries) if (en.flash) this.release(en);
    }
    return this.dispatchKind;
  }

  /**
   * Draw the latest snapshot. `eye` = camera position for the detail levels (none: all at LOD 0), `night`
   * 0…1 lights the head/tail lamps.
   */
  update(now: number, doc: CityDoc, eye?: THREE.Vector3, night = 0): void {
    const cur = this.stream.latest();
    for (const tm of this.types.values()) tm.mesh.count = 0;
    for (const e of this.entries) for (const tm of e.lods) if (tm) tm.mesh.count = 0;
    this.far.mesh.count = 0;
    this.visibleCount = 0;
    this.lodCounts[0] = this.lodCounts[1] = this.lodCounts[2] = 0;
    (this.modelMat.userData.uNight as { value: number }).value = night;
    (this.modelMat.userData.uFlash as { value: number }).value = Math.floor(now / 170) % 2;
    if (!cur) {
      this.lodSnapshot = null;
      this.finish();
      return;
    }
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

    // Pass 1: model, per-axis scale and detail level per vehicle, counts, grow meshes if needed.
    const ids = cur.vehicleTypeIds;
    this.typeSlots.length = ids.length;
    this.typeCounts.length = ids.length;
    this.typePlan.length = ids.length;
    this.typeSize.length = ids.length * 3;
    for (let t = 0; t < ids.length; t++) {
      const vt = doc.vehicleTypes[ids[t]!];
      const model = vt ? defaultModelOf(vt) : null;
      this.typeSlots[t] = this.types.get(ids[t]!);
      this.typeCounts[t] = 0;
      this.typePlan[t] = !vt ? SKIP : model === null ? PARTS : model === 'sedan' ? MIX_SEDAN : model === 'suv' ? MIX_SUV : this.fittedEntry(model, false);
      this.typeSize[t * 3] = vt?.length ?? 0;
      this.typeSize[t * 3 + 1] = vt?.width ?? 0;
      this.typeSize[t * 3 + 2] = vt?.height ?? 0;
    }
    this.need.fill(0);
    this.farNeed = 0;
    const n = cur.vehicleCount;
    if (this.slotEntry.length < n) {
      const cap = Math.max(n, this.slotEntry.length * 2);
      this.slotEntry = new Int32Array(cap);
      const lod = new Uint8Array(cap);
      lod.set(this.slotLod);
      this.slotLod = lod;
      this.slotLodOld = new Uint8Array(cap);
      this.slotScale = new Float32Array(cap * 3);
    }
    // Last frame's level per vehicle: same snapshot → same slot; next snapshot → the slot it had in the previous one.
    const sameSnap = this.lodSnapshot === cur;
    const fromPrev = !sameSnap && usePrev && this.lodSnapshot === prev;
    if (!sameSnap) {
      const t = this.slotLodOld;
      this.slotLodOld = this.slotLod;
      this.slotLod = t;
    }
    this.lodSnapshot = cur;
    const dispatched = this.dispatches(cur);
    const ex = eye?.x ?? 0;
    const ey = eye?.y ?? 0;
    const ez = eye?.z ?? 0;
    const v = cur.vehicles;
    for (let i = 0; i < n; i++) {
      const o = i * VEHICLE_STRIDE;
      const t = v[o + 3]!;
      const id = v[o + 5]!;
      let e = t >= 0 && t < ids.length ? this.typePlan[t]! : SKIP;
      if (e !== SKIP && dispatched.size > 0) {
        const kind = dispatched.get(id);
        // A dispatched vehicle is drawn as a fire engine / ambulance with flashing beacons, whatever its type.
        if (kind) e = this.fittedEntry(kind === 'fire' ? 'fire' : 'ambulance', true);
      }
      // Class entries are the first CAR_CLASSES.length entries, in class order.
      if (e === MIX_SEDAN) e = carClassOf(id, 'sedan');
      else if (e === MIX_SUV) e = carClassOf(id, 'suv');
      this.slotEntry[i] = e;
      if (e === PARTS) this.typeCounts[t]!++;
      if (e < 0) continue;
      const en = this.entries[e]!;
      // Scale to the type's size per axis: classes only ever shrink, fitted models match it.
      let sx = this.typeSize[t * 3]! / en.length;
      let sz = this.typeSize[t * 3 + 1]! / en.width;
      let sy = this.typeSize[t * 3 + 2]! / en.height;
      if (en.cls >= 0) {
        sx = Math.min(1, sx);
        sy = Math.min(1, sy);
        sz = Math.min(1, sz);
      }
      this.slotScale[i * 3] = sx;
      this.slotScale[i * 3 + 1] = sy;
      this.slotScale[i * 3 + 2] = sz;
      const dx = v[o]! - ex;
      const dz = v[o + 1]! - ez;
      let before = -1;
      if (sameSnap) before = this.slotLod[i]!;
      else if (fromPrev) {
        const j = this.prevIndex.get(id);
        if (j !== undefined) before = this.slotLodOld[j]!;
      }
      const lod = eye ? lodFor(dx * dx + ey * ey + dz * dz, en.length * sx, before) : 0;
      this.slotLod[i] = lod;
      if (lod === 2) this.farNeed++;
      else this.need[e * 2 + lod]!++;
    }
    for (let e = 0; e < this.entries.length; e++) {
      const en = this.entries[e]!;
      for (const lod of [0, 1] as const) {
        const k = this.need[e * 2 + lod]!;
        if (k === 0) continue;
        const tm = en.lods[lod];
        if (!tm) en.lods[lod] = this.makeMesh(`vehicles-${en.name}-lod${lod}`, en.build(lod), this.modelMat, Math.max(16, k));
        else if (k > tm.capacity) en.lods[lod] = this.regrow(tm, k);
      }
    }
    if (this.farNeed > this.far.capacity) this.far = this.regrow(this.far, this.farNeed);
    for (let t = 0; t < ids.length; t++) {
      const tm = this.typeSlots[t];
      if (tm && this.typeCounts[t]! > tm.capacity) {
        const next = this.regrow(tm, this.typeCounts[t]!);
        this.types.set(ids[t]!, next);
        this.typeSlots[t] = next;
      }
    }

    // Pass 2: write interpolated matrices and colors.
    const pv = usePrev ? prev.vehicles : null;
    for (let i = 0; i < n; i++) {
      const e = this.slotEntry[i]!;
      if (e === SKIP) continue;
      const o = i * VEHICLE_STRIDE;
      const t = v[o + 3]!;
      const tm = e === PARTS ? this.typeSlots[t] : null;
      if (e === PARTS && !tm) continue;
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
      if (tm) {
        _m.compose(_p, _q, _s1);
        tm.mesh.setMatrixAt(tm.mesh.count++, _m);
        continue;
      }
      const en = this.entries[e]!;
      const lod = this.slotLod[i]!;
      const mesh = lod === 2 ? this.far.mesh : en.lods[lod]!.mesh;
      _s.set(this.slotScale[i * 3]!, this.slotScale[i * 3 + 1]!, this.slotScale[i * 3 + 2]!);
      if (lod === 2) _s.multiply(_size.set(en.length, en.height, en.width));
      _m.compose(_p, _q, _s);
      mesh.setColorAt(mesh.count, en.color ?? (en.cls >= 0 ? paletteColor(carColorOf(v[o + 5]!, en.cls)) : this.typeColor(doc, ids[t]!)));
      mesh.setMatrixAt(mesh.count++, _m);
      this.lodCounts[lod]!++;
    }
    this.finish();
  }

  /** Body color of a fitted default type: its own (unchanged default) color. */
  private typeColor(doc: CityDoc, id: string): THREE.Color {
    return paletteColor(doc.vehicleTypes[id]?.color ?? '#ffffff');
  }

  /** Upload the used part of each instance buffer; hide empty meshes. */
  private finish(): void {
    const done = (tm: TypeMesh): void => {
      const mesh = tm.mesh;
      mesh.visible = mesh.count > 0;
      if (mesh.count === 0) return;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.addUpdateRange(0, mesh.count * 3);
        mesh.instanceColor.needsUpdate = true;
      }
      this.visibleCount += mesh.count;
    };
    for (const e of this.entries) for (const tm of e.lods) if (tm) done(tm);
    done(this.far);
    for (const tm of this.types.values()) done(tm);
  }

  dispose(): void {
    for (const tm of this.types.values()) {
      tm.mesh.geometry.dispose();
      tm.mesh.dispose();
    }
    this.types.clear();
    for (const e of this.entries) this.release(e);
    this.far.mesh.geometry.dispose();
    this.far.mesh.dispose();
    this.mat.dispose();
    this.modelMat.dispose();
  }
}

/** Plain mesh for one vehicle type (editor preview). */
export function vehiclePreview(parts: VehiclePart[]): THREE.Mesh {
  return new THREE.Mesh(bakeVehicleGeometry(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 }));
}
