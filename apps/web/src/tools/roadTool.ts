// Road tool: straight or curved (C: start → control → end), continuous drawing, live planRoad
// preview (length, bearing, junctions), free points use the shared snap step (G), right click / Esc cancels.
// Automatic fillet (F, ADR 0012 §1): while drawing, each corner between two straight pieces of the stroke
// is rounded in the batch of the next piece; the corner where the stroke left an existing road is not.

import {
  IdGen,
  polylineLength,
  planRoad,
  resolvePoint,
  roadHalfWidth,
  sampleSegmentCurve,
  MAX_GHOST_POINTS,
  type ResolvedPoint,
  type RoadPlan,
  type Vec2,
} from '@smartcity/shared';
import { translateError, type ClientStore } from '../app/store';
import { RemovalPreview, removalLines } from './removalPreview';
import { snapLabel, snapPoint } from './snap';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

const previewIds = new IdGen('preview');
const AUTO_FILLET_KEY = 'smartcity.road.autoFillet';

/** The remembered automatic-fillet choice (null = never set, or storage unavailable). */
function storedAutoFillet(): boolean | null {
  try {
    const v = window.localStorage.getItem(AUTO_FILLET_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Turn automatic corner rounding on/off and remember it in this browser (best effort). */
export function setAutoFillet(store: ClientStore, on: boolean): void {
  store.setToolOptions({ autoFillet: on });
  try {
    window.localStorage.setItem(AUTO_FILLET_KEY, on ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the choice just lasts for this session.
  }
}

/** Compass bearing in degrees (0 = north = -Z, clockwise). */
export function bearing(a: Vec2, b: Vec2): number {
  const deg = (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export class RoadTool implements Tool {
  readonly id = 'road' as const;
  private start: Vec2 | null = null;
  private control: Vec2 | null = null;
  private hover: Vec2 | null = null;
  private plan: RoadPlan | null = null;
  /** End node of the straight piece committed last in this stroke (a new node): the next corner to round. */
  private corner: string | null = null;
  /** Pointer-move replans (each may dry-run a fillet on a scratch doc): ≥ 1 px moves, at most once per frame. */
  private lastClient: { x: number; y: number } | null = null;
  private frame = false;
  private readonly removal = new RemovalPreview();

  constructor(private readonly ctx: ToolContext) {
    const stored = storedAutoFillet();
    if (stored !== null && stored !== this.opts.autoFillet) ctx.store.setToolOptions({ autoFillet: stored });
  }

  private get opts() {
    return this.ctx.store.getState().toolOptions;
  }

  private resolve(p: Vec2): ResolvedPoint {
    const r = resolvePoint(this.ctx.store.getState().doc, p, false);
    return r.kind === 'free' ? { kind: 'free', pos: snapPoint(r.pos, this.opts.snapStep) } : r;
  }

  private endPoints(): { start: ResolvedPoint; end: ResolvedPoint; control?: Vec2 } | null {
    if (!this.start || !this.hover) return null;
    const start = this.resolve(this.start);
    const end = this.resolve(this.hover);
    if (this.opts.curve && this.control) return { start, end, control: this.control };
    return { start, end };
  }

  /** Plan the piece; with auto fillet on, a straight piece from the stroke's last corner also rounds that corner. */
  private planFor(ep: { start: ResolvedPoint; end: ResolvedPoint; control?: Vec2 }, ids: IdGen): RoadPlan {
    const filletStart = this.opts.autoFillet && !ep.control && this.corner !== null && ep.start.kind === 'node' && ep.start.nodeId === this.corner;
    return planRoad(this.ctx.store.getState().doc, { ...ep, roadTypeId: this.opts.roadTypeId, filletStart }, ids);
  }

  private replan(): void {
    const ep = this.endPoints();
    const curvePending = this.opts.curve && !this.control;
    if (!ep || curvePending) {
      this.plan = null;
    } else {
      this.plan = this.planFor(ep, previewIds);
    }
    this.updateHint();
    this.ctx.changed();
  }

  private updateHint(): void {
    const ep = this.endPoints();
    let hint = '';
    if (!this.start) hint = this.opts.curve ? '곡선 도로: 시작점을 클릭하세요' : '도로 시작점을 클릭하세요';
    else if (this.opts.curve && !this.control) hint = '곡선의 휘는 지점(제어점)을 클릭하세요';
    else if (ep) {
      const pts = sampleSegmentCurve(ep.start.pos, ep.end.pos, ep.control);
      const len = polylineLength(pts);
      const crossings = this.plan ? Math.max(0, this.plan.junctions.length - 2) : 0;
      hint = `길이 ${len.toFixed(1)}m · 방위 ${bearing(ep.start.pos, ep.end.pos).toFixed(0)}°`;
      if (crossings > 0) hint += ` · 교차 ${crossings}곳`;
      if (this.plan?.error) hint += ` · ${this.plan.error}`;
      if (this.plan?.fillet) hint += ' · 모서리 둥글게';
      if (this.plan?.filletError) hint += ` · 모서리 유지: ${translateError(this.plan.filletError)}`;
    }
    hint += `   [C 곡선 ${this.opts.curve ? '켬' : '끔'} · F 모서리 자동 둥글게 ${this.opts.autoFillet ? '켬' : '끔'} · G 격자 ${snapLabel(this.opts.snapStep)} · Esc 취소]`;
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.hover = e.pos;
    if (!this.start) {
      this.start = this.resolve(e.pos).pos;
      this.control = null;
      this.corner = null;
      this.replan();
      return;
    }
    if (this.opts.curve && !this.control) {
      this.control = snapPoint(e.pos, this.opts.snapStep);
      this.replan();
      return;
    }
    const ep = this.endPoints();
    if (!ep) return;
    const plan = this.planFor(ep, this.ctx.ids());
    if (!plan.command) {
      this.ctx.store.toast(plan.error ?? '도로를 놓을 수 없습니다', 'error');
      return;
    }
    const ghost = [sampleSegmentCurve(plan.fillet?.onNew ?? ep.start.pos, ep.end.pos, ep.control)];
    if (plan.fillet) ghost.push(plan.fillet.curve);
    this.ctx.dispatch(plan.command, ghost);
    // Continuous drawing: the end becomes the next start; a new straight end is the next corner to round.
    const added = plan.command.type === 'batch' ? plan.command.commands.filter((c) => c.type === 'segment.add') : [];
    const last = added[added.length - 1];
    this.corner = !ep.control && ep.end.kind === 'free' && last?.type === 'segment.add' ? last.segment.b : null;
    this.start = ep.end.pos;
    this.control = null;
    this.replan();
  }

  onPointerMove(e: ToolPointer): void {
    const last = this.lastClient;
    if (last && Math.abs(e.client.x - last.x) < 1 && Math.abs(e.client.y - last.y) < 1) return;
    this.lastClient = { x: e.client.x, y: e.client.y };
    this.hover = e.pos;
    if (typeof requestAnimationFrame !== 'function') {
      this.replan();
      return;
    }
    if (this.frame) return;
    this.frame = true;
    requestAnimationFrame(() => {
      this.frame = false;
      this.replan();
    });
  }

  onPointerUp(): void {}

  onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'c') {
      this.ctx.store.setToolOptions({ curve: !this.opts.curve });
      this.control = null;
      this.replan();
      return true;
    }
    if (k === 'f') {
      setAutoFillet(this.ctx.store, !this.opts.autoFillet);
      this.replan();
      return true;
    }
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    return false;
  }

  cancel(): void {
    this.start = null;
    this.control = null;
    this.corner = null;
    this.plan = null;
    this.removal.reset();
    this.updateHint();
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    const ep = this.endPoints();
    if (!ep) return this.hover && this.start ? [this.start, this.hover] : [];
    const pts = sampleSegmentCurve(ep.start.pos, ep.end.pos, ep.control, 4);
    if (pts.length <= MAX_GHOST_POINTS) return pts;
    const step = (pts.length - 1) / (MAX_GHOST_POINTS - 1);
    const out: Vec2[] = [];
    for (let i = 0; i < MAX_GHOST_POINTS; i++) out.push(pts[Math.round(i * step)]!);
    return out;
  }

  preview(): ToolPreview {
    const prev: ToolPreview = { lines: [], points: [] };
    const doc = this.ctx.store.getState().doc;
    const rt = doc.roadTypes[this.opts.roadTypeId];
    const width = rt ? roadHalfWidth(rt) * 2 : 10;
    if (this.hover) {
      const r = this.resolve(this.hover);
      prev.points.push({ pos: r.pos, radius: 1.6, color: r.kind === 'node' ? '#4ade80' : r.kind === 'split' ? '#fb923c' : '#f8fafc' });
    }
    if (!this.start) return prev;
    prev.points.push({ pos: this.start, radius: 1.8, color: '#38bdf8' });
    if (this.opts.curve && !this.control) {
      if (this.hover) prev.lines.push({ pts: [this.start, this.hover], width: 0.4, color: '#e2e8f0' });
      return prev;
    }
    const ep = this.endPoints();
    if (!ep) return prev;
    const ok = !!this.plan?.command;
    const fillet = this.plan?.fillet;
    // A rounded corner: the new piece starts where the curve ends, and the curve is drawn too.
    const pts = sampleSegmentCurve(fillet ? fillet.onNew : ep.start.pos, ep.end.pos, ep.control);
    prev.lines.push({ pts, width, color: ok ? '#7dd3fc' : '#f87171' });
    if (fillet) prev.lines.push({ pts: fillet.curve, width, color: ok ? '#7dd3fc' : '#f87171' });
    if (this.plan?.filletError) prev.points.push({ pos: ep.start.pos, radius: 2.6, color: '#fb923c' });
    if (ep.control) {
      prev.lines.push({ pts: [ep.start.pos, ep.control, ep.end.pos], width: 0.3, color: '#e2e8f0' });
      prev.points.push({ pos: ep.control, radius: 1.2, color: '#e2e8f0' });
    }
    if (this.plan) for (const j of this.plan.junctions.slice(1, -1)) prev.points.push({ pos: j, radius: 2.4, color: '#facc15' });
    // Automatic parcels and buildings this road would remove.
    const st = this.ctx.store.getState();
    prev.lines.push(...removalLines(doc, this.removal.get(doc, st.docVersion, this.plan?.command ?? null, () => this.ctx.changed())));
    return prev;
  }
}
