import { describe, expect, it } from 'vitest';
import { createEmptyDoc, IdGen, roadHalfWidth } from '@smartcity/shared';
import { crossDoc, road } from '../test/fixtures';
import { buildRoadNetwork, fallbackNetwork } from './roadNetwork';

describe('road network fallback', () => {
  it('is used when compileNetwork throws', () => {
    const { doc } = crossDoc();
    const net = buildRoadNetwork(doc, () => {
      throw new Error('not implemented');
    });
    expect(net.graph).toBeNull();
    expect(net.segments.size).toBe(4);
  });

  it('applies junction setbacks and builds a junction polygon', () => {
    const { doc } = crossDoc();
    const net = fallbackNetwork(doc);
    const hw = roadHalfWidth(doc.roadTypes['road-2']!);
    const center = [...net.nodes.values()].find((n) => n.pos.x === 0 && n.pos.z === 0)!;
    expect(center.segments).toHaveLength(4);
    expect(center.signalized).toBe(true);
    expect(center.polygon.length).toBeGreaterThanOrEqual(4);
    for (const id of center.segments) {
      const g = net.segments.get(id)!;
      const sb = g.a === center.id ? g.setbackA : g.setbackB;
      expect(sb).toBeCloseTo(hw + 1, 6);
      // Dead ends have no setback.
      expect(g.a === center.id ? g.setbackB : g.setbackA).toBe(0);
    }
  });

  it('straight continuation of the same road type gets a 1 m setback', () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('s');
    road(doc, { x: 0, z: 0 }, { x: 80, z: 0 }, ids);
    road(doc, { x: 80, z: 0 }, { x: 160, z: 0 }, ids);
    const net = fallbackNetwork(doc);
    const mid = [...net.nodes.values()].find((n) => n.pos.x === 80)!;
    const g = net.segments.get(mid.segments[0]!)!;
    expect(g.a === mid.id ? g.setbackA : g.setbackB).toBe(1);
  });
});
