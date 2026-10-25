// HighlightLayer: shows where the AI just built. Pulsing buildings (an additive copy over the real
// instances, ~6 s), a light beacon above each new building (until confirmed / 60 s) and glowing lot
// outlines. Reads the highlight state and the doc only. With nothing active, `update` returns at once:
// no geometry, no per-frame work.

import * as THREE from 'three';
import { roadHalfWidth, sampleSegmentCurve, type BuildingType, type CityDoc, type Vec2 } from '@smartcity/shared';
import { activeHighlights, hasBeacon, isPulsing, liveTargets, nextTransition, type Highlight, type HighlightState } from '../app/highlights';
import { closedRing } from '../app/ring';
import { bakeBuildingGeometry } from './buildingGeometry';
import { MeshBuilder } from './meshBuilder';

const GLOW = '#ffe27a';
const MAX_BEACONS = 48;
const BEACON_HEIGHT = 110;
const BEACON_RADIUS = 1.3;
const Y_LINE = 0.4;
const Y_ROAD_GLOW = 0.35;

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

function beaconGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(BEACON_RADIUS * 0.6, BEACON_RADIUS, BEACON_HEIGHT, 12, 1, true);
  g.translate(0, BEACON_HEIGHT / 2, 0);
  // Brightest at the base, fading out toward the top (additive blending turns dark into transparent).
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = 1 - pos.getY(i) / BEACON_HEIGHT;
    _c.set(GLOW).multiplyScalar(k * k);
    col.set([_c.r, _c.g, _c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export interface HighlightStats {
  beacons: number;
  pulsingBuildings: number;
  lots: number;
  /** Road segments drawn with a glow band. */
  roads: number;
}

export class HighlightLayer {
  readonly group = new THREE.Group();
  private readonly glowMat = new THREE.MeshBasicMaterial({ color: GLOW, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false });
  private readonly beaconMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  private readonly lineMat = new THREE.MeshBasicMaterial({ color: GLOW, transparent: true, opacity: 0, depthWrite: false, fog: false });
  private readonly beaconGeom = beaconGeometry();
  private overlays: THREE.InstancedMesh[] = [];
  private beacons: THREE.InstancedMesh | null = null;
  private lines: THREE.Mesh | null = null;
  private roadGlow: THREE.Mesh | null = null;
  private key = '';
  private stat: HighlightStats = { beacons: 0, pulsingBuildings: 0, lots: 0, roads: 0 };
  private pulsing = false;
  /** Active highlights, recomputed only when the state changes or a phase ends (not every frame). */
  private active: Highlight[] = [];
  private lastState: HighlightState | null = null;
  private recheckAt = 0;

  constructor() {
    this.group.name = 'highlights';
  }

  /** Test/debug: what is currently drawn. */
  stats(): HighlightStats {
    return { ...this.stat };
  }

  update(now: number, doc: CityDoc, hs: HighlightState, docVersion: number): void {
    if (hs !== this.lastState || now >= this.recheckAt) {
      this.lastState = hs;
      this.active = activeHighlights(hs, now);
      this.recheckAt = nextTransition(hs, now);
    }
    const active = this.active;
    if (active.length === 0) {
      if (this.key !== '') this.clear();
      return;
    }
    const key = `${docVersion}|${active.map((h) => `${h.id}${isPulsing(h, now) ? 'p' : ''}${hasBeacon(h, now) ? 'b' : ''}`).join(',')}`;
    if (key !== this.key) {
      this.clear();
      this.key = key;
      this.build(now, doc, active);
    }
    // Soft pulse (1.2 Hz) that fades out over the pulse window.
    const t = now / 1000;
    const wave = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.2);
    let fade = 0;
    for (const h of active) if (isPulsing(h, now)) fade = Math.max(fade, 1 - (now - h.pulseFrom) / 6000);
    this.glowMat.opacity = this.pulsing ? (0.15 + 0.5 * wave) * Math.max(0.25, fade) : 0;
    this.lineMat.opacity = 0.55 + 0.4 * wave;
    this.beaconMat.opacity = 0.3 + 0.2 * wave;
  }

  private build(now: number, doc: CityDoc, active: ReturnType<typeof activeHighlights>): void {
    const byType = new Map<string, { x: number; z: number; r: number }[]>();
    const beaconAt: Vec2[] = [];
    const lines = new MeshBuilder();
    const roadBands = new MeshBuilder();
    let roads = 0;
    let lots = 0;
    let pulsingBuildings = 0;
    for (const h of active) {
      const pulse = isPulsing(h, now);
      const beacon = hasBeacon(h, now);
      const live = liveTargets(h, doc);
      for (const id of live.buildingIds) {
        const b = doc.buildings[id]!;
        if (pulse && doc.buildingTypes[b.typeId]) {
          let list = byType.get(b.typeId);
          if (!list) byType.set(b.typeId, (list = []));
          list.push({ x: b.pos.x, z: b.pos.z, r: b.rotation });
          pulsingBuildings++;
        }
        if (beacon) beaconAt.push(b.pos);
      }
      if (pulse) {
        // Glowing band as wide as the road, for the pulse only.
        for (const id of live.segmentIds) {
          const sg = doc.segments[id]!;
          const rt = doc.roadTypes[sg.roadTypeId];
          if (!rt) continue;
          roadBands.band(sampleSegmentCurve(doc.nodes[sg.a]!.pos, doc.nodes[sg.b]!.pos, sg.control, 4), -roadHalfWidth(rt), roadHalfWidth(rt), Y_ROAD_GLOW, _c.set(GLOW));
          roads++;
        }
      }
      if (beacon) {
        for (const id of live.roadSegmentIds) {
          const sg = doc.segments[id]!;
          const pts = sampleSegmentCurve(doc.nodes[sg.a]!.pos, doc.nodes[sg.b]!.pos, sg.control, 4);
          beaconAt.push(pts[Math.floor(pts.length / 2)]!);
        }
      }
      for (const id of live.parcelIds) {
        const poly = doc.parcels[id]!.polygon;
        if (!poly.length) continue;
        lines.band(closedRing(poly), -0.5, 0.5, Y_LINE, _c.set(GLOW));
        lots++;
        if (beacon && live.buildingIds.length === 0) beaconAt.push({ x: poly.reduce((a, v) => a + v.x, 0) / poly.length, z: poly.reduce((a, v) => a + v.z, 0) / poly.length });
      }
    }
    for (const [typeId, list] of byType) {
      const type: BuildingType = doc.buildingTypes[typeId]!;
      const mesh = new THREE.InstancedMesh(bakeBuildingGeometry(type), this.glowMat, list.length);
      mesh.name = `highlight-${typeId}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 16;
      list.forEach((p, i) => {
        _m.makeRotationY(p.r).setPosition(p.x, 0, p.z);
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      this.overlays.push(mesh);
    }
    this.pulsing = pulsingBuildings > 0 || roads > 0;
    if (!roadBands.empty) {
      this.roadGlow = new THREE.Mesh(roadBands.build(), this.glowMat);
      this.roadGlow.frustumCulled = false;
      this.roadGlow.renderOrder = 16;
      this.group.add(this.roadGlow);
    }
    const n = Math.min(MAX_BEACONS, beaconAt.length);
    if (n > 0) {
      const mesh = new THREE.InstancedMesh(this.beaconGeom, this.beaconMat, n);
      mesh.name = 'highlight-beacons';
      mesh.frustumCulled = false;
      mesh.renderOrder = 17;
      for (let i = 0; i < n; i++) {
        _m.makeTranslation(beaconAt[i]!.x, 0, beaconAt[i]!.z);
        mesh.setMatrixAt(i, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      this.beacons = mesh;
    }
    if (!lines.empty) {
      this.lines = new THREE.Mesh(lines.build(), this.lineMat);
      this.lines.frustumCulled = false;
      this.lines.renderOrder = 16;
      this.group.add(this.lines);
    }
    this.stat = { beacons: n, pulsingBuildings, lots, roads };
  }

  private clear(): void {
    for (const m of this.overlays) {
      this.group.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    this.overlays = [];
    if (this.beacons) {
      this.group.remove(this.beacons);
      this.beacons.dispose();
      this.beacons = null;
    }
    if (this.lines) {
      this.group.remove(this.lines);
      this.lines.geometry.dispose();
      this.lines = null;
    }
    if (this.roadGlow) {
      this.group.remove(this.roadGlow);
      this.roadGlow.geometry.dispose();
      this.roadGlow = null;
    }
    this.key = '';
    this.pulsing = false;
    this.stat = { beacons: 0, pulsingBuildings: 0, lots: 0, roads: 0 };
  }

  dispose(): void {
    this.clear();
    this.beaconGeom.dispose();
    this.glowMat.dispose();
    this.beaconMat.dispose();
    this.lineMat.dispose();
  }
}
