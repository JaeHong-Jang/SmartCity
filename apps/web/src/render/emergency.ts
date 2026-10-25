// Simulator-mode emergency overlay (ADR 0010 §3/§4): burning buildings (flickering glow + smoke), charred
// buildings, medical markers, dispatched fire trucks and ambulances, pre-empted intersections. Reads
// `snapshot.scenario`; without incidents, dispatches or pre-emption nothing is drawn and a frame costs a few
// property reads.

import * as THREE from 'three';
import type { Vec2 } from '@smartcity/shared';
import { VEHICLE_STRIDE, type ScenarioView, type SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import { interpAlpha, lerpAngle } from './vehicles';

/** What the snapshot does not carry: where a building or a node is. */
export interface EmergencySource {
  /** Axis-aligned footprint center, size and height of a building in the simulated copy. */
  building(id: string): { x: number; z: number; w: number; d: number; h: number } | null;
  node(id: string): Vec2 | null;
}

export interface EmergencyStats {
  drawn: boolean;
  fires: number;
  medical: number;
  damaged: number;
  fireTrucks: number;
  ambulances: number;
  preempted: number;
}

interface Glow {
  mat: THREE.MeshBasicMaterial;
  base: number;
  seed: number;
}
interface Smoke {
  sprite: THREE.Sprite;
  top: number;
  progress: number;
  phase: number;
}
interface Pulse {
  obj: THREE.Object3D;
  seed: number;
}
interface Rig {
  group: THREE.Group;
  lightA: THREE.MeshBasicMaterial;
  lightB: THREE.MeshBasicMaterial;
  kind: 'fire' | 'medical';
}

const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d);

/**
 * Pose of vehicle `id` exactly as VehicleLayer draws it (same interpAlpha, same previous/latest snapshots,
 * same angle interpolation), so a rig sits on the car it covers. Null when the vehicle is not in `cur`.
 */
export function rigPose(cur: SimSnapshot, prev: SimSnapshot | null, id: number, now: number, prevAt: number, latestAt: number): { x: number; z: number; h: number } | null {
  let i = -1;
  for (let k = 0; k < cur.vehicleCount; k++) {
    if (cur.vehicles[k * VEHICLE_STRIDE + 5] === id) {
      i = k;
      break;
    }
  }
  if (i < 0) return null;
  const o = i * VEHICLE_STRIDE;
  let x = cur.vehicles[o]!;
  let z = cur.vehicles[o + 1]!;
  let h = cur.vehicles[o + 2]!;
  const usePrev = prev !== null && prev.graphRevision === cur.graphRevision;
  const alpha = usePrev ? interpAlpha(now, prevAt, latestAt) : 1;
  if (usePrev && alpha < 1) {
    for (let k = 0; k < prev.vehicleCount; k++) {
      const q = k * VEHICLE_STRIDE;
      if (prev.vehicles[q + 5] !== id) continue;
      x = prev.vehicles[q]! + (x - prev.vehicles[q]!) * alpha;
      z = prev.vehicles[q + 1]! + (z - prev.vehicles[q + 1]!) * alpha;
      h = lerpAngle(prev.vehicles[q + 2]!, h, alpha);
      break;
    }
  }
  return { x, z, h };
}

