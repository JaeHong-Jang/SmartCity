// Parcel tool: drag a rectangle on the snap grid, or (P) click a polygon and close it with Enter or
// a click on the first corner. Zone and regulation come from the tool options (DEFAULT_REGULATIONS).
// Red ghost = the server would reject it (overlap, too small, self-intersecting, off the map).

import { DEFAULT_REGULATIONS, dist, type CityDoc, type Parcel, type ParcelZone, type Vec2 } from '@smartcity/shared';
import { translateError } from '../app/store';
import { GHOST_ID } from './buildingTool';
import { snapPoint } from './snap';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';
import { commandError } from './validate';

const CLOSE_RADIUS = 3;

export const PARCEL_ZONES: ParcelZone[] = ['residential', 'commercial', 'office', 'industrial', 'public', 'green'];
export const ZONE_COLORS: Record<ParcelZone, string> = {
  residential: '#facc15',
  commercial: '#f472b6',
  office: '#60a5fa',
  industrial: '#a78bfa',
  public: '#f97316',
  green: '#4ade80',
};

/** Axis-aligned rectangle with corners a and b, counter-clockwise. */
export function rectPolygon(a: Vec2, b: Vec2): Vec2[] {
  return [
    { x: a.x, z: a.z },
    { x: b.x, z: a.z },
    { x: b.x, z: b.z },
    { x: a.x, z: b.z },
  ];
}

export function makeParcel(id: string, polygon: Vec2[], zone: ParcelZone): Parcel {
  return { id, polygon, zone, regulation: { ...DEFAULT_REGULATIONS[zone] } };
}

/** Why the server would reject this parcel (Korean), or null when it is valid. */
export function parcelGhostError(doc: CityDoc, parcel: Parcel): string | null {
  const err = commandError(doc, { type: 'parcel.upsert', parcel });
  return err === null ? null : translateError(err);
}

export class ParcelTool implements Tool {
  readonly id = 'parcel' as const;
  private start: Vec2 | null = null;
  private corner: Vec2 | null = null;
  private vertices: Vec2[] = [];
  private hover: Vec2 | null = null;
  private error: string | null = null;

  constructor(private readonly ctx: ToolContext) {}

  private get opts() {
    return this.ctx.store.getState().toolOptions;
  }

  private snap(p: Vec2): Vec2 {
    return snapPoint(p, this.opts.snapStep);
  }

  /** Polygon being drawn (rectangle drag, or clicked corners plus the hover point). */
  private draft(): Vec2[] {
    if (this.opts.parcelPolygon) return this.hover && this.vertices.length ? [...this.vertices, this.hover] : this.vertices.slice();
    return this.start && this.corner ? rectPolygon(this.start, this.corner) : [];
  }

  private refresh(): void {
    const poly = this.draft();
    this.error = poly.length >= 3 ? parcelGhostError(this.ctx.store.getState().doc, makeParcel(GHOST_ID, poly, this.opts.parcelZone)) : null;
    let hint = this.opts.parcelPolygon
      ? this.vertices.length === 0
        ? '필지(다각형): 꼭짓점을 차례로 클릭하세요'
        : `꼭짓점 ${this.vertices.length}개 · Enter 또는 첫 점 클릭으로 닫기`
      : '필지(사각형): 드래그해서 그리세요';
    if (this.error) hint += ` · ${this.error}`;
    hint += `   [P ${this.opts.parcelPolygon ? '사각형' : '다각형'} 모드 · G 격자 · Esc 취소]`;
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
    this.ctx.changed();
  }

  private commit(poly: Vec2[]): void {
    const parcel = makeParcel(this.ctx.ids().next('q'), poly, this.opts.parcelZone);
    const err = parcelGhostError(this.ctx.store.getState().doc, parcel);
    if (err) {
      this.ctx.store.toast(`필지를 만들 수 없습니다: ${err}`, 'error');
      return;
    }
    this.ctx.dispatch({ type: 'parcel.upsert', parcel }, [[...poly, poly[0]!]]);
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    const p = this.snap(e.pos);
    if (!this.opts.parcelPolygon) {
      this.start = p;
      this.corner = p;
      this.refresh();
      return;
    }
    const first = this.vertices[0];
    if (first && this.vertices.length >= 3 && dist(first, p) <= Math.max(CLOSE_RADIUS, this.opts.snapStep)) {
      this.close();
      return;
    }
    const last = this.vertices[this.vertices.length - 1];
    if (!last || dist(last, p) > 1e-6) this.vertices.push(p);
    this.refresh();
  }

  private close(): void {
    if (this.vertices.length < 3) {
      this.ctx.store.toast('필지에는 꼭짓점이 3개 이상 필요합니다', 'error');
      return;
    }
    this.commit(this.vertices);
    this.vertices = [];
    this.refresh();
  }

  onPointerMove(e: ToolPointer): void {
    this.hover = this.snap(e.pos);
    if (this.start) this.corner = this.hover;
    this.refresh();
  }

  onPointerUp(e: ToolPointer): void {
    if (!this.start) return;
    const a = this.start;
    const b = this.snap(e.pos);
    this.start = null;
    this.corner = null;
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.z - b.z) > 1e-6) this.commit(rectPolygon(a, b));
    this.refresh();
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'p' || e.key === 'P') {
      this.ctx.store.setToolOptions({ parcelPolygon: !this.opts.parcelPolygon });
      this.cancel();
      return true;
    }
    if (e.key === 'Enter' && this.opts.parcelPolygon) {
      this.close();
      return true;
    }
    if (e.key === 'Backspace' && this.vertices.length) {
      this.vertices.pop();
      this.refresh();
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
    this.corner = null;
    this.vertices = [];
    this.error = null;
    this.refresh();
  }

  ghost(): Vec2[] {
    const poly = this.draft();
    return poly.length >= 2 ? [...poly, poly[0]!].slice(0, 64) : [];
  }

  preview(): ToolPreview {
    const out: ToolPreview = { lines: [], points: [] };
    const poly = this.draft();
    const color = this.error ? '#f87171' : ZONE_COLORS[this.opts.parcelZone];
    if (poly.length >= 2) out.lines.push({ pts: this.opts.parcelPolygon && poly.length < 3 ? poly : [...poly, poly[0]!], width: 0.7, color });
    for (const [i, v] of this.vertices.entries()) out.points.push({ pos: v, radius: i === 0 ? 1.4 : 1, color: i === 0 ? '#f8fafc' : color });
    if (this.hover) out.points.push({ pos: this.hover, radius: 0.8, color: '#f8fafc' });
    return out;
  }
}
