// Spatial grids for the checks of ONE transaction (applyCommand, a whole batch included): roads (filed
// under the cells their curve pieces pass through, not their whole hull), lots (polygon box) and
// buildings (world box of their real footprint). Built lazily by the first check that needs them and kept
// current through the transaction's changes (Tx listener): a moved node re-files its roads; a moved or
// placed building, or a changed design, marks those buildings dirty and they are re-filed from their final
// state at the next building lookup (once per building however often the batch changes it; a design change
// that keeps its geometry — a rename — re-files nothing).
//
// Cost model (lead decision, P5b recheck 7):
// - Construction and filing are NOT charged to the command's work budget (charging them would turn the
//   city's size into false refusals). They are bounded by the doc's capacity limits times each entity's
//   covered cells: roads ≈ (length / 64 m + 1) pieces of a few cells each, lots and buildings their true
//   box; an entity covering more than LARGE_CELLS cells goes into a short "large" list instead (scanned by
//   every query). So construction is O(entities + covered cells), never more than LARGE_CELLS per entity.
// - Query work (cells visited, entries scanned, candidates, contact evaluations) IS charged to the
//   transaction's budget (Tx.contact); when it runs out the command is refused (never silently allowed).

import { bounds, rotateY, type Bounds, type Vec2 } from '../geometry.js';
import { partOutline } from '../editing/buildings.js';
import type { BuildingType, CityDoc, RoadSegment } from '../model.js';
import type { Tx } from './tx.js';

const CELL = 64;
/** Grid entries scanned per budget unit (far cheaper than a contact evaluation, the budget unit). */
const ENTRY_WEIGHT = 8;
/** An entity covering more cells than this is kept in the grid's "large" list instead of its cells. */
const LARGE_CELLS = 1024;
const key = (i: number, j: number): number => i * 1_000_003 + j;

/** Box of a road's end and control points (its curve stays inside). Null if a node is missing. */
export function roadHullBox(doc: CityDoc, s: RoadSegment): Bounds | null {
  const a = doc.nodes[s.a]?.pos;
  const b = doc.nodes[s.b]?.pos;
  if (!a || !b) return null;
  return bounds(s.control ? [a, b, s.control] : [a, b]);
}

/** Ids filed under grid cells; stale entries are filtered by the caller against the current doc. */
class Grid {
  private cells = new Map<number, string[]>();
  /** Entities too big for the cells (see LARGE_CELLS), with their current boxes. */
  private large = new Map<string, readonly Bounds[]>();

  /** File `id` under the cells of the boxes. */
  file(id: string, boxes: readonly Bounds[]): void {
    let cover = 0;
    for (const box of boxes) cover += (Math.floor(box.maxX / CELL) - Math.floor(box.minX / CELL) + 1) * (Math.floor(box.maxZ / CELL) - Math.floor(box.minZ / CELL) + 1);
    if (cover > LARGE_CELLS) {
      this.large.set(id, boxes);
      return;
    }
    this.large.delete(id);
    for (const box of boxes)
      for (let i = Math.floor(box.minX / CELL); i <= Math.floor(box.maxX / CELL); i++)
        for (let j = Math.floor(box.minZ / CELL); j <= Math.floor(box.maxZ / CELL); j++) {
          const l = this.cells.get(key(i, j));
          if (!l) this.cells.set(key(i, j), [id]);
          else if (l[l.length - 1] !== id) l.push(id);
        }
  }

  /**
   * Sorted unique ids under `boxes`; null when the budget runs out. Charged: one unit per cell and per id
   * found, plus one per ENTRY_WEIGHT entries scanned.
   */
  near(boxes: readonly Bounds[], budget: { left: number }): string[] | null {
    const seen = new Set<number>();
    const ids = new Set<string>();
    for (const box of boxes)
      for (let i = Math.floor(box.minX / CELL); i <= Math.floor(box.maxX / CELL); i++)
        for (let j = Math.floor(box.minZ / CELL); j <= Math.floor(box.maxZ / CELL); j++) {
          const k = key(i, j);
          if (seen.has(k)) continue;
          seen.add(k);
          const l = this.cells.get(k);
          const before = ids.size;
          if (l) for (const id of l) ids.add(id);
          budget.left -= 1 + (ids.size - before) + (l ? l.length / ENTRY_WEIGHT : 0);
          if (budget.left < 0) return null;
        }
    budget.left -= this.large.size / ENTRY_WEIGHT;
    if (budget.left < 0) return null;
    for (const [id, own] of this.large) if (own.some((o) => boxes.some((q) => o.maxX >= q.minX && o.minX <= q.maxX && o.maxZ >= q.minZ && o.minZ <= q.maxZ))) ids.add(id);
    return [...ids].sort();
  }
}

