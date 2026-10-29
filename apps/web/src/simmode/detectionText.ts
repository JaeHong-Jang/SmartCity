// Detection wording (ADR 0013 §1, §5): how the city learned of an accident or fire, and the KPI summary lines.
// Outcome reasons come from the simulation: `detection.known` = "report, 3.2분" or "sensor <id>, 0.4분",
// `detection.missed` = "ended before detection" / "burned before detection" / "target gone",
// `detection.unpowered` = the sensor id whose detection a blackout voided.

import type { CityDoc } from '@smartcity/shared';
import type { DetectionKpi, DetectionMode, ResponseBreakdown, ScenarioOutcome } from '@smartcity/sim';
import { SENSOR_KIND_INFO } from '../tools/sensorTool';

export const DETECTION_MODE_LABEL: Record<DetectionMode, string> = {
  legacy: '즉시 인지 (기존)',
  reports: '신고만',
  sensors: '센서+신고',
};

const MISSED: Record<string, string> = {
  'ended before detection': '인지 전에 끝남',
  'burned before detection': '인지 전에 전소',
  'target gone': '인지 전에 대상 사라짐',
};

/** Parsed `detection.known` reason: who reported it first and after how many game minutes. */
function known(o: ScenarioOutcome): { sensorId: string | null; delay: string } | null {
  if (o.kind !== 'detection.known' || !o.reason) return null;
  const [who = '', delay = ''] = o.reason.split(', ');
  if (who === 'report') return { sensorId: null, delay };
  if (who.startsWith('sensor ')) return { sensorId: who.slice('sensor '.length), delay };
  return null;
}

/** Map label of a detection moment: "CCTV 감지", "레이더 감지", "스마트폴 감지", "신고 접수". */
export function detectionLabel(o: ScenarioOutcome, doc: CityDoc | null): { text: string; bySensor: boolean } | null {
  const k = known(o);
  if (!k) return null;
  if (k.sensorId === null) return { text: '신고 접수', bySensor: false };
  const kind = doc?.sensors?.[k.sensorId]?.kind;
  return { text: `${kind ? SENSOR_KIND_INFO[kind].short : '센서'} 감지`, bySensor: true };
}

/** Event-row note of a detection outcome (null = not one). */
export function detectionNote(o: ScenarioOutcome, doc: CityDoc | null): string | null {
  const k = known(o);
  if (k) return `${detectionLabel(o, doc)!.text} · 발생 ${k.delay} 후`;
  if (o.kind === 'detection.missed') return MISSED[o.reason ?? ''] ?? '인지 전에 끝남';
  if (o.kind === 'detection.unpowered') return `정전으로 센서 무효 (${o.reason ?? ''})`;
  return null;
}

const min1 = (v: number): string => `${v.toFixed(1)}분`;

/** One line of the live detection KPIs (game model values). */
export function detectionSummaryText(d: DetectionKpi): string {
  if (d.tracked === 0) return '감지 대상 사건(사고·화재) 없음';
  const parts = [
    `인지 ${d.detected}/${d.tracked}건 (센서 먼저 ${d.bySensor})`,
    `감지 지연 평균 ${min1(d.avgDelay)} · 최대 ${min1(d.maxDelay)}`,
    `센서 커버 ${d.covered}/${d.tracked}건`,
    `미인지 ${d.undetectedNow}건${d.undetectedNow > 0 ? ` (최장 ${min1(d.oldestUndetectedMinutes)})` : ''}`,
    `인지 전 종료 ${d.missed}건 (피해 ${d.missedDamaged})`,
    `인지 전 노출 차량 ${d.exposedVehicles}대`,
    `현장 복구 ${d.onSiteRecoveries}`,
  ];
  return parts.join(' · ');
}

/** "대응 = 감지 a + 출동 대기 b + 이동 c분 · 현장 작업 w분" (arrived responses only). */
export function responseBreakdownText(r: ResponseBreakdown): string {
  if (r.arrivals === 0) return '도착한 출동 없음';
  const total = r.detect + r.dispatchWait + r.travel;
  return `대응 ${min1(total)} = 감지 ${min1(r.detect)} + 출동 대기 ${min1(r.dispatchWait)} + 이동 ${min1(r.travel)} (도착 ${r.arrivals}건)${r.workDone > 0 ? ` · 현장 작업 ${min1(r.work)}` : ''}`;
}
