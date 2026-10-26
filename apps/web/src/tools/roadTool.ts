// Road tool (ADR 0012 §2). Three modes, every committed piece goes through the shared planner, and the
// preview always shows that same plan:
// - straight: click (or drag) piece by piece; magnet snapping (road end > road > 15° angle guide > grid,
//   screen-pixel hysteresis), length/angle label; automatic fillet of the stroke's corners (T, §1).
// - curve (C): from a road's dead end or the previous piece the curve leaves along that tangent with the
//   control point half a chord out; press on the end point and drag to move the handle along the tangent.
//   From empty space: start, control, end (3 clicks), or press on the start and drag to aim the tangent.
// - free (B): drag a path → RDP → quadratic B-spline pieces in one batch; the final curve is checked
//   (self-crossing, minimum radius, length, crossings) and refused with the reason, never bent to fit.
// Enter, a double click (no extra point) or [완료] finishes the stroke; Esc cancels; Shift = no snapping.

import {
  filletFloor,
  IdGen,
  planRoad,
  planRoadChain,
  polylineLength,
  scratchDoc,
  tryApplyCommand,
  type Command,
  resolvePoint,
  roadHalfWidth,
  sampleSegmentCurve,
  normalize,
  sub,
  dist,
  MAX_GHOST_POINTS,
  type ChainPlan,
  type ResolvedPoint,
  type RoadPlan,
  type Vec2,
} from '@smartcity/shared';
import { translateError, type ClientStore, type RoadMode } from '../app/store';
import {
  bearingDeg,
  boxAround,
  dashes,
  neighbourhoodDoc,
  quadFoldsBack,
  RoadIndex,
  defaultControl,
  endTangent,
  finalCurveProblem,
  handleControl,
  isDoubleClick,
  pieceCurves,
  pieceLabel,
  quadMinRadius,
  rdpTolerance,
  SNAP_LABEL,
  snapCursor,
  strokePieces,
  type ClickStamp,
  type SnapHold,
  type SnapResult,
  type SplinePiece,
  type StrokePiece,
} from './drawInput';
import { DragGesture } from './gesture';
import { RemovalPreview, removalLines } from './removalPreview';
import { snapLabel } from './snap';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

const previewIds = new IdGen('preview');
const AUTO_FILLET_KEY = 'smartcity.road.autoFillet';
const DEFAULT_M_PER_PX = 0.5;
const SNAP_COLORS = { node: '#4ade80', road: '#fb923c', angle: '#facc15', grid: '#f8fafc', free: '#94a3b8' } as const;
const OK = '#7dd3fc';
const BAD = '#f87171';

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
export const bearing = bearingDeg;

export const ROAD_MODE_LABEL: Record<RoadMode, string> = { straight: '직선', curve: '곡선', free: '자유' };

type Drag = 'straight' | 'handle' | 'tangent' | 'free';

interface FreePlan {
  /** What is drawn: the planned roads once planned (exactly what is sent), else the spline from the stroke. */
  pieces: SplinePiece[];
  plan: ChainPlan | null;
  error: string | null;
}

/** Planning only looks this far around the piece or stroke (snap radii, overlap, lot pruning all fit). */
const PLAN_MARGIN = 60;

