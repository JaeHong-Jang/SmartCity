import { describe, expect, it } from 'vitest';
import { PED_STRIDE } from '@smartcity/sim';
import { bakePedestrianGeometry, lerpPedestrian, PED_JUMP, PED_PALETTE, swingAmplitude } from './pedestrians';

function ped(x: number, z: number, heading: number, speed = 1.4, phase = 0): number[] {
  return [x, z, heading, speed, phase, 0, 0, 0];
}

describe('pedestrian interpolation', () => {
  it('blends position, heading and gait phase between snapshots', () => {
    const out = [0, 0, 0, 0];
    const ok = lerpPedestrian(ped(0, 0, 0, 1.4, 1), 0, ped(1, 2, 1, 1.4, 3), 0, 0.5, out);
    expect(ok).toBe(true);
    expect(out).toEqual([0.5, 1, 0.5, 2]);
  });

  it('turns the short way round', () => {
    const out = [0, 0, 0, 0];
    lerpPedestrian(ped(0, 0, Math.PI - 0.1), 0, ped(0, 0, -Math.PI + 0.1), 0, 0.5, out);
    expect(Math.cos(out[2]!)).toBeCloseTo(-1, 5);
  });

  it('does not interpolate across a jump of more than 5 m', () => {
    const out = [9, 9, 9, 9];
    expect(lerpPedestrian(ped(0, 0, 0), 0, ped(PED_JUMP + 0.1, 0, 0), 0, 0.5, out)).toBe(false);
    expect(out).toEqual([9, 9, 9, 9]);
    expect(lerpPedestrian(ped(0, 0, 0), 0, ped(PED_JUMP - 0.1, 0, 0), 0, 0.5, out)).toBe(true);
  });

  it('reads records at their stride offsets', () => {
    const prev = [...ped(0, 0, 0), ...ped(10, 10, 0)];
    const cur = [...ped(0, 0, 0), ...ped(12, 10, 0)];
    const out = [0, 0, 0, 0];
    lerpPedestrian(prev, PED_STRIDE, cur, PED_STRIDE, 0.5, out);
    expect(out[0]).toBe(11);
  });
});

describe('pedestrian model', () => {
  it('swings only while moving', () => {
    expect(swingAmplitude(0)).toBe(0);
    expect(swingAmplitude(1.4)).toBeGreaterThan(swingAmplitude(0.5));
    expect(swingAmplitude(9)).toBeLessThanOrEqual(swingAmplitude(1.4) + 1e-9);
  });

  it('bakes torso, head, 2 arms and 2 legs with limb and color attributes', () => {
    const g = bakePedestrianGeometry();
    const n = g.getAttribute('position').count;
    expect(n).toBe(6 * 36);
    expect(g.getAttribute('aLimb').count).toBe(n);
    expect(g.getAttribute('color').count).toBe(n);
    // Four swinging limbs (arms + legs), torso/arms take the shirt color.
    const limb = g.getAttribute('aLimb');
    let swinging = 0;
    let tinted = 0;
    for (let i = 0; i < n; i++) {
      if (limb.getX(i) !== 0) swinging++;
      if (limb.getZ(i) > 0.5) tinted++;
    }
    expect(swinging).toBe(4 * 36);
    expect(tinted).toBe(3 * 36);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(1.64, 1);
    expect(g.boundingBox!.min.y).toBeCloseTo(0, 6);
  });

  it('has 16 clothing colors', () => {
    expect(PED_PALETTE).toHaveLength(16);
  });
});
