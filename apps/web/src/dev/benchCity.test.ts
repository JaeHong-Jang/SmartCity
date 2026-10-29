import { describe, expect, it } from 'vitest';
import { docProblem } from '@smartcity/shared';
import { createBenchCity } from './benchCity';

describe('benchmark city', () => {
  const doc = createBenchCity();

  it('matches the performance targets (≈1,000 roads, 2,000 buildings of many designs)', () => {
    expect(Object.keys(doc.segments).length).toBe(2 * 23 * 22);
    expect(Object.keys(doc.buildings).length).toBe(2000);
    const designs = new Set(Object.values(doc.buildings).map((b) => b.typeId));
    expect(designs.size).toBeGreaterThanOrEqual(10);
    expect(Object.values(doc.parcels).some((p) => p.zone === 'green')).toBe(true);
    expect(docProblem(doc)).toBeNull();
  });

  it('is deterministic', () => {
    expect(JSON.stringify(createBenchCity())).toBe(JSON.stringify(doc));
  }, 60_000);
});
