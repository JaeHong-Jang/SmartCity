// Building placement: ghost of the selected type that snaps to the nearest road (front faces the
// road, just outside the sidewalk). Shift = free placement, , / . rotate 15°. Red = blocks a road,
// orange = breaks the destination parcel's regulations (allowed, warning only).

import {
  add,
  buildingBlocksRoad,
  buildingFootprints,
  cumulativeLengths,
  dot,
  parcelCompliance,
  partOutline,
  pointAtLength,
  pointInPolygon,
  rightNormal,
  roadHalfWidth,
  scale,
  sub,
  tangentAtLength,
  type BuildingType,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';
import type { SnapStep } from '../app/store';
import { guideGridLines, type RoadFrame } from './guideGrid';
import type { PickIndex } from './picking';
import { snapAlong, snapPoint } from './snap';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

export const ALIGN_RADIUS = 40;
export const SETBACK_MARGIN = 1;
const ROT_STEP = (15 * Math.PI) / 180;

export interface Placement {
  pos: Vec2;
  rotation: number;
  segmentId: string | null;
  /** Road frame of an aligned placement (for the local guide grid). */
  frame?: RoadFrame;
}

export type PlacementStatus = 'ok' | 'warn' | 'block';
/** Id for previews validated with the real rules (must pass the server's id check). */
export const GHOST_ID = '_ghost';
export const STATUS_COLORS: Record<PlacementStatus, string> = { ok: '#60a5fa', warn: '#fb923c', block: '#f87171' };

/** Local +z extent of the building (its front edge). */
export function frontExtent(type: BuildingType): number {
  return Math.max(...type.parts.flatMap((p) => partOutline(p).map((v) => v.z)));
}

/**
 * Align a building to the nearest road within ALIGN_RADIUS: local +z (the front) points at the
 * road and the front edge sits SETBACK_MARGIN outside the road's full half width. With a snap step
 * the position along the road moves in step increments (the road-frame grid).
 */
export function alignToRoad(doc: CityDoc, idx: PickIndex, type: BuildingType, cursor: Vec2, step: SnapStep = 0): Placement | null {
  const hit = idx.nearestSegment(cursor, ALIGN_RADIUS);
  if (!hit) return null;
  const seg = doc.segments[hit.id]!;
  const rt = doc.roadTypes[seg.roadTypeId]!;
  const cum = cumulativeLengths(hit.curve);
  const s = snapAlong(hit.s, hit.length, step);
  const point = pointAtLength(hit.curve, cum, s);
  const t = tangentAtLength(hit.curve, cum, s);
  const right = rightNormal(t);
  const side = dot(sub(cursor, point), right) >= 0 ? 1 : -1;
  const away = scale(right, side);
  const toRoad = scale(away, -1);
  // rotateY maps local (0, 1) to (sin r, cos r).
  const rotation = Math.atan2(toRoad.x, toRoad.z);
  const edge = roadHalfWidth(rt) + SETBACK_MARGIN;
  const pos = add(point, scale(away, edge + frontExtent(type)));
  return { pos, rotation, segmentId: hit.id, frame: { anchor: add(point, scale(away, edge)), u: t, v: away } };
}

export function placementValid(doc: CityDoc, type: BuildingType, p: Pick<Placement, 'pos' | 'rotation'>): boolean {
  // Same as the server: anchor and every footprint corner inside the map, and clear of roads.
  const h = doc.meta.halfSize;
  if (Math.abs(p.pos.x) > h || Math.abs(p.pos.z) > h) return false;
  if (buildingFootprints(p, type).some((poly) => poly.some((c) => Math.abs(c.x) > h || Math.abs(c.z) > h))) return false;
  return !buildingBlocksRoad(doc, p, type);
}

/**
 * Hard block (road overlap or map edge — the server rejects it), regulation warning of the parcel
 * the building would land in (`buildingId` = the moved building, if any), or ok.
 */
export function placementStatus(doc: CityDoc, type: BuildingType, p: Pick<Placement, 'pos' | 'rotation'>, buildingId = GHOST_ID): PlacementStatus {
  if (!placementValid(doc, type, p)) return 'block';
  const parcel = Object.values(doc.parcels).find((pc) => pointInPolygon(p.pos, pc.polygon));
  if (!parcel) return 'ok';
  const moved = { id: buildingId, typeId: type.id, pos: p.pos, rotation: p.rotation };
  const c = parcelCompliance({ ...doc, buildings: { ...doc.buildings, [buildingId]: moved } }, parcel);
  return c.violations.some((v) => v.buildingId === undefined || v.buildingId === buildingId) ? 'warn' : 'ok';
}

/** Placement for a building centered near `cursor`: aligned to a road unless `free`, else on the snap grid. */
export function placeAt(doc: CityDoc, idx: PickIndex, type: BuildingType, cursor: Vec2, rotation: number, step: SnapStep, free: boolean): Placement {
  const aligned = free ? null : alignToRoad(doc, idx, type, cursor, step);
  return aligned ?? { pos: snapPoint(cursor, step), rotation, segmentId: null };
}

/** Guide grid lines for an aligned placement (empty for free placement or snapping off). */
export function placementGuide(p: Placement, step: SnapStep): Vec2[][] {
  return p.frame ? guideGridLines(p.frame, step) : [];
}

export class BuildingTool implements Tool {
  readonly id = 'building' as const;
  private hover: Vec2 | null = null;
  private shift = false;
  private placement: Placement | null = null;
  private status: PlacementStatus = 'ok';

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
  ) {}

  private type(): BuildingType | undefined {
    const s = this.ctx.store.getState();
    return s.doc.buildingTypes[s.toolOptions.buildingTypeId] ?? Object.values(s.doc.buildingTypes)[0];
  }

  private recompute(): void {
    const type = this.type();
    const s = this.ctx.store.getState();
    if (!type || !this.hover) {
      this.placement = null;
    } else {
      this.placement = placeAt(s.doc, this.index(), type, this.hover, s.toolOptions.buildingRotation, s.toolOptions.snapStep, this.shift);
      this.status = placementStatus(s.doc, type, this.placement);
    }
    const name = type?.name ?? '';
    let hint = `${name} 배치: `;
    hint += this.placement?.segmentId ? '도로에 맞춰 정렬됨' : '자유 배치';
    if (this.placement && this.status === 'block') hint += ' · 도로와 겹쳐 배치할 수 없습니다';
    if (this.placement && this.status === 'warn') hint += ' · 필지 규제 위반 (경고)';
    hint += '   [Shift 자유 배치 · , . 회전 15° · Esc 취소]';
    if (s.toolHint !== hint) this.ctx.store.set({ toolHint: hint });
    this.ctx.changed();
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.hover = e.pos;
    this.shift = e.shift;
    this.recompute();
    const type = this.type();
    if (!type || !this.placement) return;
    if (this.status === 'block') {
      this.ctx.store.toast('도로와 겹치거나 영역 밖이라 배치할 수 없습니다', 'error');
      return;
    }
    const b = { id: this.ctx.ids().next('b'), typeId: type.id, pos: this.placement.pos, rotation: this.placement.rotation };
    const ghost = buildingFootprints(b, type).map((poly) => [...poly, poly[0]!]);
    this.ctx.dispatch({ type: 'building.place', building: b }, ghost);
  }

  onPointerMove(e: ToolPointer): void {
    this.hover = e.pos;
    this.shift = e.shift;
    this.recompute();
  }

  onPointerUp(): void {}

  onLeave(): void {
    this.cancel();
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === ',' || e.key === '.') {
      const r = this.ctx.store.getState().toolOptions.buildingRotation + (e.key === ',' ? -ROT_STEP : ROT_STEP);
      this.ctx.store.setToolOptions({ buildingRotation: Math.atan2(Math.sin(r), Math.cos(r)) });
      this.recompute();
      return true;
    }
    if (e.key === 'Shift') {
      this.shift = e.type === 'keydown';
      this.recompute();
      return false;
    }
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    return false;
  }

  cancel(): void {
    this.hover = null;
    this.placement = null;
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    const type = this.type();
    if (!type || !this.placement) return [];
    const polys = buildingFootprints(this.placement, type);
    const first = polys[0]!;
    return [...first, first[0]!];
  }

  preview(): ToolPreview {
    const type = this.type();
    if (!type || !this.placement) return { lines: [], points: [] };
    const color = this.status === 'ok' ? '#4ade80' : STATUS_COLORS[this.status];
    const step = this.ctx.store.getState().toolOptions.snapStep;
    return {
      lines: [
        ...placementGuide(this.placement, step).map((pts) => ({ pts, width: 0.12, color: '#e2e8f0' })),
        ...buildingFootprints(this.placement, type).map((poly) => ({ pts: [...poly, poly[0]!], width: 0.6, color })),
      ],
      points: [],
      building: { typeId: type.id, pos: this.placement.pos, rotation: this.placement.rotation, color },
    };
  }
}

