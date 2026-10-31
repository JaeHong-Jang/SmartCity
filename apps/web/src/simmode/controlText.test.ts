import { describe, expect, it } from 'vitest';
import { AGENTS, type Decision } from '@smartcity/sim';
import { agentName, decisionTime, evidenceLines, offReason, ROLE_COLOR } from './controlText';
import { WARMUP_TICKS } from './time';

describe('control room texts (ADR 0015 §5, §6)', () => {
  it('every agent: a role color, evidence with source type and outcome status kept apart, report references', () => {
    for (const a of AGENTS) {
      expect(a.roles.length).toBeGreaterThan(0);
      for (const r of a.roles) expect(ROLE_COLOR[r]).toMatch(/^#/);
      const lines = evidenceLines(a);
      expect(lines.length).toBe(a.evidence.length);
      for (const [i, e] of a.evidence.entries()) {
        expect(lines[i]).toContain(e.source);
        expect(lines[i]).toContain(`성과 ${e.outcome}`);
        for (const r of e.refs) expect(lines[i]).toContain(`[${r}]`);
      }
    }
    expect(evidenceLines(AGENTS.find((a) => a.id === 'A4')!)).toEqual(['학술 · 성과 실측 [17]']);
    expect(agentName('A5')).toBe('A5 통제·우회 안내');
  });

  it('why an agent is OFF, and the game clock of a decision', () => {
    expect(offReason(AGENTS.find((a) => a.id === 'A3')!)).toBe('P8b 예정');
    expect(offReason(AGENTS.find((a) => a.id === 'A1')!)).toMatch(/센서/);
    const d: Decision = { seq: 1, tick: WARMUP_TICKS, agent: 'A0', verdict: 'accepted', action: 'observe', text: '', reason: '', eventId: null, target: null };
    // Warm-up = 10 game minutes after 06:30.
    expect(decisionTime(d)).toBe('06:40');
  });
});
