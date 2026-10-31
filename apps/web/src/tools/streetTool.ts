// Traffic facility tool (교통 시설): hover a road to see a ghost of the crosswalk / speed bump snapped to
// 0.5 m of arc length, green when the server would accept it and red (with the reason) when not.
// Modes: crosswalk, signalized crosswalk, speed bump, school zone (toggles a whole segment), remove.
// Clicking an existing crosswalk toggles its pedestrian signal; Delete / right click removes it;
// clicking a junction selects it so the inspector can set its control and per-leg crosswalks.

import {
  bumpSpans,
  carriagewayWidth,
  cumulativeLengths,
  medianWidth,
  pointAtLength,
  rightNormal,
  tangentAtLength,
  type CityDoc,
  type Command,
  type RoadFeature,
  type RoadFeatureKind,
  type Vec2,
} from '@smartcity/shared';
import { translateError, type StreetMode } from '../app/store';
import { highlightPreview } from './highlight';
import type { PickIndex } from './picking';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';
import { commandError } from './validate';

/** Arc-length snap of facilities, meters. */
export const FEATURE_SNAP = 0.5;
/** A click within this arc distance of an existing facility selects it instead of placing a new one. */
export const FEATURE_PICK = 2.5;
const GHOST_WIDTH: Record<RoadFeatureKind, number> = { crosswalk: 4, speedBump: 2 };
const OK = '#4ade80';
const BAD = '#ef4444';
const WARN = '#f97316';
const GHOST_ID = '__street_ghost__';

export interface FeatureProjection {
  segmentId: string;
  /** Arc length from node a, snapped to FEATURE_SNAP. */
  s: number;
  /** s / segment length. */
  t: number;
  length: number;
  point: Vec2;
  /** Unit vectors along the road and to its right. */
  tangent: Vec2;
  normal: Vec2;
  /** Half width of the carriageway, and of its median (0 without one). */
  halfWidth: number;
  medianHalf: number;
}

/** Project a ground point onto the nearest road: segment, arc length (0.5 m snap) and frame. */
export function projectOnSegment(doc: CityDoc, idx: PickIndex, pos: Vec2): FeatureProjection | null {
  const hit = idx.nearestSegment(pos);
  if (!hit) return null;
  const seg = doc.segments[hit.id];
  const rt = seg && doc.roadTypes[seg.roadTypeId];
  if (!seg || !rt) return null;
  const curve = hit.curve;
  const cum = cumulativeLengths(curve);
  const length = cum[cum.length - 1]!;
  if (length <= 0) return null;
  const s = Math.min(length, Math.max(0, Math.round(hit.s / FEATURE_SNAP) * FEATURE_SNAP));
  const tangent = tangentAtLength(curve, cum, s);
  return {
    segmentId: hit.id,
    s,
    t: s / length,
    length,
    point: pointAtLength(curve, cum, s),
    tangent,
    normal: rightNormal(tangent),
    halfWidth: carriagewayWidth(rt) / 2,
    medianHalf: medianWidth(rt) / 2,
  };
}

