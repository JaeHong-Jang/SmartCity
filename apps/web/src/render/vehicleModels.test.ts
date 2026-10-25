import { describe, expect, it } from 'vitest';
import { DEFAULT_VEHICLE_TYPES } from '@smartcity/shared';
import { CAR_CLASSES, CLASS_PERCENT, carClassLength, carClassOf, carClassParts, carColorOf, usesVarietyPath } from './vehicleModels';
import { bakeVehicleGeometry } from './vehicles';

describe('car appearance classes', () => {
  it('follows the target distribution within 2 percentage points over 10000 ids', () => {
    const n = 10000;
    const counts = new Array<number>(CAR_CLASSES.length).fill(0);
    for (let id = 1; id <= n; id++) counts[carClassOf(id)]!++;
    CLASS_PERCENT.forEach((pct, i) => expect(Math.abs((counts[i]! / n) * 100 - pct)).toBeLessThanOrEqual(2));
  });

  it('is deterministic per id (class and color)', () => {
    for (const id of [1, 7, 4242, 99999]) {
      const c = carClassOf(id);
      expect(carClassOf(id)).toBe(c);
      expect(carColorOf(id, c)).toBe(carColorOf(id, c));
    }
  });

  it('paints taxis yellow and uses several colors for sedans', () => {
    const taxi = CAR_CLASSES.indexOf('taxi');
    expect(carColorOf(5, taxi)).toBe('#f2c200');
    const colors = new Set<string>();
    for (let id = 1; id <= 500; id++) colors.add(carColorOf(id, 0));
    expect(colors.size).toBeGreaterThanOrEqual(6);
  });

  it('keeps every model no longer than the shortest car type, or scales to it', () => {
    const carLens = DEFAULT_VEHICLE_TYPES.filter((t) => t.kind === 'car').map((t) => t.length);
    for (let c = 0; c < CAR_CLASSES.length; c++) {
      const len = carClassLength(c);
      expect(len).toBeGreaterThan(3);
      expect(len).toBeLessThanOrEqual(5.1);
      for (const L of carLens) expect(len * Math.min(1, L / len)).toBeLessThanOrEqual(L + 1e-9);
      const g = bakeVehicleGeometry(carClassParts(c));
      expect(g.getAttribute('position').count).toBe(carClassParts(c).length * 36);
    }
  });

  describe('variety path eligibility', () => {
    const sedan = DEFAULT_VEHICLE_TYPES.find((t) => t.id === 'sedan')!;
    it('uses variety for the unchanged default sedan', () => {
      expect(usesVarietyPath(structuredClone(sedan))).toBe(true);
    });
    it('keeps own parts when a part or the color is modified', () => {
      const part = structuredClone(sedan);
      part.parts[0]!.height += 0.1;
      expect(usesVarietyPath(part)).toBe(false);
      expect(usesVarietyPath({ ...structuredClone(sedan), color: '#123456' })).toBe(false);
    });
    it('keeps own parts for a custom car type id', () => {
      expect(usesVarietyPath({ ...structuredClone(sedan), id: 'my-car' })).toBe(false);
    });
  });
});
