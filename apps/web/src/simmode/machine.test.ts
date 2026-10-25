import { describe, expect, it } from 'vitest';
import { transition, type SimAction, type SimPhase } from './machine';

describe('simulator-mode phases', () => {
  const run = (start: SimPhase, ...actions: SimAction[]) => actions.reduce<SimPhase>((p, a) => transition(p, a), start);

  it('enter → warm-up → ready → compare → ready → exit', () => {
    expect(run('off', 'enter')).toBe('warming');
    expect(run('off', 'enter', 'warmedUp')).toBe('ready');
    expect(run('off', 'enter', 'warmedUp', 'compare')).toBe('comparing');
    expect(run('off', 'enter', 'warmedUp', 'compare', 'compareDone')).toBe('ready');
    expect(run('off', 'enter', 'warmedUp', 'compare', 'compareCancel', 'exit')).toBe('off');
  });
  it('restart goes back to warm-up from anywhere active; exit from anywhere active', () => {
    for (const p of ['warming', 'ready', 'comparing'] as const) {
      expect(transition(p, 'restart')).toBe('warming');
      expect(transition(p, 'exit')).toBe('off');
    }
  });
  it('ignores illegal transitions', () => {
    expect(transition('off', 'exit')).toBe('off');
    expect(transition('off', 'compare')).toBe('off');
    expect(transition('warming', 'compare')).toBe('warming');
    expect(transition('ready', 'enter')).toBe('ready');
    expect(transition('ready', 'warmedUp')).toBe('ready');
  });
});
