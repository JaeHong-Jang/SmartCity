// Voxel editing for the 3D building studio: users stack 2 m × 2 m × 1-floor cells, designs store
// orthogonal volumes (BuildingPart). Cells are an editing representation only (ADR 0007 §5).

import { polygonArea, type Vec2 } from '../geometry.js';
import type { BuildingPart, Facade, RoofShape, Zone } from '../model.js';
import { partOutline } from './buildings.js';
import { cellKey, cellsToOutline, outlineToCells, parseCell, type CellKey } from './footprint.js';

/** Look of a group of cells; cells with equal styles merge into one volume. */
export interface VoxelStyle {
  color: string;
  roofColor: string;
  /** Wanted roof; only rectangular top volumes can have a pitched roof, others stay flat. */
  roof: RoofShape;
  use?: Zone;
  facade?: Facade;
}

export interface VoxelModel {
  /** Horizontal cell size, meters. */
  cell: number;
  floorHeight: number;
  /** `${i},${j},${k}` → index into styles. Cell (i, j) spans [i·cell, (i+1)·cell] in the building frame; k = floor. */
  cells: Map<string, number>;
  styles: VoxelStyle[];
}

export const VOXEL_LIMITS = { cells: 4000, floors: 30, halfExtent: 16 } as const;

export const voxelKey = (i: number, j: number, k: number): string => `${i},${j},${k}`;

export function parseVoxel(key: string): [number, number, number] {
  const [i, j, k] = key.split(',').map(Number);
  return [i!, j!, k!];
}

const styleKey = (s: VoxelStyle): string =>
  [s.color, s.roofColor, s.roof, s.use ?? '', s.facade ? `${s.facade.style}/${s.facade.windowRatio}/${s.facade.ground}` : ''].join('|');

/** Index of an equal style in the list, appending it when new. */
export function internStyle(styles: VoxelStyle[], s: VoxelStyle): number {
  const key = styleKey(s);
  const i = styles.findIndex((t) => styleKey(t) === key);
  if (i >= 0) return i;
  styles.push(s);
  return styles.length - 1;
}

export interface VoxelPartsResult {
  parts: BuildingPart[];
  /** Per part: the cells it came from (for highlighting problems in the studio). */
  sources: string[][];
}

/**
 * Convert cells to volumes: per floor and style, 4-connected regions; regions with holes or more than
 * `maxVertices` corners are bisected along their longer axis until they are simple; identical regions
 * on consecutive floors merge into one multi-floor volume. Deterministic for a given cell map.
 */
