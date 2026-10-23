// Overlays: local tool preview, collaborator ghosts, cursors and selections, pending pulses, rejected
// flashes, selection (with front arrow + rotation ring), parcels, bus lines, closures, signal phase
// arrows and the traffic flow overlay.

import * as THREE from 'three';
import {
  add,
  buildingFootprints,
  cumulativeLengths,
  normalize,
  partOutline,
  pointAtLength,
  rightNormal,
  scale,
  slicePolyline,
  sub,
  type BuildingPart,
  type BuildingType,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';
import type { ClientState, ClientStore } from '../app/store';
import type { SimulationStream } from '../sim/simStream';
import { buildingGizmo } from '../tools/highlight';
import type { ToolPreview } from '../tools/types';
import { MeshBuilder } from './meshBuilder';
import { centroid, ParcelLayer } from './parcels';
import type { RoadNetworkGeom } from './roadNetwork';
import { routeBetween, stopPosition } from './busRoute';

const Y_OVER = 0.32;
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** A dynamic mesh rebuilt from bands/discs when its inputs change. */
class DynLayer {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.MeshBasicMaterial;

  constructor(parent: THREE.Object3D, name: string, opacity: number, renderOrder: number) {
    this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.name = name;
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  set(b: MeshBuilder): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = b.empty ? new THREE.BufferGeometry() : b.build();
    this.mesh.visible = !b.empty;
  }
}

function line(b: MeshBuilder, pts: readonly Vec2[], width: number, color: string, y = Y_OVER): void {
  b.band(pts, -width / 2, width / 2, y, _c.set(color));
}

function disc(b: MeshBuilder, p: Vec2, r: number, color: string, y = Y_OVER, seg = 20): void {
  _c.set(color);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    b.tri(p.x, y, p.z, p.x + Math.cos(a0) * r, y, p.z + Math.sin(a0) * r, p.x + Math.cos(a1) * r, y, p.z + Math.sin(a1) * r, _c);
  }
}

function ring(b: MeshBuilder, p: Vec2, r: number, w: number, color: string, y = Y_OVER, seg = 28): void {
  const pts: Vec2[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r });
  }
  line(b, pts, w, color, y);
}

function outline(b: MeshBuilder, poly: readonly Vec2[], w: number, color: string, y = Y_OVER): void {
  line(b, [...poly, poly[0]!], w, color, y);
}

function arrow(b: MeshBuilder, pts: readonly Vec2[], w: number, color: string, y = Y_OVER): void {
  if (pts.length < 2) return;
  const cum = cumulativeLengths(pts);
  const total = cum[cum.length - 1]!;
  const head = Math.min(4, total * 0.4);
  line(b, slicePolyline(pts, 0, total - head), w, color, y);
  const tip = pts[pts.length - 1]!;
  const base = pointAtLength(pts, cum, total - head);
  const n = rightNormal(normalize(sub(tip, base)));
  const l = add(base, scale(n, w * 1.6));
  const r = add(base, scale(n, -w * 1.6));
  b.tri(l.x, y, l.z, r.x, y, r.z, tip.x, y, tip.z, _c.set(color));
}

/** Height of a part's ghost box: walls plus a simple allowance for pitched roofs. */
const ghostHeight = (p: BuildingPart): number => p.floors * p.floorHeight + (p.roof === 'flat' ? 0 : Math.min(p.width, p.depth) * 0.35);

