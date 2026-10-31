// AI 관제실 selection mark (ADR 0015 §6): the target of the decision picked in the control room — a building,
// junction, road or blackout center — as a slowly pulsing gold ring with a label. Reads the simulator-mode
// source only; nothing is drawn while no decision is selected.

import * as THREE from 'three';

export interface ControlMarkTarget {
  x: number;
  z: number;
  /** Ring radius (m): bigger for buildings and roads than for a junction. */
  radius: number;
  label: string;
}

export interface ControlMarkSource {
  selected(): ControlMarkTarget | null;
}

export interface ControlMarkStats {
  shown: boolean;
  x: number;
  z: number;
  label: string;
}

const GOLD = new THREE.Color('#fde047');

export class ControlMarkLayer {
  readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly inner: THREE.Mesh;
  private source: ControlMarkSource | null = null;
  private tag: HTMLDivElement | null = null;
  private stat: ControlMarkStats = { shown: false, x: 0, z: 0, label: '' };
  private readonly v = new THREE.Vector3();

  constructor(private readonly labelRoot: HTMLElement) {
    this.group.name = 'control-mark';
    const mat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2), mat);
    this.inner = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.6, 48).rotateX(-Math.PI / 2), mat);
    this.ring.renderOrder = 15;
    this.inner.renderOrder = 15;
    this.group.add(this.ring, this.inner);
    this.group.visible = false;
  }

  setSource(source: ControlMarkSource | null): void {
    this.source = source;
  }

  update(now: number, camera: THREE.Camera, width: number, height: number): void {
    const t = this.source?.selected() ?? null;
    if (!t) {
      if (this.group.visible || this.tag) this.hide();
      return;
    }
    const k = 1 + 0.12 * Math.sin(now / 260);
    this.ring.position.set(t.x, 0.7, t.z);
    this.ring.scale.setScalar(t.radius * k);
    this.inner.position.set(t.x, 0.7, t.z);
    this.inner.scale.setScalar(t.radius);
    this.group.visible = true;
    if (!this.tag) {
      const el = document.createElement('div');
      el.dataset.controlMark = '';
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', margin: '-40px 0 0 -60px', padding: '2px 8px', borderRadius: '6px', font: '700 12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none', background: 'rgba(113, 63, 18, 0.92)', color: '#fef9c3', border: '1px solid #fde047' });
      this.labelRoot.appendChild(el);
      this.tag = el;
    }
    if (this.tag.textContent !== t.label) this.tag.textContent = t.label;
    this.v.set(t.x, 8, t.z).project(camera);
    const visible = this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05;
    this.tag.style.display = visible ? '' : 'none';
    if (visible) this.tag.style.transform = `translate(${((this.v.x + 1) / 2) * width}px, ${((1 - this.v.y) / 2) * height}px)`;
    this.stat = { shown: true, x: t.x, z: t.z, label: t.label };
  }

  private hide(): void {
    this.group.visible = false;
    this.tag?.remove();
    this.tag = null;
    this.stat = { shown: false, x: 0, z: 0, label: '' };
  }

  stats(): ControlMarkStats {
    return { ...this.stat };
  }

  dispose(): void {
    this.hide();
    this.ring.geometry.dispose();
    this.inner.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
  }
}
