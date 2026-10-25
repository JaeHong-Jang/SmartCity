import { describe, expect, it } from 'vitest';
import { dayTimeAtTick, gameMinToTicks, ticksToGameMin, WARMUP_TICKS } from './time';

describe('game minutes ↔ ticks', () => {
  it('one game minute is 120 ticks at 20 Hz (1 sim second = 10 game seconds)', () => {
    expect(gameMinToTicks(1)).toBe(120);
    expect(gameMinToTicks(20)).toBe(2400); // the sim's default accident duration (20 game min)
    expect(WARMUP_TICKS).toBe(1200);
  });
  it('round-trips and respects the tick rate', () => {
    expect(ticksToGameMin(gameMinToTicks(37))).toBeCloseTo(37, 9);
    expect(gameMinToTicks(1, 10)).toBe(60);
    expect(gameMinToTicks(0)).toBe(0);
    expect(gameMinToTicks(-5)).toBe(0);
  });
  it('day time starts at 06:30', () => {
    expect(dayTimeAtTick(0)).toBe(6.5 * 3600);
    expect(dayTimeAtTick(1200)).toBe(6.5 * 3600 + 600);
  });
});
