import { describe, expect, it } from 'vitest';
import { applyCommand } from '@smartcity/shared';
import type * as THREE from 'three';
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

describe('RoadLayer street facilities', () => {
  const firstSegment = (doc: ReturnType<typeof crossDoc>['doc']): string => Object.keys(doc.segments).sort()[0]!;

  it('rebuilds only the touched chunk when a speed bump or school zone changes', () => {
    const { doc, ids } = crossDoc();
    road(doc, { x: 1000, z: 1000 }, { x: 1040, z: 1000 }, ids);
    const layer = new RoadLayer();
    layer.update(fallbackNetwork(doc));
    expect(layer.chunkCount).toBe(2);
    const seg = firstSegment(doc);

    expect(applyCommand(doc, { type: 'feature.upsert', feature: { id: 'f1', segmentId: seg, kind: 'speedBump', t: 0.5 } }).ok).toBe(true);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(1);

    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);

    expect(applyCommand(doc, { type: 'segment.setSchoolZone', id: seg, schoolZone: true }).ok).toBe(true);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBeGreaterThanOrEqual(1);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);

    expect(applyCommand(doc, { type: 'feature.remove', id: 'f1' }).ok).toBe(true);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBeGreaterThanOrEqual(1);
  });

  it('rebuilds the roads at a junction when its control or crosswalk legs change', () => {
    const { doc } = crossDoc();
    const layer = new RoadLayer();
    layer.update(fallbackNetwork(doc));
    const center = Object.values(doc.nodes).find((n) => n.pos.x === 0 && n.pos.z === 0)!;
    const legs = Object.keys(doc.segments).sort().slice(0, 2);
    const r = applyCommand(doc, { type: 'intersection.set', control: { nodeId: center.id, kind: 'allStop', crosswalkLegs: legs, yellow: 3, allRed: 2, offset: 0 } });
    expect(r.ok).toBe(true);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBeGreaterThanOrEqual(1);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);
  });

  it('draws crossings from the compiled network and moves nothing when there are none', () => {
    const { doc } = crossDoc();
    const net = fallbackNetwork(doc);
    const plain = new RoadLayer();
    plain.update(net);
    const withCrossing = new RoadLayer();
    const seg = net.segments.get(firstSegment(doc))!;
    const mid = seg.length / 2;
    seg.crossings.push({
      index: 0,
      id: 'c0',
      kind: 'midblock',
      segmentId: seg.id,
      s: mid,
      a: { x: -mid, z: 4 },
      b: { x: -mid, z: -4 },
      width: 4,
      polygon: [
        { x: -mid - 2, z: 4 },
        { x: -mid + 2, z: 4 },
        { x: -mid + 2, z: -4 },
        { x: -mid - 2, z: -4 },
      ],
      signal: false,
      schoolZone: false,
    });
    withCrossing.update(net);
    const tris = (l: RoadLayer): number => l.group.children.reduce((n, m) => n + (m as THREE.Mesh).geometry.getAttribute('position').count / 3, 0);
    expect(tris(withCrossing)).toBeGreaterThan(tris(plain));
  });
});
