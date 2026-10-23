import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, type CityDoc } from '../index.js';
import { pruneFeatures } from './roads.js';
import { Tx } from './tx.js';

// Segment length is 100 m; features are placed by arc length s (t = s / 100).
function docWithRoad(): CityDoc {
  const doc = createEmptyDoc();
  applyCommand(doc, {
    type: 'batch',
    commands: [
      { type: 'node.add', node: { id: 'n1', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'n2', pos: { x: 100, z: 0 } } },
      { type: 'segment.add', segment: { id: 's1', a: 'n1', b: 'n2', roadTypeId: 'road-2' } },
    ],
  });
  return doc;
}

const feature = (id: string, s: number) => ({ id, segmentId: 's1', kind: 'speedBump' as const, t: s / 100 });

describe('feature end clearance and spacing', () => {
  const eps = 1e-6;
  const ends = [11, 12 - 2 * eps, 12 - eps / 2, 12, 12 + eps, 50, 88 - eps, 88, 88 + eps / 2, 88 + 2 * eps, 89];

  it('validateFeature and pruneFeatures agree on end clearance', () => {
    for (const s of ends) {
      const doc = docWithRoad();
      const accepted = applyCommand(doc, { type: 'feature.upsert', feature: feature('f', s) }).ok;
      const other = docWithRoad();
      other.features.f = feature('f', s);
      pruneFeatures(other, 's1', new Tx());
      expect(accepted, `s=${s}`).toBe('f' in other.features);
    }
  });

  it('validateFeature and pruneFeatures agree on spacing', () => {
    for (const gap of [5, 6 - 2 * eps, 6 - eps / 2, 6, 6 + eps, 7]) {
      const doc = docWithRoad();
      applyCommand(doc, { type: 'feature.upsert', feature: feature('a', 40) });
      const accepted = applyCommand(doc, { type: 'feature.upsert', feature: feature('b', 40 + gap) }).ok;
      const other = docWithRoad();
      other.features.a = feature('a', 40);
      other.features.b = feature('b', 40 + gap);
      pruneFeatures(other, 's1', new Tx());
      expect(accepted, `gap=${gap}`).toBe('b' in other.features);
    }
  });
});
