// Building placement: ghost of the selected type that snaps to the nearest road (front faces the
// road, just outside the sidewalk; curved roads use the arc-length secant). Shift = free placement,
// , / . rotate 15°, hold T + move = continuous rotation (Shift = no 15° snap; a quick tap = +15°),
// L = lock / unlock the road. Red = blocks a road, orange = breaks the destination parcel's
// regulations (allowed, warning only). The target pose drives collision, colour and the command;
// the 3D ghost only chases it with a render-side spring (render/ghostBuilding.ts).

import {
  buildingBlocksRoad,
  buildingFootprints,
  MAX_GHOST_POINTS,
  parcelCompliance,
  partOutline,
  pointInPolygon,
  type BuildingType,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';
import { closedRing } from '../app/ring';
import type { SnapStep } from '../app/store';
import { guideGridLines } from './guideGrid';
import {
  ALIGN_RADIUS,
  alignOnCurve,
  PlacementSolver,
  RotateGesture,
  ROT_STEP,
  snapRotation,
  wrapAngle,
  type Placement,
} from './placement';
import type { PickIndex } from './picking';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

export { ALIGN_RADIUS, SETBACK_MARGIN, frontExtent } from './placement';
export type { Placement } from './placement';

/** A press shorter than this (ms) with no turning is a tap: rotate one 15° step. */
const TAP_MS = 250;
/** Turning less than this (rad) during a short press still counts as a tap. */
const TAP_TURN = (5 * Math.PI) / 180;

export type PlacementStatus = 'ok' | 'warn' | 'block';
/** Id for previews validated with the real rules (must pass the server's id check). */
export const GHOST_ID = '_ghost';
export const STATUS_COLORS: Record<PlacementStatus, string> = { ok: '#60a5fa', warn: '#fb923c', block: '#f87171' };

/** Align a building to the nearest road within ALIGN_RADIUS (stateless: no hysteresis or lock). */
export function alignToRoad(doc: CityDoc, idx: PickIndex, type: BuildingType, cursor: Vec2, step: SnapStep = 0): Placement | null {
  const hit = idx.nearestSegment(cursor, ALIGN_RADIUS);
  return hit ? alignOnCurve(doc, type, hit, cursor, step) : null;
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
  private solver = new PlacementSolver();
  /** Hold-T rotation in progress (the building stays put and turns). */
  private turn: { gesture: RotateGesture; at: number; rotation: number } | null = null;
  /** After a rotation the building stays unaligned (with that angle) until L or Esc. */
  private manual = false;
  /** Bumped on every click: tells the ghost to jump to the target instead of easing. */
  private settle = 0;

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
  ) {}

  private type(): BuildingType | undefined {
    const s = this.ctx.store.getState();
    return s.doc.buildingTypes[s.toolOptions.buildingTypeId] ?? Object.values(s.doc.buildingTypes)[0];
  }

  private recompute(keep = false): void {
    const type = this.type();
    const s = this.ctx.store.getState();
    if (!type || !this.hover) {
      this.placement = null;
    } else if (this.turn && this.placement) {
      const rotation = snapRotation(this.turn.gesture.move(this.hover), !this.shift);
      this.turn.rotation = rotation;
      this.placement = { pos: this.turn.gesture.anchor, rotation, segmentId: null };
      this.status = placementStatus(s.doc, type, this.placement);
    } else if (keep && this.placement) {
      this.status = placementStatus(s.doc, type, this.placement);
    } else {
      this.placement = this.solver.solve(s.doc, this.index(), type, this.hover, {
        rotation: s.toolOptions.buildingRotation,
        step: s.toolOptions.snapStep,
        free: this.shift || this.manual,
      });
      this.status = placementStatus(s.doc, type, this.placement);
    }
    const name = type?.name ?? '';
    let hint = `${name} 배치: `;
    if (this.turn) hint += `회전 ${Math.round(((this.placement?.rotation ?? 0) * 180) / Math.PI)}° (T를 누른 채 마우스 이동, Shift = 15° 스냅 해제)`;
    else hint += this.placement?.segmentId ? `도로에 맞춰 정렬됨${this.solver.selector.locked ? ' (잠금)' : ''}` : '자유 배치';
    if (this.placement && this.status === 'block') hint += ' · 도로와 겹쳐 배치할 수 없습니다';
    if (this.placement && this.status === 'warn') hint += ' · 필지 규제 위반 (경고)';
    hint += '   [Shift 자유 배치 · , . 회전 15° · T+이동 회전 · L 도로 잠금 · Esc 취소]';
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
    // The command carries the target pose; the eased ghost jumps onto it.
    this.settle++;
    this.ctx.changed();
    const b = { id: this.ctx.ids().next('b'), typeId: type.id, pos: this.placement.pos, rotation: this.placement.rotation };
    const ghost = buildingFootprints(b, type).map(closedRing);
    this.ctx.dispatch({ type: 'building.place', building: b }, ghost);
  }

  onPointerMove(e: ToolPointer): void {
    this.hover = e.pos;
    this.shift = e.shift;
    this.recompute();
  }

  onPointerUp(): void {}

  onLeave(): void {
    // Hover-only state goes; the road lock and the chosen free angle survive a trip to the toolbar.
    this.turn = null;
    this.hover = null;
    this.placement = null;
    this.ctx.changed();
  }

  /** Window lost focus: key-up events will never arrive. */
  onBlur(): void {
    this.shift = false;
    this.onLeave();
  }

  private startTurn(): void {
    if (this.turn || !this.placement || !this.hover) return;
    this.turn = { gesture: new RotateGesture(this.placement.pos, this.placement.rotation, this.hover), at: performance.now(), rotation: this.placement.rotation };
    this.recompute();
  }

  /** Release T: keep the angle (a quick tap adds one 15° step) and stay unaligned from then on. */
  private endTurn(keep: boolean): void {
    const t = this.turn;
    this.turn = null;
    if (!t || !keep) return;
    const tap = performance.now() - t.at < TAP_MS && Math.abs(t.gesture.travelled) < TAP_TURN;
    const rotation = tap ? wrapAngle(t.gesture.base + ROT_STEP) : t.rotation;
    this.ctx.store.setToolOptions({ buildingRotation: rotation });
    this.manual = true;
    // Stay where the building stands; only the next pointer move re-places it.
    this.placement = { pos: t.gesture.anchor, rotation, segmentId: null };
    this.recompute(true);
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.code === 'KeyT') {
      if (e.type === 'keydown') {
        if (!e.repeat) this.startTurn();
      } else {
        this.endTurn(true);
      }
      return true;
    }
    if (e.key === ',' || e.key === '.') {
      const r = this.ctx.store.getState().toolOptions.buildingRotation + (e.key === ',' ? -ROT_STEP : ROT_STEP);
      this.ctx.store.setToolOptions({ buildingRotation: Math.atan2(Math.sin(r), Math.cos(r)) });
      this.recompute();
      return true;
    }
    if (e.code === 'KeyL') {
      if (e.type === 'keydown' && !e.repeat) {
        this.manual = false;
        const locked = this.solver.selector.toggleLock();
        this.ctx.store.toast(locked ? '도로 잠금: 이 도로에 계속 맞춥니다 (L로 해제)' : '도로 잠금 해제', 'info', 'road-lock');
        this.recompute();
      }
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
    this.turn = null;
    this.manual = false;
    this.solver.selector.clear();
    this.hover = null;
    this.placement = null;
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    const type = this.type();
    if (!type || !this.placement) return [];
    const polys = buildingFootprints(this.placement, type);
    const ring = closedRing(polys[0]!);
    // A rounded outline can have up to 128 corners: thin it evenly (closing point kept) so the presence
    // message stays within the protocol's limit (Sol P5d #2); peers only draw it as a hint.
    if (ring.length <= MAX_GHOST_POINTS) return ring;
    const step = (ring.length - 1) / (MAX_GHOST_POINTS - 1);
    return Array.from({ length: MAX_GHOST_POINTS }, (_, i) => ring[Math.round(i * step)]!);
  }

  preview(): ToolPreview {
    const type = this.type();
    if (!type || !this.placement) return { lines: [], points: [] };
    const color = this.status === 'ok' ? '#4ade80' : STATUS_COLORS[this.status];
    const step = this.ctx.store.getState().toolOptions.snapStep;
    return {
      lines: [
        ...placementGuide(this.placement, step).map((pts) => ({ pts, width: 0.12, color: '#e2e8f0' })),
        ...buildingFootprints(this.placement, type).map((poly) => ({ pts: closedRing(poly), width: 0.6, color })),
      ],
      points: [],
      building: { typeId: type.id, pos: this.placement.pos, rotation: this.placement.rotation, color, settle: this.settle },
    };
  }
}
