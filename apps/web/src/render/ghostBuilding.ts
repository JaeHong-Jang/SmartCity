// Translucent 3D ghost for building placement and moves; geometry is cached per building-type
// object (and its design revision) so pointer moves only reposition it.

import * as THREE from 'three';
import { partOutline, type BuildingPart, type BuildingType } from '@smartcity/shared';
import type { PreviewBuilding } from '../tools/types';

/** Height of a part's ghost box: walls plus a simple allowance for pitched roofs. */
const ghostHeight = (p: BuildingPart): number => p.floors * p.floorHeight + (p.roof === 'flat' ? 0 : Math.min(p.width, p.depth) * 0.35);

/** Translucent extruded outlines of a building type in its local frame (footprint parts included). */
function ghostGeometries(type: BuildingType): THREE.BufferGeometry[] {
  return type.parts.map((part) => {
    const shape = new THREE.Shape(partOutline(part).map((v) => new THREE.Vector2(v.x, -v.z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: ghostHeight(part), bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, part.baseHeight, 0);
    return g;
  });
}

export class GhostBuilding {
  readonly group = new THREE.Group();
  private readonly mat = new THREE.MeshBasicMaterial({ color: '#4ade80', transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  private key = '';
  private type: BuildingType | undefined;

  /** Rebuilds the geometry only when the type object or its id/revision changed. */
  set(type: BuildingType | undefined, pb: PreviewBuilding | undefined): void {
    const key = type ? `${type.id}:${type.rev ?? 0}` : '';
    if (key !== this.key || type !== this.type) {
      this.key = key;
      this.type = type;
      this.clear();
      if (type) {
        for (const g of ghostGeometries(type)) {
          const m = new THREE.Mesh(g, this.mat);
          m.renderOrder = 14;
          this.group.add(m);
        }
      }
    }
    this.group.visible = !!(pb && type);
    if (pb && type) {
      this.mat.color.set(pb.color);
      this.group.position.set(pb.pos.x, 0, pb.pos.z);
      this.group.rotation.y = pb.rotation;
    }
  }

  private clear(): void {
    for (const c of [...this.group.children]) {
      (c as THREE.Mesh).geometry.dispose();
      this.group.remove(c);
    }
  }

  dispose(): void {
    this.clear();
    this.mat.dispose();
  }
}