export class RoadTool implements Tool {
  readonly id = 'road' as const;
  /** Start of the piece being drawn (null = no stroke). */
  private start: ResolvedPoint | null = null;
  /** Curves: direction the next piece leaves `start` in (previous piece, a dead-end road, or aimed by a drag). */
  private tangent: Vec2 | null = null;
  /** Straight: direction of the previous piece (relative angle guides). */
  private prevDir: Vec2 | null = null;
  /** Curves: control point clicked (3-click) or dragged by the handle. */
  private control: Vec2 | null = null;
  private hover: Vec2 | null = null;
  private shift = false;
  private mPerPx = DEFAULT_M_PER_PX;
  /** What the hover snapped to, and the hysteresis hold. */
  private snap: SnapResult | null = null;
  private held: SnapHold | null = null;
  private plan: RoadPlan | null = null;
  /** End node of the straight piece committed last in this stroke (a new node): the next corner to round. */
  private corner: string | null = null;
  private readonly gesture = new DragGesture();
  private press: { pos: Vec2; snap: SnapResult } | null = null;
  private drag: Drag | null = null;
  /** Curve handle drag: the end is fixed where the press was. */
  private endFixed: SnapResult | null = null;
  /** Free mode: raw stroke and its plan. */
  private path: Vec2[] = [];
  private freeStart: SnapResult | null = null;
  private free: FreePlan | null = null;
  private lastClick: ClickStamp | null = null;
  /** Pointer-move replans (each may dry-run on a scratch doc): ≥ 1 px moves, at most once per frame, none when idle. */
  private lastClient: { x: number; y: number; doc: number; step: number } | null = null;
  private frame = false;
  private readonly removal = new RemovalPreview();
  private roadIndex: { version: number; index: RoadIndex } | null = null;

  constructor(private readonly ctx: ToolContext) {
    const stored = storedAutoFillet();
    if (stored !== null && stored !== this.opts.autoFillet) ctx.store.setToolOptions({ autoFillet: stored });
  }

  private get opts() {
    return this.ctx.store.getState().toolOptions;
  }

  private get doc() {
    return this.ctx.store.getState().doc;
  }

  private get mode(): RoadMode {
    return this.opts.roadMode;
  }

  /** Spatial index of the roads, rebuilt only when the doc changes. */
  private get index(): RoadIndex {
    const v = this.ctx.store.getState().docVersion;
    if (!this.roadIndex || this.roadIndex.version !== v || this.roadIndex.index.doc !== this.doc) this.roadIndex = { version: v, index: new RoadIndex(this.doc) };
    return this.roadIndex.index;
  }

  /** The doc around `pts` that planning can touch (see neighbourhoodDoc). */
  private local(pts: readonly Vec2[]): ReturnType<typeof neighbourhoodDoc> {
    return neighbourhoodDoc(this.doc, this.index, boxAround(pts, PLAN_MARGIN));
  }

  /** The final batch must apply to the WHOLE doc (planning saw only the neighbourhood): the reason, or null. */
  private wholeDocProblem(cmd: Command): string | null {
    const r = tryApplyCommand(scratchDoc(this.doc), cmd);
    return r.ok ? null : r.error;
  }

  // ---------- snapping and planning ----------

  /** Start as the planner takes it now: a free start becomes the node committed there. */
  private startRef(): ResolvedPoint | null {
    const s = this.start;
    if (!s) return null;
    const doc = this.doc;
    if (s.kind === 'node' && doc.nodes[s.nodeId]) return s;
    for (const n of Object.values(doc.nodes)) if (dist(n.pos, s.pos) < 1e-6) return { kind: 'node', nodeId: n.id, pos: n.pos };
    return s.kind === 'split' ? resolvePoint(doc, s.pos, false) : { kind: 'free', pos: s.pos };
  }

  /** Directions the angle guides are relative to: the roads at the start, and the previous piece. */
  private refDirs(start: ResolvedPoint): Vec2[] {
    const out: Vec2[] = [];
    if (this.prevDir) out.push(this.prevDir);
    if (start.kind === 'node') {
      const doc = this.doc;
      for (const s of Object.values(doc.segments)) {
        if (s.a !== start.nodeId && s.b !== start.nodeId) continue;
        const next = s.control ?? doc.nodes[s.a === start.nodeId ? s.b : s.a]!.pos;
        out.push(normalize(sub(next, start.pos)));
      }
    }
    return out;
  }

  /** Snap a point; `guides`: angle guides from the stroke's start (straight pieces only). */
  private snapAt(p: Vec2, guides: boolean): SnapResult {
    const start = guides ? this.startRef() : null;
    const r = snapCursor({
      doc: this.doc,
      cursor: p,
      mPerPx: this.mPerPx,
      gridStep: this.opts.snapStep,
      from: start?.pos ?? null,
      refDirs: start ? this.refDirs(start) : [],
      held: this.held,
      disabled: this.shift,
      index: this.index,
    });
    this.held = r.kind === 'free' ? null : { kind: r.kind, id: r.id };
    return r;
  }

