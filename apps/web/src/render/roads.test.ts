import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc } from '@smartcity/shared';
import type * as THREE from 'three';
import { crossDoc, road } from '../test/fixtures';
import { buildRoadNetwork, fallbackNetwork } from './roadNetwork';
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

describe('RoadLayer smooth joints (fillets, ADR 0012 §1)', () => {
  /** A → V → C corner of road-2, rounded by road.fillet (new nodes fa, fb; curve fc). */
  function filletDoc() {
    const doc = createEmptyDoc();
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'A', pos: { x: -100, z: 0 } } },
        { type: 'node.add', node: { id: 'V', pos: { x: 0, z: 0 } } },
        { type: 'node.add', node: { id: 'C', pos: { x: 0, z: 100 } } },
        { type: 'segment.add', segment: { id: 'sa', a: 'A', b: 'V', roadTypeId: 'road-2' } },
        { type: 'segment.add', segment: { id: 'sb', a: 'V', b: 'C', roadTypeId: 'road-2' } },
        { type: 'road.fillet', nodeId: 'V', ids: { a: 'fa', b: 'fb', seg: 'fc' } },
      ],
    });
    expect(r).toEqual({ ok: true });
    return doc;
  }

  it('marks the curve ends as smooth joints (compiled and fallback) and leaves sharp corners alone', () => {
    const doc = filletDoc();
    for (const net of [buildRoadNetwork(doc), fallbackNetwork(doc)]) {
      expect(net.nodes.get('fa')!.joint).toBeDefined();
      expect(net.nodes.get('fb')!.joint).toBeDefined();
      expect(net.nodes.get('A')!.joint).toBeUndefined();
    }
    const sharp = createEmptyDoc();
    applyCommand(sharp, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'A', pos: { x: -100, z: 0 } } },
        { type: 'node.add', node: { id: 'V', pos: { x: 0, z: 0 } } },
        { type: 'node.add', node: { id: 'C', pos: { x: 0, z: 100 } } },
        { type: 'segment.add', segment: { id: 'sa', a: 'A', b: 'V', roadTypeId: 'road-2' } },
        { type: 'segment.add', segment: { id: 'sb', a: 'V', b: 'C', roadTypeId: 'road-2' } },
      ],
    });
    expect(buildRoadNetwork(sharp).nodes.get('V')!.joint).toBeUndefined();
  });

  it('the straight road and the curve share their edge points at the joint (no wedge, gap or overlap)', () => {
    const doc = filletDoc();
    const net = buildRoadNetwork(doc);
    /** Mesh vertices (x, z) of one road drawn alone. */
    const vertices = (segId: string): { x: number; z: number }[] => {
      const layer = new RoadLayer();
      layer.update({ ...net, segments: new Map([[segId, net.segments.get(segId)!]]) });
      const out: { x: number; z: number }[] = [];
      for (const m of layer.group.children as THREE.Mesh[]) {
        const a = m.geometry.getAttribute('position').array as Float32Array;
        for (let i = 0; i < a.length; i += 3) out.push({ x: a[i]!, z: a[i + 2]! });
      }
      return out;
    };
    const p0 = doc.nodes.fa!.pos;
    const straight = vertices('sa');
    const curve = vertices('fc');
    // At fa the joint runs along +x: curb (±3.5) and outer sidewalk edge (±6) of both roads end on the same
    // points. Without the shared end direction the curve's edges would start up to ~0.3 m off them.
    for (const edge of [-6, -3.5, 3.5, 6]) {
      const target = { x: p0.x, z: p0.z + edge };
      for (const vs of [straight, curve]) expect(Math.min(...vs.map((q) => Math.hypot(q.x - target.x, q.z - target.z)))).toBeLessThan(1e-3);
    }
    // And the curve is drawn from the node itself (no junction cut, no polygon at the joint).
    expect(Math.min(...curve.map((q) => Math.abs(q.x - p0.x)))).toBeLessThan(1e-3);
  });
});
