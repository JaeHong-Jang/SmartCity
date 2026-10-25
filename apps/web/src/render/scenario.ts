// Simulator-mode overlay (ADR 0010): accident obstacles (two wrecked cars + warning sign), closed lanes
// (translucent red band + barricade) and event rings above surge buildings. Reads `snapshot.scenario`;
// without it nothing is drawn and a frame costs one property read.

import * as THREE from 'three';
import type { Vec2 } from '@smartcity/shared';
import type { RoadGraph, ScenarioView } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import { MeshBuilder } from './meshBuilder';

/** Where the layer gets what the snapshot does not carry. */
export interface ScenarioSource {
  /** Compiled graph of the simulated copy (lane indexes in the snapshot refer to it). */
  graph(): RoadGraph | null;
  /** Centers of buildings with a surge in progress at `tick`. */
  surges(tick: number): Vec2[];
}

export interface ScenarioStats {
  drawn: boolean;
  obstacles: number;
  closedLanes: number;
  surgeRings: number;
  /** graphRevision the lane geometry was built for. */
  revision: number;
}

const Y_BAND = 0.32;
const RING_Y = 34;
const _c = new THREE.Color();

/** Axis-aligned-in-local-frame box: center (x, z), yaw heading (travel direction angle), length along, width across. */
function box(b: MeshBuilder, x: number, z: number, heading: number, len: number, wid: number, y0: number, y1: number, color: string): void {
  _c.set(color);
  const ax = Math.cos(heading), az = Math.sin(heading);
  const bx = -az, bz = ax;
  const corner = (i: number, j: number, y: number): [number, number, number] => [x + ax * len * 0.5 * i + bx * wid * 0.5 * j, y, z + az * len * 0.5 * i + bz * wid * 0.5 * j];
  const quad = (p: [number, number, number], q: [number, number, number], r: [number, number, number], s: [number, number, number]): void => {
    b.tri(...p, ...q, ...r, _c);
    b.tri(...p, ...r, ...s, _c);
  };
  quad(corner(-1, -1, y1), corner(1, -1, y1), corner(1, 1, y1), corner(-1, 1, y1));
  quad(corner(-1, -1, y0), corner(1, -1, y0), corner(1, -1, y1), corner(-1, -1, y1));
  quad(corner(1, -1, y0), corner(1, 1, y0), corner(1, 1, y1), corner(1, -1, y1));
  quad(corner(1, 1, y0), corner(-1, 1, y0), corner(-1, 1, y1), corner(1, 1, y1));
  quad(corner(-1, 1, y0), corner(-1, -1, y0), corner(-1, -1, y1), corner(-1, 1, y1));
}

/** Orange warning triangle on a pole, facing along the travel direction (readable from approaching traffic). */
function warningSign(b: MeshBuilder, x: number, z: number, heading: number): void {
  const ax = Math.cos(heading), az = Math.sin(heading);
  const bx = -az, bz = ax;
  box(b, x, z, heading, 0.2, 0.2, 0, 2.2, '#4b5563');
  _c.set('#f97316');
  const w = 1.5;
  const y0 = 2.0, y1 = 4.2;
  b.tri(x - bx * w + ax * 0.15, y0, z - bz * w + az * 0.15, x + bx * w + ax * 0.15, y0, z + bz * w + az * 0.15, x + ax * 0.15, y1, z + az * 0.15, _c);
  b.tri(x + bx * w + ax * 0.15, y0, z + bz * w + az * 0.15, x - bx * w + ax * 0.15, y0, z - bz * w + az * 0.15, x + ax * 0.15, y1, z + az * 0.15, _c);
  const k = 0.75;
  _c.set('#fff7ed');
  b.tri(x - bx * w * k + ax * 0.2, y0 + 0.4, z - bz * w * k + az * 0.2, x + bx * w * k + ax * 0.2, y0 + 0.4, z + bz * w * k + az * 0.2, x + ax * 0.2, y1 - 0.7, z + az * 0.2, _c);
  b.tri(x + bx * w * k - ax * 0.05, y0 + 0.4, z + bz * w * k - az * 0.05, x - bx * w * k - ax * 0.05, y0 + 0.4, z - bz * w * k - az * 0.05, x - ax * 0.05, y1 - 0.7, z - az * 0.05, _c);
}

