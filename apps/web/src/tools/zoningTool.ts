// Zoning tool (ADR 0009 §4): drag along a road to lay out automatic lots on one side (shared
// lotsAlongSegment), or erase automatic lots under the drag. One batch per release.
// `[` / `]` change the lot depth (1–4 cells); number keys and the wheel keep their meanings.

import {
  buildingsInParcel,
  cumulativeLengths,
  closestPointOnPolyline,
  LIMITS,
  lotsAlongSegment,
  lotsToCommand,
  pointInPolygon,
  rightNormal,
  roadHalfWidth,
  sampleSegmentCurve,
  sub,
  dot,
  tangentAtLength,
  type CityDoc,
  type Command,
  type Parcel,
  type Vec2,
  type Zone,
} from '@smartcity/shared';
import { closedRing } from '../app/ring';
import { ZONE_COLORS } from '../app/zoneColors';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

/** How far from a road's edge (m) a press still picks that road. */
const PICK_MARGIN = 40;

export interface RoadHit {
  segmentId: string;
  side: 'left' | 'right';
  /** Arc fraction along the segment, 0..1. */
  t: number;
}

export interface ZoningRange {
  segmentId: string;
  side: 'left' | 'right';
  t0: number;
  t1: number;
}

function segmentPoints(doc: CityDoc, segId: string): Vec2[] | null {
  const seg = doc.segments[segId];
  const a = seg && doc.nodes[seg.a];
  const b = seg && doc.nodes[seg.b];
  return seg && a && b ? sampleSegmentCurve(a.pos, b.pos, seg.control) : null;
}

/** Nearest road to `p` and which side of it `p` is on (right = right of the a → b direction). */
export function nearestRoadSide(doc: CityDoc, p: Vec2, margin = PICK_MARGIN): RoadHit | null {
  let best: { id: string; dist: number; s: number; total: number; side: 'left' | 'right' } | null = null;
  for (const seg of Object.values(doc.segments)) {
    const pts = segmentPoints(doc, seg.id);
    const rt = doc.roadTypes[seg.roadTypeId];
    if (!pts || !rt) continue;
    const c = closestPointOnPolyline(pts, p);
    const reach = c.distance - roadHalfWidth(rt);
    if (reach > margin || (best && c.distance >= best.dist)) continue;
    const cum = cumulativeLengths(pts);
    const n = rightNormal(tangentAtLength(pts, cum, c.s));
    best = { id: seg.id, dist: c.distance, s: c.s, total: cum[cum.length - 1]!, side: dot(sub(p, c.point), n) >= 0 ? 'right' : 'left' };
  }
  return best && best.total > 0 ? { segmentId: best.id, side: best.side, t: best.s / best.total } : null;
}

/** The dragged range: from the press hit along the same segment and side to the pointer's projection. */
export function dragRange(doc: CityDoc, start: RoadHit, cur: Vec2): ZoningRange {
  const pts = segmentPoints(doc, start.segmentId);
  let t1 = start.t;
  if (pts) {
    const cum = cumulativeLengths(pts);
    const total = cum[cum.length - 1]!;
    if (total > 0) t1 = closestPointOnPolyline(pts, cur).s / total;
  }
  return { segmentId: start.segmentId, side: start.side, t0: start.t, t1 };
}

/** Split lots into parcel.upsert batches that each fit LIMITS.batchSize. */
export function lotBatches(lots: Parcel[], size: number = LIMITS.batchSize): Command[] {
  const out: Command[] = [];
  for (let i = 0; i < lots.length; i += size) out.push(lotsToCommand(lots.slice(i, i + size)));
  return out;
}

/** Number of lot positions of `lots` including omitted ones (ids end in the slot index). */
export function lotSlots(lots: Parcel[]): number {
  let max = -1;
  for (const l of lots) max = Math.max(max, Number(l.id.slice(l.id.lastIndexOf('-') + 1)));
  return max + 1;
}

/** parcel.remove batches for the removable (empty, automatic) lots among `ids`; `skipped` have buildings. */
export function eraseBatches(doc: CityDoc, ids: Iterable<string>, size: number = LIMITS.batchSize): { commands: Command[]; removed: number; skipped: number } {
  const ok: string[] = [];
  let skipped = 0;
  for (const id of ids) {
    const pc = doc.parcels[id];
    if (!pc?.auto) continue;
    if (buildingsInParcel(doc, pc).length > 0) skipped++;
    else ok.push(id);
  }
  const commands: Command[] = [];
  for (let i = 0; i < ok.length; i += size) commands.push({ type: 'batch', commands: ok.slice(i, i + size).map((id) => ({ type: 'parcel.remove' as const, id })) });
  return { commands, removed: ok.length, skipped };
}

/** A line whose band is the lot: from the middle of the front edge to the middle of the back edge. */
function lotFill(lot: Parcel): { pts: Vec2[]; width: number } {
  const [f0, f1, b1, b0] = lot.polygon as [Vec2, Vec2, Vec2, Vec2];
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  return { pts: [mid(f0, f1), mid(b0, b1)], width: Math.hypot(f1.x - f0.x, f1.z - f0.z) };
}

