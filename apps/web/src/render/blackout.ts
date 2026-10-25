// Simulator-mode blackout overlay (ADR 0010 §4): a dark disc over each blackout area, a dark veil over
// buildings without power (stronger at night, when their windows would otherwise glow), battery labels at
// junctions held by their battery (when the camera is near) and the substation coverage circles while the
// 정전 tool is armed. Reads `snapshot.scenario`; without blackouts, unpowered buildings or batteries (and no
// armed tool) nothing is drawn and a frame costs a few property reads.

import * as THREE from 'three';
import type { CityDoc } from '@smartcity/shared';
import type { ScenarioView } from '@smartcity/sim';
import { buildingBox } from '../simmode/buildingBox';
import { tryController } from '../simmode/instance';
import { simModeStore } from '../simmode/store';
import type { SimulationStream } from '../sim/simStream';

export interface BlackoutStats {
  drawn: boolean;
  discs: number;
  unpoweredBuildings: number;
  batteryLabels: number;
  coverageRings: number;
}

/** Labels only show when the camera is this close (orbit distance, meters). */
export const LABEL_DISTANCE = 450;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const DAY_VEIL = 0.16;
const NIGHT_VEIL = 0.62;

/** Veil opacity of an unpowered building: slight by day, strong at night (`night` 0..1). */
export const veilOpacity = (night: number): number => DAY_VEIL + (NIGHT_VEIL - DAY_VEIL) * Math.max(0, Math.min(1, night));

