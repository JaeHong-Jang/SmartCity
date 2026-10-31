// A1 영상 AI 감지 (ADR 0015 §1, §4): the eye. The physical sensing model stays in scenario/detection.ts
// (candidate ticks from hashes, sensor power); a due, valid candidate becomes an observation report, and this
// module turns a report into the observe-stage proposal — A1's for a sensor, A0's for a citizen report or an
// input known at once. A0 arbitrates it (per-tick observe budget); only an accepted report puts the event in
// the ObservationView (scenario/controlAdapter.ts → control.ts `observe`). Pure: no simulation state.

import type { ObservedEvent, PriorityClass, ProposalDraft } from './types.js';

export interface ObservationReport {
  eventId: string;
  kind: ObservedEvent['kind'];
  /** input = known when its input applied; report = citizen report; sensor = a covering sensor (A1). */
  source: ObservedEvent['source'];
  sensorId: string | null;
  segmentId: string | null;
  lane: number;
  buildingId: string | null;
}

const PRIORITY: Record<ObservedEvent['kind'], PriorityClass> = { fire: 'life', medical: 'life', accident: 'spread', blackout: 'spread', closure: 'efficiency', surge: 'efficiency' };

export function observationDraft(r: ObservationReport, tick: number, reason: string): ProposalDraft {
  return {
    agent: r.source === 'sensor' ? 'A1' : 'A0',
    stage: 'observe',
    priority: PRIORITY[r.kind],
    key: `event:${r.eventId}`,
    rank: [],
    issuedTick: tick,
    expiresTick: tick,
    // The report is what makes the event known: it cannot already be in the view.
    eventId: null,
    action: { type: 'observe', eventId: r.eventId, source: r.source, sensorId: r.sensorId },
    reason,
  };
}
