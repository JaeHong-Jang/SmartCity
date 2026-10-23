// Pedestrian graph (ADR 0008 §4, Sol 06 §2): derived from the compiled road network and the buildings,
// separate from the lane graph. Edges: sidewalks (sidewalk centerline = carriageway edge + half the
// sidewalk), corners around junctions (miter / bevel / arc, never through the junction center),
// crossings (one per RoadGraph crossing) and building access edges (door on the footprint face nearest the
// sidewalk → sidewalk, never across a carriageway). Every edge is walkable both ways. Pure and
// deterministic: segments, nodes, crossings and buildings are visited in sorted-id order.

import {
  add,
  carriagewayWidth,
  closestPointOnPolyline,
  cumulativeLengths,
  dist,
  normalize,
  offsetPolyline,
  partFootprint,
  pointAtLength,
  rightNormal,
  scale,
  segmentDistance,
  SIDEWALK_WIDTH,
  slicePolyline,
  sub,
  tangentAtLength,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';
import type { CompiledSegment, RoadGraph } from '../types.js';
import { CROSSWALK_ZONE } from './compile.js';
import { MinHeap } from './route.js';

export const PedEdgeKind = { sidewalk: 0, corner: 1, crossing: 2, access: 3 } as const;

/** Buildings attach to a sidewalk within this distance of their position (same radius as vehicle demand). */
export const ACCESS_RADIUS = 80;
const NODE_MERGE = 0.25;
const MITER_LIMIT = 2 * SIDEWALK_WIDTH;
const DEG = Math.PI / 180;
const GRID = 32;
/** Route cost: walking time at the mean speed plus a fixed wait for every crossing. */
export const ROUTE_SPEED = 1.3;
const CROSSING_COST = 8;

export interface BuildingAccess {
  door: number;
  /** Sidewalk node at the end of the access edge. */
  attach: number;
  accessEdge: number;
  segId: string;
  /** Sidewalk side of the attach node: +1 = right of a → b, −1 = left. */
  side: 1 | -1;
  /** Centerline arc length (from node a) of the attach point. */
  s: number;
  /** Curbside node at `s` on each side (where a car stops), −1 when that side has no sidewalk. */
  stopR: number;
  stopL: number;
}

export interface PedGraph {
  nNodes: number;
  x: Float64Array;
  z: Float64Array;
  nEdges: number;
  from: Int32Array;
  to: Int32Array;
  len: Float64Array;
  kind: Uint8Array;
  /** Crossing index of a crossing edge, −1 otherwise. */
  crossing: Int32Array;
  pts: Vec2[][];
  cum: number[][];
  /** CSR adjacency of signed edges (edge·2 = from → to, edge·2+1 = to → from), in edge order. */
  adjStart: Int32Array;
  adj: Int32Array;
  /** Per RoadGraph crossing: its edge, −1 if it could not be built. */
  crossingEdge: Int32Array;
  /** Sorted building ids and their access (null = not connected). */
  buildingIds: string[];
  access: (BuildingAccess | null)[];
  /** Edges by grid cell, for re-projection. */
  grid: Map<number, number[]>;
  /** Connected component of each node (walkable both ways, access edges included). */
  comp: Int32Array;
  /** Scratch stamps for neighbour searches (never part of the graph's meaning). */
  mark: Uint32Array;
}

let markStamp = 0;

interface Run {
  seg: CompiledSegment;
  side: 1 | -1;
  off: number;
  s0: number;
  s1: number;
  pts: Vec2[];
  cum: number[];
  splits: number[];
  nodeS: number[];
  nodes: number[];
}

const cellKey = (ix: number, iz: number): number => (ix + 32768) * 65536 + (iz + 32768);

function sidePoint(seg: CompiledSegment, cum: number[], s: number, side: number, off: number): Vec2 {
  const c = pointAtLength(seg.centerline, cum, s);
  const t = tangentAtLength(seg.centerline, cum, Math.max(1e-6, Math.min(seg.length, s)));
  return add(c, scale(rightNormal(t), side * off));
}

function lineIntersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = d.x * e.z - d.z * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * e.z - (q.z - p.z) * e.x) / den;
  return add(p, scale(d, t));
}

