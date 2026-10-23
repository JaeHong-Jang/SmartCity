// Building studio edit core (pure, no three.js): the draft (cells + props), reversible patches,
// undo/redo, symmetry, brushes, rectangle fill, connected regions and floor raising.
// Styles are append-only for a whole session, so a patch only records cell style indices.

import { VOXEL_LIMITS, voxelKey, parseVoxel, internStyle, type BuildingProp, type SmartFeatures, type VoxelModel, type VoxelStyle } from '@smartcity/shared';

export interface StudioDoc {
  model: VoxelModel;
  props: BuildingProp[];
  /** Smart equipment of the opened design, carried through unchanged. */
  smart?: SmartFeatures;
}

export interface Patch {
  /** [cell key, style before (undefined = empty), style after]. */
  cells: [string, number | undefined, number | undefined][];
  props?: [BuildingProp[], BuildingProp[]];
  floorHeight?: [number, number];
  smart?: [SmartFeatures | undefined, SmartFeatures | undefined];
}

export const emptyPatch = (p: Patch): boolean => p.cells.length === 0 && !p.props && !p.floorHeight && !p.smart;

export function newStudioDoc(floorHeight = 3.2): StudioDoc {
  return { model: { cell: 2, floorHeight, cells: new Map(), styles: [] }, props: [] };
}

export function applyPatch(doc: StudioDoc, p: Patch, reverse = false): void {
  const cells = reverse ? [...p.cells].reverse() : p.cells;
  for (const [key, before, after] of cells) {
    const v = reverse ? before : after;
    if (v === undefined) doc.model.cells.delete(key);
    else doc.model.cells.set(key, v);
  }
  if (p.props) doc.props = (reverse ? p.props[0] : p.props[1]).map((x) => ({ ...x, pos: { ...x.pos } }));
  if (p.floorHeight) doc.model.floorHeight = reverse ? p.floorHeight[0] : p.floorHeight[1];
  if (p.smart) {
    const s = reverse ? p.smart[0] : p.smart[1];
    if (s) doc.smart = { ...s };
    else delete doc.smart;
  }
}

/** Build a cell patch from wanted values (undefined = remove), skipping cells that would not change. */
export function cellPatch(doc: StudioDoc, wanted: Map<string, number | undefined>): Patch {
  const cells: Patch['cells'] = [];
  for (const [key, after] of wanted) {
    const before = doc.model.cells.get(key);
    if (before !== after) cells.push([key, before, after]);
  }
  return { cells };
}

/** Local undo/redo of patches (independent of the city command log). */
export class History {
  private past: Patch[] = [];
  private future: Patch[] = [];
  constructor(private readonly limit = 200) {}

  /** Apply a patch as one undo step. Returns false for a no-op. */
  commit(doc: StudioDoc, p: Patch, alreadyApplied = false): boolean {
    if (emptyPatch(p)) return false;
    if (!alreadyApplied) applyPatch(doc, p);
    this.past.push(p);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return true;
  }

  undo(doc: StudioDoc): boolean {
    const p = this.past.pop();
    if (!p) return false;
    applyPatch(doc, p, true);
    this.future.push(p);
    return true;
  }

