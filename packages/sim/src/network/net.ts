// Sim-internal flat indexes over a RoadGraph. An "edge" is a lane (index < nLanes) or a connector
// (edge = nLanes + connector index). Vehicles, routes and leader search all work in edge ids.

import type { Vec2 } from '@smartcity/shared';
import type { RoadGraph, Turn } from '../types.js';

export const TURN_PENALTY: Record<Turn, number> = { straight: 0, right: 2, left: 4, uturn: 15 };
export const SHIFT_PENALTY = 1;

export interface Net {
  graph: RoadGraph;
  nLanes: number;
  nEdges: number;
  len: Float64Array;
  speed: Float64Array;
  /** Static traversal cost in seconds (length / limit + turn and lane-shift penalties). */
  baseCost: Float64Array;
  endX: Float64Array;
  endZ: Float64Array;
  next: number[][];
  /** Lane on a closed segment; for connectors, the target lane's flag. */
  closed: Uint8Array;
  busOnly: Uint8Array;
  pts: Vec2[][];
  cum: number[][];
  /** Per connector: index into nodeIds. */
  connNode: Int32Array;
  /** Per connector: 0 = straight/right, 1 = left/U-turn. */
  connPri: Uint8Array;
  nodeIds: string[];
  nodeSignalized: Uint8Array;
  connById: Map<string, number>;
  /** `${segmentId}|f` / `|b` → lane indexes in laneIndex order. */
  groups: Map<string, number[]>;
}

/**
 * Allocation-free pose on a polyline for snapshots: writes x, z and heading at arc length `s` into
 * out[o..o+2]. `back` = travelling against the polyline; `lateral` = offset to the right of travel.
 */
export function writePose(pts: readonly Vec2[], cum: readonly number[], s: number, back: boolean, lateral: number, out: Float32Array, o: number): void {
  const last = cum.length - 1;
  const t = Math.max(0, Math.min(cum[last]!, s));
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  const seg = cum[hi]! - cum[lo]!;
  const u = seg > 0 ? (t - cum[lo]!) / seg : 0;
  let tx = b.x - a.x;
  let tz = b.z - a.z;
  const l = Math.hypot(tx, tz);
  if (l > 0) {
    tx /= l;
    tz /= l;
  } else {
    tx = 1;
    tz = 0;
  }
  if (back) {
    tx = -tx;
    tz = -tz;
  }
  out[o] = a.x + (b.x - a.x) * u - tz * lateral;
  out[o + 1] = a.z + (b.z - a.z) * u + tx * lateral;
  out[o + 2] = Math.atan2(tz, tx);
}

export const groupKey = (segmentId: string, dir: 'forward' | 'backward'): string => `${segmentId}|${dir === 'forward' ? 'f' : 'b'}`;

export function buildNet(graph: RoadGraph): Net {
  const nLanes = graph.lanes.length;
  const nEdges = nLanes + graph.connectors.length;
  const len = new Float64Array(nEdges);
  const speed = new Float64Array(nEdges);
  const baseCost = new Float64Array(nEdges);
  const endX = new Float64Array(nEdges);
  const endZ = new Float64Array(nEdges);
  const closed = new Uint8Array(nEdges);
  const busOnly = new Uint8Array(nEdges);
  const next: number[][] = [];
  const pts: Vec2[][] = [];
  const cum: number[][] = [];
  const groups = new Map<string, number[]>();
  const nodeIds = [...graph.nodes.keys()].sort();
  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const nodeSignalized = new Uint8Array(nodeIds.length);
  nodeIds.forEach((id, i) => (nodeSignalized[i] = graph.nodes.get(id)!.signalized ? 1 : 0));

  for (const l of graph.lanes) {
    const e = l.index;
    len[e] = l.length;
    speed[e] = l.speedLimit;
    baseCost[e] = l.length / l.speedLimit;
    const end = l.points[l.points.length - 1]!;
    endX[e] = end.x;
    endZ[e] = end.z;
    closed[e] = graph.segments.get(l.segmentId)?.closed ? 1 : 0;
    busOnly[e] = l.busOnly ? 1 : 0;
    next.push(l.out.map((c) => nLanes + c));
    pts.push(l.points);
    cum.push(l.cum);
    const key = groupKey(l.segmentId, l.dir);
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  const connNode = new Int32Array(graph.connectors.length);
  const connPri = new Uint8Array(graph.connectors.length);
  const connById = new Map<string, number>();
  for (const c of graph.connectors) {
    const e = nLanes + c.index;
    const from = graph.lanes[c.fromLane]!;
    const to = graph.lanes[c.toLane]!;
    len[e] = c.length;
    speed[e] = c.speedLimit;
    const nOut = groups.get(groupKey(to.segmentId, to.dir))!.length;
    const shift = c.turn === 'straight' && to.laneIndex !== Math.min(from.laneIndex, nOut - 1) ? SHIFT_PENALTY : 0;
    baseCost[e] = c.length / c.speedLimit + TURN_PENALTY[c.turn] + shift;
    const end = c.points[c.points.length - 1]!;
    endX[e] = end.x;
    endZ[e] = end.z;
    closed[e] = closed[c.toLane]!;
    busOnly[e] = busOnly[c.toLane]!;
    next.push([c.toLane]);
    pts.push(c.points);
    cum.push(c.cum);
    connNode[c.index] = nodeIndex.get(c.nodeId)!;
    connPri[c.index] = c.turn === 'left' || c.turn === 'uturn' ? 1 : 0;
    connById.set(c.id, c.index);
  }

  return { graph, nLanes, nEdges, len, speed, baseCost, endX, endZ, next, closed, busOnly, pts, cum, connNode, connPri, nodeIds, nodeSignalized, connById, groups };
}
