// Select tool: click selects (node / segment / building / bus stop / parcel) for the inspector.
// A press that travels 5 px becomes a drag: building = move (Alt = copy), junction = node.move,
// corner of the selected parcel = reshape, anything else = camera pan. Drags only preview locally
// and send one command on release. [ ] / Shift+wheel rotate the selected building (Alt = 1°),
// I = pipette, Delete/Backspace = bulldoze the selection, Esc cancels.

import {
  buildingFootprints,
  roadHalfWidth,
  sampleSegmentCurve,
  segmentsAtNode,
  sub,
  add,
  dist,
  MAX_GHOST_POINTS,
  type Building,
  type BuildingType,
  type Command,
  type Vec2,
} from '@smartcity/shared';
import { closedRing } from '../app/ring';
import { translateError, type Selection } from '../app/store';
import { removeCommandFor } from './bulldozeTool';
import { GHOST_ID, placementGuide, placementStatus, STATUS_COLORS, type Placement, type PlacementStatus } from './buildingTool';
import { DragGesture } from './gesture';
import { PlacementSolver } from './placement';
import { buildingGizmo, highlightPreview } from './highlight';
import { RemovalPreview, removalLines } from './removalPreview';
import { pickAt, type PickIndex, type PickResult } from './picking';
import { snapPoint } from './snap';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';
import { commandError } from './validate';

const DEG = Math.PI / 180;
const VERTEX_RADIUS = 3;
const WHEEL_COMMIT_MS = 350;

type DownHit = PickResult | { kind: 'vertex'; id: string; index: number };

type Drag =
  | { kind: 'pan' }
  | { kind: 'building'; id: string; type: BuildingType; copy: boolean; offset: Vec2; rotation: number; placement: Placement; status: PlacementStatus; solver: PlacementSolver }
  | { kind: 'node'; id: string; offset: Vec2; pos: Vec2; curves: Vec2[][]; error: string | null }
  | { kind: 'vertex'; id: string; index: number; polygon: Vec2[]; error: string | null };

/** Angle wrapped to (-π, π]. */
export const wrapAngle = (r: number): number => Math.atan2(Math.sin(r), Math.cos(r));

/** Concatenate outlines into one presence ghost polyline (≤ MAX_GHOST_POINTS points). */
export function ghostPolyline(polys: readonly Vec2[][]): Vec2[] {
  const pts: Vec2[] = [];
  for (const p of polys) pts.push(...p);
  return pts.slice(0, MAX_GHOST_POINTS);
}

