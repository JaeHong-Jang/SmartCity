// Parcel overlay: translucent zone-colored fill, outline and a label (zone, area) per parcel, plus
// orange regulation-violation badges over buildings (and violating parcels) when the overlay is on.
// Rebuilt only when parcels, buildings or the toggle change; label elements are reused by key and
// repositioned every frame.

import * as THREE from 'three';
import { buildingMetrics, parcelCompliance, polygonArea, ZONE_LABELS, type CityDoc, type Vec2 } from '@smartcity/shared';
import { closedRing } from '../app/ring';
import { ZONE_COLORS } from '../app/zoneColors';
import { MeshBuilder } from './meshBuilder';

const Y_FILL = 0.2;
const _c = new THREE.Color();
const _v = new THREE.Vector3();

/** Labels are hidden beyond this camera distance (they would only clutter the overview). */
const LABEL_MAX_DISTANCE = 1400;

interface Label {
  el: HTMLDivElement;
  isParcel: boolean;
  html: string;
  x: number;
  y: number;
  z: number;
}

export function centroid(poly: readonly Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const f = p.x * q.z - q.x * p.z;
    a += f;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
  }
  if (Math.abs(a) < 1e-9) return poly[0] ?? { x: 0, z: 0 };
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

export const formatArea = (m2: number): string => `${Math.round(m2).toLocaleString('ko-KR')}㎡`;

export class ParcelLayer {
  readonly group = new THREE.Group();
  private fill: THREE.Mesh;
  private lines: THREE.Mesh;
  private labels = new Map<string, Label>();
  private seen = new Set<string>();
  /** Automatic lots get a label only when hovered, selected or in violation (ADR 0009 §4, hundreds of lots). */
  private autoInfo = new Map<string, { html: string; x: number; z: number; warn: boolean }>();
  private focus = new Set<string>();

  constructor(private readonly labelRoot: HTMLElement) {
    this.group.name = 'parcels';
    const fillMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.2, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.fill = new THREE.Mesh(new THREE.BufferGeometry(), fillMat);
    this.fill.renderOrder = 3;
    const lineMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
    this.lines = new THREE.Mesh(new THREE.BufferGeometry(), lineMat);
    this.lines.renderOrder = 4;
    for (const m of [this.fill, this.lines]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  /** Create or update the label element for `key`; unchanged text is not touched. */
  private label(key: string, cls: string, html: string, x: number, y: number, z: number, building?: string): void {
    this.seen.add(key);
    let l = this.labels.get(key);
    if (!l) {
      const el = document.createElement('div');
      el.className = cls;
      if (building) el.dataset.building = building;
      this.labelRoot.appendChild(el);
      this.labels.set(key, (l = { el, isParcel: cls === 'parcel-label', html: '', x, y, z }));
    }
    if (l.html !== html) {
      l.html = html;
      l.el.innerHTML = html;
    }
    l.x = x;
    l.y = y;
    l.z = z;
  }

  update(doc: CityDoc, violations: boolean): void {
    this.seen.clear();
    this.autoInfo.clear();
    const fill = new MeshBuilder();
    const lines = new MeshBuilder();
    const badges = new Map<string, number>();
    for (const id of Object.keys(doc.parcels).sort()) {
      const pc = doc.parcels[id]!;
      const poly = pc.polygon;
      _c.set(ZONE_COLORS[pc.zone]);
      fill.polygon(poly, Y_FILL, _c);
      const comp = violations ? parcelCompliance(doc, pc) : null;
      const parcelWide = comp ? comp.violations.filter((v) => !v.buildingId).length : 0;
      for (const v of comp?.violations ?? []) if (v.buildingId) badges.set(v.buildingId, (badges.get(v.buildingId) ?? 0) + 1);
      lines.band(closedRing(poly), -0.35, 0.35, Y_FILL + 0.02, parcelWide ? _c.set('#fb923c') : _c);
      const c = centroid(poly);
      const warn = parcelWide ? ` <b class="warn">규제 위반 ${parcelWide}</b>` : '';
      const html = `${ZONE_LABELS[pc.zone]} · ${formatArea(polygonArea(poly))}${warn}`;
      if (pc.auto) {
        this.autoInfo.set(id, { html, x: c.x, z: c.z, warn: parcelWide > 0 });
        if (parcelWide > 0 || this.focus.has(id)) this.label(`p:${id}`, 'parcel-label', html, c.x, 1, c.z);
      } else {
        this.label(`p:${id}`, 'parcel-label', html, c.x, 1, c.z);
      }
    }
    for (const [id, n] of badges) {
      const b = doc.buildings[id];
      const type = b ? doc.buildingTypes[b.typeId] : undefined;
      if (!b || !type) continue;
      this.label(`v:${id}`, 'violation-badge', `!<span>${n}</span>`, b.pos.x, buildingMetrics(type).height + 4, b.pos.z, id);
    }
    for (const [key, l] of this.labels) {
      if (this.seen.has(key)) continue;
      l.el.remove();
      this.labels.delete(key);
    }
    this.setGeometry(this.fill, fill);
    this.setGeometry(this.lines, lines);
  }

  /** The selected / hovered parcel ids: their automatic lots show a label. Cheap; no mesh rebuild. */
  setFocus(ids: readonly (string | null)[]): void {
    const next = new Set<string>();
    for (const id of ids) if (id) next.add(id);
    if (next.size === this.focus.size && [...next].every((id) => this.focus.has(id))) return;
    const touched = new Set([...this.focus, ...next]);
    this.focus = next;
    for (const id of touched) {
      const info = this.autoInfo.get(id);
      const key = `p:${id}`;
      if (info && (info.warn || next.has(id))) {
        this.seen.add(key);
        this.label(key, 'parcel-label', info.html, info.x, 1, info.z);
      } else {
        const l = this.labels.get(key);
        if (l) {
          l.el.remove();
          this.labels.delete(key);
        }
      }
    }
  }

  private setGeometry(mesh: THREE.Mesh, b: MeshBuilder): void {
    mesh.geometry.dispose();
    mesh.geometry = b.empty ? new THREE.BufferGeometry() : b.build();
    mesh.visible = !b.empty;
  }

  /** Per frame: place labels over their anchors (no allocation besides the transform strings). */
  frame(camera: THREE.Camera, cameraDistance: number, width: number, height: number): void {
    const far = cameraDistance > LABEL_MAX_DISTANCE;
    for (const l of this.labels.values()) {
      _v.set(l.x, l.y, l.z).project(camera);
      const visible = !(l.isParcel && far) && _v.z < 1 && _v.x > -1.05 && _v.x < 1.05 && _v.y > -1.05 && _v.y < 1.05;
      l.el.style.display = visible ? '' : 'none';
      if (visible) l.el.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px)`;
    }
  }

  dispose(): void {
    for (const l of this.labels.values()) l.el.remove();
    this.labels.clear();
    for (const m of [this.fill, this.lines]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
