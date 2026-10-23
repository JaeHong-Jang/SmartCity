import { describe, expect, it } from 'vitest';
import type { SimStats } from '@smartcity/sim';
import { sameDisplayedStats } from './simStats';

const stats = (patch: Partial<SimStats> = {}): SimStats =>
  ({
    tick: 10,
    time: 0.5,
    vehicles: 3,
    spawned: 3,
    arrived: 0,
    removed: 0,
    avgSpeed: 4,
    stopped: 0,
    pendingRoutes: 0,
    graphRevision: 1,
    clock: { dayTime: 6.5 * 3600 + 5, day: 1 },
    citizens: { total: 5, scale: 1, home: 2, atWork: 1, walking: 1, driving: 1, waitingBus: 0, riding: 0 },
    pedestrians: 1,
    ...patch,
  }) as SimStats;

describe('sameDisplayedStats', () => {
  it('ignores tick, time and sub-minute clock movement', () => {
    expect(sameDisplayedStats(stats(), stats({ tick: 11, time: 0.55, clock: { dayTime: 6.5 * 3600 + 20, day: 1 } }))).toBe(true);
  });

  it('notices any shown value changing', () => {
    expect(sameDisplayedStats(null, stats())).toBe(false);
    expect(sameDisplayedStats(stats(), stats({ vehicles: 4 }))).toBe(false);
    expect(sameDisplayedStats(stats(), stats({ clock: { dayTime: 6.5 * 3600 + 60, day: 1 } }))).toBe(false);
    expect(sameDisplayedStats(stats(), stats({ citizens: { ...stats().citizens, walking: 2 } }))).toBe(false);
  });
});
