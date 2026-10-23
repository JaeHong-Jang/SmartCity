// Bus lines: `buses` vehicles per line spread evenly over the stops, looping stop → stop with a
// 10 s dwell. Missing buses (removed by edits) are respawned at their slot's stop.

import type { BusLine } from '@smartcity/shared';
import { groupKey } from '../network/net.js';
import { laneSAtT } from './demand.js';
import { createVehicle, routeVehicle } from './ops.js';
import { canPlace, despawn, type Goal, type Vehicle, type World } from './world.js';

export const DWELL_SECONDS = 10;
const RETRY_SECONDS = 5;

export interface BusLineState {
  id: string;
  slots: (Vehicle | null)[];
  nextTry: number;
}

export function stopGoal(w: World, line: BusLine, idx: number): Goal | null {
  const stop = w.doc.busStops[line.stopIds[idx]!];
  if (!stop) return null;
  const lanes = w.net.groups.get(groupKey(stop.segmentId, stop.dir));
  if (!lanes) return null;
  return { segId: stop.segmentId, dir: stop.dir, anyDir: false, laneIndex: lanes.length - 1, mode: 't', t: stop.t };
}

/** Reconcile line states with the doc (after any edit). Buses keep their slot; extra ones are removed. */
export function syncBusLines(w: World): void {
  const prev = new Map(w.lines.map((l) => [l.id, l]));
  const next: BusLineState[] = [];
  for (const id of Object.keys(w.doc.busLines).sort()) {
    const line = w.doc.busLines[id]!;
    const st = prev.get(id) ?? { id, slots: [], nextTry: 0 };
    prev.delete(id);
    const typeOk = w.types.has(line.vehicleTypeId);
    for (let k = 0; k < st.slots.length; k++) {
      const v = st.slots[k];
      if (v && v.alive && (k >= line.buses || !typeOk || v.typeId !== line.vehicleTypeId)) {
        despawn(w, v);
        w.removed++;
      }
    }
    st.slots.length = line.buses;
    for (let k = 0; k < line.buses; k++) {
      const v = st.slots[k];
      if (!v || !v.alive) {
        st.slots[k] = null;
        continue;
      }
      v.bus!.stopIdx %= line.stopIds.length;
      const goal = stopGoal(w, line, v.bus!.stopIdx);
      if (!goal) {
        despawn(w, v);
        w.removed++;
        st.slots[k] = null;
        continue;
      }
      v.goal = goal;
      if (v.bus!.dwell === 0 && !v.queued) {
        v.destS = Infinity;
        v.queued = true;
        w.queue.push({ v, reason: 'replan' });
      }
    }
    st.nextTry = 0;
    next.push(st);
  }
  for (const st of prev.values())
    for (const v of st.slots)
      if (v && v.alive) {
        despawn(w, v);
        w.removed++;
      }
  w.lines = next;
}

/** Spawn buses for empty slots at their designated stop. */
export function maintainBuses(w: World): void {
  for (const st of w.lines) {
    const line = w.doc.busLines[st.id]!;
    const n = line.stopIds.length;
    let failed = false;
    for (let k = 0; k < st.slots.length; k++) {
      const cur = st.slots[k];
      if (cur && cur.alive) continue;
      st.slots[k] = null;
      if (w.tick < st.nextTry) continue;
      // Buses share the global vehicle cap with private traffic.
      if (w.vehicles.length >= w.maxVehicles) {
        failed = true;
        continue;
      }
      const at = Math.floor((k * n) / Math.max(1, line.buses));
      const here = stopGoal(w, line, at);
      const goal = stopGoal(w, line, (at + 1) % n);
      const type = w.types.get(line.vehicleTypeId);
      if (!here || !goal || !type) {
        failed = true;
        continue;
      }
      const lanes = w.net.groups.get(groupKey(here.segId, here.dir))!;
      const lane = lanes[lanes.length - 1]!;
      const L = w.net.len[lane]!;
      const s = Math.max(Math.min(type.length, L), laneSAtT(w.net, lane, here.t));
      const v = canPlace(w, lane, s, type.length, 1)
        ? createVehicle(w, line.vehicleTypeId, lane, s, goal, { lineId: line.id, slot: k, stopIdx: (at + 1) % n, dwell: 0 })
        : null;
      if (v) st.slots[k] = v;
      else failed = true;
    }
    if (failed) st.nextTry = w.tick + Math.round(RETRY_SECONDS * w.tickRate);
  }
}

/** Per tick, per bus: start a dwell on reaching the stop; when it ends, head for the next stop. */
export function updateBus(w: World, v: Vehicle): void {
  const bus = v.bus!;
  if (bus.dwell > 0) {
    v.v = 0;
    if (--bus.dwell > 0) return;
    const line = w.doc.busLines[bus.lineId];
    const goal = line ? stopGoal(w, line, (bus.stopIdx + 1) % line.stopIds.length) : null;
    if (!line || !goal) return;
    bus.stopIdx = (bus.stopIdx + 1) % line.stopIds.length;
    v.goal = goal;
    if (!routeVehicle(w, v)) {
      despawn(w, v);
      w.removed++;
    }
    return;
  }
  if (!v.queued && v.ri === v.route.length - 1 && v.edge < w.net.nLanes && v.s >= v.destS - 1) {
    bus.dwell = Math.round(DWELL_SECONDS * w.tickRate);
    v.v = 0;
  }
}
