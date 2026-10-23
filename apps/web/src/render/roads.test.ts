import { describe, expect, it } from 'vitest';
import { crossDoc, road } from '../test/fixtures';
import { fallbackNetwork } from './roadNetwork';
import { RoadLayer } from './roads';

describe('RoadLayer chunk rebuilds', () => {
  it('rebuilds only chunks whose roads changed', () => {
    const { doc, ids } = crossDoc();
    const layer = new RoadLayer();
    layer.update(fallbackNetwork(doc));
    const initial = layer.chunkCount;
    expect(initial).toBeGreaterThan(0);
    expect(layer.lastRebuilt).toBe(initial);

    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);

    // A road far away touches exactly one new chunk.
    road(doc, { x: 1000, z: 1000 }, { x: 1040, z: 1000 }, ids);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(1);
    expect(layer.chunkCount).toBe(initial + 1);
    // Each chunk is a single merged mesh (one draw call).
    expect(layer.group.children.length).toBe(layer.chunkCount);
  });
});