export function buildPedGraph(doc: CityDoc, g: RoadGraph): PedGraph {
  const nx: number[] = [];
  const nz: number[] = [];
  const addNode = (p: Vec2): number => {
    nx.push(p.x);
    nz.push(p.z);
    return nx.length - 1;
  };
  const eFrom: number[] = [];
  const eTo: number[] = [];
  const eKind: number[] = [];
  const eCross: number[] = [];
  const ePts: Vec2[][] = [];
  const addEdge = (a: number, b: number, pts: Vec2[], kind: number, cross = -1): number => {
    const p = pts.slice();
    p[0] = { x: nx[a]!, z: nz[a]! };
    p[p.length - 1] = { x: nx[b]!, z: nz[b]! };
    const clean: Vec2[] = [p[0]!];
    for (let i = 1; i < p.length; i++) if (dist(p[i]!, clean[clean.length - 1]!) > 1e-3 || i === p.length - 1) clean.push(p[i]!);
    if (clean.length < 2) clean.push(clean[0]!);
    eFrom.push(a);
    eTo.push(b);
    eKind.push(kind);
    eCross.push(cross);
    ePts.push(clean);
    return ePts.length - 1;
  };

  // ---- sidewalk runs: one per segment side, between the junction crossing lines ----
  const runs: Run[] = [];
  const runOf = new Map<string, Run>();
  const cumOf = new Map<string, number[]>();
  for (const seg of g.segments.values()) {
    const cum = cumulativeLengths(seg.centerline);
    cumOf.set(seg.id, cum);
    if (!seg.roadType.sidewalk) continue;
    const ds = doc.segments[seg.id]!;
    const degA = g.nodes.get(ds.a)?.segments.length ?? 1;
    const degB = g.nodes.get(ds.b)?.segments.length ?? 1;
    let s0 = degA >= 2 ? seg.setbackA + CROSSWALK_ZONE / 2 : 0;
    let s1 = degB >= 2 ? seg.length - seg.setbackB - CROSSWALK_ZONE / 2 : seg.length;
    if (s1 - s0 < 0.5) s0 = s1 = (s0 + s1) / 2;
    const off = carriagewayWidth(seg.roadType) / 2 + SIDEWALK_WIDTH / 2;
    for (const side of [1, -1] as const) {
      const pts =
        s1 > s0 ? offsetPolyline(slicePolyline(seg.centerline, s0, s1), side * off) : [sidePoint(seg, cum, s0, side, off)];
      pts[0] = sidePoint(seg, cum, s0, side, off);
      pts[pts.length - 1] = sidePoint(seg, cum, s1, side, off);
      const run: Run = { seg, side, off, s0, s1, pts, cum: cumulativeLengths(pts), splits: [], nodeS: [], nodes: [] };
      runs.push(run);
      runOf.set(`${seg.id}|${side}`, run);
    }
  }
  for (const cr of g.crossings) {
    if (cr.kind !== 'midblock') continue;
    for (const side of [1, -1]) runOf.get(`${cr.segmentId}|${side}`)?.splits.push(cr.s);
  }

  // ---- building doors: face midpoint nearest the closest sidewalk, access line clear of carriageways ----
  const segBoxes = [...g.segments.values()].map((seg) => {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const p of seg.centerline) {
      x0 = Math.min(x0, p.x);
      z0 = Math.min(z0, p.z);
      x1 = Math.max(x1, p.x);
      z1 = Math.max(z1, p.z);
    }
    const hw = carriagewayWidth(seg.roadType) / 2;
    return { seg, hw, x0: x0 - hw, z0: z0 - hw, x1: x1 + hw, z1: z1 + hw };
  });
  const crossesRoad = (p: Vec2, q: Vec2): boolean => {
    const x0 = Math.min(p.x, q.x);
    const x1 = Math.max(p.x, q.x);
    const z0 = Math.min(p.z, q.z);
    const z1 = Math.max(p.z, q.z);
    for (const b of segBoxes) {
      if (b.x0 > x1 || b.x1 < x0 || b.z0 > z1 || b.z1 < z0) continue;
      const c = b.seg.centerline;
      for (let i = 1; i < c.length; i++) if (segmentDistance(p, q, c[i - 1]!, c[i]!) < b.hw - 1e-3) return true;
    }
    return false;
  };
  const runBoxes = runs.map((r) => {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const p of r.pts) {
      x0 = Math.min(x0, p.x);
      z0 = Math.min(z0, p.z);
      x1 = Math.max(x1, p.x);
      z1 = Math.max(z1, p.z);
    }
    return { x0, z0, x1, z1 };
  });
  const buildingIds = Object.keys(doc.buildings).sort();
  const pending: ({ run: Run; s: number; door: Vec2 } | null)[] = [];
  for (const id of buildingIds) {
    const b = doc.buildings[id]!;
    const type = doc.buildingTypes[b.typeId];
    if (!type || type.parts.length === 0) {
      pending.push(null);
      continue;
    }
    const ground = type.parts.filter((p) => p.baseHeight < 0.5);
    const polys = (ground.length ? ground : type.parts).map((p) => partFootprint(b, p));
    const cands: { run: Run; d: number; i: number; q: Vec2 }[] = [];
    runs.forEach((r, i) => {
      const bx = runBoxes[i]!;
      if (b.pos.x < bx.x0 - ACCESS_RADIUS || b.pos.x > bx.x1 + ACCESS_RADIUS || b.pos.z < bx.z0 - ACCESS_RADIUS || b.pos.z > bx.z1 + ACCESS_RADIUS) return;
      const cp = closestPointOnPolyline(r.pts, b.pos);
      if (cp.distance <= ACCESS_RADIUS) cands.push({ run: r, d: cp.distance, i, q: cp.point });
    });
    cands.sort((p, q) => p.d - q.d || p.i - q.i);
    let found: { run: Run; s: number; door: Vec2 } | null = null;
    for (const c of cands.slice(0, 8)) {
      let door = polys[0]![0]!;
      let best = Infinity;
      for (const poly of polys)
        for (let k = 0; k < poly.length; k++) {
          const m = scale(add(poly[k]!, poly[(k + 1) % poly.length]!), 0.5);
          const d = dist(m, c.q);
          if (d < best - 1e-9) {
            best = d;
            door = m;
          }
        }
      const q = closestPointOnPolyline(c.run.pts, door).point;
      if (crossesRoad(door, q)) continue;
      const s = Math.max(c.run.s0, Math.min(c.run.s1, closestPointOnPolyline(c.run.seg.centerline, q).s));
      found = { run: c.run, s, door };
      break;
    }
    if (found) {
      found.run.splits.push(found.s);
      runOf.get(`${found.run.seg.id}|${-found.run.side}`)?.splits.push(found.s);
    }
    pending.push(found);
  }

  // ---- run nodes and sidewalk edges ----
  for (const r of runs) {
    const ss = [r.s0, ...r.splits.map((s) => Math.max(r.s0, Math.min(r.s1, s))), r.s1].sort((p, q) => p - q);
    const cum = cumOf.get(r.seg.id)!;
    for (const s of ss) {
      if (r.nodeS.length && s - r.nodeS[r.nodeS.length - 1]! < NODE_MERGE) continue;
      r.nodeS.push(s);
      r.nodes.push(addNode(sidePoint(r.seg, cum, s, r.side, r.off)));
    }
    // The last node must sit exactly at s1 (junction crossings and corners attach there).
    if (r.nodeS[r.nodeS.length - 1] !== r.s1 && r.s1 - r.nodeS[r.nodeS.length - 1]! < NODE_MERGE && r.nodeS.length > 1) {
      r.nodeS[r.nodeS.length - 1] = r.s1;
      const p = sidePoint(r.seg, cum, r.s1, r.side, r.off);
      nx[r.nodes[r.nodes.length - 1]!] = p.x;
      nz[r.nodes[r.nodes.length - 1]!] = p.z;
    }
    for (let i = 1; i < r.nodes.length; i++) {
      const pts = offsetPolyline(slicePolyline(r.seg.centerline, r.nodeS[i - 1]!, r.nodeS[i]!), r.side * r.off);
      addEdge(r.nodes[i - 1]!, r.nodes[i]!, pts, PedEdgeKind.sidewalk);
    }
  }
  const nodeAt = (r: Run, s: number): number => {
    let best = 0;
    for (let i = 1; i < r.nodeS.length; i++) if (Math.abs(r.nodeS[i]! - s) < Math.abs(r.nodeS[best]! - s)) best = i;
    return r.nodes[best]!;
  };

  // ---- corners around every node (sorted ids) ----
  for (const [nodeId, node] of g.nodes) {
    const legs: { seg: CompiledSegment; atA: boolean; out: Vec2; angle: number }[] = [];
    for (const segId of node.segments) {
      const seg = g.segments.get(segId)!;
      const ds = doc.segments[segId]!;
      const c = seg.centerline;
      const atA = ds.a === nodeId;
      const out = atA ? normalize(sub(c[1]!, c[0]!)) : normalize(sub(c[c.length - 2]!, c[c.length - 1]!));
      legs.push({ seg, atA, out, angle: Math.atan2(out.z, out.x) });
    }
    legs.sort((p, q) => p.angle - q.angle || (p.seg.id < q.seg.id ? -1 : 1));
    const n = legs.length;
    for (let i = 0; i < n; i++) {
      const li = legs[i]!;
      const lj = legs[(i + 1) % n]!;
      if (!li.seg.roadType.sidewalk || !lj.seg.roadType.sidewalk) continue;
      // Right of the outward direction faces the next leg (increasing angle).
      const si = li.atA ? 1 : -1;
      const sj = lj.atA ? -1 : 1;
      const ri = runOf.get(`${li.seg.id}|${si}`)!;
      const rj = runOf.get(`${lj.seg.id}|${sj}`)!;
      const pi = li.atA ? ri.nodes[0]! : ri.nodes[ri.nodes.length - 1]!;
      const pj = lj.atA ? rj.nodes[0]! : rj.nodes[rj.nodes.length - 1]!;
      if (pi === pj) continue;
      const ei = sidePoint(li.seg, cumOf.get(li.seg.id)!, li.atA ? li.seg.setbackA : li.seg.length - li.seg.setbackB, si, ri.off);
      const ej = sidePoint(lj.seg, cumOf.get(lj.seg.id)!, lj.atA ? lj.seg.setbackA : lj.seg.length - lj.seg.setbackB, sj, rj.off);
      let delta = n === 1 ? 2 * Math.PI : lj.angle - li.angle;
      while (delta <= 1e-9) delta += 2 * Math.PI;
      const P = { x: nx[pi]!, z: nz[pi]! };
      const Q = { x: nx[pj]!, z: nz[pj]! };
      let pts: Vec2[];
      if (delta > 190 * DEG) {
        // Reflex side or dead end: arc around the node, outside every carriageway.
        const c = node.pos;
        const r = Math.max(dist(ei, c), dist(ej, c), 0.5);
        const a0 = Math.atan2(ei.z - c.z, ei.x - c.x);
        let sweep = Math.atan2(ej.z - c.z, ej.x - c.x) - a0;
        while (sweep <= 1e-9) sweep += 2 * Math.PI;
        const k = Math.max(2, Math.ceil(sweep / (20 * DEG)));
        pts = [P, ei];
        for (let m = 0; m <= k; m++) {
          const a = a0 + (sweep * m) / k;
          pts.push({ x: c.x + r * Math.cos(a), z: c.z + r * Math.sin(a) });
        }
        pts.push(ej, Q);
      } else {
        const miter = delta < 170 * DEG ? lineIntersect(ei, li.out, ej, lj.out) : null;
        pts = miter && dist(miter, ei) <= MITER_LIMIT && dist(miter, ej) <= MITER_LIMIT ? [P, ei, miter, ej, Q] : [P, ei, ej, Q];
      }
      addEdge(pi, pj, pts, PedEdgeKind.corner);
    }
  }

  // ---- crossings ----
  const crossingEdge = new Int32Array(g.crossings.length).fill(-1);
  for (const cr of g.crossings) {
    const rr = runOf.get(`${cr.segmentId}|1`);
    const rl = runOf.get(`${cr.segmentId}|-1`);
    if (!rr || !rl) continue;
    let a: number;
    let b: number;
    if (cr.kind === 'junction') {
      const atA = doc.segments[cr.segmentId]!.a === cr.nodeId;
      a = atA ? rr.nodes[0]! : rr.nodes[rr.nodes.length - 1]!;
      b = atA ? rl.nodes[0]! : rl.nodes[rl.nodes.length - 1]!;
    } else {
      a = nodeAt(rr, cr.s);
      b = nodeAt(rl, cr.s);
    }
    crossingEdge[cr.index] = addEdge(a, b, [{ x: nx[a]!, z: nz[a]! }, { x: nx[b]!, z: nz[b]! }], PedEdgeKind.crossing, cr.index);
  }

  // ---- building access edges ----
  const access: (BuildingAccess | null)[] = pending.map((f) => {
    if (!f) return null;
    const attach = nodeAt(f.run, f.s);
    const door = addNode(f.door);
    const accessEdge = addEdge(door, attach, [f.door, { x: nx[attach]!, z: nz[attach]! }], PedEdgeKind.access);
    const other = runOf.get(`${f.run.seg.id}|${-f.run.side}`);
    const opposite = other ? nodeAt(other, f.s) : -1;
    return {
      door,
      attach,
      accessEdge,
      segId: f.run.seg.id,
      side: f.run.side,
      s: f.s,
      stopR: f.run.side === 1 ? attach : opposite,
      stopL: f.run.side === -1 ? attach : opposite,
    };
  });

  // ---- flat arrays, adjacency, grid ----
  const nNodes = nx.length;
  const nEdges = ePts.length;
  const len = new Float64Array(nEdges);
  const cum: number[][] = [];
  for (let e = 0; e < nEdges; e++) {
    const c = cumulativeLengths(ePts[e]!);
    cum.push(c);
    len[e] = Math.max(c[c.length - 1]!, 0.05);
  }
  const deg = new Int32Array(nNodes + 1);
  for (let e = 0; e < nEdges; e++) {
    deg[eFrom[e]! + 1]!++;
    deg[eTo[e]! + 1]!++;
  }
  for (let i = 0; i < nNodes; i++) deg[i + 1]! += deg[i]!;
  const adjStart = deg.slice();
  const fill = deg.slice(0, nNodes);
  const adj = new Int32Array(2 * nEdges);
  for (let e = 0; e < nEdges; e++) {
    adj[fill[eFrom[e]!]!++] = e * 2;
    adj[fill[eTo[e]!]!++] = e * 2 + 1;
  }
  const grid = new Map<number, number[]>();
  for (let e = 0; e < nEdges; e++) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const p of ePts[e]!) {
      x0 = Math.min(x0, p.x);
      z0 = Math.min(z0, p.z);
      x1 = Math.max(x1, p.x);
      z1 = Math.max(z1, p.z);
    }
    for (let ix = Math.floor(x0 / GRID); ix <= Math.floor(x1 / GRID); ix++)
      for (let iz = Math.floor(z0 / GRID); iz <= Math.floor(z1 / GRID); iz++) {
        const k = cellKey(ix, iz);
        const l = grid.get(k);
        if (l) l.push(e);
        else grid.set(k, [e]);
      }
  }
  const parent = new Int32Array(nNodes);
  for (let i = 0; i < nNodes; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  for (let e = 0; e < nEdges; e++) {
    const a = find(eFrom[e]!);
    const b = find(eTo[e]!);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const comp = new Int32Array(nNodes);
  for (let i = 0; i < nNodes; i++) comp[i] = find(i);
  return {
    nNodes,
    x: Float64Array.from(nx),
    z: Float64Array.from(nz),
    nEdges,
    from: Int32Array.from(eFrom),
    to: Int32Array.from(eTo),
    len,
    kind: Uint8Array.from(eKind),
    crossing: Int32Array.from(eCross),
    pts: ePts,
    cum,
    adjStart,
    adj,
    crossingEdge,
    buildingIds,
    access,
    grid,
    comp,
    mark: new Uint32Array(nEdges),
  };
}

/** Calls `fn` once for every edge whose grid cells come within `radius` of p. */
function forEdgesNear(pg: PedGraph, p: Vec2, radius: number, fn: (e: number) => void): void {
  const stamp = ++markStamp;
  for (let ix = Math.floor((p.x - radius) / GRID); ix <= Math.floor((p.x + radius) / GRID); ix++)
    for (let iz = Math.floor((p.z - radius) / GRID); iz <= Math.floor((p.z + radius) / GRID); iz++) {
      const list = pg.grid.get(cellKey(ix, iz));
      if (!list) continue;
      for (const e of list) {
        if (pg.mark[e] === stamp) continue;
        pg.mark[e] = stamp;
        fn(e);
      }
    }
}

/** Closest node within `radius` (in component `comp`, −1 = any), ties by node index; −1 when none. */
export function nearestNode(pg: PedGraph, p: Vec2, radius: number, comp = -1): number {
  let best = -1;
  let bd = Infinity;
  const consider = (n: number): void => {
    if (comp >= 0 && pg.comp[n] !== comp) return;
    const d = Math.hypot(pg.x[n]! - p.x, pg.z[n]! - p.z);
    if (d <= radius && (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && n < best))) {
      best = n;
      bd = d;
    }
  };
  forEdgesNear(pg, p, radius, (e) => {
    consider(pg.from[e]!);
    consider(pg.to[e]!);
  });
  return best;
}