export class ScenarioLayer {
  readonly group = new THREE.Group();
  private solid: THREE.Mesh;
  private bands: THREE.Mesh;
  private rings: THREE.InstancedMesh;
  private ringCount = 0;
  private source: ScenarioSource | null = null;
  private sig = '';
  private revision = -1;
  private laneCache: RoadGraph | null = null;
  private counts = { obstacles: 0, closedLanes: 0 };

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'scenario';
    this.solid = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.solid.name = 'scenario-solid';
    this.solid.frustumCulled = false;
    this.solid.castShadow = true;
    this.bands = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }),
    );
    this.bands.name = 'scenario-closed-lanes';
    this.bands.frustumCulled = false;
    this.bands.renderOrder = 6;
    const torus = new THREE.TorusGeometry(7, 0.7, 8, 28).rotateX(Math.PI / 2);
    this.rings = new THREE.InstancedMesh(torus, new THREE.MeshBasicMaterial({ color: '#fb923c' }), 32);
    this.rings.name = 'scenario-surge-rings';
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.group.add(this.solid, this.bands, this.rings);
    this.group.visible = false;
  }

  setSource(source: ScenarioSource | null): void {
    this.source = source;
    this.sig = '';
  }

  private clear(): void {
    this.solid.geometry.dispose();
    this.solid.geometry = new THREE.BufferGeometry();
    this.bands.geometry.dispose();
    this.bands.geometry = new THREE.BufferGeometry();
    this.rings.count = 0;
    this.ringCount = 0;
    this.counts = { obstacles: 0, closedLanes: 0 };
    this.group.visible = false;
    this.sig = '';
    this.revision = -1;
  }

  private signature(sc: ScenarioView, surges: Vec2[]): string {
    let s = `${sc.graphRevision}|${sc.closedLanes.join(',')}|`;
    for (const o of sc.obstacles) s += `${o.eventId}:${o.lane}:${o.x.toFixed(1)}:${o.z.toFixed(1)};`;
    for (const p of surges) s += `s${p.x.toFixed(0)},${p.z.toFixed(0)};`;
    return s;
  }

  update(now: number): void {
    const snap = this.stream.latest();
    const sc = snap?.scenario;
    if (!snap || !sc) {
      if (this.group.visible || this.sig) this.clear();
      return;
    }
    const surges = this.source?.surges(snap.tick) ?? [];
    const sig = this.signature(sc, surges);
    if (sig !== this.sig) {
      this.sig = sig;
      // Lane geometry is re-queried whenever the graph was recompiled.
      if (sc.graphRevision !== this.revision || !this.laneCache) {
        this.revision = sc.graphRevision;
        this.laneCache = this.source?.graph() ?? null;
      }
      this.rebuild(sc, surges, this.laneCache);
    }
    // A gentle bob keeps the event rings noticeable.
    this.rings.position.y = Math.sin(now / 600) * 0.8;
    this.group.visible = this.counts.obstacles + this.counts.closedLanes + this.ringCount > 0;
  }

  private rebuild(sc: ScenarioView, surges: Vec2[], graph: RoadGraph | null): void {
    const solid = new MeshBuilder();
    const bands = new MeshBuilder();
    let closed = 0;
    if (graph) {
      for (const li of sc.closedLanes) {
        const lane = graph.lanes[li];
        if (!lane) continue;
        closed++;
        _c.set('#ef4444');
        bands.band(lane.points, -1.5, 1.5, Y_BAND, _c);
        // Barricade across the lane at its entry: red/white striped bar on two posts.
        const p0 = lane.points[0]!, p1 = lane.points[Math.min(1, lane.points.length - 1)]!;
        const h = Math.atan2(p1.z - p0.z, p1.x - p0.x);
        box(solid, p0.x, p0.z, h, 0.5, 3.0, 0.6, 1.3, '#f8fafc');
        box(solid, p0.x, p0.z, h, 0.52, 1.0, 0.6, 1.3, '#dc2626');
        box(solid, p0.x, p0.z, h, 0.4, 0.2, 0, 0.6, '#475569');
      }
    }
    for (const o of sc.obstacles) {
      const ax = Math.cos(o.heading), az = Math.sin(o.heading);
      const q = o.length * 0.25;
      box(solid, o.x - ax * q, o.z - az * q, o.heading + 0.12, 4.2, 1.8, 0.2, 1.5, '#475569');
      box(solid, o.x + ax * q, o.z + az * q, o.heading - 0.35, 4.2, 1.8, 0.2, 1.5, '#991b1b');
      warningSign(solid, o.x - ax * (o.length / 2 + 7), o.z - az * (o.length / 2 + 7), o.heading);
    }
    this.counts = { obstacles: sc.obstacles.length, closedLanes: closed };
    this.solid.geometry.dispose();
    this.solid.geometry = solid.empty ? new THREE.BufferGeometry() : solid.build();
    this.bands.geometry.dispose();
    this.bands.geometry = bands.empty ? new THREE.BufferGeometry() : bands.build();

    const m = new THREE.Matrix4();
    const n = Math.min(surges.length, this.rings.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      m.makeTranslation(surges[i]!.x, RING_Y, surges[i]!.z);
      this.rings.setMatrixAt(i, m);
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    this.ringCount = n;
  }

  stats(): ScenarioStats {
    return { drawn: this.group.visible, obstacles: this.counts.obstacles, closedLanes: this.counts.closedLanes, surgeRings: this.ringCount, revision: this.revision };
  }

  dispose(): void {
    this.solid.geometry.dispose();
    (this.solid.material as THREE.Material).dispose();
    this.bands.geometry.dispose();
    (this.bands.material as THREE.Material).dispose();
    this.rings.geometry.dispose();
    (this.rings.material as THREE.Material).dispose();
    this.rings.dispose();
  }
}