export function voxelsToParts(m: VoxelModel, maxVertices = 32): VoxelPartsResult {
  // Group cells by (floor, style).
  const layers = new Map<string, Set<CellKey>>();
  let maxK = -1;
  for (const [key, style] of m.cells) {
    const [i, j, k] = parseVoxel(key);
    const g = `${k}|${style}`;
    let set = layers.get(g);
    if (!set) layers.set(g, (set = new Set()));
    set.add(cellKey(i, j));
    if (k > maxK) maxK = k;
  }

  interface Open {
    style: number;
    cells: Set<CellKey>;
    outline: Vec2[];
    k0: number;
    k1: number;
  }
  const done: Open[] = [];
  let open = new Map<string, Open>();
  for (let k = 0; k <= maxK; k++) {
    const next = new Map<string, Open>();
    for (let style = 0; style < m.styles.length; style++) {
      const set = layers.get(`${k}|${style}`);
      if (!set) continue;
      for (const piece of simplePieces(set, m.cell, maxVertices)) {
        const id = `${style}#${[...piece.cells].sort().join(';')}`;
        const prev = open.get(id);
        if (prev && prev.k1 === k - 1) {
          prev.k1 = k;
          open.delete(id);
          next.set(id, prev);
        } else {
          next.set(id, { style, cells: piece.cells, outline: piece.outline, k0: k, k1: k });
        }
      }
    }
    for (const o of open.values()) done.push(o);
    open = next;
  }
  for (const o of open.values()) done.push(o);
  done.sort((a, b) => a.k0 - b.k0 || a.style - b.style || (firstCell(a.cells) < firstCell(b.cells) ? -1 : 1));

  const parts: BuildingPart[] = [];
  const sources: string[][] = [];
  for (const o of done) {
    const s = m.styles[o.style]!;
    // A pitched roof only on a rectangle with nothing standing on it.
    const covered = [...o.cells].some((c) => {
      const [i, j] = parseCell(c);
      return m.cells.has(voxelKey(i, j, o.k1 + 1));
    });
    const rect = o.outline.length === 4;
    const roof: RoofShape = rect && !covered ? s.roof : 'flat';
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const v of o.outline) {
      x0 = Math.min(x0, v.x);
      z0 = Math.min(z0, v.z);
      x1 = Math.max(x1, v.x);
      z1 = Math.max(z1, v.z);
    }
    const part: BuildingPart = {
      offset: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 },
      width: x1 - x0,
      depth: z1 - z0,
      floors: o.k1 - o.k0 + 1,
      floorHeight: m.floorHeight,
      baseHeight: o.k0 * m.floorHeight,
      roof,
      color: s.color,
      roofColor: s.roofColor,
    };
    if (!rect) part.footprint = o.outline;
    if (s.use) part.use = s.use;
    if (s.facade) part.facade = { ...s.facade };
    parts.push(part);
    const src: string[] = [];
    for (let k = o.k0; k <= o.k1; k++) for (const c of [...o.cells].sort()) src.push(`${c},${k}`);
    sources.push(src);
  }
  return { parts, sources };
}

function firstCell(cells: Set<CellKey>): string {
  let best = '';
  for (const c of cells) if (best === '' || c < best) best = c;
  return best;
}

/** Split a cell set into connected, hole-free pieces with at most maxVertices corners. */
function simplePieces(cells: Set<CellKey>, size: number, maxVertices: number): { cells: Set<CellKey>; outline: Vec2[] }[] {
  const out: { cells: Set<CellKey>; outline: Vec2[] }[] = [];
  const work = components(cells);
  while (work.length) {
    const comp = work.shift()!;
    const outline = cellsToOutline(comp, size)!;
    // cellsToOutline fills holes: a larger outline area than the cells means a courtyard.
    const holes = polygonArea(outline) > comp.size * size * size + 1e-6;
    if (!holes && outline.length <= maxVertices) {
      out.push({ cells: comp, outline });
      continue;
    }
    let minI = Infinity;
    let maxI = -Infinity;
    let minJ = Infinity;
    let maxJ = -Infinity;
    for (const c of comp) {
      const [i, j] = parseCell(c);
      minI = Math.min(minI, i);
      maxI = Math.max(maxI, i);
      minJ = Math.min(minJ, j);
      maxJ = Math.max(maxJ, j);
    }
    const alongI = maxI - minI >= maxJ - minJ;
    const mid = alongI ? Math.floor((minI + maxI + 1) / 2) : Math.floor((minJ + maxJ + 1) / 2);
    const lo = new Set<CellKey>();
    const hi = new Set<CellKey>();
    for (const c of comp) {
      const [i, j] = parseCell(c);
      ((alongI ? i : j) < mid ? lo : hi).add(c);
    }
    work.unshift(...components(lo), ...components(hi));
  }
  return out;
}

