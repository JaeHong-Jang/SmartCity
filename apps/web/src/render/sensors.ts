// Roadside sensors (ADR 0013 §5): one InstancedMesh per kind (pole + camera head / radar box / smart pole),
// no shadows, instances beyond CULL_RADIUS from the camera dropped. The view sectors (translucent) and the lane
// stretches each sensor really covers are drawn only while the sensor tool is active or the layer toggle is on
// (every sensor), or for the selected sensor — never by default. Coverage is the simulation's own
// `compileSensorCoverage`, recomputed only when sensors, roads or buildings changed (never per frame).

import * as THREE from 'three';
import { sensorPose, type CityDoc, type SensorKind, type Vec2 } from '@smartcity/shared';
import { compileSensorCoverage, sensorCoverage, type RoadGraph, type SensorCoverage } from '@smartcity/sim';
import { COVERED_COLOR, coveredLanes, SECTOR_COLOR } from '../tools/sensorTool';
import { MeshBuilder } from './meshBuilder';
import { fan } from './overlays';
import { Y_WALK } from './roads';

/** Instances farther than this from the camera are not drawn (a pole is sub-pixel there anyway), meters. */
export const CULL_RADIUS = 1200;
/** Re-pack the instances once the camera moved this far since the last cull, meters. */
const RECULL_STEP = 40;
const Y_FAN = 0.3;
const KINDS: readonly SensorKind[] = ['cctv', 'radar', 'smartpole'];
/** Radius and colour of the ring painted around each pole's base, meters. */
const BASE_RING = 1.6;
const BASE_RING_COLOR = '#22d3ee';
const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();

