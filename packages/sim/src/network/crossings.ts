// Conflict zones (ADR 0008 §3): one per crossing. A zone lists the vehicle passages through it — the
// [enterS, exitS] interval of a connector (junction crossings) or a lane (mid-block crossings) over which
// the vehicle front is inside the zebra widened by half a vehicle width. Pure, derived from the graph.

import { add, carriagewayWidth, dist, pointAtLength, rightNormal, scale, sub, tangentAtLength, type Vec2 } from '@smartcity/shared';
import type { Net } from './net.js';

/** Half of the widest vehicle (bus 2.5 m): passages are computed against the zebra widened by this. */
export const VEHICLE_HALF_WIDTH = 1.25;

export interface Passage {
  /** Crossing (zone) index. */
  z: number;
  enterS: number;
  exitS: number;
}

export interface ZoneIndex {
  /** Per connector: passages on it, by enterS. */
  conn: Passage[][];
  /** Per lane: mid-block passages on it, by enterS. */
  lane: Passage[][];
  /** Lanes that carry at least one mid-block passage, ascending. */
  stopLanes: number[];
  /** Per lane: connectors ending on it. */
  incoming: number[][];
  /** Per crossing: curb-to-curb length (m). */
  length: Float64Array;
  /** Per crossing: every passage through it, as [edge, passage]. */
  byZone: { edge: number; p: Passage }[][];
}

/**
 * 32-bit FNV-1a hash of the crossing ids in order (UTF-16 code units of each id, each id followed by a 0
 * unit). Snapshots carry it as `crossingSig` so a renderer reads `crossings` by index only against the
 * graph whose `crossings` produce the same value.
 */
export function crossingSignature(ids: readonly string[]): number {
  let h = 0x811c9dc5;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 0, 0x01000193);
  }
  return h >>> 0;
}

/** Arc-length interval of a polyline inside a convex polygon, or null. */
export function polylineInside(pts: readonly Vec2[], cum: readonly number[], poly: readonly Vec2[]): [number, number] | null {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    area += a.x * b.z - b.x * a.z;
  }
  const sgn = area >= 0 ? 1 : -1;
  let enter = Infinity;
  let exit = -Infinity;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1]!;
    const p1 = pts[i]!;
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    let t0 = 0;
    let t1 = 1;
    for (let k = 0; k < poly.length && t0 <= t1; k++) {
      const a = poly[k]!;
      const b = poly[(k + 1) % poly.length]!;
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      // Inside when cross(edge, p − a) has the polygon's orientation.
      const f0 = (ex * (p0.z - a.z) - ez * (p0.x - a.x)) * sgn;
      const fd = (ex * dz - ez * dx) * sgn;
      if (Math.abs(fd) < 1e-12) {
        if (f0 < 0) t1 = -1;
        continue;
      }
      const t = -f0 / fd;
      if (fd > 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (t0 > t1) continue;
    const seg = cum[i]! - cum[i - 1]!;
    enter = Math.min(enter, cum[i - 1]! + t0 * seg);
    exit = Math.max(exit, cum[i - 1]! + t1 * seg);
  }
  return enter <= exit ? [enter, exit] : null;
}

export function buildZones(net: Net): ZoneIndex {
  const g = net.graph;
  const nLanes = net.nLanes;
  const conn: Passage[][] = g.connectors.map(() => []);
  const lane: Passage[][] = g.lanes.map(() => []);
  const incoming: number[][] = g.lanes.map(() => []);
  for (const c of g.connectors) incoming[c.toLane]!.push(c.index);
  const byNode = new Map<string, number[]>();
  for (const c of g.connectors) {
    const l = byNode.get(c.nodeId);
    if (l) l.push(c.index);
    else byNode.set(c.nodeId, [c.index]);
  }
  const length = new Float64Array(g.crossings.length);
  const byZone: ZoneIndex['byZone'] = g.crossings.map(() => []);
  // Connector bounding boxes (x0, z0, x1, z1): disjoint from a zone means no passage.
  const cbox = new Float64Array(4 * g.connectors.length);
  for (const k of g.connectors) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const q of k.points) {
      x0 = Math.min(x0, q.x);
      z0 = Math.min(z0, q.z);
      x1 = Math.max(x1, q.x);
      z1 = Math.max(z1, q.z);
    }
    cbox.set([x0, z0, x1, z1], 4 * k.index);
  }
  for (const cr of g.crossings) {
    const seg = g.segments.get(cr.segmentId)!;
    length[cr.index] = dist(cr.a, cr.b);
    const pts = seg.centerline;
    const cum: number[] = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
    const t = tangentAtLength(pts, cum, Math.max(1e-6, Math.min(seg.length, cr.s)));
    const n = rightNormal(t);
    const c = pointAtLength(pts, cum, cr.s);
    const along = scale(t, cr.width / 2 + VEHICLE_HALF_WIDTH);
    const across = scale(n, carriagewayWidth(seg.roadType) / 2 + VEHICLE_HALF_WIDTH);
    const poly = [sub(sub(c, along), across), sub(add(c, along), across), add(add(c, along), across), add(sub(c, along), across)];
    const push = (edge: number, list: Passage[], points: Vec2[], pcum: number[]): void => {
      const iv = polylineInside(points, pcum, poly);
      if (!iv) return;
      const p: Passage = { z: cr.index, enterS: iv[0], exitS: iv[1] };
      list.push(p);
      byZone[cr.index]!.push({ edge, p });
    };
    if (cr.kind === 'junction') {
      let px0 = Infinity;
      let pz0 = Infinity;
      let px1 = -Infinity;
      let pz1 = -Infinity;
      for (const q of poly) {
        px0 = Math.min(px0, q.x);
        pz0 = Math.min(pz0, q.z);
        px1 = Math.max(px1, q.x);
        pz1 = Math.max(pz1, q.z);
      }
      const M = 1e-6;
      // polylineInside skips (near-)zero-length polygon edges, so a degenerate zone can reach beyond its
      // box (e.g. a zero tangent on a folded curve): the box test is only exact when every edge is real.
      let minEdge = Infinity;
      for (let i = 0; i < poly.length; i++) minEdge = Math.min(minEdge, dist(poly[i]!, poly[(i + 1) % poly.length]!));
      const boxed = minEdge >= 0.01;
      for (const ci of byNode.get(cr.nodeId!) ?? []) {
        const o = 4 * ci;
        if (boxed && (cbox[o]! > px1 + M || cbox[o + 2]! < px0 - M || cbox[o + 1]! > pz1 + M || cbox[o + 3]! < pz0 - M)) continue;
        const k = g.connectors[ci]!;
        push(nLanes + ci, conn[ci]!, k.points, k.cum);
      }
    } else {
      for (const l of seg.lanes) {
        const ln = g.lanes[l]!;
        push(l, lane[l]!, ln.points, ln.cum);
      }
    }
  }
  const byEnter = (p: Passage, q: Passage): number => p.enterS - q.enterS || p.z - q.z;
  for (const l of conn) l.sort(byEnter);
  const stopLanes: number[] = [];
  lane.forEach((l, i) => {
    l.sort(byEnter);
    if (l.length) stopLanes.push(i);
  });
  return { conn, lane, stopLanes, incoming, length, byZone };
}
