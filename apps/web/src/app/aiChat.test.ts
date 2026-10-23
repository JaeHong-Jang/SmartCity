import { describe, expect, it } from 'vitest';
import { initialAi, reduceAi, type AiState } from './aiChat';

const server = (s: AiState, msg: Parameters<typeof reduceAi>[1] extends infer E ? (E extends { kind: 'server'; msg: infer M } ? M : never) : never) => reduceAi(s, { kind: 'server', msg });

describe('AI chat reducer', () => {
  it('records status, an ask, and replaces the live progress note', () => {
    let s = server(initialAi(), { t: 'ai.status', enabled: true, model: 'm' });
    expect(s).toMatchObject({ enabled: true, model: 'm' });
    s = reduceAi(s, { kind: 'ask', text: '카페 지어줘' });
    expect(s.running).toBe(1);
    s = server(s, { t: 'ai.progress', reqId: 1, note: '설계 중' });
    s = server(s, { t: 'ai.progress', reqId: 1, note: '배치 중' });
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([['user', '카페 지어줘'], ['progress', '배치 중']]);
  });

  it('turns a proposal into an assistant message and clears progress and running', () => {
    let s = reduceAi(initialAi(), { kind: 'ask', text: 'x' });
    s = server(s, { t: 'ai.progress', reqId: 1, note: '...' });
    s = server(s, { t: 'ai.proposal', reqId: 1, commands: [], summary: '카페 1채' });
    expect(s.running).toBeNull();
    expect(s.proposal).toMatchObject({ reqId: 1, summary: '카페 1채' });
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(reduceAi(s, { kind: 'discard' }).proposal).toBeNull();
  });

  it('shows errors, ignores late answers of cancelled requests, and blocks a second ask', () => {
    let s = reduceAi(initialAi(), { kind: 'ask', text: 'a' });
    expect(reduceAi(s, { kind: 'ask', text: 'b' })).toBe(s);
    s = server(s, { t: 'ai.error', reqId: 1, error: '한도 초과' });
    expect(s.running).toBeNull();
    expect(s.messages.at(-1)).toMatchObject({ role: 'error', text: '한도 초과' });
    s = reduceAi(s, { kind: 'ask', text: 'c' });
    s = reduceAi(s, { kind: 'cancel' });
    expect(s.running).toBeNull();
    const late = server(s, { t: 'ai.proposal', reqId: 2, commands: [], summary: 'late' });
    expect(late.proposal).toBeNull();
  });
});
