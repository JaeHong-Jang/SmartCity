// Parcel overlay: translucent zone-colored fill, outline and a label (zone, area) per parcel, plus
// orange regulation-violation badges over buildings (and violating parcels) when the overlay is on.
// Rebuilt only when the doc or the toggle changes; labels are repositioned every frame.

import * as THREE from 'three';
import { buildingMetrics, parcelCompliance, polygonArea, ZONE_LABELS, type CityDoc, type Vec2 } from '@smartcity/shared';
import { ZONE_COLORS } from '../tools/parcelTool';
import { MeshBuilder } from './meshBuilder';

const Y_FILL = 0.2;
const _c = new THREE.Color();
const _v = new THREE.Vector3();

/** Labels are hidden beyond this camera distance (they would only clutter the overview). */
const LABEL_MAX_DISTANCE = 1400;

interface Label {
  el: HTMLDivElement;
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
  private labels: Label[] = [];

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

  private label(cls: string, html: string, x: number, y: number, z: number): void {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    this.labelRoot.appendChild(el);
    this.labels.push({ el, x, y, z });
  }

  update(doc: CityDoc, violations: boolean): void {
    for (const l of this.labels) l.el.remove();
    this.labels = [];
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
      lines.band([...poly, poly[0]!], -0.35, 0.35, Y_FILL + 0.02, parcelWide ? _c.set('#fb923c') : _c);
      const c = centroid(poly);
      const warn = parcelWide ? ` <b class="warn">규제 위반 ${parcelWide}</b>` : '';
      this.label('parcel-label', `${ZONE_LABELS[pc.zone]} · ${formatArea(polygonArea(poly))}${warn}`, c.x, 1, c.z);
    }
    for (const [id, n] of badges) {
      const b = doc.buildings[id];
      const type = b ? doc.buildingTypes[b.typeId] : undefined;
      if (!b || !type) continue;
      const el = `!<span>${n}</span>`;
      this.label('violation-badge', el, b.pos.x, buildingMetrics(type).height + 4, b.pos.z);
      this.labels[this.labels.length - 1]!.el.dataset.building = id;
    }
    this.setGeometry(this.fill, fill);
    this.setGeometry(this.lines, lines);
  }

  private setGeometry(mesh: THREE.Mesh, b: MeshBuilder): void {
    mesh.geometry.dispose();
    mesh.geometry = b.empty ? new THREE.BufferGeometry() : b.build();
    mesh.visible = !b.empty;
  }

  /** Per frame: place labels over their anchors (no allocation besides the transform strings). */
  frame(camera: THREE.Camera, cameraDistance: number, width: number, height: number): void {
    const far = cameraDistance > LABEL_MAX_DISTANCE;
    for (const l of this.labels) {
      const isParcel = l.el.className === 'parcel-label';
      _v.set(l.x, l.y, l.z).project(camera);
      const visible = !(isParcel && far) && _v.z < 1 && _v.x > -1.05 && _v.x < 1.05 && _v.y > -1.05 && _v.y < 1.05;
      l.el.style.display = visible ? '' : 'none';
      if (visible) l.el.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px)`;
    }
  }
}