export class SelectTool implements Tool {
  readonly id = 'select' as const;
  private hover: PickResult | null = null;
  private readonly removal = new RemovalPreview();
  private gesture = new DragGesture();
  private downHit: DownHit | null = null;
  private downPos: Vec2 = { x: 0, z: 0 };
  private downClient = { x: 0, y: 0 };
  private downAlt = false;
  private drag: Drag | null = null;
  /** Rotation of the selected building not yet sent (keys held / wheel burst). */
  private rot: { id: string; rotation: number; status: PlacementStatus } | null = null;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
  ) {}

  private get doc() {
    return this.ctx.store.getState().doc;
  }

  private get step() {
    return this.ctx.store.getState().toolOptions.snapStep;
  }

  private selectedBuilding(): { b: Building; type: BuildingType } | null {
    const sel = this.ctx.store.getState().selection;
    if (sel?.kind !== 'building') return null;
    const b = this.doc.buildings[sel.id];
    const type = b ? this.doc.buildingTypes[b.typeId] : undefined;
    return b && type ? { b, type } : null;
  }

  private pickDown(p: Vec2): DownHit | null {
    const sel = this.ctx.store.getState().selection;
    if (sel?.kind === 'parcel') {
      const v = this.index().nearestParcelVertex(p, VERTEX_RADIUS);
      if (v && v.id === sel.id) return { kind: 'vertex', id: v.id, index: v.index };
    }
    return pickAt(this.index(), p, { parcels: true });
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.commitRotation();
    this.gesture.down(e.client.x, e.client.y);
    this.downPos = e.pos;
    this.downClient = e.client;
    this.downAlt = e.alt;
    this.downHit = this.pickDown(e.pos);
  }

  onPointerMove(e: ToolPointer): void {
    if (this.gesture.phase === 'pressed' && this.gesture.move(e.client.x, e.client.y)) this.startDrag();
    if (this.gesture.phase === 'dragging' && this.drag) {
      this.updateDrag(e);
      return;
    }
    if (this.gesture.phase !== 'idle') return;
    const hit = pickAt(this.index(), e.pos, { parcels: true });
    if (hit?.id !== this.hover?.id || hit?.kind !== this.hover?.kind) {
      this.hover = hit;
      this.setHoverParcel(hit?.kind === 'parcel' ? hit.id : null);
      this.ctx.changed();
    }
    const hint = this.selectedBuilding()
      ? '드래그 이동 · Alt+드래그 복제 · [ ] / Shift+휠 회전 (Alt 1°) · I 스포이드 · Delete 철거 · Esc 해제'
      : '클릭 선택 · 건물/교차점 드래그 이동 · 빈 땅 드래그 화면 이동 · Delete 철거';
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  onPointerUp(e: ToolPointer): void {
    const phase = this.gesture.up();
    if (phase === 'pressed') {
      const hit = pickAt(this.index(), e.pos, { parcels: true });
      this.ctx.store.set({ selection: hit, panel: hit ? 'inspector' : this.ctx.store.getState().panel, phaseHighlight: null });
    } else if (phase === 'dragging') {
      this.finishDrag();
    }
    this.drag = null;
    this.downHit = null;
    this.ctx.changed();
  }

  private startDrag(): void {
    const hit = this.downHit;
    const doc = this.doc;
    // The object may have been removed by someone else since pointerdown.
    if (hit && !this.dragTargetExists(hit.kind, hit.id)) {
      this.gesture.cancel();
      return;
    }
    if (hit?.kind === 'building') {
      const b = doc.buildings[hit.id]!;
      const type = doc.buildingTypes[b.typeId];
      if (type) {
        const copy = this.downAlt;
        const placement: Placement = { pos: b.pos, rotation: b.rotation, segmentId: null };
        this.drag = { kind: 'building', id: b.id, type, copy, offset: sub(b.pos, this.downPos), rotation: b.rotation, placement, status: 'ok', solver: new PlacementSolver() };
        if (!copy) this.select({ kind: 'building', id: b.id });
        return;
      }
    }
    if (hit?.kind === 'node') {
      const n = doc.nodes[hit.id]!;
      this.drag = { kind: 'node', id: n.id, offset: sub(n.pos, this.downPos), pos: n.pos, curves: [], error: null };
      this.select({ kind: 'node', id: n.id });
      return;
    }
    if (hit?.kind === 'vertex') {
      const pc = doc.parcels[hit.id]!;
      this.drag = { kind: 'vertex', id: pc.id, index: hit.index, polygon: pc.polygon.slice(), error: null };
      return;
    }
    if (this.ctx.pan.start(this.downClient.x, this.downClient.y)) this.drag = { kind: 'pan' };
    else this.gesture.cancel();
  }

  private select(sel: Selection): void {
    const s = this.ctx.store.getState();
    if (s.selection?.kind !== sel.kind || s.selection.id !== sel.id) this.ctx.store.set({ selection: sel, panel: 'inspector', phaseHighlight: null });
  }

  private clampToMap(p: Vec2): Vec2 {
    const h = this.doc.meta.halfSize;
    return { x: Math.max(-h, Math.min(h, p.x)), z: Math.max(-h, Math.min(h, p.z)) };
  }

  private dragTargetExists(kind: string, id: string): boolean {
    const doc = this.doc;
    if (kind === 'building') return !!doc.buildings[id];
    if (kind === 'node') return !!doc.nodes[id];
    if (kind === 'vertex') return !!doc.parcels[id];
    return true;
  }

  private updateDrag(e: ToolPointer): void {
    const d = this.drag!;
    const doc = this.doc;
    if (d.kind !== 'pan' && !this.dragTargetExists(d.kind, d.id)) {
      // Removed remotely mid-drag: drop the gesture instead of sending a doomed command.
      this.drag = null;
      this.gesture.cancel();
      this.ctx.store.set({ toolHint: '다른 사용자가 이 객체를 지웠습니다' });
      this.ctx.changed();
      return;
    }
    switch (d.kind) {
      case 'pan':
        this.ctx.pan.move(e.client.x, e.client.y);
        return;
      case 'building': {
        d.placement = d.solver.solve(doc, this.index(), d.type, add(e.pos, d.offset), { rotation: d.rotation, step: this.step, free: e.shift, excludeId: d.copy ? undefined : d.id });
        d.status = placementStatus(doc, d.type, d.placement, d.copy ? GHOST_ID : d.id);
        const what = d.copy ? '복제' : '이동';
        const state = d.status === 'block' ? ' · 도로와 겹치거나 영역 밖 (놓을 수 없음)' : d.status === 'warn' ? ' · 필지 규제 위반 (경고)' : '';
        this.ctx.store.set({ toolHint: `건물 ${what}: ${d.placement.segmentId ? `도로에 맞춰 정렬됨${d.solver.selector.locked ? ' (잠금)' : ''}` : '자유 배치'}${state}   [Shift 자유 배치 · [ ] 회전 · L 도로 잠금 · Esc 취소]` });
        break;
      }
      case 'node': {
        d.pos = this.clampToMap(snapPoint(add(e.pos, d.offset), this.step));
        d.error = commandError(doc, { type: 'node.move', id: d.id, pos: d.pos });
        d.curves = segmentsAtNode(doc, d.id).map((s) => {
          const a = s.a === d.id ? d.pos : doc.nodes[s.a]!.pos;
          const b = s.b === d.id ? d.pos : doc.nodes[s.b]!.pos;
          return sampleSegmentCurve(a, b, s.control);
        });
        this.ctx.store.set({ toolHint: `교차점 이동${d.error ? ` · ${translateError(d.error)}` : ''}   [Esc 취소]` });
        break;
      }
      case 'vertex': {
        const pc = doc.parcels[d.id];
        if (!pc) return;
        d.polygon = pc.polygon.slice();
        d.polygon[d.index] = this.clampToMap(snapPoint(e.pos, this.step));
        d.error = commandError(doc, { type: 'parcel.upsert', parcel: { ...pc, polygon: d.polygon } });
        this.ctx.store.set({ toolHint: `필지 꼭짓점 이동${d.error ? ` · ${translateError(d.error)}` : ''}   [Esc 취소]` });
        break;
      }
    }
    this.ctx.changed();
  }

  private finishDrag(): void {
    this.removal.reset();
    const d = this.drag;
    const doc = this.doc;
    if (!d) return;
    switch (d.kind) {
      case 'pan':
        this.ctx.pan.end();
        return;
      case 'building': {
        const p = d.placement;
        if (d.status === 'block') {
          this.ctx.store.toast('도로와 겹치거나 영역 밖이라 놓을 수 없습니다', 'error');
          return;
        }
        if (!d.copy && p.pos.x === doc.buildings[d.id]?.pos.x && p.pos.z === doc.buildings[d.id]?.pos.z && p.rotation === doc.buildings[d.id]?.rotation) return;
        const ghost = buildingFootprints(p, d.type).map(closedRing);
        const cmd: Command = d.copy
          ? { type: 'building.place', building: { id: this.ctx.ids().next('b'), typeId: d.type.id, pos: p.pos, rotation: p.rotation } }
          : { type: 'building.move', id: d.id, pos: p.pos, rotation: p.rotation };
        this.ctx.dispatch(cmd, ghost);
        return;
      }
      case 'node':
        if (d.error) this.ctx.store.toast(`교차점을 옮길 수 없습니다: ${translateError(d.error)}`, 'error');
        else if (doc.nodes[d.id] && dist(doc.nodes[d.id]!.pos, d.pos) > 1e-9) this.ctx.dispatch({ type: 'node.move', id: d.id, pos: d.pos }, d.curves);
        return;
      case 'vertex': {
        const pc = doc.parcels[d.id];
        if (!pc) return;
        if (d.error) this.ctx.store.toast(`필지를 바꿀 수 없습니다: ${translateError(d.error)}`, 'error');
        else this.ctx.dispatch({ type: 'parcel.upsert', parcel: { ...pc, polygon: d.polygon } }, [closedRing(d.polygon)]);
        return;
      }
    }
  }

  private rotateBy(delta: number): boolean {
    if (this.drag?.kind === 'building') {
      this.drag.rotation = wrapAngle(this.drag.rotation + delta);
      this.drag.placement = { ...this.drag.placement, rotation: this.drag.placement.segmentId ? this.drag.placement.rotation : this.drag.rotation };
      this.drag.status = placementStatus(this.doc, this.drag.type, this.drag.placement, this.drag.copy ? GHOST_ID : this.drag.id);
      this.ctx.changed();
      return true;
    }
    const sel = this.selectedBuilding();
    if (!sel) return false;
    const base = this.rot?.id === sel.b.id ? this.rot.rotation : sel.b.rotation;
    const rotation = wrapAngle(base + delta);
    this.rot = { id: sel.b.id, rotation, status: placementStatus(this.doc, sel.type, { pos: sel.b.pos, rotation }, sel.b.id) };
    this.ctx.store.set({ toolHint: `회전 ${Math.round(rotation / DEG)}°${this.rot.status === 'block' ? ' · 도로와 겹칩니다' : ''}` });
    this.ctx.changed();
    return true;
  }

  /** Send the pending rotation as one building.move. */
  private commitRotation(): void {
    if (this.wheelTimer) {
      clearTimeout(this.wheelTimer);
      this.wheelTimer = null;
    }
    const r = this.rot;
    this.rot = null;
    if (!r) return;
    const b = this.doc.buildings[r.id];
    const type = b ? this.doc.buildingTypes[b.typeId] : undefined;
    if (!b || !type || Math.abs(wrapAngle(r.rotation - b.rotation)) < 1e-9) return this.ctx.changed();
    if (placementStatus(this.doc, type, { pos: b.pos, rotation: r.rotation }, b.id) === 'block') {
      this.ctx.store.toast('그 방향으로 돌리면 도로와 겹칩니다', 'error');
    } else {
      this.ctx.dispatch({ type: 'building.move', id: b.id, pos: b.pos, rotation: r.rotation }, buildingFootprints({ pos: b.pos, rotation: r.rotation }, type).map(closedRing));
    }
    this.ctx.changed();
  }

  onWheel(e: WheelEvent): boolean {
    if (!e.shiftKey || (!this.selectedBuilding() && this.drag?.kind !== 'building')) return false;
    // Shift turns the vertical wheel into a horizontal one on some platforms.
    const delta = e.deltaY || e.deltaX;
    if (!delta) return true;
    this.rotateBy(Math.sign(delta) * (e.altKey ? 1 : 15) * DEG);
    if (this.drag) return true;
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => this.commitRotation(), WHEEL_COMMIT_MS);
    return true;
  }

  private setHoverParcel(id: string | null): void {
    if (this.ctx.store.getState().hoverParcelId !== id) this.ctx.store.set({ hoverParcelId: id });
  }

  onLeave(): void {
    if (this.gesture.phase !== 'idle') return;
    this.hover = null;
    this.setHoverParcel(null);
    this.ctx.changed();
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      if (e.type === 'keyup') {
        if (!this.drag) this.commitRotation();
        return true;
      }
      return this.rotateBy((e.code === 'BracketLeft' ? -1 : 1) * (e.altKey ? 1 : 15) * DEG);
    }
    if (e.type !== 'keydown') return false;
    if (e.code === 'KeyL' && this.drag?.kind === 'building') {
      if (!e.repeat) {
        const locked = this.drag.solver.selector.toggleLock();
        this.ctx.store.toast(locked ? '도로 잠금: 이 도로에 계속 맞춥니다 (L로 해제)' : '도로 잠금 해제', 'info', 'road-lock');
      }
      return true;
    }
    if (e.key === 'Escape') {
      if (this.gesture.phase !== 'idle' || this.rot) {
        this.cancelDrag();
        this.rot = null;
        this.ctx.changed();
      } else {
        this.ctx.store.set({ selection: null, phaseHighlight: null });
      }
      return true;
    }
    const sel = this.ctx.store.getState().selection;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      const cmd = removeCommandFor(sel);
      if (!cmd) return false;
      const ghost = highlightPreview(this.doc, this.index(), sel, '#ef4444').lines.map((l) => l.pts);
      this.ctx.dispatch(cmd, ghost);
      return true;
    }
    if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey) {
      const s = this.selectedBuilding();
      if (!s) return false;
      this.ctx.store.setToolOptions({ buildingTypeId: s.type.id });
      this.ctx.store.set({ tool: 'building' });
      this.ctx.store.toast(`스포이드: '${s.type.name}' 건물로 배치합니다`, 'info');
      return true;
    }
    return false;
  }

  private cancelDrag(): void {
    if (this.drag?.kind === 'pan') this.ctx.pan.end();
    this.drag = null;
    this.gesture.cancel();
  }

  cancel(): void {
    this.removal.reset();
    this.cancelDrag();
    this.commitRotation();
    this.hover = null;
    this.setHoverParcel(null);
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    const d = this.drag;
    if (d?.kind === 'building') return ghostPolyline(buildingFootprints(d.placement, d.type).map(closedRing));
    if (d?.kind === 'node') return ghostPolyline(d.curves);
    if (d?.kind === 'vertex') return ghostPolyline([closedRing(d.polygon)]);
    const r = this.rot;
    const b = r ? this.doc.buildings[r.id] : undefined;
    const type = b ? this.doc.buildingTypes[b.typeId] : undefined;
    if (r && b && type) return ghostPolyline(buildingFootprints({ pos: b.pos, rotation: r.rotation }, type).map(closedRing));
    return [];
  }

  private buildingGhost(out: ToolPreview, type: BuildingType, p: Placement, status: PlacementStatus): void {
    const color = STATUS_COLORS[status];
    for (const pts of placementGuide(p, this.step)) out.lines.push({ pts, width: 0.12, color: '#e2e8f0' });
    for (const poly of buildingFootprints(p, type)) out.lines.push({ pts: closedRing(poly), width: 0.6, color });
    const g = buildingGizmo(p, type);
    out.lines.push({ pts: g.arrow, width: 0.8, color });
    out.building = { typeId: type.id, pos: p.pos, rotation: p.rotation, color };
  }

  preview(): ToolPreview {
    const out: ToolPreview = { lines: [], points: [] };
    const doc = this.doc;
    const d = this.drag;
    if (d?.kind === 'building') {
      this.buildingGhost(out, d.type, d.placement, d.status);
      return out;
    }
    if (d?.kind === 'node') {
      const color = d.error ? '#f87171' : '#60a5fa';
      for (const [i, s] of segmentsAtNode(doc, d.id).entries()) {
        const rt = doc.roadTypes[s.roadTypeId];
        const c = d.curves[i];
        if (c) out.lines.push({ pts: c, width: rt ? roadHalfWidth(rt) * 2 : 8, color });
      }
      out.points.push({ pos: d.pos, radius: 2.4, color });
      // Automatic parcels and buildings this move would remove.
      const cmd: Command | null = d.error ? null : { type: 'node.move', id: d.id, pos: d.pos };
      out.lines.push(...removalLines(doc, this.removal.get(doc, this.ctx.store.getState().docVersion, cmd, () => this.ctx.changed())));
      return out;
    }
    if (d?.kind === 'vertex') {
      const color = d.error ? '#f87171' : '#60a5fa';
      out.lines.push({ pts: closedRing(d.polygon), width: 0.7, color });
      out.points.push({ pos: d.polygon[d.index]!, radius: 1.4, color });
      return out;
    }
    const r = this.rot;
    const rb = r ? doc.buildings[r.id] : undefined;
    const rt = rb ? doc.buildingTypes[rb.typeId] : undefined;
    if (r && rb && rt) this.buildingGhost(out, rt, { pos: rb.pos, rotation: r.rotation, segmentId: null }, r.status);
    // Corner handles of the selected parcel.
    const sel = this.ctx.store.getState().selection;
    if (sel?.kind === 'parcel') for (const v of doc.parcels[sel.id]?.polygon ?? []) out.points.push({ pos: v, radius: 1.1, color: '#f8fafc' });
    if (this.hover && this.gesture.phase === 'idle') {
      const h = highlightPreview(doc, this.index(), this.hover, '#bae6fd');
      out.lines.push(...h.lines);
      out.points.push(...h.points);
    }
    return out;
  }
}
