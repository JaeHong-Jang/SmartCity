// Traffic calming (ADR 0008 §3). Speed bumps are speed constraints, never stop obstacles: approach with
// vAllowed(d) = sqrt(vt² + 2·b·d), cross at vt = 20 km/h until the tail is over. School zones lower the
// lane limit at compile time. allStop junctions and unsignalized school-zone crossings at a junction leg
// require a full stop at the lane end (`laneStopReq`).

import type { CityDoc } from '@smartcity/shared';
import type { RoadGraph } from '../types.js';
import { SPEED_BUMP_SPEED } from '../types.js';
import type { Vehicle, World } from './world.js';

const BUMP_LOOKAHEAD = 90;

export interface StreetTables {
  bumps: number[][];
  hasBumps: boolean;
  laneStopReq: Uint8Array;
}

export function streetTables(doc: CityDoc, g: RoadGraph): StreetTables {
  const bumps: number[][] = g.lanes.map(() => []);
  let hasBumps = false;
  const laneStopReq = new Uint8Array(g.lanes.length);
  const crossingIds = new Set(g.crossings.map((c) => c.id));
  for (const l of g.lanes) {
    const seg = g.segments.get(l.segmentId)!;
    // Bumps are stored by centerline arc length; map them proportionally onto the trimmed lane.
    const span = seg.length - seg.laneStartA - seg.laneStartB;
    if (seg.speedBumps.length && span > 0) {
      const out: number[] = [];
      for (const b of seg.speedBumps) {
        const u = (b - seg.laneStartA) / span;
        if (u <= 0 || u >= 1) continue;
        out.push((l.dir === 'forward' ? u : 1 - u) * l.length);
      }
      out.sort((p, q) => p - q);
      bumps[l.index] = out;
      if (out.length) hasBumps = true;
    }
    const node = g.nodes.get(l.toNode);
    const kind = doc.intersections[l.toNode]?.kind;
    const allStop = kind === 'allStop' && (node?.segments.length ?? 0) >= 2;
    const schoolStop = seg.schoolZone && node !== undefined && !node.signalized && crossingIds.has(`${l.toNode}|${l.segmentId}`);
    if (allStop || schoolStop) laneStopReq[l.index] = 1;
  }
  return { bumps, hasBumps, laneStopReq };
}

/** Limit an acceleration so the vehicle crosses every bump ahead (on its route) at no more than vt. */
export function bumpAccel(w: World, v: Vehicle, acc: number): number {
  const net = w.net;
  const nLanes = net.nLanes;
  const vt = SPEED_BUMP_SPEED;
  let off = -v.s;
  let j = v.ri;
  let e = v.edge;
  for (;;) {
    if (e < nLanes) {
      for (const b of w.bumps[e]!) {
        const d = off + b;
        if (d <= -v.len) continue;
        if (d <= 0) acc = Math.min(acc, (vt - v.v) / w.dt);
        else if (v.v * v.v > vt * vt + 2 * v.b * d) acc = Math.min(acc, (vt * vt - v.v * v.v) / (2 * Math.max(d, 0.5)));
      }
    }
    off += net.len[e]!;
    if (off > BUMP_LOOKAHEAD) break;
    const nxt = v.route[++j];
    if (nxt === undefined) break;
    e = nxt;
  }
  return acc;
}