/** Translucent extruded outlines of a building type in its local frame (footprint parts included). */
function ghostGeometries(type: BuildingType): THREE.BufferGeometry[] {
  return type.parts.map((part) => {
    const shape = new THREE.Shape(partOutline(part).map((v) => new THREE.Vector2(v.x, -v.z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: ghostHeight(part), bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, part.baseHeight, 0);
    return g;
  });
}

interface PeerTag {
  el: HTMLDivElement;
  x: number;
  y: number;
  z: number;
}

export class OverlayLayer {
  readonly group = new THREE.Group();
  private preview: DynLayer;
  private peers: DynLayer;
  private pending: DynLayer;
  private flash: DynLayer;
  private selection: DynLayer;
  private transit: DynLayer;
  private closures: DynLayer;
  private phases: DynLayer;
  private flow: DynLayer;
  private cursorMesh: THREE.InstancedMesh;
  private ghostBuilding = new THREE.Group();
  private ghostWallMat = new THREE.MeshBasicMaterial({ color: '#4ade80', transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  private ghostKey = '';
  private parcels: ParcelLayer;
  private peerTags: PeerTag[] = [];
  private labels = new Map<string, HTMLDivElement>();
  private prev: Partial<ClientState> = {};
  private flowGraph: unknown = null;
  /** Per lane: [first vertex, vertex count] in the flow geometry. */
  private flowRanges: Int32Array = new Int32Array(0);
  private flowSnapshot: unknown = null;

  constructor(
    private readonly store: ClientStore,
    private readonly stream: SimulationStream,
    private readonly labelRoot: HTMLElement,
    private readonly network: () => RoadNetworkGeom,
  ) {
    this.group.name = 'overlays';
    this.flow = new DynLayer(this.group, 'flow', 0.85, 5);
    this.closures = new DynLayer(this.group, 'closures', 0.8, 6);
    this.transit = new DynLayer(this.group, 'transit', 0.7, 7);
    this.phases = new DynLayer(this.group, 'phases', 0.9, 8);
    this.selection = new DynLayer(this.group, 'selection', 0.9, 9);
    this.peers = new DynLayer(this.group, 'peer-ghosts', 0.5, 10);
    this.pending = new DynLayer(this.group, 'pending', 0.5, 11);
    this.flash = new DynLayer(this.group, 'flash', 0.8, 12);
    this.preview = new DynLayer(this.group, 'preview', 0.6, 13);
    const cone = new THREE.ConeGeometry(1.6, 4, 12).rotateX(Math.PI).translate(0, 4, 0);
    this.cursorMesh = new THREE.InstancedMesh(cone, new THREE.MeshBasicMaterial({ color: '#ffffff' }), 64);
    this.cursorMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(64 * 3), 3);
    this.cursorMesh.count = 0;
    this.cursorMesh.frustumCulled = false;
    this.group.add(this.cursorMesh);
    this.group.add(this.ghostBuilding);
    this.parcels = new ParcelLayer(labelRoot);
    this.group.add(this.parcels.group);
  }

  setPreview(p: ToolPreview): void {
    const b = new MeshBuilder();
    for (const l of p.lines) line(b, l.pts, l.width, l.color, Y_OVER + 0.02);
    for (const pt of p.points) disc(b, pt.pos, pt.radius, pt.color, Y_OVER + 0.04);
    this.preview.set(b);

    // Translucent 3D ghost for building placement and moves (geometry cached per design revision).
    const pb = p.building;
    const doc = this.store.getState().doc;
    const type = pb ? doc.buildingTypes[pb.typeId] : undefined;
    const key = type ? `${type.id}:${type.rev ?? 0}:${JSON.stringify(type.parts).length}` : '';
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      for (const c of [...this.ghostBuilding.children]) {
        (c as THREE.Mesh).geometry.dispose();
        this.ghostBuilding.remove(c);
      }
      if (type) {
        for (const g of ghostGeometries(type)) {
          const m = new THREE.Mesh(g, this.ghostWallMat);
          m.renderOrder = 14;
          this.ghostBuilding.add(m);
        }
      }
    }
    this.ghostBuilding.visible = !!(pb && type);
    if (pb && type) {
      this.ghostWallMat.color.set(pb.color);
      this.ghostBuilding.position.set(pb.pos.x, 0, pb.pos.z);
      this.ghostBuilding.rotation.y = pb.rotation;
    }
  }

  /** Rebuild layers whose store inputs changed. */
  refresh(): void {
    const s = this.store.getState();
    const p = this.prev;
    const docChanged = p.docVersion !== s.docVersion;
    if (docChanged || p.presence !== s.presence || p.peers !== s.peers) this.buildPeers(s);
    if (docChanged || p.overlays?.violations !== s.overlays.violations) this.parcels.update(s.doc, s.overlays.violations);
    if (p.pending !== s.pending) this.buildPending(s);
    if (p.flashes !== s.flashes) this.buildFlash(s);
    if (docChanged || p.selection !== s.selection) this.buildSelection(s);
    if (docChanged) {
      this.buildTransit(s.doc);
      this.buildClosures(s.doc);
    }
    if (docChanged || p.phaseHighlight !== s.phaseHighlight) this.buildPhases(s);
    this.prev = s;
  }

  private buildPeers(s: ClientState): void {
    const b = new MeshBuilder();
    for (const t of this.peerTags) t.el.remove();
    this.peerTags = [];
    for (const [id, pr] of Object.entries(s.presence)) {
      const peer = s.peers.find((p) => p.clientId === id);
      const color = peer?.color ?? '#ffffff';
      if (pr.ghost.length >= 2) line(b, pr.ghost, 3, color, Y_OVER + 0.01);
      // What the collaborator has selected: outline in their color plus a name badge.
      const anchor = pr.selection ? this.outlineEntity(b, s.doc, pr.selection, color) : null;
      if (anchor && peer) {
        const el = document.createElement('div');
        el.className = 'peer-sel-label';
        el.textContent = `${peer.name} 편집 중`;
        el.style.setProperty('--peer', color);
        this.labelRoot.appendChild(el);
        this.peerTags.push({ el, x: anchor.x, y: 3, z: anchor.z });
      }
    }
    this.peers.set(b);
  }

  /** Draw an outline around the entity with this id (any kind); returns where its badge goes. */
  private outlineEntity(b: MeshBuilder, doc: CityDoc, id: string, color: string): Vec2 | null {
    const bd = doc.buildings[id];
    const t = bd ? doc.buildingTypes[bd.typeId] : undefined;
    if (bd && t) {
      for (const poly of buildingFootprints(bd, t)) outline(b, poly, 1, color, Y_OVER + 0.01);
      return bd.pos;
    }
    const g = this.network().segments.get(id);
    if (g) {
      b.band(g.centerline, g.halfWidth - 0.35, g.halfWidth + 0.35, Y_OVER + 0.01, _c.set(color));
      b.band(g.centerline, -g.halfWidth - 0.35, -g.halfWidth + 0.35, Y_OVER + 0.01, _c);
      const cum = cumulativeLengths(g.centerline);
      return pointAtLength(g.centerline, cum, cum[cum.length - 1]! / 2);
    }
    const n = doc.nodes[id];
    if (n) {
      ring(b, n.pos, 10, 0.7, color, Y_OVER + 0.01);
      return n.pos;
    }
    const st = doc.busStops[id];
    const sp = st ? stopPosition(doc, st) : null;
    if (sp) {
      ring(b, sp, 5, 0.6, color, Y_OVER + 0.01);
      return sp;
    }
    const pc = doc.parcels[id];
    if (pc) {
      outline(b, pc.polygon, 1, color, Y_OVER + 0.01);
      return centroid(pc.polygon);
    }
    return null;
  }

  private buildPending(s: ClientState): void {
    const b = new MeshBuilder();
    for (const pe of s.pending) for (const g of pe.ghost) if (g.length >= 2) line(b, g, 4, '#e0f2fe');
    this.pending.set(b);
  }

  private buildFlash(s: ClientState): void {
    const b = new MeshBuilder();
    for (const f of s.flashes) for (const g of f.ghost) if (g.length >= 2) line(b, g, 5, '#ef4444', Y_OVER + 0.03);
    this.flash.set(b);
  }

  private buildSelection(s: ClientState): void {
    const b = new MeshBuilder();
    const sel = s.selection;
    const doc = s.doc;
    const net = this.network();
    if (sel?.kind === 'segment') {
      const g = net.segments.get(sel.id);
      if (g) {
        line(b, g.centerline, 0.5, '#38bdf8');
        b.band(g.centerline, g.halfWidth - 0.25, g.halfWidth + 0.25, Y_OVER, _c.set('#38bdf8'));
        b.band(g.centerline, -g.halfWidth - 0.25, -g.halfWidth + 0.25, Y_OVER, _c.set('#38bdf8'));
      }
    } else if (sel?.kind === 'node') {
      const n = doc.nodes[sel.id];
      if (n) ring(b, n.pos, 9, 0.6, '#38bdf8');
    } else if (sel?.kind === 'building') {
      const bd = doc.buildings[sel.id];
      const t = bd ? doc.buildingTypes[bd.typeId] : undefined;
      if (bd && t) {
        for (const poly of buildingFootprints(bd, t)) outline(b, poly, 0.8, '#38bdf8');
        const g = buildingGizmo(bd, t);
        line(b, g.ring, 0.45, '#7dd3fc');
        arrow(b, g.arrow, 0.9, '#38bdf8');
      }
    } else if (sel?.kind === 'parcel') {
      const pc = doc.parcels[sel.id];
      if (pc) outline(b, pc.polygon, 0.9, '#38bdf8', Y_OVER + 0.01);
    } else if (sel?.kind === 'busStop') {
      const st = doc.busStops[sel.id];
      const p = st ? stopPosition(doc, st) : null;
      if (p) ring(b, p, 4, 0.5, '#38bdf8');
    }
    this.selection.set(b);
  }

  private buildTransit(doc: CityDoc): void {
    const b = new MeshBuilder();
    for (const lineDef of Object.values(doc.busLines)) {
      const stops = lineDef.stopIds.map((id) => doc.busStops[id]).filter((x) => x !== undefined);
      for (let i = 0; i < stops.length; i++) {
        const a = stops[i]!;
        const c = stops[(i + 1) % stops.length]!;
        const route = routeBetween(doc, a, c);
        if (route.length >= 2) line(b, route, 0.9, lineDef.color, Y_OVER - 0.02);
      }
    }
    for (const st of Object.values(doc.busStops)) {
      const p = stopPosition(doc, st);
      if (!p) continue;
      const seg = doc.segments[st.segmentId]!;
      const rt = doc.roadTypes[seg.roadTypeId]!;
      // Draw the stop on the curb side of its travel direction.
      const net = this.network().segments.get(st.segmentId);
      const pts = net?.centerline;
      let pos = p;
      if (pts && pts.length >= 2) {
        const cum = cumulativeLengths(pts);
        const sAt = st.t * cum[cum.length - 1]!;
        const ahead = pointAtLength(pts, cum, Math.min(cum[cum.length - 1]!, sAt + 0.5));
        const behind = pointAtLength(pts, cum, Math.max(0, sAt - 0.5));
        const n = rightNormal(normalize(sub(ahead, behind)));
        const off = (rt.lanesBackward === 0 ? 0.5 : 1) * (rt.lanesForward + rt.lanesBackward) * rt.laneWidth * 0.5 + 1.2;
        pos = add(p, scale(n, st.dir === 'forward' ? off : -off));
      }
      disc(b, pos, 1.8, '#ffffff', Y_OVER);
      disc(b, pos, 1.3, '#1d4ed8', Y_OVER + 0.01);
    }
    this.transit.set(b);
  }

  private buildClosures(doc: CityDoc): void {
    const b = new MeshBuilder();
    const net = this.network();
    for (const id of Object.keys(doc.closures)) {
      const g = net.segments.get(id);
      if (!g) continue;
      const pts = slicePolyline(g.centerline, g.setbackA, g.length - g.setbackB);
      b.band(pts, -g.halfWidth * 0.75, g.halfWidth * 0.75, Y_OVER - 0.05, _c.set('#7f1d1d'));
      b.dashed(pts, 0, g.halfWidth * 1.2, 2, 2, Y_OVER - 0.03, _c.set('#f97316'));
    }
    this.closures.set(b);
  }

  private buildPhases(s: ClientState): void {
    const b = new MeshBuilder();
    const h = s.phaseHighlight;
    const net = this.network();
    const node = h ? s.doc.nodes[h.nodeId] : undefined;
    if (h && node) {
      for (const segId of h.approaches) {
        const g = net.segments.get(segId);
        if (!g) continue;
        // Arrow on the incoming half of the road, ending at the junction edge.
        const atA = g.a === h.nodeId;
        const end = atA ? g.setbackA : g.length - g.setbackB;
        const start = atA ? Math.min(g.length, end + 18) : Math.max(0, end - 18);
        let pts = slicePolyline(g.centerline, Math.min(start, end), Math.max(start, end));
        if (atA) pts = pts.reverse();
        const off = g.roadType.lanesBackward === 0 ? 0 : (atA ? -1 : 1) * g.roadType.laneWidth * 0.8;
        const shifted = pts.map((p, i) => {
          const q = pts[Math.min(pts.length - 1, i + 1)]!;
          const r = pts[Math.max(0, i - 1)]!;
          return add(p, scale(rightNormal(normalize(sub(q, r))), atA ? -off : off));
        });
        arrow(b, shifted, 1.2, '#22c55e', Y_OVER + 0.05);
      }
      ring(b, node.pos, 6, 0.4, '#22c55e');
    }
    this.phases.set(b);
  }

  private buildFlowGeometry(net: RoadNetworkGeom): void {
    const b = new MeshBuilder();
    const g = net.graph;
    if (!g) {
      this.flowRanges = new Int32Array(0);
      this.flow.set(b);
      return;
    }
    this.flowRanges = new Int32Array(g.lanes.length * 2);
    _c.set('#64748b');
    for (const lane of g.lanes) {
      const start = b.pos.length / 3;
      b.band(lane.points, -1.3, 1.3, Y_OVER - 0.08, _c);
      this.flowRanges[lane.index * 2] = start;
      this.flowRanges[lane.index * 2 + 1] = b.pos.length / 3 - start;
    }
    this.flow.set(b);
  }

  private updateFlowColors(): void {
    const snap = this.stream.latest();
    if (!snap || snap === this.flowSnapshot) return;
    this.flowSnapshot = snap;
    const attr = this.flow.mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const lanes = this.flowRanges.length / 2;
    if (snap.laneFlow.length !== lanes) return;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < lanes; i++) {
      const f = snap.laneFlow[i]!;
      if (f < 0) _c.setRGB(0.32, 0.36, 0.42);
      else if (f < 0.5) _c.setRGB(0.95, 0.15 + f * 1.4, 0.12);
      else _c.setRGB(0.95 - (f - 0.5) * 1.6, 0.85, 0.2);
      const start = this.flowRanges[i * 2]!;
      const n = this.flowRanges[i * 2 + 1]!;
      for (let k = start; k < start + n; k++) {
        arr[k * 3] = _c.r;
        arr[k * 3 + 1] = _c.g;
        arr[k * 3 + 2] = _c.b;
      }
    }
    attr.needsUpdate = true;
  }

  /** Per-frame work: pulse, flow colors, cursor markers and name labels. No allocation in steady state. */
  update(now: number, camera: THREE.Camera, cameraDistance: number, width: number, height: number): void {
    const s = this.store.getState();
    this.pending.mat.opacity = 0.3 + 0.25 * (0.5 + 0.5 * Math.sin(now / 160));
    const flash = s.flashes[0];
    this.flash.mat.opacity = flash ? Math.max(0, Math.min(0.85, (flash.until - now) / 500)) : 0;

    const net = this.network();
    if (s.overlays.flow) {
      if (this.flowGraph !== net.graph) {
        this.flowGraph = net.graph;
        this.flowSnapshot = null;
        this.buildFlowGeometry(net);
      }
      this.updateFlowColors();
      this.flow.mesh.visible = this.flowRanges.length > 0;
    } else {
      this.flow.mesh.visible = false;
    }

    // Peer cursors.
    let n = 0;
    for (const peer of s.peers) {
      if (peer.clientId === s.clientId) continue;
      const pr = s.presence[peer.clientId];
      let label = this.labels.get(peer.clientId);
      if (!pr?.cursor) {
        if (label) label.style.display = 'none';
        continue;
      }
      if (n < 64) {
        _m.makeTranslation(pr.cursor.x, 0, pr.cursor.z);
        this.cursorMesh.setMatrixAt(n, _m);
        this.cursorMesh.setColorAt(n, _c.set(peer.color));
        n++;
      }
      if (!label) {
        label = document.createElement('div');
        label.className = 'peer-label';
        this.labelRoot.appendChild(label);
        this.labels.set(peer.clientId, label);
      }
      if (label.textContent !== peer.name) label.textContent = peer.name;
      label.style.setProperty('--peer', peer.color);
      _v.set(pr.cursor.x, 5, pr.cursor.z).project(camera);
      const visible = _v.z < 1 && _v.x > -1.1 && _v.x < 1.1 && _v.y > -1.1 && _v.y < 1.1;
      label.style.display = visible ? '' : 'none';
      if (visible) label.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px)`;
    }
    this.parcels.frame(camera, cameraDistance, width, height);
    for (const t of this.peerTags) {
      _v.set(t.x, t.y, t.z).project(camera);
      const visible = _v.z < 1 && _v.x > -1.05 && _v.x < 1.05 && _v.y > -1.05 && _v.y < 1.05;
      t.el.style.display = visible ? '' : 'none';
      if (visible) t.el.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px)`;
    }
    this.cursorMesh.count = n;
    if (n > 0) {
      this.cursorMesh.instanceMatrix.needsUpdate = true;
      if (this.cursorMesh.instanceColor) this.cursorMesh.instanceColor.needsUpdate = true;
    }
    for (const [id, label] of this.labels) {
      if (!s.peers.some((p) => p.clientId === id)) {
        label.remove();
        this.labels.delete(id);
      }
    }
  }
}
