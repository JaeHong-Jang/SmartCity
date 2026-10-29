// Sensor tool (ADR 0013 §5): move the cursor near a road → the pole snaps to that side's sidewalk, looking
// along the travel direction (at the junction center when one is close). Before placing, the view sector and
// the lane stretches it really covers (the simulation's own `sensorCoverage`) are previewed; the coverage is
// computed at most once per animation frame. Wheel or , . rotates the view (Shift: 5°), dragging from the
// spot aims it at the cursor, a click (or the release of the drag) places it as one `sensor.place`.
// Esc resets the rotation.

import {
  cumulativeLengths,
  dot,
  rightNormal,
  roadHalfWidth,
  SENSOR_DEFAULTS,
  segmentsAtNode,
  sensorPose,
  slicePolyline,
  sub,
  tangentAtLength,
  type CityDoc,
  type Sensor,
  type SensorKind,
  type Vec2,
} from '@smartcity/shared';
import { sensorCoverage, type RoadGraph, type SensorCoverage } from '@smartcity/sim';
import { DragGesture } from './gesture';
import { bearing } from './roadTool';
import type { PickIndex } from './picking';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

/** Kind names and one-line descriptions shown in the tool options and the inspector. */
export const SENSOR_KIND_INFO: Record<SensorKind, { label: string; short: string; desc: string }> = {
  cctv: { label: 'CCTV', short: 'CCTV', desc: '영상 감시 · 부채꼴 · 사고·화재 감지' },
  radar: { label: '레이더 검지기', short: '레이더', desc: '좁고 긴 범위 · 속도 저하로 사고 감지' },
  smartpole: { label: '스마트폴', short: '스마트폴', desc: '360° 짧은 범위 · 사고·화재 감지' },
};
/** Every sensor value is a game model value (ADR 0013 §4); the coverage ignores buildings in the way. */
export const SENSOR_MODEL_NOTE = '보정 전 모의 값 · 건물 가림 미반영';

const DEG = Math.PI / 180;
/** A spot is offered within this distance of the road's outer edge (sidewalk included), meters. */
const SNAP_MARGIN = 8;
/** Look at the junction center when the mount point is this close to it (arc length), meters. */
export const JUNCTION_AIM = 40;
/** Shown when the pressed road changed (e.g. a collaborator's fillet) before the release. */
export const ROAD_CHANGED = '도로가 바뀌어 설치를 취소했습니다 — 다시 클릭하세요';

/**
 * Geometry a spot (segmentId, t, side) depends on: its road's end points, control point and road type. A press
 * whose road changed before the release would put the same t somewhere else (fillet, node move), so it is dropped.
 */
export function roadSignature(doc: CityDoc, segmentId: string): string {
  const seg = doc.segments[segmentId];
  if (!seg) return '';
  return JSON.stringify([doc.nodes[seg.a]?.pos, doc.nodes[seg.b]?.pos, seg.control ?? null, doc.roadTypes[seg.roadTypeId] ?? null]);
}

/** Id of not-yet-placed sensors (previews). */
const PREVIEW_ID = '_preview';
export const SECTOR_COLOR = '#38bdf8';
export const COVERED_COLOR = '#facc15';

/** Angle in (−π, π]. */
export function wrapPi(a: number): number {
  const r = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  return r <= -Math.PI ? r + 2 * Math.PI : r;
}

export interface SensorSpot {
  segmentId: string;
  t: number;
  side: 'left' | 'right';
  /** Default heading (relative to the road tangent at t, ADR 0013 §4): travel direction, or the junction center. */
  heading: number;
  /** Mount point and the road tangent angle there (atan2(z, x)). */
  pos: Vec2;
  tangent: number;
}

/** Junction (three roads or more) at the end of a segment. */
function isJunction(doc: CityDoc, nodeId: string): boolean {
  return segmentsAtNode(doc, nodeId).length >= 3;
}

/**
 * Where a sensor placed at the cursor `p` would stand: the nearest road whose sidewalk (curb) is within
 * SNAP_MARGIN, on the side of the centerline the cursor is on. Null = no road close enough.
 */
