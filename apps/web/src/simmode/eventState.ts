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
      update(end.rowId, { endError: o.applied ? undefined : (o.reason ?? '종료되지 않았습니다') });
    } else if (!next.some((r) => r.eventId === o.eventId)) {
      continue;
    } else if (o.kind.endsWith('.start')) {
      if (o.applied) update(o.eventId, { status: 'ok', error: undefined, ...(o.reason?.startsWith('moved') ? { note: ACCIDENT_MOVED } : {}) });
      else update(o.eventId, { status: 'rejected', error: o.reason ?? '적용되지 않았습니다', active: false, ended: false });
    } else if (o.kind === 'accident.move') {
      update(o.eventId, { note: ACCIDENT_MOVED });
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
export function reconcileEvents(rows: EventRow[], view: Pick<ScenarioView, 'activeEvents'>, tick: number, pendingEnds: Map<string, PendingEnd>): EventRow[] {
  const active = new Map(view.activeEvents.map((a) => [a.eventId, a]));
  let changed = false;
  const next = rows.map((r) => {
    if (r.status === 'rejected') return r;
    const a = active.get(r.eventId);
    const status = a ? 'ok' : r.status;
    const isActive = !!a;
    const gone = !a && status === 'ok' && tick > r.startTick;
    const endTick = a ? a.endTick : r.endTick;
    if (r.status === status && r.active === isActive && r.ended === gone && r.endTick === endTick) return r;
    changed = true;
    // An end request is settled once the event is gone.
    if (gone) for (const [id, e] of pendingEnds) if (e.rowId === r.eventId) pendingEnds.delete(id);
    return { ...r, status, active: isActive, ended: gone, endTick };
  });
  return changed ? next : rows;
}
