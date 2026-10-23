// Grid editing for the building studio: users paint cells, buildings store the outline polygon.

import { distanceToPolygonEdge, signedArea, type Vec2 } from '../geometry.js';

/** Cell key `${i},${j}`: cell (i, j) covers [i·size, (i+1)·size] × [j·size, (j+1)·size]. */
export type CellKey = string;

export const cellKey = (i: number, j: number): CellKey => `${i},${j}`;

export function parseCell(k: CellKey): [number, number] {
  const [i, j] = k.split(',').map(Number);
  return [i!, j!];
}

/**
 * Outline of a set of grid cells as one counter-clockwise orthogonal polygon.
 * Only the largest connected region is kept and holes are filled (courtyards come later).
 * Returns null for an empty set.
 */
export function cellsToOutline(cells: ReadonlySet<CellKey>, size: number): Vec2[] | null {
  const region = largestRegion(cells);
  if (region.size === 0) return null;
  // With holes filled, a single 4-connected region cannot touch itself only at a corner (the path
  // around would enclose one of the two empty cells), so the boundary is one simple loop.
  const filled = fillHoles(region);

  // Directed boundary edges with the filled area on the left (counter-clockwise in (x, z)).
  const edges = new Map<string, string>();
  const key = (x: number, z: number): string => `${x},${z}`;
  for (const k of filled) {
    const [i, j] = parseCell(k);
    if (!filled.has(cellKey(i, j - 1))) edges.set(key(i, j), key(i + 1, j));
    if (!filled.has(cellKey(i + 1, j))) edges.set(key(i + 1, j), key(i + 1, j + 1));
    if (!filled.has(cellKey(i, j + 1))) edges.set(key(i + 1, j + 1), key(i, j + 1));
    if (!filled.has(cellKey(i - 1, j))) edges.set(key(i, j + 1), key(i, j));
  }
  // Start from the smallest vertex so the result is deterministic.
  const start = [...edges.keys()].sort((a, b) => {
    const [ax, az] = a.split(',').map(Number);
    const [bx, bz] = b.split(',').map(Number);
    return az! - bz! || ax! - bx!;
  })[0]!;
  const loop: Vec2[] = [];
  let cur = start;
  do {
    const [x, z] = cur.split(',').map(Number);
    loop.push({ x: x! * size, z: z! * size });
    cur = edges.get(cur)!;
  } while (cur !== start && loop.length <= edges.size);

  const out = dropCollinear(loop);
  return signedArea(out) < 0 ? out.reverse() : out;
}

/**
 * Cells (of the given size) whose centers lie strictly inside the polygon — to reopen a stored design.
 * Centers exactly on an edge (an outline off the grid by half a cell) are left out on both sides, so
 * the result is symmetric instead of depending on the point-in-polygon tie rule.
 */
export function outlineToCells(poly: readonly Vec2[], size: number): Set<CellKey> {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  const out = new Set<CellKey>();
  for (let i = Math.floor(minX / size); i * size < maxX; i++) {
    for (let j = Math.floor(minZ / size); j * size < maxZ; j++) {
      const c = { x: (i + 0.5) * size, z: (j + 0.5) * size };
      if (insideOrthogonal(c, poly) && distanceToPolygonEdge(c, poly) > 1e-9) out.add(cellKey(i, j));
    }
  }
  return out;
}

function insideOrthogonal(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function neighbours(k: CellKey): CellKey[] {
  const [i, j] = parseCell(k);
  return [cellKey(i + 1, j), cellKey(i - 1, j), cellKey(i, j + 1), cellKey(i, j - 1)];
}

function largestRegion(cells: ReadonlySet<CellKey>): Set<CellKey> {
  const seen = new Set<CellKey>();
  let best = new Set<CellKey>();
  for (const start of [...cells].sort()) {
    if (seen.has(start)) continue;
    const region = new Set<CellKey>([start]);
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      for (const n of neighbours(stack.pop()!)) {
        if (cells.has(n) && !seen.has(n)) {
          seen.add(n);
          region.add(n);
          stack.push(n);
        }
      }
    }
    if (region.size > best.size) best = region;
  }
  return best;
}

/** Add every empty cell inside the bounding box that cannot reach the outside. */
function fillHoles(region: Set<CellKey>): Set<CellKey> {
  let minI = Infinity;
  let minJ = Infinity;
  let maxI = -Infinity;
  let maxJ = -Infinity;
  for (const k of region) {
    const [i, j] = parseCell(k);
    minI = Math.min(minI, i);
    minJ = Math.min(minJ, j);
    maxI = Math.max(maxI, i);
    maxJ = Math.max(maxJ, j);
  }
  const outside = new Set<CellKey>();
  const stack: CellKey[] = [];
  for (let i = minI - 1; i <= maxI + 1; i++) {
    for (let j = minJ - 1; j <= maxJ + 1; j++) {
      if (i === minI - 1 || i === maxI + 1 || j === minJ - 1 || j === maxJ + 1) {
        outside.add(cellKey(i, j));
        stack.push(cellKey(i, j));
      }
    }
  }
  while (stack.length) {
    for (const n of neighbours(stack.pop()!)) {
      const [i, j] = parseCell(n);
      if (i < minI - 1 || i > maxI + 1 || j < minJ - 1 || j > maxJ + 1) continue;
      if (!region.has(n) && !outside.has(n)) {
        outside.add(n);
        stack.push(n);
      }
    }
  }
  const filled = new Set(region);
  for (let i = minI; i <= maxI; i++) for (let j = minJ; j <= maxJ; j++) if (!outside.has(cellKey(i, j))) filled.add(cellKey(i, j));
  return filled;
}

function dropCollinear(loop: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < loop.length; i++) {
    const prev = loop[(i - 1 + loop.length) % loop.length]!;
    const cur = loop[i]!;
    const next = loop[(i + 1) % loop.length]!;
    const collinear = (prev.x === cur.x && cur.x === next.x) || (prev.z === cur.z && cur.z === next.z);
    if (!collinear) out.push(cur);
  }
  return out;
}
