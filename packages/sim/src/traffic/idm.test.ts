import { describe, expect, it } from 'vitest';
import { idmAccel, MAX_DECEL } from './idm.js';

describe('IDM', () => {
  it('accelerates towards the desired speed on a free road', () => {
    let v = 0;
    for (let i = 0; i < 20 * 120; i++) v += idmAccel(v, 15, Infinity, 0, 1.6, 2.5, 2, 1.2) * 0.05;
    expect(v).toBeGreaterThan(14.5);
    expect(v).toBeLessThanOrEqual(15);
  });

  it('stops behind a standing obstacle at about s0 without touching it', () => {
    let v = 15;
    let x = 0;
    const obstacle = 150;
    let minGap = Infinity;
    for (let i = 0; i < 20 * 60; i++) {
      const gap = obstacle - x;
      const a = idmAccel(v, 15, gap, v, 1.6, 2.5, 2, 1.2);
      const nv = Math.max(0, v + a * 0.05);
      x += (v + nv) * 0.5 * 0.05;
      v = nv;
      minGap = Math.min(minGap, obstacle - x);
    }
    expect(v).toBeLessThan(0.05);
    expect(minGap).toBeGreaterThan(0);
    expect(obstacle - x).toBeGreaterThan(1.5);
    expect(obstacle - x).toBeLessThan(3);
  });

  it('caps braking at the hard deceleration limit', () => {
    expect(idmAccel(20, 20, 0.5, 20, 1.6, 2.5, 2, 1.2)).toBe(-MAX_DECEL);
  });
});
