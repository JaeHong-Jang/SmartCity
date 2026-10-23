// Buildings: each design (building type) is baked into one geometry (buildingGeometry.ts) and drawn
// with one InstancedMesh per type and a shared facade material. Geometry is cached per (type, rev);
// placing or moving buildings only rewrites instance matrices.

import * as THREE from 'three';
import { AREA_PER_JOB, AREA_PER_PERSON, buildingMetrics, type BuildingType, type CityDoc } from '@smartcity/shared';
import type { SimSnapshot } from '@smartcity/sim';
import { bakeBuildingGeometry, createBuildingMaterial } from './buildingGeometry';

export { roofHeight, wallHeight } from './buildingGeometry';

const _m = new THREE.Matrix4();

/** Share of windows lit at night when the simulation reports no occupancy at all. */
const IDLE_OCCUPANCY = 0.3;
/** Occupancy level of a building with people but no known capacity. */
const UNKNOWN_CAPACITY_OCCUPANCY = 0.6;

/** People a design can hold (homes + jobs), in residents. */
export function buildingCapacity(type: BuildingType): number {
  const m = buildingMetrics(type);
  let cap = m.areaByUse.residential / AREA_PER_PERSON;
  for (const use of Object.keys(AREA_PER_JOB) as (keyof typeof AREA_PER_JOB)[]) cap += m.areaByUse[use] / AREA_PER_JOB[use];
  return cap;
}

/** aOccupancy in [0,1]: people inside (each agent stands for `scale` residents) over capacity. */
export function occupancyLevel(people: number, scale: number, capacity: number): number {
  if (!(people > 0)) return 0;
  if (!(capacity > 0)) return UNKNOWN_CAPACITY_OCCUPANCY;
  return Math.min(1, (people * Math.max(1, scale)) / capacity);
}

interface TypeEntry {
  rev: number;
  /** Building id of each instance slot, and the per-instance window-light level. */
  ids: string[];
  occ: THREE.InstancedBufferAttribute;
  cap: number;
  /** The doc object the geometry was baked from (fast path), and its design signature (after a resync). */
  ref: BuildingType;
  sig: string;
  mesh: THREE.InstancedMesh;
  capacity: number;
}

const designSig = (t: BuildingType): string => JSON.stringify([t.parts, t.smart ?? null, t.props ?? null]);

export class BuildingLayer {
  readonly group = new THREE.Group();
  private readonly material = createBuildingMaterial();
  private types = new Map<string, TypeEntry>();
  private slotOf = new Map<string, { e: TypeEntry; slot: number }>();
  private occSnapshot: SimSnapshot | null = null;
  private occStale = true;

  constructor() {
    this.group.name = 'buildings';
  }

  private sameDesign(e: TypeEntry, t: BuildingType): boolean {
    if (e.ref === t) return true;
    if ((t.rev ?? 0) !== e.rev || designSig(t) !== e.sig) return false;
    e.ref = t;
    return true;
  }

  /** 0 = day, 1 = night: windows of occupied buildings glow. */
  setNight(night: number): void {
    (this.material.userData.uNight as { value: number }).value = night;
  }