export class BlackoutLayer {
  readonly group = new THREE.Group();
  private fixed = new THREE.Group();
  private labels = new THREE.Group();
  /** One instanced unit box for every unpowered building's veil (one draw call at any building count). */
  private veil: THREE.InstancedMesh;
  private readonly veilMat = new THREE.MeshBasicMaterial({ color: '#05070b', transparent: true, opacity: DAY_VEIL, depthWrite: false });
  private lastSnap: unknown = null;
  private lastCoverage: unknown = null;
  private lastArmed = false;
  private lastNear = false;
  private sig = '';
  private labelSig = '';
  private counts = { discs: 0, unpoweredBuildings: 0, batteryLabels: 0, coverageRings: 0 };
  private readonly unit = new THREE.BoxGeometry(1, 1, 1);
  private readonly disc = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
  private readonly ring = new THREE.RingGeometry(0.985, 1, 64).rotateX(-Math.PI / 2);

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'blackout';
    this.veil = this.makeVeil(64);
    this.group.add(this.fixed, this.labels, this.veil);
    this.group.visible = false;
  }

  private makeVeil(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.unit, this.veilMat, cap);
    m.name = 'blackout-veils';
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = 7;
    return m;
  }

  private clear(group: THREE.Group): void {
    for (const ch of [...group.children]) {
      group.remove(ch);
      ch.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        const map = (m as THREE.SpriteMaterial | undefined)?.map;
        map?.dispose();
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      });
    }
  }

  private clearAll(): void {
    this.clear(this.fixed);
    this.clear(this.labels);
    this.veil.count = 0;
    this.sig = '';
    this.lastSnap = null;
    this.lastCoverage = null;
    this.labelSig = '';
    this.counts = { discs: 0, unpoweredBuildings: 0, batteryLabels: 0, coverageRings: 0 };
    this.group.visible = false;
  }

  private rebuild(sc: ScenarioView | undefined, doc: CityDoc | null, rings: { x: number; z: number; radius: number }[]): void {
    this.clear(this.fixed);
    let discs = 0;
    let buildings = 0;
    for (const b of sc?.blackouts ?? []) {
      discs++;
      const m = new THREE.Mesh(this.disc, new THREE.MeshBasicMaterial({ color: '#05070b', transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide }));
      m.scale.set(b.radius, 1, b.radius);
      m.position.set(b.x, 0.45, b.z);
      m.renderOrder = 6;
      this.fixed.add(m);
      const edge = new THREE.Mesh(this.ring, new THREE.MeshBasicMaterial({ color: '#f59e0b', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
      edge.scale.set(b.radius, 1, b.radius);
      edge.position.set(b.x, 0.5, b.z);
      edge.renderOrder = 7;
      this.fixed.add(edge);
    }
    const ids = doc ? (sc?.unpoweredBuildings ?? []) : [];
    if (ids.length > this.veil.instanceMatrix.count) {
      let cap = this.veil.instanceMatrix.count;
      while (cap < ids.length) cap *= 2;
      this.group.remove(this.veil);
      this.veil.dispose();
      this.veil = this.makeVeil(cap);
      this.group.add(this.veil);
    }
    for (const id of ids) {
      const box = buildingBox(doc!, id);
      if (!box) continue;
      _p.set(box.x, (box.h + 0.5) / 2, box.z);
      _s.set(box.w + 0.5, box.h + 0.5, box.d + 0.5);
      _m.compose(_p, _q, _s);
      this.veil.setMatrixAt(buildings++, _m);
    }
    this.veil.count = buildings;
    this.veil.instanceMatrix.needsUpdate = true;
    for (const r of rings) {
      const m = new THREE.Mesh(this.ring, new THREE.MeshBasicMaterial({ color: '#fbbf24', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
      m.scale.set(r.radius, 1, r.radius);
      m.position.set(r.x, 0.55, r.z);
      m.renderOrder = 8;
      this.fixed.add(m);
    }
    this.counts.discs = discs;
    this.counts.unpoweredBuildings = buildings;
    this.counts.coverageRings = rings.length;
  }

  private labelTexture(text: string): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 48;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = 'rgba(17,24,33,0.88)';
    g.fillRect(0, 0, 128, 48);
    g.strokeStyle = '#fbbf24';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, 125, 45);
    // battery icon
    g.fillStyle = '#fbbf24';
    g.fillRect(10, 14, 26, 20);
    g.fillRect(36, 20, 4, 8);
    g.fillStyle = '#111821';
    g.fillRect(13, 17, 14, 14);
    g.fillStyle = '#e6edf5';
    g.font = 'bold 22px sans-serif';
    g.textBaseline = 'middle';
    g.fillText(text, 48, 25);
    return new THREE.CanvasTexture(c);
  }

  private rebuildLabels(batteries: ScenarioView['battery'], doc: CityDoc | null): void {
    this.clear(this.labels);
    let n = 0;
    const ctl = tryController();
    for (const b of batteries) {
      let pos: { x: number; z: number } | undefined;
      if (b.signalId.startsWith('n:')) pos = doc?.nodes[b.signalId.slice(2)]?.pos;
      else {
        const cr = ctl?.roadGraph()?.crossings.find((c) => c.id === b.signalId.slice(2));
        if (cr) pos = { x: (cr.a.x + cr.b.x) / 2, z: (cr.a.z + cr.b.z) / 2 };
      }
      if (!pos) continue;
      const tex = this.labelTexture(`${Math.ceil(b.remainingMinutes)}분`);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex ?? undefined, transparent: true, depthTest: false }));
      sp.position.set(pos.x, 9, pos.z);
      sp.scale.set(15, 5.6, 1);
      sp.renderOrder = 20;
      this.labels.add(sp);
      n++;
    }
    this.counts.batteryLabels = n;
  }

  /** `night` 0..1 (day → night), `cameraDistance` = orbit distance in meters. */
  update(now: number, night: number, cameraDistance: number): void {
    void now;
    const snap = this.stream.latest();
    const sc = snap?.scenario;
    const st = simModeStore.getState();
    const rings = st.armed?.kind === 'blackout' ? st.coverage : [];
    const any = !!sc && ((sc.blackouts?.length ?? 0) + (sc.unpoweredBuildings?.length ?? 0) + (sc.battery?.length ?? 0) > 0);
    if (!any && rings.length === 0) {
      if (this.group.visible || this.sig) this.clearAll();
      return;
    }
    const doc = tryController()?.copyCityDoc() ?? null;
    const armedNow = st.armed?.kind === 'blackout';
    const unchanged = snap === this.lastSnap && st.coverage === this.lastCoverage && armedNow === this.lastArmed;
    this.lastSnap = snap;
    this.lastCoverage = st.coverage;
    this.lastArmed = armedNow;
    const sig = unchanged ? this.sig : `${(sc?.blackouts ?? []).map((b) => `${b.eventId}`).join(',')}|${(sc?.unpoweredBuildings ?? []).join(',')}|${rings.map((r) => `${r.substationId}:${Math.round(r.radius)}`).join(',')}`;
    if (!unchanged && sig !== this.sig) {
      this.sig = sig;
      this.rebuild(sc, doc, rings);
    }
    // Battery labels: the minutes change, so they follow their own signature and only show up close.
    const near = cameraDistance < LABEL_DISTANCE;
    if (!unchanged || near !== this.lastNear) {
      this.lastNear = near;
      const batteries = near ? (sc?.battery ?? []) : [];
      const lsig = batteries.map((b) => `${b.signalId}:${Math.ceil(b.remainingMinutes)}`).join(',');
      if (lsig !== this.labelSig) {
        this.labelSig = lsig;
        if (batteries.length) this.rebuildLabels(batteries, doc);
        else {
          this.clear(this.labels);
          this.counts.batteryLabels = 0;
        }
      }
    }
    this.veilMat.opacity = veilOpacity(night);
    this.group.visible = true;
  }

  stats(): BlackoutStats {
    return { drawn: this.group.visible, ...this.counts };
  }

  dispose(): void {
    this.clearAll();
    this.group.remove(this.veil);
    this.veil.dispose();
    this.veilMat.dispose();
    this.unit.dispose();
    this.disc.dispose();
    this.ring.dispose();
  }
}