export class TxIndex {
  private roadGrid: Grid | null = null;
  private parcelGrid: Grid | null = null;
  private buildingGrid: Grid | null = null;
  private atNode: Map<string, string[]> | null = null;
  /** Buildings and designs changed since the building grid was last brought up to date (see flushBuildings). */
  private dirtyBuildings = new Set<string>();
  private dirtyTypes = new Set<string>();
  /** Per design: the geometry its buildings are filed with, and its part outlines in the building frame. */
  private filedShape = new Map<string, { sig: string; outlines: Vec2[][] }>();

  private constructor(private readonly doc: CityDoc) {}

  /** The transaction's index (created on first use; kept current through the transaction's changes). */
  static of(doc: CityDoc, tx: Tx): TxIndex {
    if (tx.index) return tx.index;
    const idx = new TxIndex(doc);
    tx.index = idx;
    tx.listen((rec, id) => idx.changed(rec, id));
    return idx;
  }

  private changed(rec: object, id: string): void {
    const doc = this.doc;
    if (rec === doc.segments) {
      const s = doc.segments[id];
      if (s && this.atNode) this.link(s);
      if (s && this.roadGrid) this.fileRoad(s);
    } else if (rec === doc.nodes) {
      // A moved node moves its roads.
      if (this.roadGrid) for (const sid of this.adjacency().get(id) ?? []) if (doc.segments[sid]) this.fileRoad(doc.segments[sid]!);
    } else if (rec === doc.parcels) {
      const p = doc.parcels[id];
      if (p && this.parcelGrid) this.parcelGrid.file(id, [bounds(p.polygon)]);
    } else if (rec === doc.buildings) {
      if (this.buildingGrid) this.dirtyBuildings.add(id);
    } else if (rec === doc.buildingTypes) {
      if (this.buildingGrid) this.dirtyTypes.add(id);
    }
  }

  /** Roads are filed under the cells their curve pieces' hulls cover (a long diagonal fills a band, not its box). */
  private fileRoad(s: RoadSegment): void {
    const a = this.doc.nodes[s.a]?.pos;
    const b = this.doc.nodes[s.b]?.pos;
    if (a && b) this.roadGrid!.file(s.id, curveBoxes(a, b, s.control, 0));
  }

  private link(s: RoadSegment): void {
    for (const n of [s.a, s.b]) {
      const l = this.atNode!.get(n);
      if (!l) this.atNode!.set(n, [s.id]);
      else if (!l.includes(s.id)) l.push(s.id);
    }
  }

  /** Road ids at each node (built on first use by one scan; entries of removed roads are filtered on use). */
  private adjacency(): Map<string, string[]> {
    if (!this.atNode) {
      this.atNode = new Map();
      for (const s of Object.values(this.doc.segments)) this.link(s);
    }
    return this.atNode;
  }

  /** The design's geometry as it is now (what partOutline depends on), and its outlines in the building frame. */
  private shape(typeId: string): { sig: string; outlines: Vec2[][] } {
    const t: BuildingType | undefined = this.doc.buildingTypes[typeId];
    const sig = t ? JSON.stringify(t.parts.map((p) => [p.offset.x, p.offset.z, p.width, p.depth, p.round ?? 0, p.footprint ?? null])) : '';
    const filed = this.filedShape.get(typeId);
    if (filed && filed.sig === sig) return filed;
    const fresh = { sig, outlines: t ? t.parts.map((p) => partOutline(p)) : [] };
    this.filedShape.set(typeId, fresh);
    return fresh;
  }

  /**
   * Building box: the world box of its real footprint (position, rotation and design, part offsets included;
   * the same outlines as buildingFootprints).
   */
  private fileBuilding(id: string): void {
    const b = this.doc.buildings[id]!;
    const { outlines } = this.shape(b.typeId);
    if (outlines.length === 0) return;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const poly of outlines)
      for (const v of poly) {
        const r = rotateY(v, b.rotation);
        const x = b.pos.x + r.x;
        const z = b.pos.z + r.z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    this.buildingGrid!.file(id, [{ minX, minZ, maxX, maxZ }]);
  }

