// Bus line tool: click along roads in order; each click creates (or reuses) a stop on the clicked
// side (= travel direction). Enter or clicking the first stop finishes: one batch of busStop.add
// commands plus busLine.upsert.

import {
  cumulativeLengths,
  dot,
  pointAtLength,
  rightNormal,
  sub,
  tangentAtLength,
  type BusStop,
  type CityDoc,
  type Command,
  type TravelDir,
  type Vec2,
} from '@smartcity/shared';
import type { PickIndex, SegmentHit } from './picking';
import { snapAlong } from './snap';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

export const LINE_COLORS = ['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'];
const STOP_REUSE_RADIUS = 5;
const CLOSE_RADIUS = 6;

/** Stop placement from a click near a road: the clicked side decides the travel direction. */
export function stopFromClick(doc: CityDoc, hit: SegmentHit, cursor: Vec2): { segmentId: string; t: number; dir: TravelDir; pos: Vec2 } {
  const seg = doc.segments[hit.id]!;
  const rt = doc.roadTypes[seg.roadTypeId]!;
  const cum = cumulativeLengths(hit.curve);
  const s = Math.min(Math.max(hit.s, 0), hit.length);
  const tangent = tangentAtLength(hit.curve, cum, Math.min(Math.max(s, 0.01), hit.length - 0.01));
  // Traffic keeps right: forward lanes are on the right of a → b.
  const right = dot(sub(cursor, hit.point), rightNormal(tangent)) >= 0;
  const dir: TravelDir = right || rt.lanesBackward === 0 ? 'forward' : 'backward';
  const t = hit.length > 0 ? Math.min(1, Math.max(0, s / hit.length)) : 0;
  return { segmentId: hit.id, t, dir, pos: pointAtLength(hit.curve, cum, s) };
}

interface DraftStop {
  id: string;
  pos: Vec2;
  /** Present when the stop is new and must be added. */
  stop?: BusStop;
}

export class BusLineTool implements Tool {
  readonly id = 'busLine' as const;
  private stops: DraftStop[] = [];
  private hover: Vec2 | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
  ) {}

  private hint(): void {
    const n = this.stops.length;
    const hint =
      n === 0
        ? '노선의 첫 정류장을 도로 위에서 클릭하세요 (클릭한 쪽이 진행 방향)'
        : `정류장 ${n}개 · 다음 정류장을 클릭하세요 · Enter 또는 첫 정류장 클릭으로 완료 · Esc 취소`;
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    const idx = this.index();
    const first = this.stops[0];
    if (first && this.stops.length >= 2 && Math.hypot(first.pos.x - e.pos.x, first.pos.z - e.pos.z) <= CLOSE_RADIUS) {
      this.finish();
      return;
    }
    const existing = idx.nearestStop(e.pos, STOP_REUSE_RADIUS);
    if (existing) {
      if (!this.stops.some((s) => s.id === existing.id)) this.stops.push({ id: existing.id, pos: existing.pos });
    } else {
      const hit = idx.nearestSegment(e.pos);
      if (!hit) {
        this.ctx.store.toast('정류장은 도로 위에만 만들 수 있습니다', 'error');
        return;
      }
      const { doc, toolOptions } = this.ctx.store.getState();
      // Stops move along the road in snap-step increments.
      const s = snapAlong(hit.s, hit.length, toolOptions.snapStep);
      const st = stopFromClick(doc, { ...hit, s, point: pointAtLength(hit.curve, cumulativeLengths(hit.curve), s) }, e.pos);
      const id = this.ctx.ids().next('p');
      this.stops.push({ id, pos: st.pos, stop: { id, segmentId: st.segmentId, t: st.t, dir: st.dir } });
    }
    this.hint();
    this.ctx.changed();
  }

  private finish(): void {
    if (this.stops.length < 2) {
      this.ctx.store.toast('노선에는 정류장이 2개 이상 필요합니다', 'error');
      return;
    }
    const doc = this.ctx.store.getState().doc;
    const n = Object.keys(doc.busLines).length;
    const busTypes = Object.values(doc.vehicleTypes).filter((v) => v.kind === 'bus').sort((a, b) => a.id.localeCompare(b.id));
    const vehicleTypeId = busTypes[0]?.id ?? Object.keys(doc.vehicleTypes).sort()[0];
    if (!vehicleTypeId) {
      this.ctx.store.toast('사용할 차량 타입이 없습니다', 'error');
      return;
    }
    const commands: Command[] = [];
    for (const s of this.stops) if (s.stop) commands.push({ type: 'busStop.add', stop: s.stop });
    commands.push({
      type: 'busLine.upsert',
      line: { id: this.ctx.ids().next('L'), name: `${n + 1}번 노선`, color: LINE_COLORS[n % LINE_COLORS.length]!, stopIds: this.stops.map((s) => s.id), vehicleTypeId, buses: 3 },
    });
    this.ctx.dispatch({ type: 'batch', commands }, [[...this.stops.map((s) => s.pos), this.stops[0]!.pos]]);
    this.stops = [];
    this.hint();
    this.ctx.changed();
  }

  onPointerMove(e: ToolPointer): void {
    this.hover = e.pos;
    this.hint();
    if (this.stops.length) this.ctx.changed();
  }

  onPointerUp(): void {}

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      this.finish();
      return true;
    }
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    return false;
  }

  cancel(): void {
    this.stops = [];
    this.hint();
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    const pts = this.stops.map((s) => s.pos);
    if (this.hover && pts.length) pts.push(this.hover);
    return pts.slice(0, 64);
  }

  preview(): ToolPreview {
    const out: ToolPreview = { lines: [], points: [] };
    const pts = this.ghost();
    if (pts.length >= 2) out.lines.push({ pts, width: 1.2, color: '#60a5fa' });
    this.stops.forEach((s, i) => out.points.push({ pos: s.pos, radius: i === 0 ? 3 : 2.2, color: i === 0 ? '#facc15' : '#60a5fa' }));
    return out;
  }
}
