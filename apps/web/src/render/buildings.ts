// Buildings: each design (building type) is baked into one geometry (buildingGeometry.ts) and drawn
// with one InstancedMesh per type and a shared facade material. Geometry is cached per (type, rev);
// placing or moving buildings only rewrites instance matrices.

import * as THREE from 'three';
import type { BuildingType, CityDoc } from '@smartcity/shared';
import { bakeBuildingGeometry, createBuildingMaterial } from './buildingGeometry';

export { roofHeight, wallHeight } from './buildingGeometry';

const _m = new THREE.Matrix4();

interface TypeEntry {
  rev: number;
  /** The doc object the geometry was baked from (fast path), and its design signature (after a resync). */
  ref: BuildingType;
  sig: string;
  mesh: THREE.InstancedMesh;
  capacity: number;
}

const designSig = (t: BuildingType): string => JSON.stringify([t.parts, t.smart ?? null]);

export class BuildingLayer {
  readonly group = new THREE.Group();
  private readonly material = createBuildingMaterial();
  private types = new Map<string, TypeEntry>();

  constructor() {
    this.group.name = 'buildings';
  }

  private sameDesign(e: TypeEntry, t: BuildingType): boolean {
    if (e.ref === t) return true;
    if ((t.rev ?? 0) !== e.rev || designSig(t) !== e.sig) return false;
    e.ref = t;
    return true;
  }

  private createMesh(id: string, geo: THREE.BufferGeometry, capacity: number): THREE.InstancedMesh {
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
        e = { rev: t.rev ?? 0, ref: t, sig: designSig(t), mesh: this.createMesh(id, bakeBuildingGeometry(t), capacity), capacity };
        this.types.set(id, e);
      } else if (n > e.capacity) {
        let capacity = e.capacity;
        while (capacity < n) capacity *= 2;
        const geo = e.mesh.geometry;
        this.group.remove(e.mesh);
        e.mesh.dispose();
        e.mesh = this.createMesh(id, geo, capacity);
        e.capacity = capacity;
      }
    }

    for (const e of this.types.values()) e.mesh.count = 0;
    for (const b of Object.values(doc.buildings)) {
      const e = this.types.get(b.typeId);
      if (!e) continue;
      _m.makeRotationY(b.rotation).setPosition(b.pos.x, 0, b.pos.z);
      e.mesh.setMatrixAt(e.mesh.count++, _m);
    }
    for (const e of this.types.values()) {
      e.mesh.visible = e.mesh.count > 0;
      e.mesh.instanceMatrix.needsUpdate = true;
      if (e.mesh.count > 0) e.mesh.computeBoundingSphere();
    }
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
