import { describe, expect, it } from 'vitest';
import { createEmptyDoc, DEFAULT_REGULATIONS, type Parcel } from '@smartcity/shared';
import { growthBlockers } from './growthInfo';

const lot = (extra: Partial<Parcel> = {}): Parcel => ({
  id: 'p',
  polygon: [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 24 }, { x: 0, z: 24 }],
  zone: 'residential',
  regulation: { ...DEFAULT_REGULATIONS.residential },
  auto: true,
  frontage: { segmentId: 's', side: 'left' },
  ...extra,
});

describe('growthBlockers', () => {
  it('lists every reason an empty auto lot does not grow', () => {
    const doc = createEmptyDoc();
    doc.meta.growth = false;
    const reasons = growthBlockers(doc, lot(), { residential: 0.01, commercial: 0.5, office: 0.5 });
    expect(reasons.join('|')).toMatch(/꺼져/);
    expect(reasons.join('|')).toMatch(/수요가 낮/);
    expect(reasons.join('|')).toMatch(/접한 도로/);
  });

  it('is quiet for manual lots and lots that already have a building', () => {
    const doc = createEmptyDoc();
    expect(growthBlockers(doc, lot({ auto: undefined }), null)).toEqual([]);
    doc.buildings['b'] = { id: 'b', typeId: 'grow-res-1', pos: { x: 10, z: 12 }, rotation: 0, auto: true };
    expect(growthBlockers(doc, lot(), null)).toEqual([]);
  });

  it('finds no design for a lot that is too small, and says industry is unsupported', () => {
    const doc = createEmptyDoc();
    const tiny = lot({ polygon: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }] });
    expect(growthBlockers(doc, tiny, null).join('|')).toMatch(/성장 설계가 없/);
    expect(growthBlockers(doc, lot({ zone: 'industrial' }), null).join('|')).toMatch(/산업/);
  });

  it('a roomy lot with a road and demand has no blockers', () => {
    const doc = createEmptyDoc();
    doc.segments['s'] = { id: 's', a: 'x', b: 'y', roadTypeId: 'road-2' };
    expect(growthBlockers(doc, lot(), { residential: 0.6, commercial: 0, office: 0 })).toEqual([]);
  });
});
