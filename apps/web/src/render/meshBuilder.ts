// Helpers to build flat-shaded, vertex-colored, non-indexed BufferGeometry from XZ polylines.

import * as THREE from 'three';
import { offsetPolyline, slicePolyline, cumulativeLengths, type Vec2 } from '@smartcity/shared';

export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];

  get empty(): boolean {
    return this.pos.length === 0;
  }

  /** One triangle; horizontal triangles always get an up normal (materials are double-sided where needed). */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, c: THREE.Color): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    if (Math.abs(ny) > 0.5) {
      // Make it face up (counter-clockwise seen from +Y) so single-sided materials render it.
      if (ny < 0) {
        this.pos.push(ax, ay, az, cx, cy, cz, bx, by, bz);
      } else {
        this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      }
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    for (let i = 0; i < 3; i++) {
      this.nor.push(nx, ny, nz);
      this.col.push(c.r, c.g, c.b);
    }
  }

  /** Flat band between lateral offsets o1 and o2 (meters, + = right of travel) along a polyline. */
  band(pts: readonly Vec2[], o1: number, o2: number, y: number, c: THREE.Color): void {
    if (pts.length < 2) return;
    const a = offsetPolyline(pts, o1);
    const b = offsetPolyline(pts, o2);
    for (let i = 1; i < pts.length; i++) {
      const a0 = a[i - 1]!, a1 = a[i]!, b0 = b[i - 1]!, b1 = b[i]!;
      this.tri(a0.x, y, a0.z, b0.x, y, b0.z, a1.x, y, a1.z, c);
      this.tri(b0.x, y, b0.z, b1.x, y, b1.z, a1.x, y, a1.z, c);
    }
  }

  /** Vertical wall along a polyline offset, from y0 to y1. */
  wall(pts: readonly Vec2[], o: number, y0: number, y1: number, c: THREE.Color): void {
    if (pts.length < 2) return;
    const a = offsetPolyline(pts, o);
    for (let i = 1; i < a.length; i++) {
      const p = a[i - 1]!, q = a[i]!;
      this.tri(p.x, y0, p.z, q.x, y0, q.z, q.x, y1, q.z, c);
      this.tri(p.x, y0, p.z, q.x, y1, q.z, p.x, y1, p.z, c);
    }
  }

  /** Dashed thin line along a lateral offset. */
  dashed(pts: readonly Vec2[], o: number, width: number, dash: number, gap: number, y: number, c: THREE.Color): void {
    const cum = cumulativeLengths(pts);
    const total = cum[cum.length - 1]!;
    for (let s = gap / 2; s < total; s += dash + gap) {
      const piece = slicePolyline(pts, s, Math.min(total, s + dash));
      this.band(piece, o - width / 2, o + width / 2, y, c);
    }
  }

  /** Filled polygon (any simple polygon) at height y. */
  polygon(poly: readonly Vec2[], y: number, c: THREE.Color): void {
    if (poly.length < 3) return;
    const contour = poly.map((p) => new THREE.Vector2(p.x, p.z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const t of tris) {
      const a = poly[t[0]!]!, b = poly[t[1]!]!, d = poly[t[2]!]!;
      this.tri(a.x, y, a.z, b.x, y, b.z, d.x, y, d.z, c);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
