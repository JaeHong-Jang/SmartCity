// Road tool: straight or curved (C: start → control → end), continuous drawing, live planRoad
// preview (length, bearing, junctions), free points use the shared snap step (G), right click / Esc cancels.

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
import { snapLabel, snapPoint } from './snap';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

const previewIds = new IdGen('preview');

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

  constructor(private readonly ctx: ToolContext) {}

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

  private replan(): void {
    const ep = this.endPoints();
    const curvePending = this.opts.curve && !this.control;
    if (!ep || curvePending) {
      this.plan = null;
    } else {
      this.plan = planRoad(this.ctx.store.getState().doc, { ...ep, roadTypeId: this.opts.roadTypeId }, previewIds);
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
    }
    hint += `   [C 곡선 ${this.opts.curve ? '켬' : '끔'} · G 격자 ${snapLabel(this.opts.snapStep)} · Esc 취소]`;
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.hover = e.pos;
    if (!this.start) {
      this.start = this.resolve(e.pos).pos;
      this.control = null;
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
    const plan = planRoad(this.ctx.store.getState().doc, { ...ep, roadTypeId: this.opts.roadTypeId }, this.ctx.ids());
    if (!plan.command) {
      this.ctx.store.toast(plan.error ?? '도로를 놓을 수 없습니다', 'error');
      return;
    }
    this.ctx.dispatch(plan.command, [sampleSegmentCurve(ep.start.pos, ep.end.pos, ep.control)]);
    // Continuous drawing: the end becomes the next start.
    this.start = ep.end.pos;
    this.control = null;
    this.replan();
  }

  onPointerMove(e: ToolPointer): void {
    this.hover = e.pos;
    this.replan();
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
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    return false;
  }

  cancel(): void {
    this.start = null;
    this.control = null;
    this.plan = null;
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
    const pts = sampleSegmentCurve(ep.start.pos, ep.end.pos, ep.control);
    prev.lines.push({ pts, width, color: ok ? '#7dd3fc' : '#f87171' });
    if (ep.control) {
      prev.lines.push({ pts: [ep.start.pos, ep.control, ep.end.pos], width: 0.3, color: '#e2e8f0' });
      prev.points.push({ pos: ep.control, radius: 1.2, color: '#e2e8f0' });
    }
    if (this.plan) for (const j of this.plan.junctions.slice(1, -1)) prev.points.push({ pos: j, radius: 2.4, color: '#facc15' });
    return prev;
  }
}