  redo(doc: StudioDoc): boolean {
    const p = this.future.pop();
    if (!p) return false;
    applyPatch(doc, p);
    this.past.push(p);
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  clear(): void {
    this.past = [];
    this.future = [];
  }
}

export type Cell = [number, number, number];

export const inBounds = (i: number, j: number, k: number): boolean =>
  i >= -VOXEL_LIMITS.halfExtent && i < VOXEL_LIMITS.halfExtent && j >= -VOXEL_LIMITS.halfExtent && j < VOXEL_LIMITS.halfExtent && k >= 0 && k < VOXEL_LIMITS.floors;

export interface Symmetry {
  x: boolean;
  z: boolean;
}

/** Cells with their mirror images across the x = 0 and/or z = 0 planes (cell i ↔ −1 − i). Unique, in order. */
export function withSymmetry(cells: readonly Cell[], sym: Symmetry): Cell[] {
  const out: Cell[] = [];
  const seen = new Set<string>();
  const add = (c: Cell): void => {
    const k = voxelKey(c[0], c[1], c[2]);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (const [i, j, k] of cells) {
    add([i, j, k]);
    if (sym.x) add([-1 - i, j, k]);
    if (sym.z) add([i, -1 - j, k]);
    if (sym.x && sym.z) add([-1 - i, -1 - j, k]);
  }
  return out;
}

export type Brush = 1 | 2;

/** Cells under the brush at (i, j, k); the 2 × 2 (4 m) brush snaps to the 4 m grid. */
export function brushCells(i: number, j: number, k: number, brush: Brush): Cell[] {
  if (brush === 1) return [[i, j, k]];
  const i0 = Math.floor(i / 2) * 2;
  const j0 = Math.floor(j / 2) * 2;
  return [
    [i0, j0, k],
    [i0 + 1, j0, k],
    [i0, j0 + 1, k],
    [i0 + 1, j0 + 1, k],
  ];
}

/** All cells of the rectangle spanned by two cells on floor k (brush-aligned corners). */
export function rectCells(a: { i: number; j: number }, b: { i: number; j: number }, k: number, brush: Brush): Cell[] {
  const s = brush;
  const i0 = Math.min(Math.floor(a.i / s), Math.floor(b.i / s)) * s;
  const i1 = (Math.max(Math.floor(a.i / s), Math.floor(b.i / s)) + 1) * s - 1;
  const j0 = Math.min(Math.floor(a.j / s), Math.floor(b.j / s)) * s;
  const j1 = (Math.max(Math.floor(a.j / s), Math.floor(b.j / s)) + 1) * s - 1;
  const out: Cell[] = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push([i, j, k]);
  return out;
}

/** Same-style cells 6-connected to the start cell (a "chunk" for painting). */
export function connectedRegion(model: VoxelModel, start: Cell): Cell[] {
  const style = model.cells.get(voxelKey(...start));
  if (style === undefined) return [];
  const seen = new Set<string>([voxelKey(...start)]);
  const out: Cell[] = [];
  const stack: Cell[] = [start];
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    const [i, j, k] = c;
    for (const n of [
      [i + 1, j, k],
      [i - 1, j, k],
      [i, j + 1, k],
      [i, j - 1, k],
      [i, j, k + 1],
      [i, j, k - 1],
    ] as Cell[]) {
      const key = voxelKey(...n);
      if (!seen.has(key) && model.cells.get(key) === style) {
        seen.add(key);
        stack.push(n);
      }
    }
  }
  return out;
}

export type EditResult = { patch: Patch; error?: undefined } | { patch: null; error: string };

/** Add cells with a style (cells already there or out of bounds are left alone). */
export function addCells(doc: StudioDoc, cells: readonly Cell[], style: number): EditResult {
  const wanted = new Map<string, number | undefined>();
  for (const [i, j, k] of cells) {
    if (!inBounds(i, j, k)) continue;
    const key = voxelKey(i, j, k);
    if (!doc.model.cells.has(key)) wanted.set(key, style);
  }
  if (doc.model.cells.size + wanted.size > VOXEL_LIMITS.cells) return { patch: null, error: `블록은 ${VOXEL_LIMITS.cells.toLocaleString()}개까지 쌓을 수 있습니다` };
  return { patch: cellPatch(doc, wanted) };
}

export function removeCells(doc: StudioDoc, cells: readonly Cell[]): Patch {
  const wanted = new Map<string, number | undefined>();
  for (const [i, j, k] of cells) {
    const key = voxelKey(i, j, k);
    if (doc.model.cells.has(key)) wanted.set(key, undefined);
  }
  return cellPatch(doc, wanted);
}

/** What a paint stroke changes on each painted cell's style. */
export type PaintChannel = 'all' | 'color' | 'roofColor' | 'facade' | 'use' | 'roof';

export function paintStyle(base: VoxelStyle, brush: VoxelStyle, channel: PaintChannel): VoxelStyle {
  const next: VoxelStyle = { ...base, ...(base.facade ? { facade: { ...base.facade } } : {}) };
  switch (channel) {
    case 'all':
      return { ...brush, ...(brush.facade ? { facade: { ...brush.facade } } : {}) };
    case 'color':
      next.color = brush.color;
      break;
    case 'roofColor':
      next.roofColor = brush.roofColor;
      break;
    case 'facade':
      if (brush.facade) next.facade = { ...brush.facade };
      next.color = brush.color;
      next.roofColor = brush.roofColor;
      break;
    case 'use':
      if (brush.use) next.use = brush.use;
      else delete next.use;
      break;
    case 'roof':
      next.roof = brush.roof;
      break;
  }
  return next;
}

/** Repaint existing cells (styles are interned into the model's append-only list). */
export function paintCells(doc: StudioDoc, cells: readonly Cell[], brush: VoxelStyle, channel: PaintChannel): Patch {
  const wanted = new Map<string, number | undefined>();
  const memo = new Map<number, number>();
  for (const [i, j, k] of cells) {
    const key = voxelKey(i, j, k);
    const cur = doc.model.cells.get(key);
    if (cur === undefined) continue;
    let next = memo.get(cur);
    if (next === undefined) {
      next = internStyle(doc.model.styles, paintStyle(doc.model.styles[cur]!, brush, channel));
      memo.set(cur, next);
    }
    wanted.set(key, next);
  }
  return cellPatch(doc, wanted);
}

/**
 * Raise (delta > 0) or lower (delta < 0) a volume by whole floors. `columns` are its plan cells,
 * `top` its highest floor and `bottom` its lowest; new floors copy the style of the top floor, and
 * lowering keeps at least the bottom floor.
 */
export function raiseFloors(doc: StudioDoc, columns: readonly [number, number][], bottom: number, top: number, delta: number): EditResult {
  const wanted = new Map<string, number | undefined>();
  if (delta > 0) {
    for (const [i, j] of columns) {
      const style = doc.model.cells.get(voxelKey(i, j, top));
      if (style === undefined) continue;
      for (let k = top + 1; k <= top + delta; k++) {
        const key = voxelKey(i, j, k);
        if (inBounds(i, j, k) && !doc.model.cells.has(key)) wanted.set(key, style);
      }
    }
    if (doc.model.cells.size + wanted.size > VOXEL_LIMITS.cells) return { patch: null, error: `블록은 ${VOXEL_LIMITS.cells.toLocaleString()}개까지 쌓을 수 있습니다` };
  } else if (delta < 0) {
    const from = Math.max(bottom + 1, top + delta + 1);
    for (const [i, j] of columns) for (let k = from; k <= top; k++) if (doc.model.cells.has(voxelKey(i, j, k))) wanted.set(voxelKey(i, j, k), undefined);
  }
  return { patch: cellPatch(doc, wanted) };
}

/** Patch that replaces the whole draft (dice, templates); its styles are interned into `doc`. */
export function replacePatch(doc: StudioDoc, next: StudioDoc): Patch {
  const remap = next.model.styles.map((s) => internStyle(doc.model.styles, s));
  const wanted = new Map<string, number | undefined>();
  for (const key of doc.model.cells.keys()) wanted.set(key, undefined);
  for (const [key, s] of next.model.cells) wanted.set(key, remap[s]!);
  const p = cellPatch(doc, wanted);
  p.props = [doc.props.map((x) => ({ ...x, pos: { ...x.pos } })), next.props.map((x) => ({ ...x, pos: { ...x.pos } }))];
  if (doc.model.floorHeight !== next.model.floorHeight) p.floorHeight = [doc.model.floorHeight, next.model.floorHeight];
  if (JSON.stringify(doc.smart ?? null) !== JSON.stringify(next.smart ?? null)) p.smart = [doc.smart, next.smart];
  return p;
}

/** Cell bounds of the draft in plan (inclusive cell indices), or null when empty. */
export function cellBounds(model: VoxelModel): { i0: number; i1: number; j0: number; j1: number; k1: number } | null {
  if (model.cells.size === 0) return null;
  let i0 = Infinity;
  let i1 = -Infinity;
  let j0 = Infinity;
  let j1 = -Infinity;
  let k1 = -Infinity;
  for (const key of model.cells.keys()) {
    const [i, j, k] = parseVoxel(key);
    i0 = Math.min(i0, i);
    i1 = Math.max(i1, i);
    j0 = Math.min(j0, j);
    j1 = Math.max(j1, j);
    k1 = Math.max(k1, k);
  }
  return { i0, i1, j0, j1, k1 };
}