/** The facility of a segment closest to arc length `s` (within `within` meters), if any. */
export function featureNear(doc: CityDoc, segmentId: string, s: number, length: number, within = FEATURE_PICK): RoadFeature | null {
  let best: RoadFeature | null = null;
  let bestD = within;
  for (const f of Object.values(doc.features ?? {})) {
    if (f.segmentId !== segmentId) continue;
    const d = Math.abs(f.t * length - s);
    if (d <= bestD) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

/** Facility the mode places (null for modes that do not place one). */
export function featureOf(mode: StreetMode, id: string, p: Pick<FeatureProjection, 'segmentId' | 't'>): RoadFeature | null {
  switch (mode) {
    case 'crosswalk':
      return { id, segmentId: p.segmentId, kind: 'crosswalk', t: p.t, signal: false };
    case 'signalCrosswalk':
      return { id, segmentId: p.segmentId, kind: 'crosswalk', t: p.t, signal: true };
    case 'speedBump':
      return { id, segmentId: p.segmentId, kind: 'speedBump', t: p.t };
    default:
      return null;
  }
}

/** Error (English, as the server words it) for placing `feature`, or null when it is accepted. */
export function featureError(doc: CityDoc, feature: RoadFeature): string | null {
  return commandError(doc, { type: 'feature.upsert', feature });
}

/** Short Korean reason for the badge. */
export const featureReason = (error: string): string => translateError(error);

/** Ghost across the carriageway at the projection. */
export function crossingGhost(p: FeatureProjection): Vec2[] {
  return [
    { x: p.point.x - p.normal.x * p.halfWidth, z: p.point.z - p.normal.z * p.halfWidth },
    { x: p.point.x + p.normal.x * p.halfWidth, z: p.point.z + p.normal.z * p.halfWidth },
  ];
}

/** Ghost lines of a facility: a speed bump spans the driving areas only (not the median, as drawn), a crosswalk the whole carriageway. */
export function featureGhost(p: FeatureProjection, kind: RoadFeatureKind): Vec2[][] {
  if (kind !== 'speedBump') return [crossingGhost(p)];
  const at = (l: number): Vec2 => ({ x: p.point.x + p.normal.x * l, z: p.point.z + p.normal.z * l });
  return bumpSpans(p.halfWidth, p.medianHalf).map(([from, to]) => [at(from), at(to)]);
}

const MODE_HINT: Record<StreetMode, string> = {
  crosswalk: '도로 위를 클릭해 횡단보도(비신호)를 놓습니다',
  signalCrosswalk: '도로 위를 클릭해 신호 횡단보도를 놓습니다',
  speedBump: '도로 위를 클릭해 과속방지턱을 놓습니다',
  schoolZone: '도로를 클릭해 어린이보호구역을 켜고 끕니다',
  remove: '시설을 클릭하거나 Delete/우클릭으로 제거합니다',
};

type Hover =
  | { kind: 'place'; proj: FeatureProjection; feature: RoadFeature; error: string | null }
  | { kind: 'existing'; proj: FeatureProjection; feature: RoadFeature }
  | { kind: 'school'; segmentId: string; on: boolean }
  | { kind: 'node'; id: string };

export class StreetTool implements Tool {
  readonly id = 'street' as const;
  private hover: Hover | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
  ) {}

  private get doc(): CityDoc {
    return this.ctx.store.getState().doc;
  }

  private get mode(): StreetMode {
    return this.ctx.store.getState().toolOptions.streetMode;
  }

  /** Evaluate what is under the cursor for the current mode. */
  private resolve(pos: Vec2): Hover | null {
    const doc = this.doc;
    const idx = this.index();
    const node = idx.nearestNode(pos, 6);
    if (node) return { kind: 'node', id: node.id };
    const proj = projectOnSegment(doc, idx, pos);
    if (!proj) return null;
    const mode = this.mode;
    if (mode === 'schoolZone') return { kind: 'school', segmentId: proj.segmentId, on: !!doc.segments[proj.segmentId]?.schoolZone };
    const existing = featureNear(doc, proj.segmentId, proj.s, proj.length);
    if (existing) return { kind: 'existing', proj, feature: existing };
    if (mode === 'remove') return null;
    const feature = featureOf(mode, GHOST_ID, proj);
    if (!feature) return null;
    return { kind: 'place', proj, feature, error: featureError(doc, feature) };
  }

  private setHint(hover: Hover | null): void {
    let hint = MODE_HINT[this.mode];
    if (hover?.kind === 'place' && hover.error) hint = `놓을 수 없음: ${featureReason(hover.error)}`;
    else if (hover?.kind === 'place') hint = `${MODE_HINT[this.mode]} (구간 ${Math.round(hover.proj.s)}m 지점)`;
    else if (hover?.kind === 'existing') {
      const f = hover.feature;
      hint = this.mode === 'remove' ? '클릭하면 시설을 제거합니다' : f.kind === 'crosswalk' ? `클릭: 보행 신호 ${f.signal ? '끄기' : '켜기'} · Delete/우클릭: 제거` : '과속방지턱 · Delete/우클릭: 제거';
    } else if (hover?.kind === 'school') hint = hover.on ? '클릭하면 어린이보호구역을 해제합니다' : '클릭하면 이 도로를 어린이보호구역으로 지정합니다 (제한속도 30km/h)';
    else if (hover?.kind === 'node') hint = '클릭하면 교차로를 선택합니다 (속성 패널에서 신호·횡단보도 설정)';
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    const hover = this.resolve(e.pos);
    this.hover = hover;
    if (!hover) return;
    switch (hover.kind) {
      case 'node':
        this.ctx.store.set({ selection: { kind: 'node', id: hover.id }, panel: 'inspector', phaseHighlight: null });
        break;
      case 'school':
        this.ctx.dispatch({ type: 'segment.setSchoolZone', id: hover.segmentId, schoolZone: !hover.on });
        break;
      case 'existing': {
        const f = hover.feature;
        if (this.mode === 'remove') this.remove(f);
        else if (f.kind === 'crosswalk') this.ctx.dispatch({ type: 'feature.upsert', feature: { ...f, signal: !f.signal } }, [crossingGhost(hover.proj)]);
        break;
      }
      case 'place': {
        if (hover.error) {
          this.ctx.store.toast(`놓을 수 없음: ${featureReason(hover.error)}`, 'error', 'street');
          break;
        }
        const id = this.ctx.ids().next('f');
        const cmd: Command = { type: 'feature.upsert', feature: { ...hover.feature, id } };
        this.ctx.dispatch(cmd, [crossingGhost(hover.proj)]);
        break;
      }
    }
    this.ctx.changed();
  }

  private remove(f: RoadFeature): void {
    this.ctx.dispatch({ type: 'feature.remove', id: f.id });
  }

  onPointerMove(e: ToolPointer): void {
    this.hover = this.resolve(e.pos);
    this.setHint(this.hover);
    this.ctx.changed();
  }

  onPointerUp(): void {}

  /** Right click: remove the facility under the cursor (true = handled, the camera/cancel logic is skipped). */
  onSecondaryClick(): boolean {
    if (this.hover?.kind !== 'existing') return false;
    this.remove(this.hover.feature);
    this.hover = null;
    this.ctx.changed();
    return true;
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown' || (e.key !== 'Delete' && e.key !== 'Backspace')) return false;
    if (this.hover?.kind === 'existing') return this.onSecondaryClick();
    if (this.hover?.kind === 'school' && this.hover.on) {
      this.ctx.dispatch({ type: 'segment.setSchoolZone', id: this.hover.segmentId, schoolZone: false });
      return true;
    }
    return false;
  }

  onLeave(): void {
    this.cancel();
  }

  cancel(): void {
    this.hover = null;
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    const h = this.hover;
    return h && (h.kind === 'place' || h.kind === 'existing') ? crossingGhost(h.proj) : [];
  }

  preview(): ToolPreview {
    const out: ToolPreview = { lines: [], points: [] };
    const h = this.hover;
    if (!h) return out;
    const doc = this.doc;
    switch (h.kind) {
      case 'place':
        for (const pts of featureGhost(h.proj, h.feature.kind)) out.lines.push({ pts, width: GHOST_WIDTH[h.feature.kind], color: h.error ? BAD : OK });
        out.points.push({ pos: h.proj.point, radius: 1.2, color: h.error ? BAD : OK });
        break;
      case 'existing':
        for (const pts of featureGhost(h.proj, h.feature.kind)) out.lines.push({ pts, width: GHOST_WIDTH[h.feature.kind] + 0.6, color: this.mode === 'remove' ? BAD : '#fbbf24' });
        break;
      case 'school':
        return highlightPreview(doc, this.index(), { kind: 'segment', id: h.segmentId }, h.on ? WARN : OK);
      case 'node':
        out.points.push({ pos: doc.nodes[h.id]?.pos ?? { x: 0, z: 0 }, radius: 6, color: '#60a5fa' });
        break;
    }
    return out;
  }
}

/** Facilities of a segment sorted along it, for the inspector list. */
export function segmentFeatures(doc: CityDoc, segmentId: string): RoadFeature[] {
  return Object.values(doc.features ?? {})
    .filter((f) => f.segmentId === segmentId)
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}