  /**
   * Bring the building grid up to the final state of the changes so far: a design whose geometry really
   * changed marks its buildings; every marked building is re-filed once (old entries only widen a search).
   */
  private flushBuildings(): void {
    if (this.dirtyTypes.size > 0) {
      const changed = new Set<string>();
      for (const typeId of this.dirtyTypes) {
        const before = this.filedShape.get(typeId)?.sig;
        if (this.shape(typeId).sig !== before) changed.add(typeId);
      }
      this.dirtyTypes.clear();
      if (changed.size > 0) for (const b of Object.values(this.doc.buildings)) if (changed.has(b.typeId)) this.dirtyBuildings.add(b.id);
    }
    for (const id of this.dirtyBuildings) if (this.doc.buildings[id]) this.fileBuilding(id);
    this.dirtyBuildings.clear();
  }

  /** Roads at a node now, in id order. */
  segmentsAt(nodeId: string): RoadSegment[] {
    return (this.adjacency().get(nodeId) ?? [])
      .map((id) => this.doc.segments[id])
      .filter((s): s is RoadSegment => !!s && (s.a === nodeId || s.b === nodeId))
      .sort((p, q) => (p.id < q.id ? -1 : 1));
  }

  /** Roads near the boxes (current ones, by id); null when the budget runs out (building the grid included). */
  roadsNear(boxes: readonly Bounds[], budget: { left: number }): RoadSegment[] | null {
    if (!this.roadGrid) {
      this.roadGrid = new Grid();
      for (const s of Object.values(this.doc.segments)) this.fileRoad(s);
    }
    if (budget.left < 0) return null;
    const ids = this.roadGrid.near(boxes, budget);
    return ids && ids.map((id) => this.doc.segments[id]).filter((s): s is RoadSegment => !!s);
  }

  /** Ids of the lots near the boxes, sorted; null when the budget runs out. */
  parcelsNear(boxes: readonly Bounds[], budget: { left: number }): string[] | null {
    if (!this.parcelGrid) {
      this.parcelGrid = new Grid();
      for (const p of Object.values(this.doc.parcels)) this.parcelGrid.file(p.id, [bounds(p.polygon)]);
    }
    if (budget.left < 0) return null;
    return this.parcelGrid.near(boxes, budget)?.filter((id) => !!this.doc.parcels[id]) ?? null;
  }

  /** Ids of the buildings near the boxes, sorted; null when the budget runs out. */
  buildingsNear(boxes: readonly Bounds[], budget: { left: number }): string[] | null {
    if (!this.buildingGrid) {
      this.buildingGrid = new Grid();
      for (const id of Object.keys(this.doc.buildings)) this.fileBuilding(id);
    } else {
      this.flushBuildings();
    }
    if (budget.left < 0) return null;
    return this.buildingGrid.near(boxes, budget)?.filter((id) => !!this.doc.buildings[id]) ?? null;
  }
}

/** Boxes covering a straight or quadratic curve piece by piece (pieces about one grid cell long), grown by `margin`. */
export function curveBoxes(a: Vec2, b: Vec2, control: Vec2 | undefined, margin: number): Bounds[] {
  const len = control ? Math.hypot(control.x - a.x, control.z - a.z) + Math.hypot(b.x - control.x, b.z - control.z) : Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / CELL));
  const at = (t: number): Vec2 =>
    control
      ? { x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * control.x + t * t * b.x, z: (1 - t) * (1 - t) * a.z + 2 * (1 - t) * t * control.z + t * t * b.z }
      : { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  const out: Bounds[] = [];
  for (let k = 0; k < n; k++) {
    const t0 = k / n;
    const t1 = (k + 1) / n;
    const p0 = at(t0);
    const pts = [p0, at(t1)];
    if (control) {
      // Control point of the piece: B(t0) + (t1 − t0)·B'(t0)/2 (the piece stays in this hull).
      const dx = (1 - t0) * (control.x - a.x) + t0 * (b.x - control.x);
      const dz = (1 - t0) * (control.z - a.z) + t0 * (b.z - control.z);
      pts.push({ x: p0.x + (t1 - t0) * dx, z: p0.z + (t1 - t0) * dz });
    }
    const box = bounds(pts);
    out.push({ minX: box.minX - margin, minZ: box.minZ - margin, maxX: box.maxX + margin, maxZ: box.maxZ + margin });
  }
  return out;
}
