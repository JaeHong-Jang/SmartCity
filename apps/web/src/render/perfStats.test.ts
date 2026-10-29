import { describe, expect, it } from 'vitest';
import { FrameTimes, percentile } from './perfStats';

describe('frame time percentiles', () => {
  it('uses the nearest rank', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 10, 0.5)).toBe(5);
    expect(percentile(s, 10, 0.95)).toBe(10);
    expect(percentile(s, 10, 0.1)).toBe(1);
    expect(percentile([], 0, 0.5)).toBe(0);
  });

  it('summarizes only the most recent frames of the ring', () => {
    const f = new FrameTimes(100);
    for (let i = 0; i < 100; i++) f.push(100);
    // The first hundred frames are overwritten by 1..100.
    for (let i = 1; i <= 100; i++) f.push(i);
    const p = f.summarize({ p50: 0, p95: 0, p99: 0 });
    expect(f.count).toBe(100);
    expect(p.p50).toBe(50);
    expect(p.p95).toBe(95);
    expect(p.p99).toBe(99);
  });

  it('keeps the slow outliers visible in p99', () => {
    const f = new FrameTimes(100);
    for (let i = 0; i < 98; i++) f.push(16.7);
    f.push(80);
    f.push(90);
    const p = f.summarize({ p50: 0, p95: 0, p99: 0 });
    expect(p.p50).toBeCloseTo(16.7, 3);
    expect(p.p95).toBeCloseTo(16.7, 3);
    expect(p.p99).toBe(80);
    f.clear();
    expect(f.summarize(p).p50).toBe(0);
  });
});
