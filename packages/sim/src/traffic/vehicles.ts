// Car following: leader search over per-edge ordered lists, IDM acceleration from the previous state,
// ballistic integration with a hard no-overlap clamp, and edge transitions with tail-based release.
// Stop lines: lane ends without a connector grant and mid-block crossing lines without a pass.

import type { Passage } from '../network/crossings.js';
import { bumpAccel } from './calming.js';
import { idmAccel, MAX_DECEL } from './idm.js';
import { mustStopAt, nextGate } from './zones.js';
import { insertOnEdge, removeFromEdge, tailOverhang, type Obstacle, type Vehicle, type World } from './world.js';

const LOOKAHEAD = 150;
const CURVE_LOOKAHEAD = 100;
const MIN_REQUEST_DIST = 12;
/** At a line that requires a full stop, the IDM obstacle is shifted so the front halts this far before it. */
const STOP_CREEP = 0.8;

const scratch: Obstacle = { gap: Infinity, v: 0 };

/** Distance to the stop line at which the lead vehicle asks for a grant (ADR 0004). */
export function requestDistance(v: Vehicle): number {
  return Math.max(MIN_REQUEST_DIST, (v.v * v.v) / (2 * v.b) + 5);
}

/** IDM gap for a stop line at distance d: lines that need a full stop pull the vehicle up close to them. */
const stopGap = (v: Vehicle, d: number, full: boolean): number => (full ? d + v.s0 - STOP_CREEP : d);

export function computeAccelerations(w: World): void {
  const net = w.net;
  const nLanes = net.nLanes;
  const zl = w.zones.lane;
  // Scenario accident obstacles (ADR 0010 §3): stationary leaders, never counted as vehicles.
  const obs = w.sc !== null ? w.sc.obs : null;
  for (let e = 0; e < net.nEdges; e++) {
    const list = w.onEdge[e]!;
    const L = net.len[e]!;
    const stops = e < nLanes ? zl[e]! : null;
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
      const horizon = requestDistance(v) + v.v * v.T;
      const gate: Passage | null = stops && stops.length ? nextGate(v, stops, e, v.s) : null;
      if (k > 0) {
        const l = list[k - 1]!;
        ob.gap = l.s - l.len - v.s;
        ob.v = l.v;
      } else if (!gate) {
        tailOverhang(w, e, L - v.s, 0, ob);
        let d = L - v.s;
        let j = v.ri;
        let cur = e;
        for (;;) {
          const nxt = v.route[j + 1];
          if (nxt === undefined || (cur < nLanes && (j > v.ri || v.grant !== nxt - nLanes))) {
            hard = Math.min(hard, d);
            const arriving = nxt === undefined && !v.bus && v.destS < Infinity;
            const g = stopGap(v, d, cur < nLanes && w.laneStopReq[cur] === 1);
            if (!arriving && d <= horizon && g < ob.gap) {
              ob.gap = g;
              ob.v = 0;
            }
            break;
          }
          if (d > LOOKAHEAD) break;
          let blocked = false;
          if (nxt < nLanes && zl[nxt]!.length) {
            const p = nextGate(v, zl[nxt]!, nxt, -Infinity);
            if (p) {
              const dd = d + p.enterS;
              hard = Math.min(hard, dd);
              const g = stopGap(v, dd, mustStopAt(w, p.z));
              if (dd <= horizon && g < ob.gap) {
                ob.gap = g;
                ob.v = 0;
              }
              blocked = true;
            }
          }
          if (obs !== null && nxt < nLanes && obs[nxt]!.length > 0) {
            const g = d + obs[nxt]![0]!.rear;
            if (g < ob.gap) {
              ob.gap = g;
              ob.v = 0;
            }
            blocked = true;
          }
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
          if (blocked) break;
          d += net.len[nxt]!;
          cur = nxt;
          j++;
        }
      }
      if (obs !== null && stops !== null && obs[e]!.length > 0) {
        for (const o of obs[e]!) {
          if (o.rear < v.s - 1e-6) continue;
          const g = o.rear - v.s;
          if (g < ob.gap) {
            ob.gap = g;
            ob.v = 0;
          }
          break;
        }
      }
      if (gate) {
        const d = gate.enterS - v.s;
        hard = Math.min(hard, d);
        const g = stopGap(v, d, mustStopAt(w, gate.z));
        if (d <= horizon && g < ob.gap) {
          ob.gap = g;
          ob.v = 0;
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
      if (w.hasBumps) acc = bumpAccel(w, v, acc);
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
    v.stopCnt = 0;
    v.stopTick = -1;
    for (const h of v.zones) if (h.edge === e && h.rel === Infinity) h.rel = v.odo - over + h.exitS + v.len;
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
  for (let i = v.zones.length - 1; i >= 0; i--) {
    const h = v.zones[i]!;
    if (h.rel <= v.odo + 1e-9) {
      w.zs.veh[h.z]!--;
      w.zs.passed[h.z]!++;
      v.zones.splice(i, 1);
    }
  }
}
