// "주사위": a small deterministic shape grammar (podium → body → setbacks → roof → props) per style
// and size. Same seed, style and size = same draft. Pure; the result goes through the normal save.

import { Rng, voxelKey, internStyle, type BuildingProp, type PropKind, type VoxelStyle, type Zone } from '@smartcity/shared';
import type { VoxelHit } from './picking';
import { snapProp } from './props';
import { PROP_INFO } from './palette';
import { newStudioDoc, type StudioDoc } from './voxelEdit';

export type DiceStyle = 'house' | 'shop' | 'glassOffice' | 'ecoTower' | 'hanok';
export type DiceSize = 'S' | 'M' | 'L';

export const DICE_STYLES: { id: DiceStyle; name: string }[] = [
  { id: 'house', name: '주택' },
  { id: 'shop', name: '상가' },
  { id: 'glassOffice', name: '유리 오피스' },
  { id: 'ecoTower', name: '친환경 타워' },
  { id: 'hanok', name: '한옥풍' },
];

export const DICE_SIZES: { id: DiceSize; name: string }[] = [
  { id: 'S', name: '소' },
  { id: 'M', name: '중' },
  { id: 'L', name: '대' },
];

export interface DiceResult {
  doc: StudioDoc;
  zone: Zone;
  name: string;
}

class Draft {
  readonly doc = newStudioDoc();
  constructor(readonly rng: Rng) {}

  style(s: VoxelStyle): number {
    return internStyle(this.doc.model.styles, s);
  }

  /** Box of cells i ∈ [i0, i0 + w), j ∈ [j0, j0 + d), floors k0 .. k0 + floors − 1. */
  box(style: number, i0: number, j0: number, w: number, d: number, k0: number, floors: number): void {
    for (let k = k0; k < k0 + floors; k++) for (let i = i0; i < i0 + w; i++) for (let j = j0; j < j0 + d; j++) this.doc.model.cells.set(voxelKey(i, j, k), style);
  }

  has(i: number, j: number, k: number): boolean {
    return this.doc.model.cells.has(voxelKey(i, j, k));
  }

  /** Highest occupied floor of a column, or −1. */
  top(i: number, j: number): number {
    let k = -1;
    while (this.has(i, j, k + 1)) k++;
    return k;
  }

  /** Prop on the outside face of cell (i, j, k) facing (nx, nz). */
  wall(kind: PropKind, i: number, j: number, k: number, nx: number, nz: number, size = 1, color = PROP_INFO[kind].color): void {
    if (this.has(i + nx, j + nz, k)) return;
    const r = snapProp(this.doc.model, { kind: 'cell', i, j, k, normal: [nx, 0, nz], t: 0, point: [0, 0, 0] }, kind, 0, size, color);
    if (r.ok) this.push(r.prop);
  }

  /** Prop on top of column (i, j) (on the ground when empty). */
  onTop(kind: PropKind, i: number, j: number, rot = 0, size = 1, color = PROP_INFO[kind].color): void {
    const k = this.top(i, j);
    const hit: VoxelHit = { kind: k < 0 ? 'plane' : 'cell', i, j, k: Math.max(0, k), normal: [0, 1, 0], t: 0, point: [0, 0, 0] };
    const r = snapProp(this.doc.model, hit, kind, rot, size, color);
    if (r.ok) this.push(r.prop);
  }

  private push(p: BuildingProp): void {
    if (this.doc.props.some((q) => q.pos.x === p.pos.x && q.pos.y === p.pos.y && q.pos.z === p.pos.z)) return;
    this.doc.props.push(p);
  }

  range(lo: number, hi: number): number {
    return lo + this.rng.int(hi - lo + 1);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.rng.int(items.length)]!;
  }
}

const SIZE_IDX: Record<DiceSize, 0 | 1 | 2> = { S: 0, M: 1, L: 2 };
const by = <T>(size: DiceSize, s: T, m: T, l: T): T => [s, m, l][SIZE_IDX[size]]!;
/** Start index of a span of n cells centred on 0. */
const c0 = (n: number): number => -Math.floor(n / 2);

