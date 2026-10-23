// Building placement: ghost of the selected type that snaps to the nearest road (front faces the
// road, just outside the sidewalk). Shift = free placement, , / . rotate 15°. Red = blocks a road.

import {
  add,
  buildingBlocksRoad,
  buildingFootprints,
  cumulativeLengths,
  dot,
  pointAtLength,
  rightNormal,
  roadHalfWidth,
  scale,
  sub,
  tangentAtLength,
  type BuildingType,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';
import type { PickIndex } from './picking';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

export const ALIGN_RADIUS = 40;
export const SETBACK_MARGIN = 1;
const ROT_STEP = (15 * Math.PI) / 180;

export interface Placement {
  pos: Vec2;
  rotation: number;
  segmentId: string | null;
}

/** Local +z extent of the building (its front edge). */
export function frontExtent(type: BuildingType): number {
  return Math.max(...type.parts.map((p) => p.offset.z + p.depth / 2));
}

/**
 * Align a building to the nearest road within ALIGN_RADIUS: local +z (the front) points at the
 * road and the front edge sits SETBACK_MARGIN outside the road's full half width.
 */
export function alignToRoad(doc: CityDoc, idx: PickIndex, type: BuildingType, cursor: Vec2): Placement | null {
  const hit = idx.nearestSegment(cursor, ALIGN_RADIUS);
  if (!hit) return null;
  const seg = doc.segments[hit.id]!;
  const rt = doc.roadTypes[seg.roadTypeId]!;
  const cum = cumulativeLengths(hit.curve);
  const s = Math.min(Math.max(hit.s, 0.01), hit.length - 0.01);
  const point = pointAtLength(hit.curve, cum, s);
  const t = tangentAtLength(hit.curve, cum, s);
  const right = rightNormal(t);
  const side = dot(sub(cursor, point), right) >= 0 ? 1 : -1;
  const away = scale(right, side);
  const toRoad = scale(away, -1);
  // rotateY maps local (0, 1) to (sin r, cos r).
  const rotation = Math.atan2(toRoad.x, toRoad.z);
  const pos = add(point, scale(away, roadHalfWidth(rt) + SETBACK_MARGIN + frontExtent(type)));
  return { pos, rotation, segmentId: hit.id };
}

export function placementValid(doc: CityDoc, type: BuildingType, p: Placement): boolean {
  const h = doc.meta.halfSize;
  if (Math.abs(p.pos.x) > h || Math.abs(p.pos.z) > h) return false;
  return !buildingBlocksRoad(doc, p, type);
}

export class BuildingTool implements Tool {
  readonly id = 'building' as const;
  private hover: Vec2 | null = null;
  private shift = false;
  private placement: Placement | null = null;
  private ok = false;

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
      const aligned = this.shift ? null : alignToRoad(s.doc, this.index(), type, this.hover);
      this.placement = aligned ?? { pos: this.hover, rotation: s.toolOptions.buildingRotation, segmentId: null };
      this.ok = placementValid(s.doc, type, this.placement);
    }
    const name = type?.name ?? '';
    let hint = `${name} 배치: `;
    hint += this.placement?.segmentId ? '도로에 맞춰 정렬됨' : '자유 배치';
    if (this.placement && !this.ok) hint += ' · 도로와 겹쳐 배치할 수 없습니다';
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
    if (!this.ok) {
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
    const color = this.ok ? '#4ade80' : '#f87171';
    return {
      lines: buildingFootprints(this.placement, type).map((poly) => ({ pts: [...poly, poly[0]!], width: 0.6, color })),
      points: [],
      building: { typeId: type.id, pos: this.placement.pos, rotation: this.placement.rotation, ok: this.ok },
    };
  }
}

