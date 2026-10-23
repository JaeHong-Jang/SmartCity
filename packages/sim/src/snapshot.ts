// Snapshot buffer writer: copies world state into (reused) typed arrays for the renderer.

import { fillOccupancy } from './citizens/citizens.js';
import { gaitPhase, pedElevation, writePedPose } from './citizens/peds.js';
import { writePose } from './network/net.js';
import { headColor } from './traffic/signals.js';
import type { World } from './traffic/world.js';
import {
  CROSSING_STRIDE,
  PED_STRIDE,
  SIGNAL_STRIDE,
  VEHICLE_STRIDE,
  type SimSnapshot,
  type SimStats,
  type SnapshotBuffers,
} from './types.js';

/** Snapshot scratch for laneFlow (internal, never handed out). */
export interface SnapshotScratch {
  flowSum: Float64Array;
  flowCnt: Int32Array;
}

export function newSnapshotScratch(): SnapshotScratch {
  return { flowSum: new Float64Array(0), flowCnt: new Int32Array(0) };
}

export function writeSnapshot(w: World, scratch: SnapshotScratch, stats: SimStats, reuse?: SnapshotBuffers): SimSnapshot {
    const n = w.vehicles.length;
    let vb = reuse?.vehicles;
    if (!vb || vb.length < n * VEHICLE_STRIDE) vb = new Float32Array(Math.ceil(n * 1.25) * VEHICLE_STRIDE);
    const net = w.net;
    for (let i = 0; i < n; i++) {
      const v = w.vehicles[i]!;
      const o = i * VEHICLE_STRIDE;
      // Body center (it may sit on the previous edge), written without allocating.
      let e = v.edge;
      let s = v.s - v.len / 2;
      if (s < 0 && v.ri > 0) {
        e = v.route[v.ri - 1]!;
        s = Math.max(0, net.len[e]! + s);
      }
      writePose(net.pts[e]!, net.cum[e]!, Math.max(0, s), false, 0, vb, o);
      vb[o + 3] = v.typeIdx;
      vb[o + 4] = v.v;
      vb[o + 5] = v.id;
    }
    let heads = 0;
    for (const p of w.signals.plans) heads += p.heads.length;
    for (const m of w.signals.mids) heads += m.heads.length;
    let sb = reuse?.signals;
    if (!sb || sb.length < heads * SIGNAL_STRIDE) sb = new Float32Array(heads * SIGNAL_STRIDE);
    let o = 0;
    const colorCode = (c: string): number => (c === 'green' ? 2 : c === 'yellow' ? 1 : 0);
    for (const p of w.signals.plans) {
      for (let h = 0; h < p.heads.length; h++) {
        const head = p.heads[h]!;
        sb[o++] = head.x;
        sb[o++] = head.z;
        sb[o++] = head.heading;
        sb[o++] = colorCode(headColor(p, h));
      }
    }
    // Mid-block crossing signals: one vehicle head per lane at its stop line.
    for (const m of w.signals.mids) {
      for (const head of m.heads) {
        sb[o++] = head.x;
        sb[o++] = head.z;
        sb[o++] = head.heading;
        sb[o++] = colorCode(m.color);
      }
    }
    const nLanes = w.net.nLanes;
    let lf = reuse?.laneFlow;
    if (!lf || lf.length !== nLanes) lf = new Float32Array(nLanes);
    if (scratch.flowSum.length !== nLanes) {
      scratch.flowSum = new Float64Array(nLanes);
      scratch.flowCnt = new Int32Array(nLanes);
    }
    const sum = scratch.flowSum.fill(0);
    const cnt = scratch.flowCnt.fill(0);
    for (const v of w.vehicles) {
      if (v.edge >= nLanes) continue;
      sum[v.edge]! += v.v / w.net.speed[v.edge]!;
      cnt[v.edge]!++;
    }
    for (let l = 0; l < nLanes; l++) lf[l] = cnt[l]! > 0 ? Math.min(1, sum[l]! / cnt[l]!) : -1;
    const peds = w.peds;
    const nPed = peds.count;
    let pb = reuse?.pedestrians;
    if (!pb || pb.length < nPed * PED_STRIDE) pb = new Float32Array(Math.ceil(nPed * 1.25) * PED_STRIDE);
    let pi = reuse?.pedestrianIds;
    if (!pi || pi.length < nPed) pi = new Uint32Array(Math.ceil(nPed * 1.25));
    let k = 0;
    for (let i = 0; i < peds.hi; i++) {
      if (!peds.alive[i]) continue;
      const o = k * PED_STRIDE;
      writePedPose(w, i, pb, o);
      pb[o + 3] = peds.vCur[i]!;
      pb[o + 4] = gaitPhase(w, i);
      pb[o + 5] = peds.style[i]!;
      pb[o + 6] = peds.state[i]!;
      pb[o + 7] = pedElevation(w, i);
      pi[k++] = peds.pid[i]!;
    }
    const nCross = w.graph.crossings.length;
    let cb = reuse?.crossings;
    if (!cb || cb.length < nCross * CROSSING_STRIDE) cb = new Float32Array(nCross * CROSSING_STRIDE);
    for (let z = 0; z < nCross; z++) {
      cb[z * CROSSING_STRIDE] = w.zs.pedSig[z]!;
      cb[z * CROSSING_STRIDE + 1] = w.zs.ped[z]!;
      cb[z * CROSSING_STRIDE + 2] = w.zs.veh[z]!;
    }
    const buildingIds = w.ped.pg.buildingIds.slice();
    let ob = reuse?.occupancy;
    if (!ob || ob.length < buildingIds.length) ob = new Float32Array(buildingIds.length);
    fillOccupancy(w, w.ped.pg.buildingIds, ob);
    return {
      tick: w.tick,
      time: w.tick / w.tickRate,
      graphRevision: w.graphRevision,
      vehicles: vb,
      vehicleCount: n,
      vehicleTypeIds: w.typeIds.slice(),
      signals: sb,
      signalCount: heads,
      laneFlow: lf,
      pedestrians: pb,
      pedestrianIds: pi,
      pedestrianCount: nPed,
      crossings: cb,
      crossingCount: nCross,
      crossingSig: w.crossingSig,
      occupancy: ob,
      buildingIds,
      stats,
    };
}
