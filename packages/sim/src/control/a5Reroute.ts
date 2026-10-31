// A5 통제·우회 안내 (ADR 0015 §1, §2): when an event the city knows of starts or ends, the informed vehicles
// (factor `reroute`, `hash01(id, seed) < informedShare`) whose remaining route uses an affected lane are told
// to search a new route. Pure: the agent gets the known event, its affected lanes, the factors and the
// declared query `informedUsing`; A0 arbitrates the notice and scenario/controlAdapter.ts hands the accepted
// vehicles to the existing re-route queue (REROUTE_BUDGET searches per tick). Recovery of invalid routes is
// not A5 (policy independent, the vehicle's own).

import type { ObservationView, ObservedEvent, ProposalDraft, RerouteQueries } from './types.js';

export function proposeReroute(ev: ObservedEvent, lanes: readonly number[], ended: boolean, obs: Pick<ObservationView, 'tick' | 'factors'>, q: RerouteQueries): ProposalDraft | null {
  if (!obs.factors.reroute || lanes.length === 0) return null;
  const vehicleIds = q.informedUsing(lanes, obs.factors.informedShare);
  if (vehicleIds.length === 0) return null;
  return {
    agent: 'A5',
    stage: 'route',
    priority: 'efficiency',
    key: `reroute:${ev.eventId}:${ended ? 'end' : 'start'}`,
    rank: [],
    issuedTick: obs.tick,
    expiresTick: obs.tick,
    eventId: ev.eventId,
    action: { type: 'reroute', eventId: ev.eventId, vehicleIds },
    reason: '',
  };
}