function components(cells: Set<CellKey>): Set<CellKey>[] {
  const seen = new Set<CellKey>();
  const out: Set<CellKey>[] = [];
  for (const start of [...cells].sort()) {
    if (seen.has(start)) continue;
    const comp = new Set<CellKey>([start]);
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const [i, j] = parseCell(stack.pop()!);
      for (const n of [cellKey(i + 1, j), cellKey(i - 1, j), cellKey(i, j + 1), cellKey(i, j - 1)]) {
        if (cells.has(n) && !seen.has(n)) {
          seen.add(n);
          comp.add(n);
          stack.push(n);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

export interface PartsVoxelsResult {
  model: VoxelModel;
  /** True when reopening changes the design: off the cell grid, mixed floor heights, or roofs that would merge. */
  lossy: boolean;
  /** The design exceeds the studio limits (VOXEL_LIMITS); the model is left empty. */
  tooLarge: boolean;
}

const sameVolume = (a: BuildingPart, b: BuildingPart): boolean =>
  a.roof === b.roof &&
  Math.abs(a.baseHeight - b.baseHeight) < 1e-6 &&
  Math.abs(a.floors * a.floorHeight - b.floors * b.floorHeight) < 1e-6 &&
  Math.abs(a.offset.x - b.offset.x) < 1e-6 &&
  Math.abs(a.offset.z - b.offset.z) < 1e-6 &&
  Math.abs(a.width - b.width) < 1e-6 &&
  Math.abs(a.depth - b.depth) < 1e-6;

/** Reopen a stored design as cells. Volumes are snapped to the grid and to whole floors. */
export function partsToVoxels(parts: readonly BuildingPart[], cell = 2): PartsVoxelsResult {
  const floorHeight = parts[0]?.floorHeight ?? 3.2;
  const model: VoxelModel = { cell, floorHeight, cells: new Map(), styles: [] };
  // Check the size before creating any cell: a server-valid design can be far larger than the studio.
  const reach = VOXEL_LIMITS.halfExtent * cell;
  // Extent first (it bounds the per-part cell count), then the exact number of cells to create.
  let count = 0;
  for (const p of parts) {
    const top = (p.baseHeight + p.floors * p.floorHeight) / floorHeight;
    const out = partOutline(p).some((v) => Math.abs(v.x) > reach || Math.abs(v.z) > reach);
    if (out || top > VOXEL_LIMITS.floors + 1e-6) return { model, lossy: true, tooLarge: true };
    count += outlineToCells(partOutline(p), cell).size * Math.max(1, Math.round((p.floors * p.floorHeight) / floorHeight));
    if (count > VOXEL_LIMITS.cells) return { model, lossy: true, tooLarge: true };
  }
  let lossy = false;
  for (const p of parts) {
    const style = internStyle(model.styles, {
      color: p.color,
      roofColor: p.roofColor,
      roof: p.roof,
      ...(p.use ? { use: p.use } : {}),
      ...(p.facade ? { facade: { ...p.facade } } : {}),
    });
    const outline = partOutline(p);
    const cells = outlineToCells(outline, cell);
    // An orthogonal outline is covered exactly by its cells iff every corner lies on the grid
    // (equal area alone misses a shifted shape).
    const onGrid = (v: number): boolean => Math.abs(v / cell - Math.round(v / cell)) < 1e-9;
    if (!outline.every((v) => onGrid(v.x) && onGrid(v.z)) || cells.size * cell * cell < polygonArea(outline) - 1e-6) lossy = true;
    if (Math.abs(p.floorHeight - floorHeight) > 1e-9) lossy = true;
    const k0f = p.baseHeight / floorHeight;
    const k0 = Math.round(k0f);
    if (Math.abs(k0f - k0) > 1e-6) lossy = true;
    const floors = Math.max(1, Math.round((p.floors * p.floorHeight) / floorHeight));
    for (let k = k0; k < k0 + floors; k++) {
      for (const c of cells) {
        const [i, j] = parseCell(c);
        const key = voxelKey(i, j, k);
        if (model.cells.has(key)) lossy = true;
        model.cells.set(key, style);
      }
    }
  }
  // Pitched roofs survive only if converting back yields the same volume (adjacent equal-style
  // volumes would otherwise merge under one roof).
  if (!lossy && parts.some((p) => p.roof !== 'flat')) {
    const again = voxelsToParts(model).parts;
    if (parts.some((p) => p.roof !== 'flat' && !again.some((q) => sameVolume(p, q)))) lossy = true;
  }
  return { model, lossy, tooLarge: false };
}
