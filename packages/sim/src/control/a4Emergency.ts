// A4 긴급 대응 (ADR 0015 §1, §2): the dispatch choice and the emergency signal requests, as proposals to A0.
// Pure: the agent sees only the ObservationView (known incidents, its own fleet, the factors) and the declared
// read-only queries (control/types.ts DispatchQueries / SignalQueries); it never reads the simulation state.
// Dispatch: the facility of the incident's service with the cheapest free-flow route to the building (ties:
// facility id) — the rule of ADR 0010 §8, unchanged. Signals: every own vehicle on a call (to the scene, or
// carrying a patient) whose next signalized stop line is within max(150 m, 15 s × speed) asks for its
// approach's phase (ADR 0010 §4); A0 keeps one request per junction (the one being served, else ETA → vehicle
// id) and the single safety executor (scenario/preempt.ts) decides every transition.

import { KIND_LABEL, type DispatchQueries, type ObservationView, type ObservedEvent, type ProposalDraft, type SignalQueries } from './types.js';

/** A request reaches this far ahead of the stop line: max(PREEMPT_DISTANCE, PREEMPT_ETA × speed). */
export const PREEMPT_DISTANCE = 150;
export const PREEMPT_ETA = 15;

export type DispatchChoice = { ok: true; draft: ProposalDraft; facilityId: string; typeId: string } | { ok: false; reason: string };

/** The dispatch proposal for a known fire or medical call, or why none can be made. */
export function proposeDispatch(ev: ObservedEvent, q: DispatchQueries, tick: number): DispatchChoice {
  const kind = ev.kind === 'fire' ? 'fire' : 'medical';
  const typeId = q.vehicleType(kind);
  if (typeId === null) return { ok: false, reason: '긴급 차종 없음' };
  const facilities = q.facilities(kind);
  if (facilities.length === 0) return { ok: false, reason: '시설 없음' };
  const building = ev.buildingId;
  if (building === null || !q.hasAccess(building)) return { ok: false, reason: '경로 없음' };
  let best: { id: string; cost: number } | null = null;
  // Ids ascend, so ties keep the smaller id.
  for (const id of facilities) {
    const cost = q.routeCost(id, building, typeId);
    if (cost !== null && (best === null || cost < best.cost)) best = { id, cost };
  }
  if (best === null) return { ok: false, reason: '경로 없음' };
  return {
    ok: true,
    facilityId: best.id,
    typeId,
    draft: {
      agent: 'A4',
      stage: 'dispatch',
      priority: 'life',
      key: `incident:${ev.eventId}`,
      rank: [],
      issuedTick: tick,
      expiresTick: tick,
      eventId: ev.eventId,
      action: { type: 'dispatch', eventId: ev.eventId, facilityId: best.id, typeId },
      reason: `${KIND_LABEL[ev.kind]} ${ev.eventId}`,
    },
  };
}

/** Signal requests of the own fleet (fleet order). None while pre-emption is off. */
export function proposeSignals(obs: ObservationView, q: SignalQueries): ProposalDraft[] {
  const out: ProposalDraft[] = [];
  if (!obs.factors.preempt) return out;
  for (const f of obs.fleet) {
    if (f.vehicleId === null || (f.stage !== 'enroute' && f.stage !== 'transport')) continue;
    const next = q.nextSignal(f.vehicleId, Math.max(PREEMPT_DISTANCE, PREEMPT_ETA * f.speed));
    if (next === null) continue;
    const eta = Math.ceil((next.distance / Math.max(f.speed, 1)) * obs.tickRate);
    // The vehicle being served keeps the junction (no switching back and forth), then ETA, vehicle id.
    const kept = q.servedVehicle(next.nodeId) === f.vehicleId ? 0 : 1;
    out.push({
      agent: 'A4',
      stage: 'signal',
      priority: 'life',
      key: `node:${next.nodeId}`,
      rank: [kept, eta, f.vehicleId],
      issuedTick: obs.tick,
      expiresTick: obs.tick,
      eventId: f.eventId,
      action: { type: 'signal', nodeId: next.nodeId, phase: next.phase, vehicleId: f.vehicleId, eta },
      reason: `${KIND_LABEL[f.kind]} ${f.eventId} ${f.stage === 'transport' ? '이송' : '출동'}`,
    });
  }
  return out;
}
