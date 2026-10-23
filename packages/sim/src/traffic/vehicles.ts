// Car following: leader search over per-edge ordered lists, IDM acceleration from the previous state,
// ballistic integration with a hard no-overlap clamp, and edge transitions with tail-based release.

import { idmAccel, MAX_DECEL } from './idm.js';
import { insertOnEdge, removeFromEdge, tailOverhang, type Obstacle, type Vehicle, type World } from './world.js';

const LOOKAHEAD = 150;
const CURVE_LOOKAHEAD = 100;
const MIN_REQUEST_DIST = 12;

const scratch: Obstacle = { gap: Infinity, v: 0 };

/** Distance to the stop line at which the lead vehicle asks for a grant (ADR 0004). */
export function requestDistance(v: Vehicle): number {
  return Math.max(MIN_REQUEST_DIST, (v.v * v.v) / (2 * v.b) + 5);
}

export function computeAccelerations(w: World): void {
  const net = w.net;
  const nLanes = net.nLanes;
  for (let e = 0; e < net.nEdges; e++) {
    const list = w.onEdge[e]!;
    const L = net.len[e]!;
    for (let k = 0; k < list.length; k++) {
      const v = list[k]!;
      if (v.bus && v.bus.dwell > 0) {
        v.acc = 0;
        v.gapHard = 0;
        continue;
      }
      const ob = scratch;
      ob.gap = Infinity;
      ob.v = 0;
      // Virtual obstacles (stop lines, route end) always bound the motion; IDM only reacts to them inside
      // the request horizon, otherwise vehicles would brake for every junction before they may ask for it.
      let hard = Infinity;
      if (k > 0) {
        const l = list[k - 1]!;
        ob.gap = l.s - l.len - v.s;
        ob.v = l.v;
      } else {
        tailOverhang(w, e, L - v.s, 0, ob);
        const horizon = requestDistance(v) + v.v * v.T;
        let d = L - v.s;
        let j = v.ri;
        let cur = e;
        for (;;) {
          const nxt = v.route[j + 1];
          if (nxt === undefined || (cur < nLanes && (j > v.ri || v.grant !== nxt - nLanes))) {
            hard = d;
            const arriving = nxt === undefined && !v.bus && v.destS < Infinity;
            if (!arriving && d <= horizon && d < ob.gap) {
              ob.gap = d;
              ob.v = 0;
            }
            break;
          }
          if (d > LOOKAHEAD) break;
          const l2 = w.onEdge[nxt]!;
          if (l2.length > 0) {
            const last = l2[l2.length - 1]!;
            const g = d + last.s - last.len;
            if (g < ob.gap) {
              ob.gap = g;
              ob.v = last.v;
            }
            break;
          }
          d += net.len[nxt]!;
          cur = nxt;
          j++;
        }
      }
      v.gapHard = Math.min(ob.gap, hard);
      let gap = ob.gap;
      let lv = ob.v;
      // Bus stop: a soft obstacle placed so the bus front halts at the stop.
      if (v.bus && v.ri === v.route.length - 1 && e < nLanes) {
        const g = v.destS + v.s0 - v.s;
        if (g < gap) {
          gap = g;
          lv = 0;
        }
      }
      const v0 = Math.min(net.speed[e]!, v.maxSpeed);
      let acc = idmAccel(v.v, v0, gap, v.v - lv, v.a, v.b, v.s0, v.T);
      // Slow down ahead of a slower next edge (tight connector).
      const nxt = v.route[v.ri + 1];
      if (nxt !== undefined) {
        const vn = Math.min(net.speed[nxt]!, v.maxSpeed);
        const dEnd = L - v.s;
        if (v.v > vn && dEnd < CURVE_LOOKAHEAD) acc = Math.min(acc, (vn * vn - v.v * v.v) / (2 * Math.max(dEnd, 0.5)));
      }
      v.acc = Math.max(-MAX_DECEL, acc);
    }
  }
}

export function integrate(w: World): void {
  const dt = w.dt;
  for (const v of w.vehicles) {
    if (!v.alive || (v.bus && v.bus.dwell > 0)) continue;
    let nv = v.v + v.acc * dt;
    let ds: number;
    if (nv <= 0) {
      nv = 0;
      ds = v.acc < 0 ? Math.min(v.v * dt, (v.v * v.v) / (-2 * v.acc)) : 0;
    } else {
      ds = (v.v + nv) * 0.5 * dt;
    }
    const lim = Math.max(0, v.gapHard);
    if (ds > lim) {
      ds = lim;
      if (nv > ds / dt) nv = ds / dt;
    }
    v.v = nv;
    advance(w, v, ds);
  }
}

function advance(w: World, v: Vehicle, ds: number): void {
  const net = w.net;
  const nLanes = net.nLanes;
  let e = v.edge;
  let s = v.s + ds;
  v.odo += ds;
  while (s >= net.len[e]!) {
    const nxt = v.route[v.ri + 1];
    if (nxt === undefined || (e < nLanes && v.grant !== nxt - nLanes)) {
      s = net.len[e]!;
      break;
    }
    const over = s - net.len[e]!;
    removeFromEdge(w.onEdge[e]!, v);
    if (e >= nLanes) {
      const c = e - nLanes;
      for (const h of v.held) if (h.c === c && h.rel === Infinity) h.rel = v.odo - over + v.len;
    } else {
      v.grant = -1;
    }
    e = nxt;
    v.ri++;
    s = over;
    if (e < nLanes && v.resLane === e) {
      w.reserved[e]! -= v.resNeed;
      v.resLane = -1;
    }
    v.edge = e;
    v.s = s;
    insertOnEdge(w.onEdge[e]!, v);
  }
  v.edge = e;
  v.s = s;
  for (let i = v.held.length - 1; i >= 0; i--) {
    const h = v.held[i]!;
    if (h.rel <= v.odo + 1e-9) {
      w.holders[h.c]!--;
      v.held.splice(i, 1);
    }
  }
}