export function sensorSpot(doc: CityDoc, idx: PickIndex, p: Vec2): SensorSpot | null {
  const hit = idx.nearestSegment(p, 40);
  const seg = hit ? doc.segments[hit.id] : undefined;
  const rt = seg ? doc.roadTypes[seg.roadTypeId] : undefined;
  if (!hit || !seg || !rt || hit.distance > roadHalfWidth(rt) + SNAP_MARGIN || hit.length <= 0) return null;
  const cum = cumulativeLengths(hit.curve);
  const s = Math.min(hit.length, Math.max(0, hit.s));
  const tan = tangentAtLength(hit.curve, cum, Math.max(1e-6, s));
  const side: 'left' | 'right' = dot(sub(p, hit.point), rightNormal(tan)) >= 0 ? 'right' : 'left';
  const t = s / hit.length;
  // Travel direction next to that side (right-hand traffic): forward lanes run a → b on the right.
  const travel = rt.lanesBackward === 0 ? 0 : rt.lanesForward === 0 ? Math.PI : side === 'right' ? 0 : Math.PI;
  const pose = sensorPose(doc, { id: PREVIEW_ID, kind: 'cctv', segmentId: seg.id, t, side, heading: 0, fov: 1, range: 10 });
  if (!pose) return null;
  const tangent = pose.yaw;
  let heading = travel;
  const ends: [string, number][] = [
    [seg.a, s],
    [seg.b, hit.length - s],
  ];
  ends.sort((x, y) => x[1] - y[1]);
  for (const [nodeId, d] of ends) {
    const n = doc.nodes[nodeId];
    if (!n || d > JUNCTION_AIM || !isJunction(doc, nodeId)) continue;
    heading = Math.atan2(n.pos.z - pose.pos.z, n.pos.x - pose.pos.x) - tangent;
    break;
  }
  return { segmentId: seg.id, t, side, heading: wrapPi(heading), pos: pose.pos, tangent };
}

/** The sensor a spot would become (kind defaults for fov and range). */
export function sensorAt(spot: SensorSpot, id: string, kind: SensorKind, heading: number): Sensor {
  const d = SENSOR_DEFAULTS[kind];
  return { id, kind, segmentId: spot.segmentId, t: spot.t, side: spot.side, heading: wrapPi(heading), fov: d.fov, range: d.range };
}

/** Closed outline of a view sector (apex → arc → apex); a full circle for 360°. At most 34 points. */
export function sectorOutline(pos: Vec2, yaw: number, fov: number, range: number): Vec2[] {
  const full = fov >= 2 * Math.PI - 1e-6;
  const steps = Math.max(4, Math.ceil((Math.min(fov, 2 * Math.PI) / (2 * Math.PI)) * 32));
  const out: Vec2[] = full ? [] : [pos];
  const a0 = full ? 0 : yaw - fov / 2;
  const span = full ? 2 * Math.PI : fov;
  for (let i = 0; i <= (full ? steps - 1 : steps); i++) {
    const a = a0 + (span * i) / steps;
    out.push({ x: pos.x + Math.cos(a) * range, z: pos.z + Math.sin(a) * range });
  }
  out.push(full ? out[0]! : pos);
  return out;
}

/** Compass bearing (0 = north = −z, clockwise, integer degrees) of a view direction. */
export function sensorBearing(pos: Vec2, yaw: number): number {
  return Math.round(bearing(pos, { x: pos.x + Math.cos(yaw), z: pos.z + Math.sin(yaw) })) % 360;
}

