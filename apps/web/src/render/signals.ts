// Signal heads: one instanced pole + one instanced lamp per incoming lane, lamp color from the snapshot.

import * as THREE from 'three';
import { SIGNAL_STRIDE } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';

const COLORS = [new THREE.Color('#ff3b30'), new THREE.Color('#ffcc00'), new THREE.Color('#34c759')];
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class SignalLayer {
  readonly group = new THREE.Group();
  private poles: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private capacity = 0;
  private readonly poleGeo = new THREE.CylinderGeometry(0.12, 0.12, 4.2, 6).translate(0, 2.1, 0);
  private readonly lampGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5).translate(0, 4.3, 0);
  private readonly poleMat = new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.6 });
  private readonly lampMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  private lastSnapshot: unknown = null;

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'signals';
    this.poles = this.make(this.poleGeo, this.poleMat, 64);
    this.lamps = this.make(this.lampGeo, this.lampMat, 64);
    this.capacity = 64;
  }

  private make(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.group.add(m);
    return m;
  }

  update(): void {
    const snap = this.stream.latest();
    if (!snap) {
      this.poles.count = 0;
      this.lamps.count = 0;
      return;
    }
    if (snap === this.lastSnapshot) return;
    this.lastSnapshot = snap;
    const n = snap.signalCount;
    if (n > this.capacity) {
      let cap = this.capacity;
      while (cap < n) cap *= 2;
      this.group.remove(this.poles, this.lamps);
      this.poles.dispose();
      this.lamps.dispose();
      this.poles = this.make(this.poleGeo, this.poleMat, cap);
      this.lamps = this.make(this.lampGeo, this.lampMat, cap);
      this.capacity = cap;
    }
    const a = snap.signals;
    for (let i = 0; i < n; i++) {
      const o = i * SIGNAL_STRIDE;
      _p.set(a[o]!, 0, a[o + 1]!);
      _q.setFromAxisAngle(_up, -a[o + 2]!);
      _m.compose(_p, _q, _s);
      this.poles.setMatrixAt(i, _m);
      this.lamps.setMatrixAt(i, _m);
      this.lamps.setColorAt(i, COLORS[a[o + 3]! | 0] ?? COLORS[0]!);
    }
    this.poles.count = n;
    this.lamps.count = n;
    this.poles.instanceMatrix.needsUpdate = true;
    this.lamps.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }
}