/** Closest point on a sidewalk or corner edge within `radius` (in component `comp`, −1 = any), ties by edge index. */
export function nearestEdge(pg: PedGraph, p: Vec2, radius: number, comp = -1): { edge: number; s: number; d: number } | null {
  let best: { edge: number; s: number; d: number } | null = null;
  forEdgesNear(pg, p, radius, (e) => {
    const k = pg.kind[e];
    if (k === PedEdgeKind.crossing || k === PedEdgeKind.access || (comp >= 0 && pg.comp[pg.from[e]!] !== comp)) return;
    const cp = closestPointOnPolyline(pg.pts[e]!, p);
    if (cp.distance > radius) return;
    if (!best || cp.distance < best.d - 1e-9 || (Math.abs(cp.distance - best.d) <= 1e-9 && e < best.edge)) best = { edge: e, s: cp.s, d: cp.distance };
  });
  return best;
}

/** A* over pedestrian nodes. Paths are signed edges; ties pop the smaller node first. */
export class PedRouter {
  private readonly g: Float64Array;
  private readonly via: Int32Array;
  private readonly seen: Uint32Array;
  private readonly done: Uint32Array;
  private readonly heap = new MinHeap();
  private stamp = 0;

  constructor(private readonly pg: PedGraph) {
    this.g = new Float64Array(pg.nNodes);
    this.via = new Int32Array(pg.nNodes);
    this.seen = new Uint32Array(pg.nNodes);
    this.done = new Uint32Array(pg.nNodes);
  }

