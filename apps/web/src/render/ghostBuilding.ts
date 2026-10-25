// Translucent 3D ghost for building placement and moves; geometry is cached per building-type
// object (and its design revision) so pointer moves only reposition it. The shown pose eases toward
// the tool's target pose with a critically damped spring (render only: collision, colour and
// commands use the target). It jumps on first show and on a confirm (`settle` changed), restarts
// when hidden, and stops requesting frames once settled, so an idle ghost costs nothing.

import * as THREE from 'three';
import { partOutline, type BuildingPart, type BuildingType } from '@smartcity/shared';
import { PoseSpring } from '../tools/placement';
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
  private readonly spring = new PoseSpring();
  private tx = 0;
  private tz = 0;
  private tr = 0;
  private settle: number | undefined;
  private last = 0;
  private raf = 0;

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
      this.tx = pb.pos.x;
      this.tz = pb.pos.z;
      this.tr = pb.rotation;
      if (!this.spring.active || pb.settle !== this.settle) this.spring.snapTo(this.tx, this.tz, this.tr);
      this.settle = pb.settle;
      this.apply();
      this.schedule();
    } else {
      this.spring.reset();
      this.settle = undefined;
      this.last = 0;
      if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private apply(): void {
    this.group.position.set(this.spring.x, 0, this.spring.z);
    this.group.rotation.y = this.spring.r;
  }

  private schedule(): void {
    if (this.raf || typeof requestAnimationFrame !== 'function') return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (t: number): void => {
    this.raf = 0;
    if (this.advance(t)) this.schedule();
  };

  /** Advance the shown pose to time `nowMs`; false once it sits on the target. */
  advance(nowMs: number): boolean {
    if (!this.spring.active) return false;
    const dt = this.last ? (nowMs - this.last) / 1000 : 1 / 60;
    this.last = nowMs;
    const moving = this.spring.step(dt, this.tx, this.tz, this.tr);
    this.apply();
    if (!moving) this.last = 0;
    return moving;
  }

  private clear(): void {
    for (const c of [...this.group.children]) {
      (c as THREE.Mesh).geometry.dispose();
      this.group.remove(c);
    }
  }

  dispose(): void {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clear();
    this.mat.dispose();
  }
}
