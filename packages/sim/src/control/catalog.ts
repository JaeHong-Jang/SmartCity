// Agent catalog (ADR 0015 §1, §5): names, eye / brain / body role, the policy factor that switches each one,
// and the evidence shown next to it — source type, outcome status and transfer limit kept apart, with the
// team report's reference numbers (보고서/work/report.md 6장). No evidence enters the model as an effect.

import type { AgentId, AgentRole, PolicyFactors } from './types.js';

export type SourceType = '학술' | '기관 발표' | '보도' | '기업' | '팀 제안';
export type OutcomeStatus = '실측' | '추정' | '목표' | '없음';

export interface AgentEvidence {
  source: SourceType;
  outcome: OutcomeStatus;
  /** Report reference numbers ([n] in 보고서 6장). */
  refs: number[];
  /** What the case is and why it does not transfer as-is (other city, conditions, measurement). */
  note: string;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  roles: AgentRole[];
  /** The factor that turns it on (null = always on; 'reserved' = not built yet). */
  factor: keyof PolicyFactors | null | 'reserved';
  /** Phase it arrives in (built agents: 'P8a'). */
  phase: string;
  evidence: AgentEvidence[];
}

export const AGENTS: readonly AgentInfo[] = [
  { id: 'A0', name: '중앙 관제', roles: ['brain'], factor: null, phase: 'P8a', evidence: [{ source: '팀 제안', outcome: '없음', refs: [], note: '눈–두뇌–몸 구조와 사전 검증 고리는 본 팀 제안안(보고서 2.1), 성과 근거 아님' }] },
  {
    id: 'A1',
    name: '영상 AI 감지',
    roles: ['eye'],
    factor: 'detection',
    phase: 'P8a',
    evidence: [
      { source: '보도', outcome: '목표', refs: [13], note: '한국도로공사 AI CCTV 인지→안내 80초 이내는 목표치(고속도로)' },
      { source: '기업', outcome: '없음', refs: [14, 19], note: '노타 NVA 교통관제·판교 시범, 정량 성과 미공개' },
    ],
  },
  { id: 'A2', name: '차량 온디바이스', roles: ['eye', 'body'], factor: 'reserved', phase: 'P8c', evidence: [{ source: '보도', outcome: '실측', refs: [15], note: '대전~세종 C-ITS 사고 −19%, 비교 기준 미제시' }] },
  {
    id: 'A3',
    name: '적응형 신호',
    roles: ['brain'],
    factor: 'reserved',
    phase: 'P8b',
    evidence: [
      { source: '학술', outcome: '실측', refs: [11], note: 'Surtrac 9개 교차로, 개발팀 자체 평가·측정 월 다름' },
      { source: '기관 발표', outcome: '실측', refs: [12], note: '제주 애조로, 보도된 기관 발표' },
    ],
  },
  { id: 'A4', name: '긴급 대응', roles: ['brain'], factor: null, phase: 'P8a', evidence: [{ source: '학술', outcome: '실측', refs: [17], note: '청주 우선신호 시범 약 2분 단축, 포화 시 효과 감소(수동 전환)' }] },
  { id: 'A5', name: '통제·우회 안내', roles: ['brain', 'body'], factor: 'reroute', phase: 'P8a', evidence: [{ source: '기관 발표', outcome: '없음', refs: [16], note: '서울 TOPIS 통제 예보·우회 안내, 정량 효과 없음' }] },
  { id: 'A6', name: '사전 검증', roles: ['brain'], factor: 'reserved', phase: 'P8e', evidence: [{ source: '기관 발표', outcome: '실측', refs: [12], note: '가상 도로 시험 후 조정 사례, 사전 시뮬레이션 효과는 분리되지 않음' }] },
  { id: 'A7', name: '드론·로봇', roles: ['body'], factor: 'reserved', phase: 'P8d', evidence: [{ source: '보도', outcome: '없음', refs: [18, 24], note: '무인소방로봇 배치 사실, 진압 성과 미공개' }] },
  {
    id: 'A8',
    name: '환경 지표',
    roles: ['brain'],
    factor: 'reserved',
    phase: 'P8e',
    evidence: [
      { source: '기관 발표', outcome: '실측', refs: [10], note: '도로수송 배출 비중 통계(대책의 효과가 아님)' },
      { source: '학술', outcome: '추정', refs: [11], note: 'Surtrac 배출 −21.48%는 모델 추정치, 보정 전 모의 값만 표시 예정' },
    ],
  },
];
