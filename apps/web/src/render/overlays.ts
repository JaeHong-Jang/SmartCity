// Overlays: local tool preview, collaborator ghosts, cursors and selections, pending pulses, rejected
// flashes, selection (with front arrow + rotation ring), parcels, bus lines, closures, signal phase
// arrows and the traffic flow overlay.

import * as THREE from 'three';
import {
  add,
  buildingFootprints,
  cumulativeLengths,
  normalize,
  pointAtLength,
  rightNormal,
  scale,
  slicePolyline,
  sub,
  type CityDoc,
  type Command,
  type Vec2,
} from '@smartcity/shared';
import { closedRing } from '../app/ring';
import type { ClientState, ClientStore } from '../app/store';
import type { SimulationStream } from '../sim/simStream';
import { buildingGizmo } from '../tools/highlight';
import type { ToolPreview } from '../tools/types';
import { commandDomains, D_ALL, D_BUILDINGS, D_BUS_LINES, D_BUS_STOPS, D_PARCELS, D_ROADS, touchesSelection } from './dirty';
import { GhostBuilding } from './ghostBuilding';
import { MeshBuilder } from './meshBuilder';
import { centroid, ParcelLayer } from './parcels';
import { ProposalLayer } from './proposal';
import type { RoadNetworkGeom } from './roadNetwork';
import { BusRouter, stopPosition } from './busRoute';

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

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
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
  line(b, closedRing(poly), w, color, y);
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

interface StopBadge {
  el: HTMLDivElement;
  x: number;
  z: number;
  shown: number;
}