export class ZoningTool implements Tool {
  readonly id = 'zoning' as const;
  private start: RoadHit | null = null;
  private cur: Vec2 | null = null;
  private hover: Vec2 | null = null;
  private erase: Set<string> | null = null;
  private lots: Parcel[] = [];

  constructor(private readonly ctx: ToolContext) {}

  private get opts() {
    return this.ctx.store.getState().toolOptions;
  }
  private get doc(): CityDoc {
    return this.ctx.store.getState().doc;
  }

  private recompute(): void {
    this.lots = [];
    if (this.start && this.cur && !this.opts.zoningErase) {
      const r = dragRange(this.doc, this.start, this.cur);
      this.lots = lotsAlongSegment(this.doc, r.segmentId, r.side, r.t0, r.t1, this.opts.zoningDepth, this.opts.zoningZone as Zone, 'preview');
    }
    let hint: string;
    if (this.opts.zoningErase) hint = this.erase ? `지울 자동 필지 ${this.erase.size}개` : '조닝 지우기: 자동 필지 위를 드래그하세요 (건물이 있는 필지는 건너뜀)';
    else if (this.start) hint = `필지 ${this.lots.length}개 (깊이 ${this.opts.zoningDepth}칸 = ${this.opts.zoningDepth * 8}m)`;
    else hint = '조닝: 도로 옆에서 드래그하세요';
    hint += '   [ [ ] 깊이 · Esc 취소]';
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
    this.ctx.changed();
  }

  private pick(p: Vec2): void {
    const doc = this.doc;
    for (const pc of Object.values(doc.parcels)) if (pc.auto && !this.erase!.has(pc.id) && pointInPolygon(p, pc.polygon)) this.erase!.add(pc.id);
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    if (this.opts.zoningErase) {
      this.erase = new Set();
      this.pick(e.pos);
    } else {
      this.start = nearestRoadSide(this.doc, e.pos);
      if (!this.start) {
        this.ctx.store.toast('도로 옆에서 드래그하세요', 'info', 'zoning');
        return;
      }
      this.cur = e.pos;
    }
    this.recompute();
  }

  onPointerMove(e: ToolPointer): void {
    this.hover = e.pos;
    if (this.erase) this.pick(e.pos);
    else if (this.start) this.cur = e.pos;
    this.recompute();
  }

  onPointerUp(): void {
    const store = this.ctx.store;
    if (this.erase) {
      const r = eraseBatches(this.doc, this.erase);
      for (const c of r.commands) this.ctx.dispatch(c);
      if (r.removed + r.skipped > 0) store.toast(`자동 필지 ${r.removed}개 삭제${r.skipped ? ` · 건물이 있어 ${r.skipped}개는 남김` : ''}`, r.removed ? 'success' : 'info');
    } else if (this.start && this.cur) {
      const range = dragRange(this.doc, this.start, this.cur);
      const lots = lotsAlongSegment(this.doc, range.segmentId, range.side, range.t0, range.t1, this.opts.zoningDepth, this.opts.zoningZone as Zone, this.ctx.ids().next('z'));
      if (lots.length === 0) store.toast('이 구간에는 필지를 만들 수 없습니다 (교차로 근처이거나 다른 필지·건물과 겹침)', 'error');
      else {
        for (const c of lotBatches(lots)) this.ctx.dispatch(c, lots.slice(0, 50).map((l) => closedRing(l.polygon)));
        const skipped = Math.max(0, lotSlots(lots) - lots.length);
        store.toast(`필지 ${lots.length}개 생성${skipped ? ` · ${skipped}곳은 겹쳐서 건너뜀` : ''}`, 'success');
      }
    }
    this.reset();
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return false;
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const d = Math.max(1, Math.min(4, this.opts.zoningDepth + (e.code === 'BracketRight' ? 1 : -1))) as 1 | 2 | 3 | 4;
      this.ctx.store.setToolOptions({ zoningDepth: d });
      this.recompute();
      return true;
    }
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    return false;
  }

  private reset(): void {
    this.start = null;
    this.cur = null;
    this.erase = null;
    this.lots = [];
    this.recompute();
  }

  onLeave(): void {
    this.hover = null;
    this.ctx.changed();
  }

  cancel(): void {
    this.reset();
  }

  ghost(): Vec2[] {
    return [];
  }

  preview(): ToolPreview {
    const out: ToolPreview = { lines: [], points: [] };
    const doc = this.doc;
    const color = ZONE_COLORS[this.opts.zoningZone];
    for (const lot of this.lots) {
      const f = lotFill(lot);
      out.lines.push({ pts: f.pts, width: f.width - 0.4, color });
      out.lines.push({ pts: closedRing(lot.polygon), width: 0.35, color: '#f8fafc' });
    }
    for (const id of this.erase ?? []) {
      const pc = doc.parcels[id];
      if (pc) out.lines.push({ pts: closedRing(pc.polygon), width: 0.9, color: buildingsInParcel(doc, pc).length ? '#fb923c' : '#ef4444' });
    }
    if (this.hover && !this.start && !this.erase) {
      const hit = this.opts.zoningErase ? null : nearestRoadSide(doc, this.hover);
      out.points.push({ pos: this.hover, radius: 1.6, color: hit ? color : '#64748b' });
    }
    return out;
  }
}
