// Row text of fire and medical calls: incident state, dispatch status and response time.

import type { EventRow } from './store';

const FIRE_STATE = { burning: '불타는 중', suppressing: '진압 중' } as const;
const MEDICAL_STATE = { waiting: '대기 중', treating: '처치 중', transport: '이송 중' } as const;

/** State of a fire / medical row ('' for other kinds): result when over, else the live incident state. */
export function incidentText(e: Pick<EventRow, 'kind' | 'incident' | 'result' | 'ended' | 'endReason'>): string {
  if (e.kind !== 'fire' && e.kind !== 'medical') return '';
  if (e.result) return e.result;
  if (e.endReason) return e.endReason; // over for another reason: never the last progress state
  const i = e.incident;
  if (!i) return e.ended ? '종료됨' : '';
  if (e.kind === 'fire') return i.state === 'burning' ? `${FIRE_STATE.burning} ${Math.round(i.progress)}%` : (FIRE_STATE as Record<string, string>)[i.state] ?? '';
  return (MEDICAL_STATE as Record<string, string>)[i.state] ?? '';
}

/**
 * Dispatch status and response time: "현장 도착 · 대응 12.0분", "출동 불가: 시설 없음". Once the incident is over
 * (end reason, result or gone) the vehicle is recalled, so the text follows its real stage and outcomes
 * (복귀 중, 복귀 완료, 출동 취소, 출동 차량 상실) and never says "출동 중".
 */
export function dispatchText(e: Pick<EventRow, 'dispatchNote' | 'response' | 'dispatch' | 'endReason' | 'result' | 'ended'>): string {
  const over = !!(e.endReason || e.result || e.ended);
  const parts: string[] = [];
  const stage = e.dispatch?.stage;
  let live = stage === 'enroute' ? '출동 중' : stage === 'working' ? '현장 작업' : stage === 'transport' ? '이송 중' : stage === 'returning' ? '복귀 중' : '';
  if (over && (stage === 'enroute' || stage === 'transport')) live = ''; // recalled: the snapshot says so within a tick
  let note: string | undefined = live || e.dispatchNote;
  if (over && note === '출동 중') note = undefined;
  if (note) parts.push(note);
  if (e.response) parts.push(`대응 ${e.response}`);
  return parts.join(' · ');
}
