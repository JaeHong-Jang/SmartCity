// Event rows follow the simulation, not the acks. A new row is "확인 중" (status 'pending') until the sim
// reports the outcome of its creation input (lossless `outcomes` stream) or lists it in `activeEvents`
// (which proves it was applied). Then it is active while listed and "ended" once it is no longer listed after
// its start. Rejected or no-op inputs carry the sim's reason. `recentLog` is not used: it is lossy.

import type { ScenarioOutcome, ScenarioView } from '@smartcity/sim';
import type { EventRow } from './store';

export type EventOutcome = ScenarioOutcome;

/** Row notes for outcomes caused by edits of the (frozen) copy's roads or by the sim moving the obstacle. */
export const ACCIDENT_MOVED = '사고 위치 이동';
export const REMOVED_BY_EDIT = '도로 편집으로 제거됨';

export interface PendingEnd {
  rowId: string;
  tick: number;
}

export const MANUAL_END = '수동 종료';
/** Core reasons of an applied `fire.end` / `medical.end` outcome on the incident itself. */
const END_REASON: Record<string, string> = {
  'target gone': '대상 건물 삭제됨',
  // The core ends a medical call this way for any lost transport (no hospital, vehicle gone, no route);
  // the specific cause is the dispatch note (dispatch.lost reason).
  'patient transport lost': '이송 실패',
};

/** Fire / medical outcomes (eventId = the incident's event) → row fields. */
const EMERGENCY_OUTCOME: Record<string, (o: ScenarioOutcome) => Partial<EventRow>> = {
  'dispatch.start': () => ({ dispatchNote: '출동 중' }),
  'dispatch.arrive': (o) => ({ dispatchNote: '현장 도착', response: o.reason }),
  'dispatch.return': () => ({ dispatchNote: '복귀 완료' }),
  'dispatch.cancel': () => ({ dispatchNote: '출동 취소' }),
  'dispatch.lost': (o) => ({ dispatchNote: `출동 차량 상실${o.reason ? `: ${o.reason}` : ''}` }),
  'dispatch.failed': (o) => ({ dispatchNote: o.reason ?? '출동 불가' }),
  'fire.extinguished': () => ({ result: '진화됨' }),
  'fire.damaged': () => ({ result: '피해' }),
  'medical.complete': () => ({ result: '완료' }),
};

/**
 * Outcomes of creation inputs (`*.start`: applied → 'ok', else 'rejected' + reason) and of end requests
 * (matched by the end input's own eventId: applied clears `endError`, otherwise it shows the reason).
 * `pendingEnds` is updated in place. Returns `rows` itself when nothing changed.
 */
export function applyOutcomes(rows: EventRow[], outcomes: readonly EventOutcome[], pendingEnds: Map<string, PendingEnd>): EventRow[] {
  let next = rows;
  const update = (id: string, patch: Partial<EventRow>): void => {
    next = next.map((r) => (r.eventId === id ? { ...r, ...patch } : r));
  };
  for (const o of outcomes) {
    const end = pendingEnds.get(o.eventId);
    if (end) {
      pendingEnds.delete(o.eventId);
      const manual = o.applied && next.some((r) => r.eventId === end.rowId && (r.kind === 'fire' || r.kind === 'medical'));
      update(end.rowId, { endError: o.applied ? undefined : (o.reason ?? '종료되지 않았습니다'), ...(manual ? { endReason: MANUAL_END } : {}) });
    } else if (!next.some((r) => r.eventId === o.eventId)) {
      continue;
    } else if (EMERGENCY_OUTCOME[o.kind]) {
      update(o.eventId, EMERGENCY_OUTCOME[o.kind]!(o));
    } else if (o.kind.endsWith('.start')) {
      if (o.applied) update(o.eventId, { status: 'ok', error: undefined, ...(o.reason?.startsWith('moved') ? { note: ACCIDENT_MOVED } : {}) });
      else update(o.eventId, { status: 'rejected', error: o.reason ?? '적용되지 않았습니다', active: false, ended: false });
    } else if (o.kind === 'accident.move') {
      update(o.eventId, { note: ACCIDENT_MOVED });
    } else if ((o.kind === 'fire.end' || o.kind === 'medical.end') && o.applied) {
      // Not extinguished / damaged / completed: the call was over for another reason.
      update(o.eventId, { endReason: END_REASON[o.reason ?? ''] ?? o.reason ?? '종료됨' });
    } else if (o.kind.endsWith('.end') && o.applied && (o.reason === 'lane gone' || o.reason === 'no room after edit')) {
      update(o.eventId, { note: REMOVED_BY_EDIT });
    }
  }
  return next;
}

/**
 * Rows after reading one snapshot at `tick`: listed events are active (and confirmed); an applied row that is
 * no longer listed after its start is ended. A row whose creation is still unconfirmed never counts as ended.
 */
export function reconcileEvents(rows: EventRow[], view: Pick<ScenarioView, 'activeEvents'> & Partial<Pick<ScenarioView, 'incidents' | 'dispatches'>>, tick: number, pendingEnds: Map<string, PendingEnd>): EventRow[] {
  const active = new Map(view.activeEvents.map((a) => [a.eventId, a]));
  const incidents = new Map((view.incidents ?? []).map((i) => [i.eventId, i]));
  const dispatches = new Map((view.dispatches ?? []).map((d) => [d.eventId, d]));
  let changed = false;
  const next = rows.map((r) => {
    if (r.status === 'rejected') return r;
    const a = active.get(r.eventId);
    const status = a ? 'ok' : r.status;
    const isActive = !!a;
    const gone = !a && status === 'ok' && tick > r.startTick;
    const endTick = a ? a.endTick : r.endTick;
    const inc = incidents.get(r.eventId);
    // Once the incident is over its last progress state is meaningless ("불타는 중 0%" after an end).
    const incident = gone ? undefined : inc ? { state: inc.state, progress: inc.progress } : r.incident;
    const dis = dispatches.get(r.eventId);
    const dispatch = dis ? { stage: dis.stage, vehicleId: dis.vehicleId } : undefined;
    const sameInc = incident === r.incident || (incident && r.incident && incident.state === r.incident.state && incident.progress === r.incident.progress);
    const sameDis = dispatch === r.dispatch || (dispatch && r.dispatch && dispatch.stage === r.dispatch.stage && dispatch.vehicleId === r.dispatch.vehicleId);
    if (r.status === status && r.active === isActive && r.ended === gone && r.endTick === endTick && sameInc && sameDis) return r;
    changed = true;
    // An end request is settled once the event is gone.
    if (gone) for (const [id, e] of pendingEnds) if (e.rowId === r.eventId) pendingEnds.delete(id);
    return { ...r, status, active: isActive, ended: gone, endTick, incident, dispatch };
  });
  return changed ? next : rows;
}