/** Waiting-count badges are hidden beyond this camera distance. */
const BADGE_MAX_DISTANCE = 700;

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
  private ghost = new GhostBuilding();
  /** Numbers/colors of the last drawn preview, to skip identical rebuilds on pointer moves. */
  private previewNums: number[] = [];
  private previewCols: string[] = [];
  private previewDrawn = false;
  /** Layers whose inputs a command changed since the last refresh (everything starts dirty). */
  private stale = D_ALL;
  private selectionStale = true;
  private parcels: ParcelLayer;
  private proposal = new ProposalLayer();
  private peerTags: PeerTag[] = [];
  private stopBadges = new Map<string, StopBadge>();
  private labels = new Map<string, HTMLDivElement>();
  /** Drawing label of the tool preview (length · angle · snap), placed next to the cursor every frame. */
  private drawLabel: HTMLDivElement | null = null;
  private drawLabelPos: Vec2 | null = null;
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
    this.group.add(this.ghost.group);
    this.parcels = new ParcelLayer(labelRoot);
    this.group.add(this.parcels.group);
    this.group.add(this.proposal.group);
  }

  setPreview(p: ToolPreview): void {
    if (!this.previewDrawn || !this.samePreview(p)) {
      this.previewDrawn = true;
      this.storePreview(p);
      const b = new MeshBuilder();
      for (const l of p.lines) line(b, l.pts, l.width, l.color, Y_OVER + 0.02);
      for (const pt of p.points) disc(b, pt.pos, pt.radius, pt.color, Y_OVER + 0.04);
      this.preview.set(b);
    }

    this.setDrawLabel(p.label);

    // Translucent 3D ghost for building placement and moves (geometry cached per design revision).
    const pb = p.building;
    this.ghost.set(pb ? this.store.getState().doc.buildingTypes[pb.typeId] : undefined, pb);
  }

  private setDrawLabel(l: ToolPreview['label']): void {
    if (!l) {
      this.drawLabelPos = null;
      if (this.drawLabel) this.drawLabel.style.display = 'none';
      return;
    }
    let el = this.drawLabel;
    if (!el) {
      el = this.drawLabel = document.createElement('div');
      el.className = 'draw-label';
      el.dataset.drawLabel = '';
      // Inline style: one small element, positioned by update() like the peer labels.
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', margin: '18px 0 0 14px', padding: '2px 7px', borderRadius: '6px', font: '600 12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none', color: '#f8fafc' });
      this.labelRoot.appendChild(el);
    }
    if (el.textContent !== l.text) el.textContent = l.text;
    el.style.background = l.error ? 'rgba(185, 28, 28, 0.85)' : 'rgba(11, 16, 22, 0.72)';
    this.drawLabelPos = l.pos;
  }

  /** Whether the line/point geometry equals the last drawn preview (no allocation). */
  private samePreview(p: ToolPreview): boolean {
    const n = this.previewNums;
    const c = this.previewCols;
    let i = 0;
    let k = 0;
    if (n[i++] !== p.lines.length) return false;
    for (const l of p.lines) {
      if (n[i++] !== l.width || n[i++] !== l.pts.length || c[k++] !== l.color) return false;
      for (const v of l.pts) if (n[i++] !== v.x || n[i++] !== v.z) return false;
    }
    if (n[i++] !== p.points.length) return false;
    for (const pt of p.points) if (n[i++] !== pt.pos.x || n[i++] !== pt.pos.z || n[i++] !== pt.radius || c[k++] !== pt.color) return false;
    return i === n.length && k === c.length;
  }

  private storePreview(p: ToolPreview): void {
    const n: number[] = [p.lines.length];
    const c: string[] = [];
    for (const l of p.lines) {
      n.push(l.width, l.pts.length);
      c.push(l.color);
      for (const v of l.pts) n.push(v.x, v.z);
    }
    n.push(p.points.length);
    for (const pt of p.points) {
      n.push(pt.pos.x, pt.pos.z, pt.radius);
      c.push(pt.color);
    }
    this.previewNums = n;
    this.previewCols = c;
  }

  /** A command was applied: mark the layers it can change (called from the store's applied hook). */
  invalidate(cmd: Command): void {
    this.stale |= commandDomains(cmd);
    const sel = this.store.getState().selection;
    if (sel && touchesSelection(cmd, sel)) this.selectionStale = true;
  }

  /** The whole doc was replaced (resync). */
  invalidateAll(): void {
    this.stale = D_ALL;
    this.selectionStale = true;
  }

  /** Rebuild layers whose store inputs changed. */
  refresh(): void {
    const s = this.store.getState();
    const p = this.prev;
    const d = this.stale;
    this.stale = 0;
    const selStale = this.selectionStale;
    this.selectionStale = false;
    if (d & (D_ROADS | D_BUILDINGS | D_BUS_STOPS | D_PARCELS) || p.presence !== s.presence || p.peers !== s.peers) this.buildPeers(s);
    if (d & (D_PARCELS | D_BUILDINGS) || p.overlays?.violations !== s.overlays.violations) this.parcels.update(s.doc, s.overlays.violations);
    if (p.selection !== s.selection || p.hoverParcelId !== s.hoverParcelId || d & (D_PARCELS | D_BUILDINGS)) {
      this.parcels.setFocus([s.selection?.kind === 'parcel' ? s.selection.id : null, s.hoverParcelId]);
    }
    if (p.ai?.proposal !== s.ai.proposal || p.proposalStatus !== s.proposalStatus || (s.ai.proposal && p.docVersion !== s.docVersion)) this.proposal.set(s.doc, s.ai.proposal, s.proposalStatus?.invalid ?? {}, s.docVersion);
    if (p.pending !== s.pending) this.buildPending(s);
    if (p.flashes !== s.flashes) this.buildFlash(s);
    if (selStale || p.selection !== s.selection) this.buildSelection(s);
    if (d & (D_ROADS | D_BUS_STOPS | D_BUS_LINES)) this.buildTransit(s.doc);
    if (d & D_ROADS) this.buildClosures(s.doc);
    if (d & D_ROADS || p.phaseHighlight !== s.phaseHighlight) this.buildPhases(s);
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
    const router = new BusRouter(doc);
    for (const lineDef of Object.values(doc.busLines)) {
      const stops = lineDef.stopIds.map((id) => doc.busStops[id]).filter((x) => x !== undefined);
      for (let i = 0; i < stops.length; i++) {
        const a = stops[i]!;
        const c = stops[(i + 1) % stops.length]!;
        const route = router.routeBetween(a, c);
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
      let badge = this.stopBadges.get(st.id);
      if (!badge) {
        const el = document.createElement('div');
        el.className = 'stop-badge';
        el.dataset.stop = st.id;
        el.style.display = 'none';
        this.labelRoot.appendChild(el);
        this.stopBadges.set(st.id, (badge = { el, x: pos.x, z: pos.z, shown: -1 }));
      }
      badge.x = pos.x;
      badge.z = pos.z;
    }
    for (const [id, badge] of this.stopBadges) {
      if (doc.busStops[id] && stopPosition(doc, doc.busStops[id]!)) continue;
      badge.el.remove();
      this.stopBadges.delete(id);
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
    if (this.drawLabel && this.drawLabelPos) {
      _v.set(this.drawLabelPos.x, 0, this.drawLabelPos.z).project(camera);
      const visible = _v.z < 1 && _v.x > -1.05 && _v.x < 1.05 && _v.y > -1.05 && _v.y < 1.05;
      this.drawLabel.style.display = visible ? '' : 'none';
      if (visible) this.drawLabel.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px)`;
    }
    const waiting = s.transit?.waiting;
    for (const [id, badge] of this.stopBadges) {
      const n = waiting?.[id] ?? 0;
      _v.set(badge.x, 4, badge.z).project(camera);
      const visible = n > 0 && cameraDistance <= BADGE_MAX_DISTANCE && _v.z < 1 && _v.x > -1.05 && _v.x < 1.05 && _v.y > -1.05 && _v.y < 1.05;
      if (!visible) {
        if (badge.shown !== 0) {
          badge.shown = 0;
          badge.el.style.display = 'none';
        }
        continue;
      }
      if (badge.shown !== n) {
        badge.shown = n;
        badge.el.textContent = String(n);
        badge.el.title = `대기 ${n}명`;
        badge.el.style.display = '';
      }
      badge.el.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px)`;
    }
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

  dispose(): void {
    for (const l of [this.preview, this.peers, this.pending, this.flash, this.selection, this.transit, this.closures, this.phases, this.flow]) l.dispose();
    this.cursorMesh.geometry.dispose();
    (this.cursorMesh.material as THREE.Material).dispose();
    this.cursorMesh.dispose();
    this.ghost.dispose();
    this.drawLabel?.remove();
    this.parcels.dispose();
    this.proposal.dispose();
    for (const badge of this.stopBadges.values()) badge.el.remove();
    this.stopBadges.clear();
    for (const t of this.peerTags) t.el.remove();
    this.peerTags = [];
    for (const label of this.labels.values()) label.remove();
    this.labels.clear();
  }
}
