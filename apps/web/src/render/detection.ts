// Simulator-mode detection marks (ADR 0013 §5): the moment the city learns of an accident or fire — an
// expanding pulse at the event with a "CCTV 감지" / "신고 접수" label for a few seconds — and events it does
// not know of yet (`ScenarioView.undetected`) as a faint grey warning ring with a dim "미인지" label.
// Reads the snapshot and the simulator-mode source; nothing is drawn outside simulator mode.

import * as THREE from 'three';
import type { Vec2 } from '@smartcity/shared';
import type { SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';

export interface DetectionMark {
  eventId: string;
  label: string;
  bySensor: boolean;
  pos: Vec2;
  /** performance.now() of the detection. */
  at: number;
}

export interface DetectionSource {
  /** Recent detection moments (shown for `flashMs` after `at`). */
  flashes(): readonly DetectionMark[];
  flashMs: number;
  /** Map position of an event (accidents: the obstacle from the snapshot is preferred). */
  position(eventId: string): Vec2 | null;
}

export interface DetectionStats {
  pulses: number;
  undetected: number;
  labels: string[];
}

const MAX = 32;
const PULSE_MS = 1600;
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const SENSOR_COLOR = new THREE.Color('#22d3ee');
const REPORT_COLOR = new THREE.Color('#fb923c');
const WAIT_COLOR = new THREE.Color('#a8a29e');

interface Tag {
  el: HTMLDivElement;
  x: number;
  z: number;
  used: boolean;
}
const _pos = { x: 0, z: 0 };

export class DetectionLayer {
  readonly group = new THREE.Group();
  private rings: THREE.InstancedMesh;
  private source: DetectionSource | null = null;
  /** Labels by eventId: detection moments, and events not known yet. */
  private flashTags = new Map<string, Tag>();
  private waitTags = new Map<string, Tag>();
  private pulses = 0;
  private waiting = 0;

  constructor(
    private readonly stream: SimulationStream,
    private readonly labelRoot: HTMLElement,
  ) {
    this.group.name = 'detection';
    const ring = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }), MAX);
    this.rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 14;
    this.group.add(this.rings);
  }

  setSource(source: DetectionSource | null): void {
    this.source = source;
  }

  private tag(tags: Map<string, Tag>, eventId: string, text: string, style: 'sensor' | 'report' | 'wait', x: number, z: number): void {
    let t = tags.get(eventId);
    if (!t) {
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', margin: '-34px 0 0 -40px', padding: '2px 8px', borderRadius: '6px', font: '700 12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none' });
      this.labelRoot.appendChild(el);
      tags.set(eventId, (t = { el, x, z, used: true }));
    }
    t.x = x;
    t.z = z;
    t.used = true;
    if (t.el.textContent !== text) t.el.textContent = text;
    if (t.el.dataset.detectLabel !== style) {
      t.el.dataset.detectLabel = style;
      t.el.style.background = style === 'sensor' ? 'rgba(8, 145, 178, 0.92)' : style === 'report' ? 'rgba(194, 65, 12, 0.92)' : 'rgba(41, 37, 36, 0.55)';
      t.el.style.color = style === 'wait' ? 'rgba(250, 250, 249, 0.75)' : '#f8fafc';
    }
  }

  /** The accident obstacle of `eventId` from the snapshot (module-scope result), or null. */
  private obstacle(sc: NonNullable<SimSnapshot['scenario']>, eventId: string): Vec2 | null {
    for (const o of sc.obstacles) {
      if (o.eventId !== eventId) continue;
      _pos.x = o.x;
      _pos.z = o.z;
      return _pos;
    }
    return null;
  }

  private ring(i: number, x: number, z: number, y: number, r: number, color: THREE.Color): void {
    _p.set(x, y, z);
    _s.set(r, 1, r);
    this.rings.setMatrixAt(i, _m.compose(_p, _q, _s));
    this.rings.setColorAt(i, color);
  }

  /** Place and hide labels; drop the ones not used this frame. */
  private placeTags(tags: Map<string, Tag>, camera: THREE.Camera, width: number, height: number): void {
    for (const [key, t] of tags) {
      if (!t.used) {
        t.el.remove();
        tags.delete(key);
        continue;
      }
      t.used = false;
      _v.set(t.x, 6, t.z).project(camera);
      const visible = _v.z < 1 && _v.x > -1.05 && _v.x < 1.05 && _v.y > -1.05 && _v.y < 1.05;
      t.el.style.display = visible ? '' : 'none';
      if (visible) t.el.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px)`;
    }
  }

  update(now: number, camera: THREE.Camera, width: number, height: number): void {
    const sc = this.stream.latest()?.scenario;
    if (!sc && this.rings.count === 0 && this.flashTags.size === 0 && this.waitTags.size === 0) return;
    let n = 0;
    this.pulses = 0;
    this.waiting = 0;
    const src = this.source;
    if (sc && src) {
      for (const f of src.flashes()) {
        const age = now - f.at;
        if (n >= MAX || age < 0 || age >= src.flashMs) continue;
        const pos = this.obstacle(sc, f.eventId) ?? f.pos;
        // Two pulses during the first seconds, then the label alone.
        if (age < PULSE_MS * 2) {
          const k = (age % PULSE_MS) / PULSE_MS;
          this.ring(n++, pos.x, pos.z, 0.6, 6 + k * 26, _c.copy(f.bySensor ? SENSOR_COLOR : REPORT_COLOR).multiplyScalar(1 - k * 0.6));
          this.pulses++;
        }
        this.tag(this.flashTags, f.eventId, f.label, f.bySensor ? 'sensor' : 'report', pos.x, pos.z);
      }
      for (const u of sc.undetected) {
        if (n >= MAX) break;
        const pos = this.obstacle(sc, u.eventId) ?? src.position(u.eventId);
        if (!pos) continue;
        this.ring(n++, pos.x, pos.z, 0.5, 12 + Math.sin(now / 500) * 1.2, _c.copy(WAIT_COLOR));
        this.waiting++;
        this.tag(this.waitTags, u.eventId, '미인지', 'wait', pos.x, pos.z);
      }
    }
    this.rings.count = n;
    if (n > 0) {
      this.rings.instanceMatrix.needsUpdate = true;
      if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    }
    this.placeTags(this.flashTags, camera, width, height);
    this.placeTags(this.waitTags, camera, width, height);
    this.group.visible = n > 0;
  }

  stats(): DetectionStats {
    const labels = [...this.flashTags.values(), ...this.waitTags.values()].map((t) => t.el.textContent ?? '');
    return { pulses: this.pulses, undetected: this.waiting, labels };
  }

  dispose(): void {
    for (const t of [...this.flashTags.values(), ...this.waitTags.values()]) t.el.remove();
    this.flashTags.clear();
    this.waitTags.clear();
    this.rings.geometry.dispose();
    (this.rings.material as THREE.Material).dispose();
    this.rings.dispose();
  }
}
