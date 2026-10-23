// Studio controller without three.js: the draft, undo history, tool settings and selection, plus
// the edit actions the 3D view calls with picking results. React subscribes through `subscribe`.

import { internStyle, parseVoxel, voxelKey, voxelsToParts, type PropKind, type VoxelPartsResult, type VoxelStyle } from '@smartcity/shared';
import { PROP_INFO } from './palette';
import type { VoxelHit } from './picking';
import { mirrorProps, outOfReach, snapProp, type PropSnap } from './props';
import {
  addCells,
  brushCells,
  connectedRegion,
  History,
  inBounds,
  paintCells,
  raiseFloors,
  rectCells,
  removeCells,
  replacePatch,
  withSymmetry,
  applyPatch,
  type Brush,
  type Cell,
  type PaintChannel,
  type Patch,
  type StudioDoc,
} from './voxelEdit';

export type StudioTool = 'stack' | 'erase' | 'paint' | 'eyedropper' | 'select' | 'prop';

export const TOOL_INFO: { id: StudioTool; label: string; key: string; hint: string }[] = [
  { id: 'stack', label: '쌓기', key: '1', hint: '면을 클릭하면 그 방향에 블록 추가 · 드래그 = 사각 채우기 · 우클릭/Shift+클릭 = 지우기' },
  { id: 'erase', label: '지우개', key: '2', hint: '블록·장식을 클릭해 지우기 · 드래그 = 사각 지우기' },
  { id: 'paint', label: '칠하기', key: '3', hint: '블록을 클릭해 칠하기 · 드래그 = 사각 칠하기' },
  { id: 'eyedropper', label: '스포이드', key: '4', hint: '블록을 클릭해 그 색·재질·용도를 집기' },
  { id: 'select', label: '선택', key: '5', hint: '덩어리를 클릭해 선택 · 위 화살표를 끌어 층 추가/제거 · 지붕 형태 바꾸기' },
  { id: 'prop', label: '장식', key: '6', hint: '벽면이나 옥상을 클릭해 장식 붙이기 · R 회전 · [ ] 크기 · 우클릭 = 장식 지우기' },
];

export type RectMode = 'add' | 'erase' | 'paint';

export interface Selection {
  /** Index into the current conversion's parts. */
  part: number;
  cells: Cell[];
  columns: [number, number][];
  bottom: number;
  top: number;
}

export const DEFAULT_STYLE: VoxelStyle = { color: '#e8dcc8', roofColor: '#5b5f66', roof: 'flat', facade: { style: 'grid', windowRatio: 0.45, ground: 'none' } };

export class StudioEditor {
  doc: StudioDoc;
  readonly history = new History();
  /** Increments on every change (draft or settings). */
  version = 0;
  /** Increments on draft changes only (cells, props). */
  draftVersion = 0;

  tool: StudioTool = 'stack';
  brush: Brush = 1;
  sym = { x: false, z: false };
  style: VoxelStyle = { ...DEFAULT_STYLE, facade: { ...DEFAULT_STYLE.facade! } };
  channel: PaintChannel = 'all';
  /** Paint one cell or the whole same-style connected chunk. */
  /** Paint whole same-style chunks by default: a single cell barely shows on a windowed wall. */
  paintChunk = true;
  /** Current floor (null = all floors). Upper floors are not pickable. */
  floor: number | null = null;
  upperHidden = false;
  propKind: PropKind = 'balcony';
  propRot = 0;
  propSize = 1;
  propColor = PROP_INFO.balcony.color;
  /** Key of a cell of the selected volume. */
  selected: string | null = null;
  hint = '';

  private listeners = new Set<() => void>();
  private conv: { v: number; r: VoxelPartsResult } | null = null;
  /** A floor-raise drag in progress: already applied to the draft, committed as one step. */
  private transient: { sel: Selection; patch: Patch } | null = null;