/** Polylines of the covered lane stretches. */
export function coveredLanes(graph: RoadGraph, cov: SensorCoverage): Vec2[][] {
  const out: Vec2[][] = [];
  for (const iv of cov.lanes) {
    const li = graph.laneById.get(iv.laneId);
    const lane = li === undefined ? undefined : graph.lanes[li];
    if (!lane) continue;
    const pts = slicePolyline(lane.points, iv.sFrom, Math.max(iv.sTo, iv.sFrom + 0.5));
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

/** Runs `cb` on the next animation frame (synchronously where there is none: tests). */
export type FrameScheduler = (cb: () => void) => void;
const nextFrame: FrameScheduler = (cb) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else cb();
};

export class SensorTool implements Tool {
  readonly id = 'sensor' as const;
  private spot: SensorSpot | null = null;
  private cursor: Vec2 | null = null;
  /** User rotation on top of the default heading (wheel, , .), radians. */
  private turn = 0;
  private gesture = new DragGesture();
  /** Spot and absolute aim of a press-drag (the spot stays where the press was). */
  private press: { spot: SensorSpot; aim: number | null; road: string } | null = null;
  private coverage: { key: string; graph: RoadGraph; cov: SensorCoverage } | null = null;
  private framePending = false;

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
    private readonly schedule: FrameScheduler = nextFrame,
  ) {}

  private get doc(): CityDoc {
    return this.ctx.store.getState().doc;
  }

  private get kind(): SensorKind {
    return this.ctx.store.getState().toolOptions.sensorKind;
  }

  /** What would be placed now (the pressed spot while dragging), or null. */
  candidate(): Sensor | null {
    const p = this.press;
    if (p) return sensorAt(p.spot, PREVIEW_ID, this.kind, p.aim === null ? p.spot.heading + this.turn : p.aim - p.spot.tangent);
    return this.spot ? sensorAt(this.spot, PREVIEW_ID, this.kind, this.spot.heading + this.turn) : null;
  }

  private key(s: Sensor): string {
    return `${s.kind}|${s.segmentId}|${s.t}|${s.side}|${s.heading}|${this.ctx.store.getState().docVersion}`;
  }

  /** Coverage of the candidate, recomputed at most once per frame (only when the candidate changed). */
  private requestCoverage(): void {
    if (this.framePending) return;
    this.framePending = true;
    this.schedule(() => {
      this.framePending = false;
      const c = this.candidate();
      const graph = this.ctx.roadGraph?.() ?? null;
      if (!c || !graph) return;
      const key = this.key(c);
      if (this.coverage && this.coverage.key === key && this.coverage.graph === graph) return;
      this.coverage = { key, graph, cov: sensorCoverage(this.doc, graph, c) };
      this.ctx.changed();
    });
  }

  /** Coverage of the current candidate if it is up to date (null while it is being computed). */
  previewCoverage(): SensorCoverage | null {
    const c = this.candidate();
    const cv = this.coverage;
    return c && cv && cv.key === this.key(c) && cv.graph === (this.ctx.roadGraph?.() ?? null) ? cv.cov : null;
  }

  private hint(): void {
    const info = SENSOR_KIND_INFO[this.kind];
    const hint = this.spot || this.press
      ? `${info.label} · 클릭 설치 · 드래그로 방향 지정 · 휠 / , . 회전 (Shift 5°) · Esc 회전 초기화 · ${SENSOR_MODEL_NOTE}`
      : `${info.label}을(를) 놓을 도로 가까이에 커서를 두세요 · ${SENSOR_MODEL_NOTE}`;
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.cursor = e.pos;
    this.spot = sensorSpot(this.doc, this.index(), e.pos);
    this.gesture.down(e.client.x, e.client.y);
    this.press = this.spot ? { spot: this.spot, aim: null, road: roadSignature(this.doc, this.spot.segmentId) } : null;
    if (!this.press && this.ctx.pan.start(e.client.x, e.client.y)) return;
    this.ctx.changed();
  }

  onPointerMove(e: ToolPointer): void {
    this.cursor = e.pos;
    if (this.gesture.phase === 'pressed') this.gesture.move(e.client.x, e.client.y);
    if (this.gesture.phase !== 'idle' && !this.press) {
      // Dragging from off the road pans the view.
      this.ctx.pan.move(e.client.x, e.client.y);
      return;
    }
    if (this.press && this.pressStale()) this.dropPress();
    if (this.press) {
      if (this.gesture.phase === 'dragging') {
        const at = this.press.spot.pos;
        if (Math.hypot(e.pos.x - at.x, e.pos.z - at.z) > 1) this.press.aim = Math.atan2(e.pos.z - at.z, e.pos.x - at.x);
      }
    } else {
      this.spot = sensorSpot(this.doc, this.index(), e.pos);
    }
    this.hint();
    this.requestCoverage();
    this.ctx.changed();
  }

  onPointerUp(e: ToolPointer): void {
    const phase = this.gesture.up();
    const press = this.press;
    this.press = null;
    if (!press) {
      this.ctx.pan.end();
      this.onPointerMove({ ...e, button: -1 });
      return;
    }
    if ((phase === 'pressed' || phase === 'dragging') && roadSignature(this.doc, press.spot.segmentId) !== press.road) {
      this.ctx.store.toast(ROAD_CHANGED, 'error', 'sensor-road');
    } else if (phase === 'pressed' || phase === 'dragging') {
      const heading = press.aim === null ? press.spot.heading + this.turn : press.aim - press.spot.tangent;
      const sensor = sensorAt(press.spot, this.ctx.ids().next('sn'), this.kind, heading);
      const pose = sensorPose(this.doc, sensor);
      this.ctx.dispatch({ type: 'sensor.place', sensor }, pose ? [sectorOutline(pose.pos, pose.yaw, sensor.fov, sensor.range)] : []);
    }
    this.spot = sensorSpot(this.doc, this.index(), e.pos);
    this.requestCoverage();
    this.ctx.changed();
  }

  /** The pressed road changed since the press (the controller re-runs onPointerMove on every doc change). */
  private pressStale(): boolean {
    return !!this.press && roadSignature(this.doc, this.press.spot.segmentId) !== this.press.road;
  }

  /** Cancel the press of a changed road; the rest of the gesture does nothing. */
  private dropPress(): void {
    this.press = null;
    this.gesture.cancel();
    this.ctx.store.toast(ROAD_CHANGED, 'error', 'sensor-road');
  }

  private rotate(by: number): void {
    this.turn = wrapPi(this.turn + by);
    this.requestCoverage();
    this.ctx.changed();
  }

  onWheel(e: WheelEvent): boolean {
    // Only while a spot is offered: elsewhere the wheel keeps zooming.
    if (!this.spot && !this.press) return false;
    const delta = e.deltaY || e.deltaX;
    if (delta) this.rotate(Math.sign(delta) * (e.shiftKey ? 5 : 15) * DEG);
    return true;
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return false;
    // By physical key: with Shift held the characters are < and > on most layouts.
    if (e.code === 'Comma' || e.code === 'Period') {
      this.rotate((e.code === 'Comma' ? -1 : 1) * (e.shiftKey ? 5 : 15) * DEG);
      return true;
    }
    if (e.key === 'Escape') {
      this.gesture.cancel();
      this.press = null;
      this.turn = 0;
      this.requestCoverage();
      this.ctx.changed();
      return true;
    }
    return false;
  }

  onLeave(): void {
    if (this.gesture.phase !== 'idle') return;
    this.spot = null;
    this.cursor = null;
    this.ctx.changed();
  }

  cancel(): void {
    if (this.gesture.phase !== 'idle' && !this.press) this.ctx.pan.end();
    this.gesture.cancel();
    this.gesture.up();
    this.press = null;
    this.spot = null;
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    const c = this.candidate();
    const pose = c ? sensorPose(this.doc, c) : null;
    return c && pose ? sectorOutline(pose.pos, pose.yaw, c.fov, c.range) : [];
  }

  preview(): ToolPreview {
    const out: ToolPreview = { lines: [], points: [] };
    const c = this.candidate();
    const pose = c ? sensorPose(this.doc, c) : null;
    if (!c || !pose) return out;
    out.sectors = [{ pos: pose.pos, yaw: pose.yaw, fov: c.fov, range: c.range, color: SECTOR_COLOR }];
    out.lines.push({ pts: sectorOutline(pose.pos, pose.yaw, c.fov, c.range), width: 0.5, color: SECTOR_COLOR });
    const cov = this.previewCoverage();
    const graph = this.ctx.roadGraph?.() ?? null;
    if (cov && graph) for (const pts of coveredLanes(graph, cov)) out.lines.push({ pts, width: 2.2, color: COVERED_COLOR });
    out.points.push({ pos: pose.pos, radius: 1.2, color: '#f8fafc' });
    const lanes = cov ? `차선 구간 ${cov.lanes.length}개` : '커버리지 계산 중';
    out.label = { pos: this.cursor ?? pose.pos, text: `${SENSOR_KIND_INFO[c.kind].short} · 방위 ${sensorBearing(pose.pos, pose.yaw)}° · ${lanes} · 건물 가림 미반영` };
    return out;
  }
}