  /** Plan one piece; straight pieces from the stroke's last corner also round that corner (§1). */
  private planPiece(end: ResolvedPoint, control: Vec2 | undefined, ids: IdGen): RoadPlan {
    const start = this.startRef()!;
    const filletStart = this.mode === 'straight' && this.opts.autoFillet && !control && this.corner !== null && start.kind === 'node' && start.nodeId === this.corner;
    const doc = this.local(control ? [start.pos, end.pos, control] : [start.pos, end.pos]);
    const plan = planRoad(doc, { start, end, control, roadTypeId: this.opts.roadTypeId, filletStart }, ids);
    const rt = this.doc.roadTypes[this.opts.roadTypeId];
    if (plan.command && control && quadFoldsBack(start.pos, control, end.pos)) return { command: null, error: '곡선이 제자리에서 되돌아갑니다', junctions: plan.junctions };
    if (plan.command && control && rt) {
      const r = quadMinRadius(start.pos, control, end.pos);
      const floor = filletFloor(rt);
      if (r < floor - 1e-9) return { command: null, error: `곡선이 너무 급합니다 (최소 반경 ${r.toFixed(1)} m < ${floor.toFixed(1)} m)`, junctions: plan.junctions };
    }
    return plan;
  }

  /** The control point of the curve piece ending at `end` (null: the control still has to be clicked). */
  private curveControl(end: Vec2): Vec2 | null {
    if (this.control) return this.control;
    const start = this.startRef();
    return start && this.tangent ? defaultControl(start.pos, this.tangent, end) : null;
  }

  /** End and control of the piece under the cursor (null: nothing to plan yet). */
  private pending(): { end: SnapResult; control?: Vec2 } | null {
    if (!this.start || !this.hover) return null;
    if (this.mode === 'straight') return this.snap ? { end: this.snap } : null;
    if (this.mode !== 'curve') return null;
    if (this.drag === 'handle' && this.endFixed && this.control) return { end: this.endFixed, control: this.control };
    if (this.drag === 'tangent' || !this.snap) return null;
    const c = this.curveControl(this.snap.pos);
    return c ? { end: this.snap, control: c } : null;
  }

  private planFree(endPos: Vec2, ids: IdGen): FreePlan {
    const doc = this.doc;
    const rt = doc.roadTypes[this.opts.roadTypeId];
    const fail = (error: string, pieces: SplinePiece[] = []): FreePlan => ({ pieces, plan: null, error });
    if (!rt || !this.freeStart) return fail('알 수 없는 도로 타입');
    const end = this.snapAt(endPos, false);
    this.snap = end;
    const path = [this.freeStart.pos, ...this.path.slice(1), end.pos];
    const local = this.local(path);
    const roads = Object.values(local.segments).map((s) => ({ id: s.id, pts: sampleSegmentCurve(local.nodes[s.a]!.pos, local.nodes[s.b]!.pos, s.control) }));
    const pieces: StrokePiece[] = strokePieces(path, roads, rdpTolerance(this.mPerPx));
    if (pieces.length === 0 || polylineLength(path) < 1) return fail('드래그해서 길을 그리세요');
    const floor = filletFloor(rt);
    // Early reason from the stroke's spline; the verdict is on the planned geometry below.
    const early = finalCurveProblem(pieces, floor);
    if (early) return fail(early, pieces);
    const plan = planRoadChain(local, { start: this.freeStart.ref, end: end.ref, roadTypeId: rt.id, pieces: pieces.map((p) => ({ pos: p.to, control: p.control, road: p.crossing })) }, ids);
    if (!plan.command) return fail(translateError(plan.error ?? '도로를 놓을 수 없습니다'), pieces);
    // The roads actually added (crossings resolved, roads split): preview and checks use exactly these.
    const added: SplinePiece[] = plan.added.map((a) => ({ from: a.a, to: a.b, ...(a.control ? { control: a.control } : {}) }));
    const problem = finalCurveProblem(added, floor);
    if (problem) return fail(problem, added);
    return { pieces: added, plan, error: null };
  }

