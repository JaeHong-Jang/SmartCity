// Signal heads. Vehicle signals: one instanced pole + housing with three lamps per incoming lane, the
// lit lamp from the snapshot. Pedestrian signals: a two-lamp head (red / green) on each curb of a
// signalized crossing, state from snapshot.crossings.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CROSSING_STRIDE, crossingSignature, PedSignal, SIGNAL_STRIDE, type Crossing } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';

const LAMP_ON = [new THREE.Color('#ff3b30'), new THREE.Color('#ffcc00'), new THREE.Color('#34c759')];
const LAMP_OFF = [new THREE.Color('#3a1512'), new THREE.Color('#3a3010'), new THREE.Color('#10301a')];
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

function makeInstanced(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, colored = true): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, cap);
  m.count = 0;
  m.frustumCulled = false;
  if (colored) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  group.add(m);
  return m;
}

export class SignalLayer {
  readonly group = new THREE.Group();
  private poles: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh[];
  private capacity = 0;
  private readonly poleGeo = mergePole(new THREE.CylinderGeometry(0.12, 0.12, 4.2, 6).translate(0, 2.1, 0), new THREE.BoxGeometry(0.3, 1.5, 0.5).translate(0, 4.3, 0));
  private readonly lampGeos = [4.7, 4.3, 3.9].map((y) => new THREE.BoxGeometry(0.1, 0.32, 0.32).translate(-0.18, y, 0));
  private readonly poleMat = new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.6 });
  private readonly lampMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  private lastSnapshot: unknown = null;
  /** Pose (x, z, heading) and lit lamp written to each slot, so only changed slots are rewritten. */
  private pose = new Float32Array(64 * 3).fill(NaN);
  private litSlot = new Uint8Array(64).fill(255);

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'signals';
    this.poles = makeInstanced(this.group, this.poleGeo, this.poleMat, 64, false);
    this.lamps = this.lampGeos.map((g) => makeInstanced(this.group, g, this.lampMat, 64));
    this.capacity = 64;
  }

  update(): void {
    const snap = this.stream.latest();
    if (!snap) {
      this.poles.count = 0;
      for (const l of this.lamps) l.count = 0;
      return;
    }
    if (snap === this.lastSnapshot) return;
    this.lastSnapshot = snap;
    const n = snap.signalCount;
    if (n > this.capacity) {
      let cap = this.capacity;
      while (cap < n) cap *= 2;
      this.group.remove(this.poles, ...this.lamps);
      this.poles.dispose();
      for (const l of this.lamps) l.dispose();
      this.poles = makeInstanced(this.group, this.poleGeo, this.poleMat, cap, false);
      this.lamps = this.lampGeos.map((g) => makeInstanced(this.group, g, this.lampMat, cap));
      this.capacity = cap;
      // New meshes start empty: every slot must be written again.
      this.pose = new Float32Array(cap * 3).fill(NaN);
      this.litSlot = new Uint8Array(cap).fill(255);
    }
    const a = snap.signals;
    let moved = false;
    let recolored = false;
    for (let i = 0; i < n; i++) {
      const o = i * SIGNAL_STRIDE;
      const pose = this.pose;
      if (pose[i * 3] !== a[o] || pose[i * 3 + 1] !== a[o + 1] || pose[i * 3 + 2] !== a[o + 2]) {
        pose[i * 3] = a[o]!;
        pose[i * 3 + 1] = a[o + 1]!;
        pose[i * 3 + 2] = a[o + 2]!;
        _p.set(a[o]!, 0, a[o + 1]!);
        _q.setFromAxisAngle(_up, -a[o + 2]!);
        _m.compose(_p, _q, _s);
        this.poles.setMatrixAt(i, _m);
        for (const l of this.lamps) l.setMatrixAt(i, _m);
        moved = true;
      }
      const lit = Math.min(2, Math.max(0, a[o + 3]! | 0));
      if (this.litSlot[i] !== lit) {
        this.litSlot[i] = lit;
        for (let k = 0; k < 3; k++) this.lamps[k]!.setColorAt(i, k === lit ? LAMP_ON[k]! : LAMP_OFF[k]!);
        recolored = true;
      }
    }
    this.poles.count = n;
    if (moved) this.poles.instanceMatrix.needsUpdate = true;
    for (const l of this.lamps) {
      l.count = n;
      if (moved) l.instanceMatrix.needsUpdate = true;
      if (recolored && l.instanceColor) l.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.poles.dispose();
    for (const l of this.lamps) l.dispose();
    this.poleGeo.dispose();
    for (const g of this.lampGeos) g.dispose();
    this.poleMat.dispose();
    this.lampMat.dispose();
  }
}

