// AI control room texts (ADR 0015 §5, §6): eye / brain / body colors, agent states, evidence lines (source
// type, outcome status and report reference numbers kept apart) and decision log rows. Pure functions.

import { AGENTS, type AgentId, type AgentInfo, type AgentRole, type AgentState, type Decision } from '@smartcity/sim';
import { formatClock } from '../render/dayNight';
import { dayTimeAtTick } from './time';

export const ROLE_LABEL: Record<AgentRole, string> = { eye: '눈', brain: '두뇌', body: '몸' };
/** Role colors (eye cyan, brain violet, body orange); readable on the dark panel. */
export const ROLE_COLOR: Record<AgentRole, string> = { eye: '#22d3ee', brain: '#a78bfa', body: '#fb923c' };
export const STATE_LABEL: Record<AgentState, string> = { idle: '대기', active: '동작', off: 'OFF' };
export const VERDICT_LABEL: Record<Decision['verdict'], string> = { accepted: '채택', rejected: '거절', cancelled: '취소' };

export const agentInfo = (id: AgentId): AgentInfo => AGENTS.find((a) => a.id === id)!;

/** "A4 긴급 대응" */
export const agentName = (id: AgentId): string => `${id} ${agentInfo(id).name}`;

/** "근거: 학술 · 실측 [17]" lines, one per evidence entry. */
export function evidenceLines(a: AgentInfo): string[] {
  return a.evidence.map((e) => `${e.source} · 성과 ${e.outcome}${e.refs.length > 0 ? ` ${e.refs.map((r) => `[${r}]`).join('')}` : ''}`);
}

/** Why an OFF agent is off: not built yet (its phase) or its factor is off. */
export function offReason(a: AgentInfo): string {
  if (a.factor === 'reserved') return `${a.phase} 예정`;
  if (a.factor === 'detection') return '감지 모드가 센서+신고일 때 동작';
  if (a.factor === 'reroute') return '스마트 대응 OFF';
  return '';
}

/** Game clock of a decision, "07:42". */
export const decisionTime = (d: Decision): string => formatClock(dayTimeAtTick(d.tick));
