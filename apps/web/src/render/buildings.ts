// Buildings: one InstancedMesh per part shape (walls box, gable roof prism, pyramid roof).
// Walls get a window/floor pattern in the shader from local position × instance scale and floor height.

import * as THREE from 'three';
import { rotateY, type Building, type BuildingPart, type CityDoc } from '@smartcity/shared';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

export function createGableGeometry(): THREE.BufferGeometry {
  // Unit prism: base x,z ∈ [-0.5, 0.5] at y = 0, ridge along X at y = 1.
  const v = [
    // slope +z
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0,
    -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    // slope -z
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0,
    0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    // gable ends
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export function createPyramidGeometry(): THREE.BufferGeometry {
  const v = [
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0,
    0.5, 0, 0.5, 0.5, 0, -0.5, 0, 1, 0,
    0.5, 0, -0.5, -0.5, 0, -0.5, 0, 1, 0,
    -0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export function createWallGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

export const wallHeight = (p: BuildingPart): number => p.floors * p.floorHeight;
export const roofHeight = (p: BuildingPart): number =>
  p.roof === 'flat' ? 0 : Math.min(p.roof === 'gable' ? 0.42 * Math.min(p.width, p.depth) : 0.55 * Math.min(p.width, p.depth), 14);

/** World transform of a part's walls (unit box scaled to width × height × depth). */
export function wallMatrix(b: Pick<Building, 'pos' | 'rotation'>, p: BuildingPart, out: THREE.Matrix4): THREE.Matrix4 {
  const o = rotateY(p.offset, b.rotation);
  _p.set(b.pos.x + o.x, p.baseHeight, b.pos.z + o.z);
  _q.setFromEuler(_e.set(0, b.rotation, 0));
  _s.set(p.width, wallHeight(p), p.depth);
  return out.compose(_p, _q, _s);
}

/** World transform of a part's roof; gable ridges follow the longer side. */
export function roofMatrix(b: Pick<Building, 'pos' | 'rotation'>, p: BuildingPart, out: THREE.Matrix4): THREE.Matrix4 {
  const o = rotateY(p.offset, b.rotation);
  _p.set(b.pos.x + o.x, p.baseHeight + wallHeight(p), b.pos.z + o.z);
  const swap = p.roof === 'gable' && p.depth > p.width;
  _q.setFromEuler(_e.set(0, b.rotation + (swap ? Math.PI / 2 : 0), 0));
  _s.set(swap ? p.depth : p.width, roofHeight(p), swap ? p.width : p.depth);
  return out.compose(_p, _q, _s);
}

/** Wall material with roof-colored tops and a floor/window pattern. */
export function createWallMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.02 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 instanceRoof;
        attribute float instanceFloorH;
        varying vec3 vScaledLocal;
        varying vec3 vLocalNormal;
        varying vec3 vRoof;
        varying float vFloorH;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 instScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vScaledLocal = position * instScale;
        vLocalNormal = normal;
        vRoof = instanceRoof;
        vFloorH = instanceFloorH;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vScaledLocal;
        varying vec3 vLocalNormal;
        varying vec3 vRoof;
        varying float vFloorH;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (vLocalNormal.y > 0.5) {
          diffuseColor.rgb = vRoof;
        } else if (vLocalNormal.y > -0.5) {
          float u = abs(vLocalNormal.x) > 0.5 ? vScaledLocal.z : vScaledLocal.x;
          float fl = vScaledLocal.y / vFloorH;
          float inFloor = fract(fl);
          float bay = vFloorH > 6.0 ? 6.0 : 3.2;
          float inBay = fract(u / bay + 0.5);
          float win = step(0.28, inFloor) * step(inFloor, 0.82) * step(0.18, inBay) * step(inBay, 0.82);
          // Floor slab line.
          float slab = 1.0 - step(0.06, inFloor);
          vec3 glass = vec3(0.11, 0.16, 0.22) + 0.06 * vec3(fract(sin(floor(fl) * 12.9898 + floor(u / bay) * 78.233) * 43758.5453));
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.85);
          diffuseColor.rgb *= 1.0 - slab * 0.12;
        }`,
      );
  };
  return mat;
}

class GrowableInstances {
  mesh: THREE.InstancedMesh;
  capacity: number;

  constructor(
    private readonly geo: THREE.BufferGeometry,
    private readonly mat: THREE.Material,
    private readonly parent: THREE.Object3D,
    private readonly extra: { name: string; size: number }[],
    initial = 64,
  ) {
    this.capacity = initial;
    this.mesh = this.create(initial);
  }

  private create(capacity: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geo, this.mat, capacity);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    for (const e of this.extra) this.geo.setAttribute(e.name, new THREE.InstancedBufferAttribute(new Float32Array(capacity * e.size), e.size));
    m.castShadow = true;
    m.receiveShadow = true;
    m.count = 0;
    m.frustumCulled = false;
    this.parent.add(m);
    return m;
  }

  ensure(n: number): void {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.capacity = cap;
    this.mesh = this.create(cap);
  }

  attr(name: string): THREE.InstancedBufferAttribute {
    return this.geo.getAttribute(name) as THREE.InstancedBufferAttribute;
  }
}

export class BuildingLayer {
  readonly group = new THREE.Group();
  private walls: GrowableInstances;
  private gables: GrowableInstances;
  private pyramids: GrowableInstances;
  /** Instance index → building id, for wall instances (debug/picking aid). */
  wallOwners: string[] = [];

  constructor() {
    this.group.name = 'buildings';
    this.walls = new GrowableInstances(createWallGeometry(), createWallMaterial(), this.group, [
      { name: 'instanceRoof', size: 3 },
      { name: 'instanceFloorH', size: 1 },
    ]);
    const roofMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.02, side: THREE.DoubleSide });
    this.gables = new GrowableInstances(createGableGeometry(), roofMat, this.group, []);
    this.pyramids = new GrowableInstances(createPyramidGeometry(), roofMat, this.group, []);
  }

  update(doc: CityDoc): void {
    let nWalls = 0;
    let nGable = 0;
    let nPyr = 0;
    const list = Object.values(doc.buildings);
    for (const b of list) {
      const t = doc.buildingTypes[b.typeId];
      if (!t) continue;
      for (const p of t.parts) {
        nWalls++;
        if (p.roof === 'gable') nGable++;
        else if (p.roof === 'pyramid') nPyr++;
      }
    }
    this.walls.ensure(nWalls);
    this.gables.ensure(nGable);
    this.pyramids.ensure(nPyr);
    const w = this.walls.mesh;
    const roofAttr = this.walls.attr('instanceRoof');
    const floorAttr = this.walls.attr('instanceFloorH');
    let iw = 0;
    let ig = 0;
    let ip = 0;
    this.wallOwners.length = 0;
    for (const b of list) {
      const t = doc.buildingTypes[b.typeId];
      if (!t) continue;
      for (const p of t.parts) {
        w.setMatrixAt(iw, wallMatrix(b, p, _m));
        w.setColorAt(iw, _c.set(p.color));
        _c2.set(p.roof === 'flat' ? p.roofColor : p.color);
        roofAttr.setXYZ(iw, _c2.r, _c2.g, _c2.b);
        floorAttr.setX(iw, p.floorHeight);
        this.wallOwners[iw] = b.id;
        iw++;
        if (p.roof === 'gable') {
          this.gables.mesh.setMatrixAt(ig, roofMatrix(b, p, _m));
          this.gables.mesh.setColorAt(ig++, _c.set(p.roofColor));
        } else if (p.roof === 'pyramid') {
          this.pyramids.mesh.setMatrixAt(ip, roofMatrix(b, p, _m));
          this.pyramids.mesh.setColorAt(ip++, _c.set(p.roofColor));
        }
      }
    }
    for (const [g, n] of [
      [this.walls, iw],
      [this.gables, ig],
      [this.pyramids, ip],
    ] as const) {
      g.mesh.count = n;
      g.mesh.instanceMatrix.needsUpdate = true;
      if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
    }
    roofAttr.needsUpdate = true;
    floorAttr.needsUpdate = true;
  }
}

/** Plain meshes for a single building type (editor preview). */
export function buildingPreview(parts: BuildingPart[]): THREE.Group {
  const g = new THREE.Group();
  const wallGeo = createWallGeometry();
  const gable = createGableGeometry();
  const pyr = createPyramidGeometry();
  const b = { pos: { x: 0, z: 0 }, rotation: 0 };
  for (const p of parts) {
    const walls = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.85 }));
    wallMatrix(b, p, walls.matrix);
    walls.matrixAutoUpdate = false;
    g.add(walls);
    if (p.roof === 'flat') {
      const top = new THREE.Mesh(new THREE.PlaneGeometry(p.width, p.depth).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: p.roofColor }));
      top.position.set(p.offset.x, p.baseHeight + wallHeight(p) + 0.02, p.offset.z);
      g.add(top);
    } else {
      const roof = new THREE.Mesh(p.roof === 'gable' ? gable : pyr, new THREE.MeshStandardMaterial({ color: p.roofColor, side: THREE.DoubleSide }));
      roofMatrix(b, p, roof.matrix);
      roof.matrixAutoUpdate = false;
      g.add(roof);
    }
  }
  return g;
}