function mergePole(pole: THREE.BufferGeometry, housing: THREE.BufferGeometry): THREE.BufferGeometry {
  const parts = [pole, housing].map((g) => {
    const flat = g.toNonIndexed();
    flat.deleteAttribute('uv');
    g.dispose();
    return flat;
  });
  const merged = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  return merged;
}

// ---------- pedestrian signals ----------

export interface PedHead {
  /** Index into the crossings array (and snapshot.crossings). */
  crossing: number;
  x: number;
  z: number;
  /** Unit vector the lamps face. */
  dx: number;
  dz: number;
}

const HEAD_BACK = 0.45;
const HEAD_SIDE = 0.5;

/** Two heads per signalized crossing, one on each curb, facing across the road, just outside the zebra. */
export function pedSignalHeads(crossings: readonly Crossing[]): PedHead[] {
  const out: PedHead[] = [];
  crossings.forEach((c, i) => {
    if (!c.signal) return;
    let ux = c.b.x - c.a.x;
    let uz = c.b.z - c.a.z;
    const l = Math.hypot(ux, uz);
    if (l < 1) return;
    ux /= l;
    uz /= l;
    const side = c.width / 2 + HEAD_SIDE;
    const vx = -uz * side;
    const vz = ux * side;
    out.push({ crossing: i, x: c.a.x - ux * HEAD_BACK + vx, z: c.a.z - uz * HEAD_BACK + vz, dx: ux, dz: uz });
    out.push({ crossing: i, x: c.b.x + ux * HEAD_BACK + vx, z: c.b.z + uz * HEAD_BACK + vz, dx: -ux, dz: -uz });
  });
  return out;
}

/** Lamp states of a pedestrian signal: which lamps are lit at `now` (ms). */
const LAMPS_WALK = { red: false, green: true };
const LAMPS_DARK_GREEN = { red: false, green: false };
const LAMPS_RED = { red: true, green: false };

/** The returned objects are shared constants: do not mutate them. */
export function pedLampState(signal: number, now: number): { readonly red: boolean; readonly green: boolean } | null {
  switch (signal) {
    case PedSignal.walk:
      return LAMPS_WALK;
    case PedSignal.clearance:
      return Math.floor(now / 300) % 2 === 0 ? LAMPS_WALK : LAMPS_DARK_GREEN;
    case PedSignal.red:
      return LAMPS_RED;
    default:
      return null;
  }
}

const PED_RED = new THREE.Color('#ff3b30');
const PED_GREEN = new THREE.Color('#3cff7a');
const PED_RED_OFF = new THREE.Color('#3a1512');
const PED_GREEN_OFF = new THREE.Color('#10301a');

