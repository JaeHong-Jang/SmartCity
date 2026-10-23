import { describe, expect, it } from 'vitest';
import { computeDayNight, createDayNightState, formatClock, sunElevation } from './dayNight';

const H = 3600;
const at = (h: number) => computeDayNight(h * H, createDayNightState());

describe('day / night cycle', () => {
  it('formats the game clock', () => {
    expect(formatClock(7.5 * H + 32 * 60 - 1800)).toBe('07:32');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(86400 + 3600)).toBe('01:00');
  });

  it('puts the sun up at noon and down at midnight', () => {
    expect(sunElevation(12 * H)).toBeGreaterThan(0.9);
    expect(sunElevation(0)).toBeLessThan(-0.5);
    expect(sunElevation(6 * H)).toBeCloseTo(0, 6);
  });

  it('is fully lit at noon and dark at midnight, with the city still visible', () => {
    const noon = at(12);
    const night = at(0);
    expect(noon.night).toBe(0);
    expect(night.night).toBe(1);
    expect(noon.lightIntensity).toBeGreaterThan(night.lightIntensity * 1.4);
    expect(night.hemiIntensity).toBeGreaterThanOrEqual(0.5);
    expect(night.lightIntensity).toBeGreaterThan(0.3);
    expect(noon.sky.getHex()).not.toBe(night.sky.getHex());
    expect(noon.sky.r + noon.sky.g + noon.sky.b).toBeGreaterThan(night.sky.r + night.sky.g + night.sky.b);
  });

  it('keeps the light above the horizon and the transition continuous', () => {
    let prev = at(0);
    // One game minute per step (= 6 real seconds): nothing may jump.
    for (let m = 1; m <= 24 * 60; m++) {
      const s = at(m / 60);
      expect(s.lightDir.y).toBeGreaterThan(0.2);
      expect(Math.abs(s.lightIntensity - prev.lightIntensity)).toBeLessThan(0.05);
      expect(Math.abs(s.night - prev.night)).toBeLessThan(0.05);
      expect(Math.abs(s.lightDir.x - prev.lightDir.x)).toBeLessThan(0.08);
      prev = s;
    }
  });

  it('turns the windows on around dusk', () => {
    expect(at(17).night).toBeLessThan(0.1);
    expect(at(19.5).night).toBeGreaterThan(0.5);
    expect(at(6.5).night).toBeLessThan(0.7);
  });
});
