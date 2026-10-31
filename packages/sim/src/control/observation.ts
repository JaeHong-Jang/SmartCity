// ObservationView (ADR 0015 §2): what agents and A0 may see. The active events filtered by the observation
// boundary (`ControlState.known`, written only where the city learns of an event — control.ts `observe`),
// never the detection queue, the queued inputs or the KPIs. Physical state used for evaluation stays out.

import type { World } from '../traffic/world.js';
import { policyFactors } from './policy.js';
import type { ObservationView, ObservedEvent } from './types.js';

/** Ids of the events in effect now (effects, incidents, blackouts, surges with trips to depart). */
function activeIds(w: World): Set<string> {
  const sc = w.sc!;
  const ids = new Set<string>();
  for (const e of sc.effects) ids.add(e.eventId);
  for (const inc of sc.incidents) ids.add(inc.eventId);
  for (const b of sc.blackouts) ids.add(b.eventId);
  for (const t of sc.surgeQueue) ids.add(t.eventId);
  return ids;
}

export function observationView(w: World): ObservationView {
  const sc = w.sc!;
  const events: ObservedEvent[] = [];
  for (const id of activeIds(w)) {
    const k = sc.control.known.get(id);
    if (k) events.push({ ...k });
  }
  events.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  return {
    tick: w.tick,
    factors: policyFactors(sc.policy),
    events,
    stoppedPerLane: Int32Array.from(w.stopped),
    tickRate: w.tickRate,
    fleet: sc.missions.map((m) => {
      const v = m.v !== null && m.v.alive ? m.v : null;
      return { eventId: m.incident.eventId, kind: m.incident.kind, vehicleId: v ? v.id : null, speed: v ? v.v : 0, stage: m.stage, facilityId: m.facilityId };
    }),
  };
}

/** A known event, active or not (its location as observed), or null when the city does not know of it. */
export function knownEvent(w: World, eventId: string): ObservedEvent | null {
  return w.sc!.control.known.get(eventId) ?? null;
}
