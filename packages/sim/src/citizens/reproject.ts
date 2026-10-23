// Pedestrian re-projection after a network or building edit (ADR 0008 §4): re-placing pedestrians on the
// rebuilt graph, routing crossers, and re-resolving walker goals.

import { tangentAtLength } from '@smartcity/shared';
import { PedEdgeKind, type PedGraph } from '../network/pedGraph.js';
import { nearestEdge, nearestNode } from '../network/pedQuery.js';
import type { World } from '../traffic/world.js';
import { PED_SPACING, pedPose, releaseGrant, requestRoute, resetBands, routeLength, routeStart, setRoute } from './peds.js';

/** Re-projection radius after a network or building edit. */
const REPROJECT_RADIUS = 20;

/**
 * After a rebuild of the pedestrian graph (ADR 0008 §4): every pedestrian is placed within 20 m of where it
 * was, in the walkable component that contains its goal (`goalOf`, a node of the new graph, −1 = none).
 * Pedestrians on a crossing that still exists stay on it (or step to its curb if vehicles now hold the
 * zone); walking pedestrians go to the closest sidewalk/corner point (heading kept), standing ones to the
 * closest node; anyone that would land closer than the spacing to the pedestrian ahead goes to the band's
 * start node instead — again only within 20 m. Everyone else is returned as lost (the owner sends citizens
 * home, counted). Routes are dropped: placed pedestrians are left pending with `goal` set to the new node.
 */
export function reprojectPeds(w: World, oldPg: PedGraph, oldCrossingIds: string[], goalOf: (i: number) => number): number[] {
  const p = w.peds;
  const pg = w.ped.pg;
  const lost: number[] = [];
  const poses: { x: number; z: number; heading: number }[] = [];
  const oldEdge: number[] = [];
  const cur = w.ped.pg;
  w.ped.pg = oldPg;
  for (let i = 0; i < p.hi; i++) {
    poses.push(p.alive[i] ? pedPose(w, i) : { x: 0, z: 0, heading: 0 });
    oldEdge.push(p.alive[i] ? p.edge[i]! : -1);
  }
  w.ped.pg = cur;
  // Goals first (owners resolve them on the new graph).
  const goals: number[] = [];
  for (let i = 0; i < p.hi; i++) goals.push(p.alive[i] ? goalOf(i) : -1);
  resetBands(w);
  w.zs.ped.fill(0);
  for (let i = 0; i < p.hi; i++) p.resBand[i] = -1;
  const crossingByOldId = new Map(w.graph.crossings.map((c) => [c.id, c.index]));
  const within = (n: number, pose: { x: number; z: number }): boolean => Math.hypot(pg.x[n]! - pose.x, pg.z[n]! - pose.z) <= REPROJECT_RADIUS;
  // Insert in slot order; bands are re-sorted afterwards.
  for (let i = 0; i < p.hi; i++) {
    if (!p.alive[i]) continue;
    p.grant[i] = -1;
    p.pending[i] = 1;
    p.ri[i] = -1;
    p.route[i] = new Int32Array(0);
    p.edge[i] = -1;
    const pose = poses[i]!;
    const oe = oldEdge[i]!;
    const goal = goals[i]!;
    if (goal < 0) {
      lost.push(i);
      continue;
    }
    p.goal[i] = goal;
    p.goalX[i] = pg.x[goal]!;
    p.goalZ[i] = pg.z[goal]!;
    const comp = pg.comp[goal]!;
    let placed = false;
    if (oe >= 0 && oldPg.crossing[oe]! >= 0) {
      const z = crossingByOldId.get(oldCrossingIds[oldPg.crossing[oe]!]!);
      const ne = z === undefined ? -1 : pg.crossingEdge[z]!;
      if (ne >= 0 && pg.comp[pg.from[ne]!] === comp) {
        if (w.zs.veh[z!]! === 0) {
          // Same crossing id, but it may have moved: stay on it only within 20 m of where we were.
          p.edge[i] = ne;
          p.pos[i] = Math.min(p.pos[i]!, pg.len[ne]!);
          const np = pedPose(w, i);
          if (Math.hypot(np.x - pose.x, np.z - pose.z) <= REPROJECT_RADIUS) {
            p.grant[i] = z!;
            w.zs.ped[z!]!++;
            p.bands[ne * 2 + p.dir[i]!]!.push(i);
            placed = true;
          } else p.edge[i] = -1;
        } else {
          const curb = p.dir[i] === 0 ? pg.from[ne]! : pg.to[ne]!;
          if (within(curb, pose)) {
            p.node[i] = curb;
            placed = true;
          }
        }
      }
    }
    if (!placed && oe >= 0) {
      const near = nearestEdge(pg, pose, REPROJECT_RADIUS, comp);
      if (near) {
        const e = near.edge;
        const t = tangentAtLength(pg.pts[e]!, pg.cum[e]!, Math.max(1e-6, near.s));
        const fwd = t.x * Math.cos(pose.heading) + t.z * Math.sin(pose.heading) >= 0;
        p.edge[i] = e;
        p.dir[i] = fwd ? 0 : 1;
        p.pos[i] = fwd ? near.s : pg.len[e]! - near.s;
        p.bands[e * 2 + p.dir[i]!]!.push(i);
        placed = true;
      }
    }
    if (!placed) {
      const n = nearestNode(pg, pose, REPROJECT_RADIUS, comp);
      if (n >= 0) {
        p.node[i] = n;
        placed = true;
      }
    }
    if (!placed) lost.push(i);
  }
  // Order bands by position; anyone closer than the spacing to the one ahead steps off to the start node.
  for (let b = 0; b < p.bands.length; b++) {
    const list = p.bands[b]!;
    if (list.length < 2) continue;
    list.sort((x, y) => p.pos[y]! - p.pos[x]! || x - y);
    for (let k = 1; k < list.length; k++) {
      const i = list[k]!;
      if (p.pos[list[k - 1]!]! - p.pos[i]! >= PED_SPACING - 1e-9) continue;
      list.splice(k--, 1);
      if (p.grant[i]! >= 0) releaseGrant(w, i);
      const e = b >> 1;
      const start = (b & 1) === 0 ? pg.from[e]! : pg.to[e]!;
      p.edge[i] = -1;
      if (within(start, poses[i]!)) p.node[i] = start;
      else lost.push(i);
    }
  }
  return lost;
}

/**
 * After a rebuild, pedestrians standing on a crossing get their route (and with it the place beyond the
 * crossing) right away, before anyone else moves; their queued request is invalidated.
 */
export function routeCrossers(w: World): void {
  const p = w.peds;
  const pg = w.ped.pg;
  for (let i = 0; i < p.hi; i++) {
    const e = p.edge[i]!;
    if (!p.alive[i] || !p.pending[i] || e < 0 || pg.kind[e] !== PedEdgeKind.crossing) continue;
    const res = routeLength(w, routeStart(w, i), p.goal[i]!);
    if (!res) continue;
    p.gen[i]!++;
    setRoute(w, i, res.path);
  }
}

/** Goal of a walker (no citizen) on a rebuilt graph: the node nearest its old goal, −1 = none within 20 m. */
export function walkerGoal(w: World, i: number): number {
  return nearestNode(w.ped.pg, { x: w.peds.goalX[i]!, z: w.peds.goalZ[i]! }, REPROJECT_RADIUS);
}

/** After a rebuild: re-placed walkers head for their (re-resolved) goal node. */
export function retargetWalkers(w: World, slots: Iterable<number>): void {
  for (const i of slots) requestRoute(w, i, w.peds.goal[i]!);
}
