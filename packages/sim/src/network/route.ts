// Lane-graph A*. Nodes are edges (lanes and connectors); g(edge) = cost to reach the end of the edge
// (or the destination point on a goal lane). Ties pop the smaller edge index first.

import { pointAtLength } from '@smartcity/shared';
import type { Net } from './net.js';

export interface RouteGoal {
  lane: number;
  destS: number;
}

export interface RouteResult {
  path: number[];
  /** Goal lane reached (last element of path) and the destination position on it. */
  destS: number;
}

const HEURISTIC_SPEED = 40;
const QUEUE_COST = 2;

class MinHeap {
  private f = new Float64Array(256);
  private e = new Int32Array(256);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  private less(i: number, j: number): boolean {
    const fi = this.f[i]!;
    const fj = this.f[j]!;
    return fi < fj || (fi === fj && this.e[i]! < this.e[j]!);
  }

  private swap(i: number, j: number): void {
    const f = this.f[i]!;
    this.f[i] = this.f[j]!;
    this.f[j] = f;
    const e = this.e[i]!;
    this.e[i] = this.e[j]!;
    this.e[j] = e;
  }

  push(f: number, e: number): void {
    if (this.size === this.f.length) {
      const nf = new Float64Array(this.size * 2);
      nf.set(this.f);
      this.f = nf;
      const ne = new Int32Array(this.size * 2);
      ne.set(this.e);
      this.e = ne;
    }
    let i = this.size++;
    this.f[i] = f;
    this.e[i] = e;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.e[0]!;
    this.size--;
    if (this.size > 0) {
      this.f[0] = this.f[this.size]!;
      this.e[0] = this.e[this.size]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

export class Router {
  private readonly g: Float64Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array;
  private readonly done: Uint32Array;
  private readonly goalMark: Uint32Array;
  private readonly goalS: Float64Array;
  private readonly heap = new MinHeap();
  private stamp = 0;

  constructor(private readonly net: Net) {
    const n = net.nEdges;
    this.g = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.done = new Uint32Array(n);
    this.goalMark = new Uint32Array(net.nLanes);
    this.goalS = new Float64Array(net.nLanes);
  }

  /**
   * Route from edge `start` at position `s` to any goal lane. The start edge itself is always allowed
   * (vehicles drain out of closed roads); other edges must be open and, unless `bus`, not bus-only.
   * `stopped[lane]` adds the queue cost observed now.
   */
  find(start: number, s: number, goals: readonly RouteGoal[], bus: boolean, stopped: Int32Array): RouteResult | null {
    if (goals.length === 0) return null;
    const net = this.net;
    const stamp = ++this.stamp;
    for (const gl of goals) {
      this.goalMark[gl.lane] = stamp;
      this.goalS[gl.lane] = gl.destS;
    }
    if (start < net.nLanes && this.goalMark[start] === stamp && s <= this.goalS[start]! + 1e-6) {
      return { path: [start], destS: this.goalS[start]! };
    }
    const g0 = goals[0]!;
    const destPts = net.pts[g0.lane]!;
    const destCum = net.cum[g0.lane]!;
    const destP = pointAtLength(destPts, destCum, g0.destS);
    const heap = this.heap;
    heap.clear();

    const relax = (n: number, gPrev: number, from: number): void => {
      if (this.done[n] === stamp) return;
      if (net.closed[n] || (!bus && net.busOnly[n])) return;
      const isGoal = n < net.nLanes && this.goalMark[n] === stamp;
      let cost: number;
      if (n < net.nLanes) cost = (isGoal ? this.goalS[n]! / net.speed[n]! : net.baseCost[n]!) + stopped[n]! * QUEUE_COST;
      else cost = net.baseCost[n]!;
      const ng = gPrev + cost;
      if (this.seen[n] === stamp && ng >= this.g[n]!) return;
      this.seen[n] = stamp;
      this.g[n] = ng;
      this.parent[n] = from;
      const h = isGoal ? 0 : Math.hypot(net.endX[n]! - destP.x, net.endZ[n]! - destP.z) / HEURISTIC_SPEED;
      heap.push(ng + h, n);
    };

    const gStart = Math.max(0, net.len[start]! - s) / net.speed[start]!;
    for (const n of net.next[start]!) relax(n, gStart, -1);
    while (heap.size > 0) {
      const e = heap.pop();
      if (this.done[e] === stamp) continue;
      this.done[e] = stamp;
      if (e < net.nLanes && this.goalMark[e] === stamp) {
        const path: number[] = [];
        let cur = e;
        // parent chains only through edges seen in this search; -1 marks the start's successors.
        while (cur !== -1) {
          path.push(cur);
          cur = this.parent[cur]!;
        }
        path.push(start);
        path.reverse();
        return { path, destS: this.goalS[e]! };
      }
      const ge = this.g[e]!;
      for (const n of net.next[e]!) relax(n, ge, e);
    }
    return null;
  }
}