  private createMesh(id: string, geo: THREE.BufferGeometry, capacity: number, occ: THREE.InstancedBufferAttribute): THREE.InstancedMesh {
    geo.setAttribute('aOccupancy', occ);
    const mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    mesh.name = `buildings-${id}`;
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private drop(e: TypeEntry): void {
    this.group.remove(e.mesh);
    e.mesh.geometry.dispose();
    e.mesh.dispose();
  }

  update(doc: CityDoc): void {
    const counts = new Map<string, number>();
    for (const b of Object.values(doc.buildings)) if (doc.buildingTypes[b.typeId]) counts.set(b.typeId, (counts.get(b.typeId) ?? 0) + 1);

    // Rebake only designs that changed or disappeared.
    for (const [id, e] of this.types) {
      const t = doc.buildingTypes[id];
      if (!t || !this.sameDesign(e, t)) {
        this.drop(e);
        this.types.delete(id);
      }
    }
    for (const [id, n] of counts) {
      const t = doc.buildingTypes[id]!;
      let e = this.types.get(id);
      if (!e) {
        let capacity = 16;
        while (capacity < n) capacity *= 2;
        const occ = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
        e = { rev: t.rev ?? 0, ids: [], occ, cap: buildingCapacity(t), ref: t, sig: designSig(t), mesh: this.createMesh(id, bakeBuildingGeometry(t), capacity, occ), capacity };
        this.types.set(id, e);
      } else if (n > e.capacity) {
        let capacity = e.capacity;
        while (capacity < n) capacity *= 2;
        const geo = e.mesh.geometry;
        this.group.remove(e.mesh);
        e.mesh.dispose();
        e.occ = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
        e.mesh = this.createMesh(id, geo, capacity, e.occ);
        e.capacity = capacity;
      }
    }

    for (const e of this.types.values()) {
      e.mesh.count = 0;
      e.ids.length = 0;
    }
    this.slotOf.clear();
    for (const b of Object.values(doc.buildings)) {
      const e = this.types.get(b.typeId);
      if (!e) continue;
      _m.makeRotationY(b.rotation).setPosition(b.pos.x, 0, b.pos.z);
      this.slotOf.set(b.id, { e, slot: e.mesh.count });
      e.ids.push(b.id);
      e.mesh.setMatrixAt(e.mesh.count++, _m);
    }
    this.occStale = true;
    for (const e of this.types.values()) {
      e.mesh.visible = e.mesh.count > 0;
      e.mesh.instanceMatrix.needsUpdate = true;
      if (e.mesh.count > 0) e.mesh.computeBoundingSphere();
    }
  }

  /**
   * Window light level per building from the latest snapshot (`occupancy` in `buildingIds` order).
   * Without citizen data every building gets a modest default so the night city is not black.
   */
  setOccupancy(snap: SimSnapshot | null): void {
    if (snap === this.occSnapshot && !this.occStale) return;
    this.occSnapshot = snap;
    this.occStale = false;
    const known = !!snap && snap.buildingIds?.length > 0 && !!snap.occupancy;
    const scale = snap?.stats.citizens?.scale ?? 1;
    for (const e of this.types.values()) e.occ.array.fill(known ? 0 : IDLE_OCCUPANCY);
    if (known) {
      const ids = snap!.buildingIds;
      const occ = snap!.occupancy;
      for (let i = 0; i < ids.length; i++) {
        const at = this.slotOf.get(ids[i]!);
        if (at) (at.e.occ.array as Float32Array)[at.slot] = occupancyLevel(occ[i] ?? 0, scale, at.e.cap);
      }
    }
    for (const e of this.types.values()) e.occ.needsUpdate = true;
  }

  /** Number of instanced meshes currently drawn (one per design in use). */
  get meshCount(): number {
    let n = 0;
    for (const e of this.types.values()) if (e.mesh.visible) n++;
    return n;
  }
}

/**
 * Editor preview: the design with the same geometry and facade material as the city, standing on
 * its square plot (side `plot` m) with an arrow marking the front (+Z, road side).
 */
export function buildingPreview(type: Pick<BuildingType, 'parts' | 'smart'>, plot?: number): THREE.Group {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(bakeBuildingGeometry(type), createBuildingMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  if (plot) {
    const h = plot / 2;
    const pts = [new THREE.Vector3(-h, 0.08, -h), new THREE.Vector3(h, 0.08, -h), new THREE.Vector3(h, 0.08, h), new THREE.Vector3(-h, 0.08, h)];
    g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#fbbf24' })));
    const s = Math.max(2, plot * 0.06);
    const arrow = new THREE.Shape([new THREE.Vector2(-s, 0), new THREE.Vector2(s, 0), new THREE.Vector2(0, s * 1.4)]);
    const marker = new THREE.Mesh(new THREE.ShapeGeometry(arrow).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#fbbf24', side: THREE.DoubleSide }));
    marker.position.set(0, 0.1, h + s * 0.4);
    marker.name = 'front-marker';
    g.add(marker);
  }
  return g;
}