export class PedSignalLayer {
  readonly group = new THREE.Group();
  private heads: PedHead[] = [];
  private capacity = 0;
  private poles!: THREE.InstancedMesh;
  private red!: THREE.InstancedMesh;
  private green!: THREE.InstancedMesh;
  private crossings: readonly Crossing[] | null = null;
  /** crossingSignature of `crossings`, compared with the snapshot's crossingSig. */
  private sig = 0;
  private readonly poleGeo = mergePole(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6).translate(0, 1.2, 0), new THREE.BoxGeometry(0.16, 0.62, 0.3).translate(0, 2.55, 0));
  private readonly redGeo = new THREE.BoxGeometry(0.06, 0.2, 0.2).translate(0.1, 2.7, 0);
  private readonly greenGeo = new THREE.BoxGeometry(0.06, 0.2, 0.2).translate(0.1, 2.42, 0);
  private readonly poleMat = new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.6 });
  private readonly lampMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  /** Head index and lamp bits (1 red, 2 green) written to each slot; -1 / 255 = nothing written yet. */
  private slotHead = new Int32Array(0);
  private slotLamps = new Uint8Array(0);
  private lastY = NaN;

  constructor(private readonly stream: SimulationStream) {
    this.group.name = 'ped-signals';
    this.allocate(32);
  }

  private allocate(cap: number): void {
    if (this.poles) {
      this.group.remove(this.poles, this.red, this.green);
      this.poles.dispose();
      this.red.dispose();
      this.green.dispose();
    }
    this.capacity = cap;
    this.poles = makeInstanced(this.group, this.poleGeo, this.poleMat, cap, false);
    this.red = makeInstanced(this.group, this.redGeo, this.lampMat, cap);
    this.green = makeInstanced(this.group, this.greenGeo, this.lampMat, cap);
    this.slotHead = new Int32Array(cap).fill(-1);
    this.slotLamps = new Uint8Array(cap).fill(255);
  }

  /** Recompute head positions when the road network (and so the crossing list) changed. */
  setCrossings(crossings: readonly Crossing[]): void {
    if (crossings === this.crossings) return;
    this.crossings = crossings;
    this.sig = crossingSignature(crossings.map((c) => c.id));
    this.heads = pedSignalHeads(crossings);
    // Head positions may differ for the same index: rewrite every slot.
    this.slotHead.fill(-1);
    this.slotLamps.fill(255);
    if (this.heads.length > this.capacity) {
      let cap = this.capacity;
      while (cap < this.heads.length) cap *= 2;
      this.allocate(cap);
    }
  }

  update(now: number, y: number): void {
    const snap = this.stream.latest();
    const data = snap?.crossings;
    // Indexes are only meaningful for the same crossing list; until the sim catches up with an edit,
    // signalized crossings show red.
    const known = !!data && (snap?.crossingCount ?? 0) > 0 && snap!.crossingSig === this.sig;
    if (y !== this.lastY) {
      this.lastY = y;
      this.slotHead.fill(-1);
    }
    let n = 0;
    let moved = false;
    let recolored = false;
    for (let hi = 0; hi < this.heads.length; hi++) {
      const h = this.heads[hi]!;
      // Without crossing data from the simulation a signalized crossing shows red.
      const code = known ? (data[h.crossing * CROSSING_STRIDE] ?? PedSignal.none) : PedSignal.red;
      const lamps = pedLampState(code, now);
      if (!lamps) continue;
      if (this.slotHead[n] !== hi) {
        this.slotHead[n] = hi;
        _p.set(h.x, y, h.z);
        _q.setFromAxisAngle(_up, -Math.atan2(h.dz, h.dx));
        _m.compose(_p, _q, _s);
        this.poles.setMatrixAt(n, _m);
        this.red.setMatrixAt(n, _m);
        this.green.setMatrixAt(n, _m);
        moved = true;
      }
      const bits = (lamps.red ? 1 : 0) | (lamps.green ? 2 : 0);
      if (this.slotLamps[n] !== bits) {
        this.slotLamps[n] = bits;
        this.red.setColorAt(n, lamps.red ? PED_RED : PED_RED_OFF);
        this.green.setColorAt(n, lamps.green ? PED_GREEN : PED_GREEN_OFF);
        recolored = true;
      }
      n++;
    }
    this.poles.count = this.red.count = this.green.count = n;
    if (moved) {
      this.poles.instanceMatrix.needsUpdate = true;
      this.red.instanceMatrix.needsUpdate = true;
      this.green.instanceMatrix.needsUpdate = true;
    }
    if (recolored) {
      this.red.instanceColor!.needsUpdate = true;
      this.green.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    this.poles.dispose();
    this.red.dispose();
    this.green.dispose();
    this.poleGeo.dispose();
    this.redGeo.dispose();
    this.greenGeo.dispose();
    this.poleMat.dispose();
    this.lampMat.dispose();
  }
}