  private replan(): void {
    this.plan = null;
    if (this.mode === 'free') {
      this.free = this.drag === 'free' && this.hover ? this.planFree(this.hover, previewIds) : null;
      if (!this.drag && this.hover) this.snap = this.snapAt(this.hover, false);
    } else if (this.hover && this.drag !== 'handle') {
      this.snap = this.snapAt(this.hover, this.mode === 'straight' && !!this.start);
    }
    const p = this.pending();
    if (p) this.plan = this.planPiece(p.end.ref, p.control, previewIds);
    this.updateHint();
    this.ctx.changed();
  }

  private requestReplan(): void {
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

  private updateHint(): void {
    const mode = this.mode;
    let hint = '';
    if (mode === 'free') hint = this.drag === 'free' ? (this.free?.error ?? '놓으면 도로를 만듭니다') : '자유 그리기: 누른 채 끌어서 길을 그리세요';
    else if (!this.start) hint = mode === 'curve' ? '곡선 도로: 시작점을 클릭하세요 (기존 도로 끝에서 시작하면 접선을 이어받습니다)' : '도로 시작점을 클릭하세요';
    else if (mode === 'curve' && this.drag === 'tangent') hint = '끌어서 곡선이 나가는 방향을 정하세요';
    else if (mode === 'curve' && !this.tangent && !this.control) hint = '곡선의 휘는 지점(제어점)을 클릭하세요 · 또는 시작점에서 끌어 방향 지정';
    else {
      const p = this.pending();
      if (p) {
        const start = this.startRef()!;
        const pts = sampleSegmentCurve(start.pos, p.end.pos, p.control);
        hint = `길이 ${polylineLength(pts).toFixed(1)}m · 방위 ${bearingDeg(start.pos, p.end.pos).toFixed(0)}°`;
        const crossings = this.plan ? Math.max(0, this.plan.junctions.length - 2) : 0;
        if (crossings > 0) hint += ` · 교차 ${crossings}곳`;
        if (this.plan?.error) hint += ` · ${translateError(this.plan.error)}`;
        if (this.plan?.fillet) hint += ' · 모서리 둥글게';
        if (this.plan?.filletError) hint += ` · 모서리 유지: ${translateError(this.plan.filletError)}`;
      }
    }
    // Kept short: the hint bar sits over the viewport (the full key list is in the road tool panel).
    hint += `   [${ROAD_MODE_LABEL[mode]} · T 둥글게 ${this.opts.autoFillet ? '켬' : '끔'} · G 격자 ${snapLabel(this.opts.snapStep)} · Esc 취소]`;
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  // ---------- committing ----------

  /** Commit the piece from `start` to `end`; the stroke continues from its end. */
  private commit(end: SnapResult, control: Vec2 | undefined): void {
    const start = this.startRef();
    if (!start) return;
    const plan = this.planPiece(end.ref, control, this.ctx.ids());
    const problem = plan.command ? this.wholeDocProblem(plan.command) : (plan.error ?? '도로를 놓을 수 없습니다');
    if (!plan.command || problem) {
      this.ctx.store.toast(translateError(problem ?? '도로를 놓을 수 없습니다'), 'error');
      return;
    }
    const ghost = [sampleSegmentCurve(plan.fillet?.onNew ?? start.pos, end.pos, control)];
    if (plan.fillet) ghost.push(plan.fillet.curve);
    this.ctx.dispatch(plan.command, ghost);
    // A new straight end is the next corner to round automatically.
    const added = plan.command.type === 'batch' ? plan.command.commands.filter((c) => c.type === 'segment.add') : [];
    const last = added[added.length - 1];
    this.corner = this.mode === 'straight' && end.ref.kind === 'free' && last?.type === 'segment.add' ? last.segment.b : null;
    const dir = normalize(sub(end.pos, control ?? start.pos));
    this.tangent = dir;
    this.prevDir = control ? null : dir;
    this.start = end.ref.kind === 'node' ? end.ref : { kind: 'free', pos: end.pos };
    this.control = null;
  }

  private commitFree(endPos: Vec2): void {
    const f = this.planFree(endPos, this.ctx.ids());
    const problem = f.plan?.command ? this.wholeDocProblem(f.plan.command) : (f.error ?? '도로를 놓을 수 없습니다');
    if (!f.plan?.command || problem) {
      this.ctx.store.toast(translateError(problem ?? '도로를 놓을 수 없습니다'), 'error');
      return;
    }
    this.ctx.dispatch(f.plan.command, pieceCurves(f.pieces));
  }

  /** Begin a stroke at a snapped point (curves inherit a dead-end road's tangent). */
  private begin(at: SnapResult): void {
    this.start = at.ref;
    this.control = null;
    this.corner = null;
    this.prevDir = null;
    this.tangent = at.ref.kind === 'node' ? endTangent(this.doc, at.ref.nodeId) : null;
  }

  /** Enter / double click / [완료]: the stroke ends; committed pieces stay. */
  finish(): void {
    this.start = null;
    this.tangent = null;
    this.prevDir = null;
    this.control = null;
    this.corner = null;
    this.plan = null;
    this.drag = null;
    this.endFixed = null;
    this.path = [];
    this.free = null;
    this.removal.reset();
    this.updateHint();
    this.ctx.changed();
  }

  // ---------- input ----------

  private pointerState(e: ToolPointer): void {
    if (e.mPerPx && Number.isFinite(e.mPerPx) && e.mPerPx > 0) this.mPerPx = e.mPerPx;
    this.shift = e.shift;
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointerState(e);
    this.gesture.down(e.client.x, e.client.y);
    this.hover = e.pos;
    const guides = this.mode === 'straight' && !!this.start;
    this.press = { pos: e.pos, snap: this.snapAt(e.pos, guides) };
  }

  onPointerMove(e: ToolPointer): void {
    this.pointerState(e);
    // The controller re-sends the last pointer when the doc or the snap step changes: always replan then.
    const st = this.ctx.store.getState();
    const last = this.lastClient;
    if (last && last.doc === st.docVersion && last.step === st.toolOptions.snapStep && Math.abs(e.client.x - last.x) < 1 && Math.abs(e.client.y - last.y) < 1) return;
    this.lastClient = { x: e.client.x, y: e.client.y, doc: st.docVersion, step: st.toolOptions.snapStep };
    this.hover = e.pos;
    if (this.gesture.move(e.client.x, e.client.y) && this.press) this.startDrag(this.press);
    if (this.drag === 'free') {
      const prev = this.path[this.path.length - 1];
      if (!prev || dist(prev, e.pos) >= Math.max(0.5, 2 * this.mPerPx)) this.path.push(e.pos);
    } else if (this.drag === 'handle' && this.tangent) {
      const start = this.startRef();
      if (start) this.control = handleControl(start.pos, this.tangent, e.pos);
    }
    this.requestReplan();
  }

  private startDrag(press: { pos: Vec2; snap: SnapResult }): void {
    if (this.mode === 'free') {
      this.drag = 'free';
      this.freeStart = press.snap;
      this.path = [press.snap.pos];
      return;
    }
    if (this.mode === 'straight') {
      this.drag = 'straight';
      if (!this.start) this.begin(press.snap);
      return;
    }
    // Curves.
    if (this.start && this.tangent) {
      this.drag = 'handle';
      this.endFixed = this.snapAt(press.pos, false);
      this.control = handleControl(this.startRef()!.pos, this.tangent, press.pos);
    } else if (!this.control) {
      this.drag = 'tangent';
      if (!this.start) this.begin(press.snap);
    } else {
      this.drag = 'straight';
    }
  }

  onPointerUp(e: ToolPointer): void {
    this.pointerState(e);
    const phase = this.gesture.up();
    const drag = this.drag;
    this.drag = null;
    this.hover = e.pos;
    if (phase === 'pressed') {
      // The click uses where the button was released, exactly as the preview shows it now.
      this.replan();
      this.click(e);
    }
    else if (phase === 'dragging') {
      if (drag === 'free') {
        this.commitFree(e.pos);
        this.path = [];
        this.free = null;
        this.freeStart = null;
      } else if (drag === 'handle' && this.endFixed && this.control) {
        this.commit(this.endFixed, this.control);
      } else if (drag === 'tangent') {
        const start = this.startRef();
        if (start && dist(start.pos, e.pos) > 1) this.tangent = normalize(sub(e.pos, start.pos));
      } else if (drag === 'straight' && this.start) {
        const end = this.snapAt(e.pos, this.mode === 'straight');
        if (this.mode === 'straight') this.commit(end, undefined);
        else if (this.control) this.commit(end, this.control);
      }
      this.endFixed = null;
    }
    this.press = null;
    this.replan();
  }

  private click(e: ToolPointer): void {
    const stamp = { t: performance.now(), x: e.client.x, y: e.client.y };
    if (this.start && isDoubleClick(this.lastClick, stamp)) {
      this.lastClick = null;
      this.finish();
      return;
    }
    this.lastClick = stamp;
    if (this.mode === 'free') return;
    const at = this.snap ?? this.snapAt(e.pos, this.mode === 'straight' && !!this.start);
    if (!this.start) {
      this.begin(at);
      return;
    }
    if (this.mode === 'straight') {
      this.commit(at, undefined);
      return;
    }
    if (!this.tangent && !this.control) {
      this.control = at.pos;
      return;
    }
    const c = this.curveControl(at.pos);
    if (c) this.commit(at, c);
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Shift') {
      const down = e.type === 'keydown';
      if (this.shift !== down) {
        this.shift = down;
        this.replan();
      }
      return false;
    }
    if (e.type !== 'keydown') return false;
    const k = e.key.toLowerCase();
    // Mode keys avoid the camera's W A S D Q E R F; a held key (auto-repeat) toggles once.
    if (k === 'c' || k === 'b') {
      if (e.repeat) return true;
      const target: RoadMode = k === 'c' ? 'curve' : 'free';
      this.setMode(this.mode === target ? 'straight' : target);
      return true;
    }
    if (k === 't') {
      if (e.repeat) return true;
      setAutoFillet(this.ctx.store, !this.opts.autoFillet);
      this.replan();
      return true;
    }
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

  private setMode(mode: RoadMode): void {
    this.ctx.store.setToolOptions({ roadMode: mode });
    this.control = null;
    this.corner = null;
    this.replan();
  }

  cancel(): void {
    this.gesture.cancel();
    this.press = null;
    this.held = null;
    this.finish();
  }

  // ---------- preview ----------

  ghost(): Vec2[] {
    let pts: Vec2[] = [];
    if (this.drag === 'free') pts = this.path;
    else {
      const start = this.startRef();
      const p = this.pending();
      if (start && p) pts = sampleSegmentCurve(start.pos, p.end.pos, p.control, 4);
      else if (start && this.hover) pts = [start.pos, this.hover];
    }
    if (pts.length <= MAX_GHOST_POINTS) return pts;
    const step = (pts.length - 1) / (MAX_GHOST_POINTS - 1);
    const out: Vec2[] = [];
    for (let i = 0; i < MAX_GHOST_POINTS; i++) out.push(pts[Math.round(i * step)]!);
    return out;
  }

  preview(): ToolPreview {
    const prev: ToolPreview = { lines: [], points: [] };
    const doc = this.doc;
    const rt = doc.roadTypes[this.opts.roadTypeId];
    const width = rt ? roadHalfWidth(rt) * 2 : 10;
    const snap = this.snap;
    if (this.hover && snap) prev.points.push({ pos: snap.pos, radius: snap.kind === 'free' ? 1.2 : 1.8, color: SNAP_COLORS[snap.kind] });
    const tag = snap && snap.kind !== 'free' ? ` · ${SNAP_LABEL[snap.kind]}` : '';

    if (this.mode === 'free') {
      if (this.drag !== 'free' || !this.hover) {
        if (this.hover && tag) prev.label = { pos: this.hover, text: tag.slice(3) };
        return prev;
      }
      const f = this.free;
      prev.lines.push({ pts: this.path, width: 0.4, color: '#e2e8f0' });
      if (f) {
        const ok = !!f.plan?.command;
        for (const c of pieceCurves(f.pieces)) prev.lines.push({ pts: c, width, color: ok ? OK : BAD });
        if (f.plan) for (const j of f.plan.junctions.slice(1, -1)) prev.points.push({ pos: j, radius: 1.6, color: '#facc15' });
        const len = f.pieces.reduce((s, p) => s + polylineLength(sampleSegmentCurve(p.from, p.to, p.control)), 0);
        prev.label = ok ? { pos: this.hover, text: `자유 곡선 ${len.toFixed(1)} m · ${f.plan!.added.length}조각${tag}` } : { pos: this.hover, text: f.error ?? '그릴 수 없습니다', error: true };
      }
      return prev;
    }

    const start = this.startRef();
    if (!start) {
      if (this.hover && tag) prev.label = { pos: this.hover, text: tag.slice(3) };
      return prev;
    }
    prev.points.push({ pos: start.pos, radius: 1.8, color: '#38bdf8' });
    if (this.mode === 'curve' && this.tangent) {
      const t = this.tangent;
      prev.lines.push(...dashes(start.pos, { x: start.pos.x + t.x * 24, z: start.pos.z + t.z * 24 }, 2, 1.5).map((pts) => ({ pts, width: 0.3, color: '#e2e8f0' })));
    }
    if (this.mode === 'curve' && this.drag === 'tangent' && this.hover) {
      prev.lines.push({ pts: [start.pos, this.hover], width: 0.4, color: '#e2e8f0' });
      return prev;
    }
    const p = this.pending();
    if (!p) {
      if (this.hover) prev.lines.push({ pts: [start.pos, snap?.pos ?? this.hover], width: 0.4, color: '#e2e8f0' });
      return prev;
    }
    const ok = !!this.plan?.command;
    const fillet = this.plan?.fillet;
    // A rounded corner: the new piece starts where the curve ends, and the curve is drawn too.
    const pts = sampleSegmentCurve(fillet ? fillet.onNew : start.pos, p.end.pos, p.control);
    prev.lines.push({ pts, width, color: ok ? OK : BAD });
    if (fillet) prev.lines.push({ pts: fillet.curve, width, color: ok ? OK : BAD });
    if (this.plan?.filletError) prev.points.push({ pos: start.pos, radius: 2.6, color: '#fb923c' });
    if (p.control) {
      prev.lines.push({ pts: [start.pos, p.control, p.end.pos], width: 0.3, color: '#e2e8f0' });
      prev.points.push({ pos: p.control, radius: 1.4, color: '#e2e8f0' });
    }
    if (snap?.kind === 'angle' && snap.dir && !p.control) {
      const far = { x: snap.pos.x + snap.dir.x * 40, z: snap.pos.z + snap.dir.z * 40 };
      prev.lines.push(...dashes(start.pos, far).map((d) => ({ pts: d, width: 0.35, color: '#fde68a' })));
    }
    if (this.plan) for (const j of this.plan.junctions.slice(1, -1)) prev.points.push({ pos: j, radius: 2.4, color: '#facc15' });
    const len = polylineLength(sampleSegmentCurve(start.pos, p.end.pos, p.control));
    let text = pieceLabel(start.pos, p.end.pos, len);
    if (p.control) {
      const r = quadMinRadius(start.pos, p.control, p.end.pos);
      if (Number.isFinite(r)) text += ` · R ${r.toFixed(1)} m`;
    }
    text += tag;
    prev.label = ok ? { pos: this.hover ?? p.end.pos, text } : { pos: this.hover ?? p.end.pos, text: `${text} · ${translateError(this.plan?.error ?? '')}`, error: true };
    // Automatic parcels and buildings this road would remove.
    const st = this.ctx.store.getState();
    prev.lines.push(...removalLines(doc, this.removal.get(doc, st.docVersion, this.plan?.command ?? null, () => this.ctx.changed())));
    return prev;
  }
}
