// Bus passenger numbers for the HUD, summarized from a sim snapshot (ADR 0009 §2). The snapshot has
// no bus line per vehicle, so a line's own load is only known when it is the sole user of its vehicle type.

import { VEHICLE_STRIDE, type SimSnapshot } from '@smartcity/sim';
import type { BusLine, CityDoc } from '@smartcity/shared';

export const DEFAULT_BUS_CAPACITY = 40;

export interface BusTypeLoad {
  buses: number;
  aboard: number;
  capacity: number;
}

export interface TransitSummary {
  buses: number;
  aboard: number;
  capacity: number;
  /** Bus vehicle type id → load of all buses of that type. */
  byType: Record<string, BusTypeLoad>;
  /** Bus stop id → citizens waiting. */
  waiting: Record<string, number>;
}

type SnapshotView = Pick<SimSnapshot, 'vehicles' | 'vehicleCount' | 'vehicleTypeIds' | 'busLoad' | 'stopWaiting' | 'busStopIds'>;

export function summarizeTransit(snap: SnapshotView, doc: CityDoc): TransitSummary {
  const out: TransitSummary = { buses: 0, aboard: 0, capacity: 0, byType: {}, waiting: {} };
  for (let i = 0; i < snap.vehicleCount; i++) {
    const typeId = snap.vehicleTypeIds[snap.vehicles[i * VEHICLE_STRIDE + 3]!];
    const vt = typeId ? doc.vehicleTypes[typeId] : undefined;
    if (!typeId || !vt || vt.kind !== 'bus') continue;
    const cap = vt.capacity ?? DEFAULT_BUS_CAPACITY;
    const load = snap.busLoad[i] ?? 0;
    const t = (out.byType[typeId] ??= { buses: 0, aboard: 0, capacity: 0 });
    t.buses++;
    t.aboard += load;
    t.capacity += cap;
    out.buses++;
    out.aboard += load;
    out.capacity += cap;
  }
  for (let i = 0; i < snap.busStopIds.length; i++) {
    const n = snap.stopWaiting[i] ?? 0;
    if (n > 0) out.waiting[snap.busStopIds[i]!] = n;
  }
  return out;
}

export function sameTransit(a: TransitSummary | null, b: TransitSummary): boolean {
  if (!a || a.buses !== b.buses || a.aboard !== b.aboard || a.capacity !== b.capacity) return false;
  const same = (x: Record<string, unknown>, y: Record<string, unknown>, eq: (p: never, q: never) => boolean): boolean => {
    const kx = Object.keys(x);
    if (kx.length !== Object.keys(y).length) return false;
    return kx.every((k) => k in y && eq(x[k] as never, y[k] as never));
  };
  return same(a.waiting, b.waiting, (p: number, q: number) => p === q) && same(a.byType, b.byType, (p: BusTypeLoad, q: BusTypeLoad) => p.buses === q.buses && p.aboard === q.aboard && p.capacity === q.capacity);
}

/** Citizens waiting at the line's stops (a stop shared with another line is counted in both). */
export function lineWaiting(t: TransitSummary, line: BusLine): number {
  let n = 0;
  for (const id of line.stopIds) n += t.waiting[id] ?? 0;
  return n;
}

/** Load of a line's buses, or null when other lines use the same vehicle type (cannot be told apart). */
export function lineLoad(t: TransitSummary, doc: CityDoc, line: BusLine): BusTypeLoad | null {
  const sharing = Object.values(doc.busLines).filter((l) => l.vehicleTypeId === line.vehicleTypeId).length;
  if (sharing !== 1) return null;
  return t.byType[line.vehicleTypeId] ?? { buses: 0, aboard: 0, capacity: 0 };
}