function house(g: Draft, size: DiceSize): Zone {
  const w = by(size, g.range(4, 5), g.range(5, 6), g.range(6, 7));
  const d = by(size, 4, g.range(4, 5), g.range(5, 6));
  const floors = by(size, 2, g.range(2, 3), 3);
  const wall = g.pick(['#f2efe8', '#e8dcc8', '#d9c3a5', '#c98f6b', '#a5553f']);
  const roofColor = g.pick(['#3f3f46', '#9a4a32', '#5b5f66']);
  const roof = w === d || g.rng.next() < 0.25 ? 'pyramid' : 'gable';
  const body = g.style({ color: wall, roofColor, roof, facade: { style: 'grid', windowRatio: 0.35, ground: 'none' } });
  const i0 = c0(w);
  const j0 = c0(d);
  // Podium: an optional one-floor annex (garage) on one side, same style so it reads as one house.
  const annex = g.rng.next() < 0.6 ? g.range(2, 3) : 0;
  const left = g.rng.next() < 0.5;
  if (annex) g.box(body, left ? i0 - annex : i0 + w, j0, annex, d - 1, 0, 1);
  // Body.
  g.box(body, i0, j0, w, d, 0, floors);
  // Props: balcony on the front, a tree and a planter in the front yard, chimney on the annex.
  const front = j0 + d - 1;
  const mid = i0 + Math.floor(w / 2);
  if (floors >= 2) g.wall('balcony', mid, front, 1, 0, 1, w >= 6 ? 1.5 : 1, '#f2efe8');
  g.wall('canopy', i0 + 1, front, 0, 0, 1, 0.6);
  g.onTop('tree', left ? i0 + w - 1 : i0, front + 1);
  g.onTop('planter', mid, front + 1, 0, 1);
  g.wall('ac', left ? i0 + w - 1 : i0, j0 + 1, 0, left ? 1 : -1, 0);
  if (annex) g.onTop('chimney', left ? i0 - 1 : i0 + w, j0 + 1);
  return 'residential';
}

function shop(g: Draft, size: DiceSize): Zone {
  const w = by(size, g.range(4, 5), g.range(6, 7), g.range(8, 10));
  const d = by(size, g.range(4, 5), g.range(5, 6), g.range(6, 7));
  const upper = by(size, 2, g.range(2, 3), g.range(3, 4));
  const ground = g.style({ color: g.pick(['#e8dcc8', '#f2efe8', '#d9c3a5']), roofColor: '#5b5f66', roof: 'flat', use: 'commercial', facade: { style: 'grid', windowRatio: 0.5, ground: 'shop' } });
  const homes = g.style({ color: g.pick(['#c98f6b', '#a5553f', '#b8c4c9', '#f2efe8']), roofColor: '#5b5f66', roof: 'flat', use: 'residential', facade: { style: 'grid', windowRatio: 0.4, ground: 'none' } });
  const i0 = c0(w);
  const j0 = c0(d);
  // Podium: the shop floor. Body: homes above, one cell shallower at the back.
  g.box(ground, i0, j0, w, d, 0, 1);
  g.box(homes, i0, j0, w, d - 1, 1, upper);
  // Setback: a front terrace on the top floor of larger shops.
  if (size !== 'S' && g.rng.next() < 0.6) for (let i = i0; i < i0 + w; i++) g.doc.model.cells.delete(voxelKey(i, j0 + d - 2, upper));
  const front = j0 + d - 1;
  const awning = g.pick(['#e4572e', '#3a86ff', '#4caf7d', '#f2c14e']);
  for (let i = i0; i < i0 + w; i += 2) g.wall('awning', i, front, 0, 0, 1, 0.9, awning);
  g.wall('sign', i0 + Math.floor(w / 2), front - 1, 1, 0, 1, 1, g.pick(['#3a86ff', '#e4572e', '#8e5cd9']));
  for (let k = 1; k <= upper; k++) g.wall('ac', i0, j0 + 1, k, -1, 0);
  g.onTop('waterTank', i0 + 1, j0);
  g.onTop('planter', i0 + w - 1, front + 1, 0, 1);
  return 'commercial';
}

function glassOffice(g: Draft, size: DiceSize): Zone {
  const w = by(size, 6, g.range(8, 9), g.range(10, 12));
  const d = by(size, 5, g.range(7, 8), g.range(9, 10));
  const podiumFloors = by(size, 1, 2, 2);
  const towerFloors = by(size, g.range(4, 6), g.range(8, 12), g.range(14, 20));
  const podium = g.style({ color: g.pick(['#b8c4c9', '#7d8790', '#d6d3cc']), roofColor: '#5b5f66', roof: 'flat', use: 'office', facade: { style: 'curtain', windowRatio: 0.75, ground: 'lobby' } });
  const glass = g.style({ color: g.pick(['#5f7f99', '#a9c7d8', '#4b5563']), roofColor: '#2f4f6f', roof: 'flat', use: 'office', facade: { style: 'curtain', windowRatio: 0.85, ground: 'none' } });
  const i0 = c0(w);
  const j0 = c0(d);
  g.box(podium, i0, j0, w, d, 0, podiumFloors);
  // Body: the tower, then 0–2 setbacks of one cell on each side.
  let tw = w - 2;
  let td = d - 2;
  let k = podiumFloors;
  const steps = by(size, 0, g.range(0, 1), g.range(1, 2));
  let left = towerFloors;
  for (let s = 0; s <= steps && left > 0; s++) {
    const n = s === steps ? left : Math.max(2, Math.floor(left / (steps - s + 1)));
    g.box(glass, c0(tw), c0(td), tw, td, k, n);
    k += n;
    left -= n;
    tw = Math.max(2, tw - 2);
    td = Math.max(2, td - 2);
  }
  // Roof props on the tower top, solar on the podium roof, entrance canopy and a flag out front.
  if (size === 'L' && tw + 2 >= 4) g.onTop('helipad', 0, 0, 0, 0.6);
  else g.onTop('antenna', -1, -1);
  g.onTop('solarPanel', i0, j0, 0, 1);
  g.onTop('solarPanel', i0 + w - 1, j0, 0, 1);
  g.wall('canopy', 0, j0 + d - 1, 0, 0, 1, 1.2);
  g.onTop('flag', i0, j0 + d);
  g.onTop('flag', i0 + w - 1, j0 + d);
  return 'office';
}