  constructor(doc: StudioDoc) {
    this.doc = doc;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Notify listeners; `draft` marks a change of the cells or props. */
  changed(draft = false): void {
    this.version++;
    if (draft) this.draftVersion++;
    for (const fn of this.listeners) fn();
  }

  set<K extends keyof this>(key: K, value: this[K]): void {
    this[key] = value;
    if (key === 'tool') this.hint = '';
    this.changed();
  }

  setHint(h: string): void {
    if (h === this.hint) return;
    this.hint = h;
    this.changed();
  }

  /** Volumes of the current draft (cached per draft version). */
  parts(): VoxelPartsResult {
    if (!this.conv || this.conv.v !== this.draftVersion) this.conv = { v: this.draftVersion, r: voxelsToParts(this.doc.model) };
    return this.conv.r;
  }

  has = (i: number, j: number, k: number): boolean => this.doc.model.cells.has(voxelKey(i, j, k));

  /** Picking view of the draft: upper floors are out of reach while a floor is chosen. */
  pickable = (i: number, j: number, k: number): boolean => (this.floor === null || k <= this.floor) && this.has(i, j, k);

  private commit(p: Patch | null, error?: string): boolean {
    if (!p) {
      if (error) this.setHint(error);
      return false;
    }
    if (!this.history.commit(this.doc, p)) return false;
    this.hint = '';
    this.changed(true);
    return true;
  }

  // ── Targets (also used for ghost previews) ──

  private styleIndex(): number {
    return internStyle(this.doc.model.styles, { ...this.style, ...(this.style.facade ? { facade: { ...this.style.facade } } : {}) });
  }

  /** Cell a stack click adds next to (or on the plane under) the hit. */
  static stackCell(hit: VoxelHit): Cell {
    if (hit.kind === 'plane') return [hit.i, hit.j, hit.k];
    return [hit.i + hit.normal[0], hit.j + hit.normal[2], hit.k + hit.normal[1]];
  }

  /** Cells a click would change with the current tool, brush and symmetry. */
  clickTargets(hit: VoxelHit, erase: boolean): { mode: RectMode; cells: Cell[] } | null {
    const tool = erase ? 'erase' : this.tool;
    if (tool === 'stack') {
      const [i, j, k] = StudioEditor.stackCell(hit);
      const cells = withSymmetry(brushCells(i, j, k, this.brush), this.sym).filter(([a, b, c]) => inBounds(a, b, c) && !this.has(a, b, c));
      return { mode: 'add', cells };
    }
    if (hit.kind !== 'cell') return null;
    if (tool === 'erase') {
      return { mode: 'erase', cells: withSymmetry(brushCells(hit.i, hit.j, hit.k, this.brush), this.sym).filter(([a, b, c]) => this.has(a, b, c)) };
    }
    if (tool === 'paint') {
      const seeds = withSymmetry(this.paintChunk ? [[hit.i, hit.j, hit.k]] : brushCells(hit.i, hit.j, hit.k, this.brush), this.sym);
      const cells: Cell[] = [];
      const seen = new Set<string>();
      for (const s of seeds) {
        for (const c of this.paintChunk ? connectedRegion(this.doc.model, s) : [s]) {
          const key = voxelKey(...c);
          if (!seen.has(key) && this.has(...c)) {
            seen.add(key);
            cells.push(c);
          }
        }
      }
      return { mode: 'paint', cells };
    }
    return null;
  }

  /** Cells of a rectangle drag from `start` (on floor start[2]) to plan cell `end`. */
  rectTargets(mode: RectMode, start: Cell, end: { i: number; j: number }): Cell[] {
    const cells = withSymmetry(rectCells({ i: start[0], j: start[1] }, end, start[2], this.brush), this.sym);
    return cells.filter(([i, j, k]) => (mode === 'add' ? inBounds(i, j, k) && !this.has(i, j, k) : this.has(i, j, k)));
  }

  // ── Actions ──

  apply(mode: RectMode, cells: readonly Cell[]): boolean {
    if (mode === 'add') {
      const r = addCells(this.doc, cells, this.styleIndex());
      return this.commit(r.patch, r.error);
    }
    if (mode === 'erase') return this.commit(removeCells(this.doc, cells));
    return this.commit(paintCells(this.doc, cells, this.style, this.channel));
  }

  click(hit: VoxelHit, erase = false): boolean {
    const t = this.clickTargets(hit, erase);
    if (!t) return false;
    return this.apply(t.mode, t.cells);
  }

  /** Copy the look of a cell into the current style. */
  eyedrop(hit: VoxelHit): boolean {
    if (hit.kind !== 'cell') return false;
    const s = this.doc.model.styles[this.doc.model.cells.get(voxelKey(hit.i, hit.j, hit.k))!];
    if (!s) return false;
    this.style = { ...s, ...(s.facade ? { facade: { ...s.facade } } : {}) };
    this.channel = 'all';
    this.tool = 'paint';
    this.hint = '집은 스타일로 칠하기 도구로 바꿨습니다';
    this.changed();
    return true;
  }

  // ── Props ──

  propSnap(hit: VoxelHit): PropSnap {
    return snapProp(this.doc.model, hit, this.propKind, this.propRot, this.propSize, this.propColor);
  }

  placeProp(hit: VoxelHit): boolean {
    const r = this.propSnap(hit);
    if (!r.ok) {
      this.setHint(r.reason);
      return false;
    }
    const add = mirrorProps(r.prop, this.sym);
    // Mirrored copies must hang on the building too, or the save would be rejected later.
    for (const p of add) {
      const why = outOfReach(this.doc.model, p);
      if (why) {
        this.setHint(`대칭 장식을 붙일 수 없습니다: ${why}`);
        return false;
      }
    }
    if (this.doc.props.length + add.length > 64) {
      this.setHint('장식은 64개까지 붙일 수 있습니다');
      return false;
    }
    const before = this.doc.props.map((p) => ({ ...p, pos: { ...p.pos } }));
    return this.commit({ cells: [], props: [before, [...before, ...add]] });
  }

  removeProps(indices: readonly number[]): boolean {
    if (!indices.length) return false;
    const drop = new Set(indices);
    const before = this.doc.props.map((p) => ({ ...p, pos: { ...p.pos } }));
    return this.commit({ cells: [], props: [before, before.filter((_, i) => !drop.has(i))] });
  }

  /** Mirror partners of a prop under the current symmetry (to delete them together). */
  propGroup(index: number): number[] {
    const p = this.doc.props[index];
    if (!p) return [];
    const images = mirrorProps(p, this.sym);
    const out = new Set<number>([index]);
    this.doc.props.forEach((q, i) => {
      if (images.some((m) => m.kind === q.kind && m.pos.x === q.pos.x && m.pos.y === q.pos.y && m.pos.z === q.pos.z)) out.add(i);
    });
    return [...out];
  }

  // ── Selection, roof and floor raising ──

  /** The selected volume (recomputed from the current conversion), or null. */
  selection(): Selection | null {
    if (!this.selected) return null;
    const conv = this.parts();
    const idx = conv.sources.findIndex((src) => src.includes(this.selected!));
    if (idx < 0) return null;
    const cells = conv.sources[idx]!.map(parseVoxel);
    let bottom = Infinity;
    let top = -Infinity;
    const cols = new Map<string, [number, number]>();
    for (const [i, j, k] of cells) {
      bottom = Math.min(bottom, k);
      top = Math.max(top, k);
      cols.set(`${i},${j}`, [i, j]);
    }
    return { part: idx, cells, columns: [...cols.values()], bottom, top };
  }

  select(hit: VoxelHit | null): void {
    this.selected = hit && hit.kind === 'cell' ? voxelKey(hit.i, hit.j, hit.k) : null;
    this.changed();
  }

  /** Whether the selected volume can take a pitched roof, with the reason when it cannot. */
  roofOptions(): { ok: boolean; reason: string } {
    const sel = this.selection();
    if (!sel) return { ok: false, reason: '덩어리를 먼저 선택하세요' };
    const part = this.parts().parts[sel.part]!;
    if (part.footprint) return { ok: false, reason: '경사 지붕은 사각형 덩어리에만 올릴 수 있습니다' };
    if (sel.columns.some(([i, j]) => this.has(i, j, sel.top + 1))) return { ok: false, reason: '위에 블록이 있어 평지붕이 됩니다 — 옥상 장식을 써 보세요' };
    return { ok: true, reason: '' };
  }

  setRoof(roof: VoxelStyle['roof']): boolean {
    const sel = this.selection();
    if (!sel) return false;
    if (roof !== 'flat' && !this.roofOptions().ok) return false;
    return this.commit(paintCells(this.doc, sel.cells, { ...this.style, roof }, 'roof'));
  }

  /** Start dragging the floor handle of the selection. */
  beginRaise(): boolean {
    const sel = this.selection();
    if (!sel) return false;
    this.transient = { sel, patch: { cells: [] } };
    return true;
  }

  /** Preview a raise by `delta` floors (applied to the draft; replaces the previous preview). */
  previewRaise(delta: number): void {
    const tr = this.transient;
    if (!tr) return;
    applyPatch(this.doc, tr.patch, true);
    const r = raiseFloors(this.doc, tr.sel.columns, tr.sel.bottom, tr.sel.top, delta);
    tr.patch = r.patch ?? { cells: [] };
    applyPatch(this.doc, tr.patch);
    this.hint = r.error ?? '';
    this.changed(true);
  }

  /** Finish the drag: the whole drag is one undo step. */
  endRaise(cancel = false): void {
    const tr = this.transient;
    if (!tr) return;
    this.transient = null;
    if (cancel) applyPatch(this.doc, tr.patch, true);
    else if (this.history.commit(this.doc, tr.patch, true)) {
      // Keep the volume selected at its new top.
      const [i, j] = tr.sel.columns[0]!;
      let k = tr.sel.bottom;
      while (this.has(i, j, k + 1)) k++;
      this.selected = voxelKey(i, j, k);
    }
    this.changed(true);
  }

  get raising(): boolean {
    return this.transient !== null;
  }

  // ── Whole-draft operations ──

  replace(next: StudioDoc): boolean {
    this.selected = null;
    return this.commit(replacePatch(this.doc, next));
  }

  undo(): void {
    if (this.transient) this.endRaise(true);
    if (this.history.undo(this.doc)) this.changed(true);
  }

  redo(): void {
    if (this.transient) this.endRaise(true);
    if (this.history.redo(this.doc)) this.changed(true);
  }

  /** Floors used by the draft (for the floor slider). */
  floorsUsed(): number {
    let top = -1;
    for (const key of this.doc.model.cells.keys()) top = Math.max(top, parseVoxel(key)[2]);
    return top + 1;
  }
}
