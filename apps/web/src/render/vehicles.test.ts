import { describe, expect, it } from 'vitest';
import { DEFAULT_VEHICLE_TYPES } from '@smartcity/shared';
import { bakeVehicleGeometry, interpAlpha, lerpAngle } from './vehicles';
import { TICK_MS } from '../sim/protocol';

describe('vehicle rendering helpers', () => {
  it('interpolates one tick behind the latest snapshot', () => {
    expect(interpAlpha(1000 + TICK_MS, 1000, 1050)).toBe(0);
    expect(interpAlpha(1050 + TICK_MS, 1000, 1050)).toBe(1);
    expect(interpAlpha(1025 + TICK_MS, 1000, 1050)).toBeCloseTo(0.5);
    expect(interpAlpha(5000, 1000, 1000)).toBe(1);
  });

  it('lerps angles the short way round', () => {
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI, 6);
  });

  it('bakes all parts into one vertex-colored geometry', () => {
    const vt = DEFAULT_VEHICLE_TYPES[0]!;
    const g = bakeVehicleGeometry(vt.parts);
    expect(g.getAttribute('position').count).toBe(vt.parts.length * 36);
    expect(g.getAttribute('color').count).toBe(vt.parts.length * 36);
  });
});