function ecoTower(g: Draft, size: DiceSize): Zone {
  const w = by(size, 6, g.range(8, 9), g.range(10, 12));
  const d = by(size, 6, g.range(7, 8), g.range(9, 10));
  const steps = by(size, 2, 3, 4);
  const lobby = g.style({ color: '#e7efe4', roofColor: '#5f8f4e', roof: 'flat', facade: { style: 'ribbon', windowRatio: 0.5, ground: 'lobby' } });
  const terrace = g.style({ color: g.pick(['#e7efe4', '#f2efe8', '#c7d9b7']), roofColor: '#5f8f4e', roof: 'flat', facade: { style: 'ribbon', windowRatio: 0.45, ground: 'none' } });
  let i0 = c0(w);
  const j0 = c0(d);
  let tw = w;
  let td = d;
  // Podium: a lobby floor over the whole plot.
  g.box(lobby, i0, j0, tw, td, 0, 1);
  let k = 1;
  const terraces: [number, number, number, number][] = [];
  for (let s = 0; s < steps && tw >= 2 && td >= 2; s++) {
    const n = by(size, g.range(2, 4), g.range(3, 5), g.range(4, 6));
    g.box(terrace, i0, j0, tw, td, k, n);
    terraces.push([i0, j0, tw, td]);
    k += n;
    // Setback: shrink from the front (and alternately a side) so terraces face the street.
    const side = s % 2 === 0 ? 1 : 0;
    td -= 1;
    tw -= side;
    if (side && g.rng.next() < 0.5) i0 += 1;
    if (k >= 27) break;
  }
  // Trees on every terrace front, solar panels on the top roof.
  for (const [ti, tj, ww, dd] of terraces) {
    const fj = tj + dd - 1;
    for (let i = ti; i < ti + ww; i += 2) if (!g.has(i, fj, g.top(i, fj) + 1)) g.onTop(g.rng.next() < 0.6 ? 'tree' : 'planter', i, fj, 0, 0.7);
  }
  const [li, lj, lw, ld] = terraces[terraces.length - 1]!;
  g.onTop('solarPanel', li, lj, 0, 1);
  if (lw > 2) g.onTop('solarPanel', li + lw - 1, lj, 0, 1);
  if (ld > 2) g.onTop('waterTank', li, lj + 1);
  return 'residential';
}

function hanok(g: Draft, size: DiceSize): Zone {
  const hallW = by(size, 5, g.range(6, 7), 8);
  const hall = g.style({ color: '#efe6d6', roofColor: '#3f3f46', roof: 'gable', facade: { style: 'grid', windowRatio: 0.3, ground: 'none' } });
  const wing = g.style({ color: '#e8dcc8', roofColor: '#3f3f46', roof: 'gable', facade: { style: 'grid', windowRatio: 0.3, ground: 'none' } });
  const i0 = c0(hallW);
  const j0 = -3;
  // Body: the main hall (안채) at the back; wings (사랑채) forward on one or both sides.
  g.box(hall, i0, j0, hallW, 3, 0, 1);
  const wingD = by(size, 0, g.range(3, 4), 4);
  if (size !== 'S') g.box(wing, i0, j0 + 3, 3, wingD, 0, 1);
  if (size === 'L') g.box(wing, i0 + hallW - 3, j0 + 3, 3, wingD, 0, 1);
  // Yard props: trees, planters and a bench in the court.
  const yard = j0 + 3;
  g.onTop('tree', i0 + Math.floor(hallW / 2), yard + 1, 0, 0.8, '#2f7d4f');
  g.onTop('planter', i0 + Math.floor(hallW / 2) - 1, yard, 0, 1);
  g.onTop('bench', i0 + Math.floor(hallW / 2) + 1, yard, 2, 1);
  if (size === 'L') g.onTop('tree', i0 + 3, yard + wingD - 1, 0, 0.6, '#e78fb3');
  g.wall('ac', i0, j0 + 1, 0, -1, 0);
  return 'residential';
}

const GRAMMAR: Record<DiceStyle, (g: Draft, size: DiceSize) => Zone> = { house, shop, glassOffice, ecoTower, hanok };

/** Deterministic random design for a seed, style and size. */
export function rollDesign(seed: number, style: DiceStyle, size: DiceSize): DiceResult {
  const g = new Draft(new Rng(seed * 7919 + SIZE_IDX[size] * 131 + DICE_STYLES.findIndex((s) => s.id === style) * 17));
  const zone = GRAMMAR[style](g, size);
  const name = `${DICE_STYLES.find((s) => s.id === style)!.name} #${seed}`;
  return { doc: g.doc, zone, name };
}