  /** Signed-edge path from node `src` to node `dst` and its length, or null when unreachable. */
  find(src: number, dst: number): { path: Int32Array; length: number } | null {
    const pg = this.pg;
    if (src === dst) return { path: new Int32Array(0), length: 0 };
    const stamp = ++this.stamp;
    const heap = this.heap;
    heap.clear();
    const tx = pg.x[dst]!;
    const tz = pg.z[dst]!;
    const h = (n: number): number => Math.hypot(pg.x[n]! - tx, pg.z[n]! - tz) / ROUTE_SPEED;
    this.g[src] = 0;
    this.seen[src] = stamp;
    this.via[src] = -1;
    heap.push(h(src), src);
    while (heap.size > 0) {
      const n = heap.pop();
      if (this.done[n] === stamp) continue;
      this.done[n] = stamp;
      if (n === dst) {
        const out: number[] = [];
        let length = 0;
        let cur = n;
        while (cur !== src) {
          const se = this.via[cur]!;
          out.push(se);
          const e = se >> 1;
          length += pg.len[e]!;
          cur = se & 1 ? pg.to[e]! : pg.from[e]!;
        }
        out.reverse();
        return { path: Int32Array.from(out), length };
      }
      const gn = this.g[n]!;
      for (let k = pg.adjStart[n]!; k < pg.adjStart[n + 1]!; k++) {
        const se = pg.adj[k]!;
        const e = se >> 1;
        const m = se & 1 ? pg.from[e]! : pg.to[e]!;
        if (this.done[m] === stamp) continue;
        // Access edges only start or end a trip: no walking through buildings.
        if (pg.kind[e] === PedEdgeKind.access && m !== dst && n !== src) continue;
        const ng = gn + pg.len[e]! / ROUTE_SPEED + (pg.kind[e] === PedEdgeKind.crossing ? CROSSING_COST : 0);
        if (this.seen[m] === stamp && ng >= this.g[m]!) continue;
        this.seen[m] = stamp;
        this.g[m] = ng;
        this.via[m] = se;
        heap.push(ng + h(m), m);
      }
    }
    return null;
  }
}
