// Policy normalization (ADR 0015 §3): a ResponsePolicy → independent factors. Omitted = the existing
// behaviour (pre-emption and batteries follow `reroute`, detection legacy). An explicit value always wins and
// is kept as given in the record (no rewriting: records replay byte-identically). Reserved factors
// (`adaptive`, `drone`, `precheck`, `onboard`) are fixed OFF in P8a: omitted or false / 0 is accepted and
// ignored (never recorded), true / 1 is rejected.

import { batteryOn, detectionOf, preemptOn, type ResponsePolicy } from '../scenario/types.js';
import type { PolicyFactors } from './types.js';

export const RESERVED_FACTORS = ['adaptive', 'drone', 'precheck', 'onboard'] as const;
export type ReservedFactor = (typeof RESERVED_FACTORS)[number];

export function policyFactors(p: ResponsePolicy): PolicyFactors {
  return {
    preempt: preemptOn(p),
    reroute: p.reroute,
    battery: batteryOn(p),
    detection: detectionOf(p),
    informedShare: p.informedShare,
    adaptive: false,
    drone: false,
    precheck: false,
    onboard: false,
  };
}

/** A reserved factor set ON (policy object: true; policy.set params: anything but 0). Null = fine. */
export function reservedError(get: (k: ReservedFactor) => unknown, off: unknown): string | null {
  for (const k of RESERVED_FACTORS) {
    const v = get(k);
    if (v !== undefined && v !== off) return `policy.${k}: 아직 지원하지 않는 요인입니다 (OFF 고정)`;
  }
  return null;
}

/**
 * The normalization table (ADR 0015 §3), one row per factor: what omission means, which explicit values are
 * accepted, what the factor covers and how a contradiction is resolved. Shown in docs and tested as data.
 */
export const POLICY_TABLE: readonly { factor: keyof PolicyFactors; omitted: string; explicit: string; scope: string; contradiction: string }[] = [
  { factor: 'reroute', omitted: '필수 (기본 정책 false)', explicit: 'boolean · policy.set 0|1', scope: 'A5: 도시가 아는 사건의 시작·종료 때 정보 수신 차량 재탐색만. 무효 경로 복구(통제로 막힌 선두 차량)는 정책과 무관', contradiction: '정보 차량 비율 0이면 대상 없음(값은 그대로 보존)' },
  { factor: 'informedShare', omitted: '필수 (기본 0.7)', explicit: '0..1 유한수', scope: 'A5 대상 = hash01(차량 id, seed) < 비율', contradiction: 'reroute OFF면 쓰이지 않음(값 보존)' },
  { factor: 'preempt', omitted: 'reroute를 따름 (4c1 기록 그대로)', explicit: 'boolean · policy.set 0|1', scope: 'A4 우선신호 요청만. 출동 선택(가장 가까운 시설)은 항상 ON', contradiction: 'DARK 신호에서는 요청 없음(DARK > PREEMPT). 비교 프리셋 ①은 명시값을 지워 reroute를 따르게 함' },
  { factor: 'battery', omitted: 'reroute를 따름', explicit: 'boolean · policy.set 0|1', scope: '정전 신호 배터리(인프라, 에이전트 아님)', contradiction: '비교 프리셋 ①은 명시값을 지워 reroute를 따르게 함' },
  { factor: 'detection', omitted: 'legacy (즉시 인지)', explicit: "'legacy' | 'reports' | 'sensors' · policy.set 0|1|2", scope: '사고·화재를 아는 시점. A1 = sensors일 때만 ON. 응급·통제·급증·정전은 항상 즉시', contradiction: 'sensors + 센서 0개 = reports와 같은 결과. engine 1 기록에는 명시 불가' },
  { factor: 'adaptive', omitted: 'OFF', explicit: 'false · policy.set 0만 (true/1 거부)', scope: 'A3 적응형 신호 자리 (P8b)', contradiction: '기록에 저장하지 않음. engine 1·2 기록에는 명시 불가' },
  { factor: 'drone', omitted: 'OFF', explicit: 'false · policy.set 0만 (true/1 거부)', scope: 'A7 드론·로봇 자리 (P8d)', contradiction: '기록에 저장하지 않음. engine 1·2 기록에는 명시 불가' },
  { factor: 'precheck', omitted: 'OFF', explicit: 'false · policy.set 0만 (true/1 거부)', scope: 'A6 사전 검증 자리 (P8e)', contradiction: '기록에 저장하지 않음. engine 1·2 기록에는 명시 불가' },
  { factor: 'onboard', omitted: 'OFF', explicit: 'false · policy.set 0만 (true/1 거부)', scope: 'A2 차량 온디바이스 자리 (P8c)', contradiction: '기록에 저장하지 않음. engine 1·2 기록에는 명시 불가' },
];