/** Box from (x0, y0, z0) to (x1, y1, z1) in model space (+x = view direction), faces wound outward. */
function box(b: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: string): void {
  _c.set(color);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const q = (a: number[], c: number[], d: number[], e: number[]): void => {
    // Outward = the normal points away from the box center.
    const ux = c[0]! - a[0]!, uy = c[1]! - a[1]!, uz = c[2]! - a[2]!;
    const vx = d[0]! - a[0]!, vy = d[1]! - a[1]!, vz = d[2]! - a[2]!;
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const m = [(a[0]! + d[0]!) / 2 - cx, (a[1]! + d[1]!) / 2 - cy, (a[2]! + d[2]!) / 2 - cz];
    const [p1, p2, p3, p4] = n[0]! * m[0]! + n[1]! * m[1]! + n[2]! * m[2]! >= 0 ? [a, c, d, e] : [a, e, d, c];
    b.tri(p1![0]!, p1![1]!, p1![2]!, p2![0]!, p2![1]!, p2![2]!, p3![0]!, p3![1]!, p3![2]!, _c);
    b.tri(p1![0]!, p1![1]!, p1![2]!, p3![0]!, p3![1]!, p3![2]!, p4![0]!, p4![1]!, p4![2]!, _c);
  };
  q([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
  q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  q([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  q([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
  q([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
}

/** Model of one kind, standing at the origin and looking along +x. */
export function sensorModel(kind: SensorKind): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const pole = '#6b7280';
  // Ground ring around the base, so a pole can be found from the usual editing distance (same instance, no shadow).
  const ring: Vec2[] = [];
  for (let i = 0; i <= 24; i++) ring.push({ x: Math.cos((i / 24) * Math.PI * 2) * BASE_RING, z: Math.sin((i / 24) * Math.PI * 2) * BASE_RING });
  b.band(ring, -0.25, 0.25, 0.06, _c.set(BASE_RING_COLOR));
  if (kind === 'cctv') {
    box(b, -0.18, 0, -0.18, 0.18, 6, 0.18, pole);
    box(b, -0.12, 5.7, -0.1, 0.8, 5.9, 0.1, pole);
    box(b, 0.45, 5.25, -0.32, 1.6, 5.8, 0.32, '#e5e7eb');
    box(b, 1.6, 5.35, -0.22, 1.72, 5.7, 0.22, '#111827');
  } else if (kind === 'radar') {
    box(b, -0.18, 0, -0.18, 0.18, 5.2, 0.18, pole);
    box(b, 0.18, 4.3, -0.5, 0.55, 5.1, 0.5, '#f8fafc');
    box(b, 0.55, 4.4, -0.4, 0.6, 5.0, 0.4, '#1e3a8a');
  } else {
    box(b, -0.22, 0, -0.22, 0.22, 8, 0.22, '#4b5563');
    box(b, -0.42, 6.1, -0.42, 0.42, 6.9, 0.42, '#e5e7eb');
    box(b, -0.44, 6.4, -0.44, 0.44, 6.6, 0.44, '#0ea5e9');
    box(b, -0.05, 7.6, -0.05, 1.6, 7.75, 0.05, '#4b5563');
    box(b, 1.2, 7.35, -0.2, 1.9, 7.6, 0.2, '#fde68a');
  }
  return b.build();
}

export interface SensorStats {
  /** Instances drawn per kind (after culling) and sensors with a pose. */
  drawn: Record<SensorKind, number>;
  total: number;
  /** Sensors whose view sector is shown now, and lane stretches highlighted. */
  sectors: number;
  coveredLanes: number;
}

interface Mount {
  kind: SensorKind;
  pos: Vec2;
  yaw: number;
}

/** Which view sectors to show: every sensor, one sensor (`id`), or none. */
export type SectorMode = 'all' | 'one' | 'none';

export class SensorLayer {
  readonly group = new THREE.Group();
  private meshes: Record<SensorKind, THREE.InstancedMesh>;
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private mounts: Mount[] = [];
  private culledAt: { x: number; z: number } | null = null;
  private fans: THREE.Mesh;
  private lanes: THREE.Mesh;
  /** Coverage of every sensor for the doc/graph it was built from (null = stale). */
  private coverage: SensorCoverage[] | null = null;
  /** What the sector meshes show now (`fresh` = false after update(): rebuild on the next call). */
  private shown: { mode: SectorMode; id: string | null; graph: RoadGraph | null; fresh: boolean } = { mode: 'none', id: null, graph: null, fresh: false };
  private counts = { sectors: 0, coveredLanes: 0 };

  constructor() {
    this.group.name = 'sensors';
    this.meshes = {} as Record<SensorKind, THREE.InstancedMesh>;
    for (const k of KINDS) {
      const m = new THREE.InstancedMesh(sensorModel(k), this.material, 16);
      m.name = `sensors-${k}`;
      m.count = 0;
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      this.meshes[k] = m;
      this.group.add(m);
    }
    const overlay = (name: string, opacity: number, order: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
      mesh.name = name;
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      return mesh;
    };
    this.fans = overlay('sensor-sectors', 0.16, 5);
    this.lanes = overlay('sensor-covered-lanes', 0.75, 6);
  }

  /** Sensors, roads or buildings changed: new mounts, coverage recomputed when next shown. */
  update(doc: CityDoc): void {
    this.mounts = [];
    for (const id of Object.keys(doc.sensors ?? {}).sort()) {
      const s = doc.sensors[id]!;
      const pose = sensorPose(doc, s);
      if (pose) this.mounts.push({ kind: s.kind, pos: pose.pos, yaw: pose.yaw });
    }
    for (const k of KINDS) {
      const n = this.mounts.filter((m) => m.kind === k).length;
      const mesh = this.meshes[k];
      if (mesh.instanceMatrix.count < n) {
        const next = new THREE.InstancedMesh(mesh.geometry, this.material, Math.max(n, mesh.instanceMatrix.count * 2));
        next.name = mesh.name;
        next.castShadow = false;
        next.receiveShadow = false;
        next.frustumCulled = false;
        this.group.remove(mesh);
        mesh.dispose();
        this.meshes[k] = next;
        this.group.add(next);
      }
    }
    this.culledAt = null;
    this.coverage = null;
    this.shown.fresh = false;
  }

  /** Pack the instances near the camera (only after it moved RECULL_STEP since the last pack). */
  frame(cameraX: number, cameraZ: number): void {
    const c = this.culledAt;
    if (c && Math.hypot(c.x - cameraX, c.z - cameraZ) < RECULL_STEP) return;
    this.culledAt = { x: cameraX, z: cameraZ };
    const n: Record<SensorKind, number> = { cctv: 0, radar: 0, smartpole: 0 };
    for (const m of this.mounts) {
      if (Math.hypot(m.pos.x - cameraX, m.pos.z - cameraZ) > CULL_RADIUS) continue;
      _m.makeTranslation(m.pos.x, Y_WALK, m.pos.z).multiply(_r.makeRotationY(-m.yaw));
      this.meshes[m.kind].setMatrixAt(n[m.kind]++, _m);
    }
    for (const k of KINDS) {
      this.meshes[k].count = n[k];
      this.meshes[k].instanceMatrix.needsUpdate = true;
    }
  }

  /** Show the view sectors and covered lanes of `mode` (rebuilt only when the mode or the coverage changed). */
  setSectors(doc: CityDoc, graph: RoadGraph | null, mode: SectorMode, id: string | null = null): void {
    const sh = this.shown;
    // Called every frame: no allocation unless something changed.
    if (sh.fresh && sh.mode === mode && sh.graph === graph && (mode !== 'one' || sh.id === id)) return;
    this.shown = { mode, id, graph, fresh: true };
    let list: SensorCoverage[] = [];
    if (graph && mode === 'all') list = this.coverage ??= compileSensorCoverage(doc, graph);
    else if (graph && mode === 'one' && id !== null) {
      const s = doc.sensors[id];
      if (s) list = [this.coverage?.find((c) => c.sensorId === id) ?? sensorCoverage(doc, graph, s)];
    }
    const fans = new MeshBuilder();
    const lanes = new MeshBuilder();
    let laneCount = 0;
    for (const cov of list) {
      const s = doc.sensors[cov.sensorId];
      if (!s || !sensorPose(doc, s)) continue;
      fan(fans, { x: cov.x, z: cov.z }, cov.yaw, s.fov, s.range, SECTOR_COLOR, Y_FAN);
      if (!graph) continue;
      _c.set(COVERED_COLOR);
      for (const pts of coveredLanes(graph, cov)) {
        lanes.band(pts, -1.1, 1.1, Y_FAN + 0.02, _c);
        laneCount++;
      }
    }
    this.counts = { sectors: list.length, coveredLanes: laneCount };
    for (const [mesh, b] of [
      [this.fans, fans],
      [this.lanes, lanes],
    ] as const) {
      mesh.geometry.dispose();
      mesh.geometry = b.empty ? new THREE.BufferGeometry() : b.build();
      mesh.visible = !b.empty;
    }
  }

  stats(): SensorStats {
    const drawn = { cctv: this.meshes.cctv.count, radar: this.meshes.radar.count, smartpole: this.meshes.smartpole.count };
    return { drawn, total: this.mounts.length, sectors: this.counts.sectors, coveredLanes: this.counts.coveredLanes };
  }

  dispose(): void {
    for (const k of KINDS) {
      this.meshes[k].geometry.dispose();
      this.meshes[k].dispose();
    }
    this.material.dispose();
    for (const m of [this.fans, this.lanes]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
