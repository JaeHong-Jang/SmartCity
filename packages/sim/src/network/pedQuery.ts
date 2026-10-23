// Pedestrian graph queries (spatial lookups over the edge grid) and the pedestrian A* router.

import { closestPointOnPolyline, type Vec2 } from '@smartcity/shared';
import { GRID, PedEdgeKind, ROUTE_SPEED, type PedGraph } from './pedGraph.js';
import { MinHeap } from './route.js';

const CROSSING_COST = 8;

let markStamp = 0;

/** Calls `fn` once for every edge whose grid cells come within `radius` of p. */
function forEdgesNear(pg: PedGraph, p: Vec2, radius: number, fn: (e: number) => void): void {
  const stamp = ++markStamp;
  const g = pg.grid;
  const ix0 = Math.max(g.x0, Math.floor((p.x - radius) / GRID));
  const ix1 = Math.min(g.x0 + g.nx - 1, Math.floor((p.x + radius) / GRID));
  const iz0 = Math.max(g.z0, Math.floor((p.z - radius) / GRID));
  const iz1 = Math.min(g.z0 + g.nz - 1, Math.floor((p.z + radius) / GRID));
  for (let ix = ix0; ix <= ix1; ix++)
    for (let iz = iz0; iz <= iz1; iz++) {
      const c = (ix - g.x0) * g.nz + (iz - g.z0);
      for (let k = g.start[c]!; k < g.start[c + 1]!; k++) {
        const e = g.edges[k]!;
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
    // The box is never farther than the polyline: skip edges whose box is clearly out of reach.
    const dx = Math.max(pg.box[4 * e]! - p.x, 0, p.x - pg.box[4 * e + 2]!);
    const dz = Math.max(pg.box[4 * e + 1]! - p.z, 0, p.z - pg.box[4 * e + 3]!);
    if (dx * dx + dz * dz > (radius + 1e-6) * (radius + 1e-6)) return;
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
    this.g[src] = 0;
    this.seen[src] = stamp;
    this.via[src] = -1;
    heap.push(Math.hypot(pg.x[src]! - tx, pg.z[src]! - tz) / ROUTE_SPEED, src);
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
        heap.push(ng + Math.hypot(pg.x[m]! - tx, pg.z[m]! - tz) / ROUTE_SPEED, m);
      }
    }
    return null;
  }
}