export class EmergencyLayer {
  readonly group = new THREE.Group();
  private fixed = new THREE.Group();
  private rigs = new Map<number, Rig>();
  private glows: Glow[] = [];
  private smokes: Smoke[] = [];
  private pulses: Pulse[] = [];
  private sirens: Pulse[] = [];
  private source: EmergencySource | null = null;
  private sig = '';
  private counts = { fires: 0, medical: 0, damaged: 0, preempted: 0 };
  private smokeTex: THREE.Texture | null = null;
  private readonly geo = {
    unit: box(1, 1, 1),
    ring: new THREE.RingGeometry(4.2, 5.4, 32).rotateX(-Math.PI / 2),
  };
  private index = new Map<number, number>();

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'emergency';
    this.group.add(this.fixed);
    this.group.visible = false;
  }

  setSource(source: EmergencySource | null): void {
    this.source = source;
    this.sig = '';
  }

  private smokeTexture(): THREE.Texture | null {
    if (this.smokeTex || typeof document === 'undefined') return this.smokeTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (!g) return null;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(70,70,70,0.9)');
    grad.addColorStop(1, 'rgba(70,70,70,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.smokeTex = new THREE.CanvasTexture(c);
    return this.smokeTex;
  }

  private clearFixed(): void {
    for (const ch of [...this.fixed.children]) {
      this.fixed.remove(ch);
      ch.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.dispose();
      });
    }
    this.glows = [];
    this.smokes = [];
    this.pulses = [];
    this.sirens = [];
  }

  private clearAll(): void {
    this.clearFixed();
    for (const r of this.rigs.values()) this.disposeRig(r);
    this.rigs.clear();
    this.counts = { fires: 0, medical: 0, damaged: 0, preempted: 0 };
    this.sig = '';
    this.group.visible = false;
  }

  private disposeRig(r: Rig): void {
    this.group.remove(r.group);
    r.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.dispose();
    });
  }

  private signature(sc: ScenarioView): string {
    return `${sc.incidents.map((i) => `${i.eventId}:${i.state}${i.progress >= 30 ? "+" : ""}`).join(',')}|${sc.damagedBuildings.join(',')}|${sc.preempted.map((p) => `${p.nodeId}:${p.phase < 0 ? '~' : p.color}`).join(',')}`;
  }

  private rebuild(sc: ScenarioView): void {
    this.clearFixed();
    const src = this.source;
    let fires = 0;
    let medical = 0;
    let preempted = 0;
    const add = (o: THREE.Object3D): void => void this.fixed.add(o);
    const tex = this.smokeTexture();
    if (src) {
      for (const i of sc.incidents) {
        const b = src.building(i.buildingId);
        if (!b) continue;
        if (i.kind === 'fire') {
          fires++;
          const suppressing = i.state === 'suppressing';
          const mat = new THREE.MeshBasicMaterial({ color: suppressing ? '#fb923c' : '#ff5a1f', transparent: true, opacity: 0.5, depthWrite: false });
          const m = new THREE.Mesh(this.geo.unit, mat);
          m.scale.set(b.w + 1.2, b.h + 1.2, b.d + 1.2);
          m.position.set(b.x, (b.h + 1.2) / 2, b.z);
          m.renderOrder = 8;
          add(m);
          this.glows.push({ mat, base: suppressing ? 0.28 : 0.5, seed: fires * 1.7 });
          for (let k = 0; k < (i.progress >= 30 && !suppressing ? 5 : 3); k++) {
            const sm = new THREE.SpriteMaterial({ map: tex ?? undefined, color: suppressing ? '#d1d5db' : '#4b5563', transparent: true, depthWrite: false });
            const sp = new THREE.Sprite(sm);
            sp.position.set(b.x + (k - 1) * b.w * 0.2, b.h, b.z + (k - 1) * b.d * 0.15);
            add(sp);
            this.smokes.push({ sprite: sp, top: b.h, progress: suppressing ? 25 : i.progress, phase: k / (i.progress >= 30 && !suppressing ? 5 : 3) });
          }
        } else {
          medical++;
          const cross = new THREE.Group();
          const mat = new THREE.MeshBasicMaterial({ color: '#ef4444' });
          const a = new THREE.Mesh(this.geo.unit, mat);
          a.scale.set(7, 1.8, 1.8);
          const c = new THREE.Mesh(this.geo.unit, mat);
          c.scale.set(1.8, 1.8, 7);
          cross.add(a, c);
          cross.position.set(b.x, b.h + 8, b.z);
          add(cross);
          this.pulses.push({ obj: cross, seed: medical });
        }
      }
      for (const id of sc.damagedBuildings) {
        const b = src.building(id);
        if (!b) continue;
        const mat = new THREE.MeshBasicMaterial({ color: '#1c1917', transparent: true, opacity: 0.62, depthWrite: false });
        const m = new THREE.Mesh(this.geo.unit, mat);
        m.scale.set(b.w + 0.6, b.h + 0.6, b.d + 0.6);
        m.position.set(b.x, (b.h + 0.6) / 2, b.z);
        m.renderOrder = 7;
        add(m);
      }
      for (const p of sc.preempted) {
        const pos = src.node(p.nodeId);
        if (!pos) continue;
        preempted++;
        // phase −1 = handing the junction back to its plan (edit-time clearing): amber "정리 중" ring.
        const color = p.phase < 0 ? '#f59e0b' : p.color === 'green' ? '#22c55e' : p.color === 'yellow' ? '#facc15' : '#ef4444';
        const ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }));
        ring.position.set(pos.x, 0.5, pos.z);
        ring.renderOrder = 9;
        add(ring);
        // Small siren: a red/blue beacon on a post.
        const siren = new THREE.Group();
        const post = new THREE.Mesh(this.geo.unit, new THREE.MeshBasicMaterial({ color: '#475569' }));
        post.scale.set(0.4, 5, 0.4);
        post.position.y = 2.5;
        const lamp = new THREE.Mesh(this.geo.unit, new THREE.MeshBasicMaterial({ color: '#ef4444' }));
        lamp.scale.set(1.8, 1.2, 1.8);
        lamp.position.y = 5.6;
        siren.add(post, lamp);
        siren.position.set(pos.x + 6.5, 0, pos.z + 6.5);
        add(siren);
        this.sirens.push({ obj: lamp, seed: preempted });
      }
    }
    this.counts = { fires, medical, damaged: sc.damagedBuildings.length, preempted };
  }

  private makeRig(kind: 'fire' | 'medical'): Rig {
    const g = new THREE.Group();
    const lightA = new THREE.MeshBasicMaterial({ color: '#ef4444' });
    const lightB = new THREE.MeshBasicMaterial({ color: '#3b82f6' });
    const part = (w: number, h: number, d: number, color: string, x: number, y: number, z: number): void => {
      const m = new THREE.Mesh(this.geo.unit, new THREE.MeshLambertMaterial({ color }));
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      g.add(m);
    };
    if (kind === 'fire') {
      part(9, 2.4, 2.7, '#c81e1e', 0, 1.9, 0); // body
      part(2.6, 1.6, 2.5, '#9b1c1c', 3.2, 3.9, 0); // cab roof
      part(6, 0.5, 0.9, '#cbd5e1', -1.2, 3.5, 0); // ladder
      part(6, 0.15, 0.15, '#94a3b8', -1.2, 3.9, 0.35);
      part(9.02, 0.35, 2.72, '#fbbf24', 0, 1.1, 0); // stripe
    } else {
      part(6.4, 2.6, 2.4, '#f8fafc', 0, 1.9, 0);
      part(2.2, 1.4, 2.3, '#e2e8f0', 2.2, 3.7, 0);
      part(6.42, 0.5, 2.42, '#dc2626', 0, 1.7, 0); // red stripe
      part(1.6, 0.35, 0.1, '#dc2626', -0.6, 2.9, 1.23); // side cross
      part(0.35, 1.6, 0.1, '#dc2626', -0.6, 2.9, 1.23);
    }
    const bar = (mat: THREE.Material, z: number): void => {
      const m = new THREE.Mesh(this.geo.unit, mat);
      m.scale.set(0.7, 0.45, 0.9);
      m.position.set(kind === 'fire' ? 3.2 : 2.2, kind === 'fire' ? 4.9 : 4.6, z);
      g.add(m);
    };
    bar(lightA, -0.7);
    bar(lightB, 0.7);
    this.group.add(g);
    return { group: g, lightA, lightB, kind };
  }

  private updateVehicles(now: number, snap: SimSnapshot, sc: ScenarioView): void {
    const prev = this.stream.previous();
    this.index.clear();
    for (let i = 0; i < snap.vehicleCount; i++) this.index.set(snap.vehicles[i * VEHICLE_STRIDE + 5]!, i);
    const live = new Set<number>();
    const flash = Math.floor(now / 170) % 2 === 0;
    for (const d of sc.dispatches) {
      if (d.vehicleId === null) continue;
      const i = this.index.get(d.vehicleId);
      if (i === undefined) continue;
      live.add(d.vehicleId);
      let rig = this.rigs.get(d.vehicleId);
      if (!rig || rig.kind !== d.kind) {
        if (rig) this.disposeRig(rig);
        rig = this.makeRig(d.kind);
        this.rigs.set(d.vehicleId, rig);
      }
      const pose = rigPose(snap, prev, d.vehicleId, now, this.stream.previousAt(), this.stream.latestAt())!;
      const { x, z, h } = pose;
      rig.group.position.set(x, 0.12, z);
      rig.group.rotation.y = -h;
      rig.lightA.color.set(flash ? '#ff2a2a' : '#4a0d0d');
      rig.lightB.color.set(flash ? '#0d1a4a' : '#3b82f6');
    }
    for (const [id, rig] of this.rigs) {
      if (live.has(id)) continue;
      this.disposeRig(rig);
      this.rigs.delete(id);
    }
  }

  update(now: number): void {
    const snap = this.stream.latest();
    const sc = snap?.scenario;
    if (!snap || !sc || !((sc.incidents?.length ?? 0) + (sc.damagedBuildings?.length ?? 0) + (sc.dispatches?.length ?? 0) + (sc.preempted?.length ?? 0))) {
      if (this.group.visible || this.sig || this.rigs.size) this.clearAll();
      return;
    }
    const sig = this.signature(sc);
    if (sig !== this.sig) {
      this.sig = sig;
      this.rebuild(sc);
    }
    this.group.visible = true;
    for (const g of this.glows) g.mat.opacity = Math.max(0.1, g.base + 0.22 * Math.sin(now / 90 + g.seed * 1.7) + 0.1 * Math.sin(now / 37 + g.seed));
    for (const s of this.smokes) {
      const t = (now / 1800 + s.phase) % 1;
      const scale = (4 + (s.progress / 100) * 9) * (0.6 + t) * (s.progress >= 30 ? 1.35 : 1);
      s.sprite.position.y = s.top + t * (8 + s.progress / 5);
      s.sprite.scale.set(scale, scale, 1);
      (s.sprite.material as THREE.SpriteMaterial).opacity = (1 - t) * Math.min(0.95, 0.35 + (s.progress / 100) * 0.55 + (s.progress >= 30 ? 0.2 : 0));
    }
    for (const p of this.pulses) p.obj.scale.setScalar(1 + 0.25 * Math.sin(now / 220 + p.seed));
    for (const p of this.sirens) (p.obj as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.color.set(Math.floor(now / 170) % 2 === 0 ? '#ef4444' : '#3b82f6');
    this.updateVehicles(now, snap, sc);
  }

  stats(): EmergencyStats {
    let fireTrucks = 0;
    let ambulances = 0;
    for (const r of this.rigs.values()) r.kind === 'fire' ? fireTrucks++ : ambulances++;
    return { drawn: this.group.visible, ...this.counts, fireTrucks, ambulances };
  }

  dispose(): void {
    this.clearAll();
    this.geo.unit.dispose();
    this.geo.ring.dispose();
    this.smokeTex?.dispose();
  }
}
