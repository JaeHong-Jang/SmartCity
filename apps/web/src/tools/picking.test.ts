import { describe, expect, it } from 'vitest';
import { applyCommand } from '@smartcity/shared';
import { crossDoc } from '../test/fixtures';
import { PickIndex, pickAt } from './picking';

describe('PickIndex', () => {
  it('finds the junction node, segments and buildings', () => {
    const { doc } = crossDoc();
    expect(applyCommand(doc, { type: 'building.place', building: { id: 'b1', typeId: 'house', pos: { x: 40, z: 30 }, rotation: 0 } }).ok).toBe(true);
    const idx = new PickIndex(doc);
    const center = idx.nearestNode({ x: 2, z: 1 }, 6);
    expect(center).not.toBeNull();
    expect(doc.nodes[center!.id]!.pos).toEqual({ x: 0, z: 0 });

    const seg = idx.nearestSegment({ x: 50, z: 3 });
    expect(seg).not.toBeNull();
    expect(Math.abs(seg!.point.z)).toBeLessThan(1e-6);
    expect(idx.nearestSegment({ x: 50, z: 30 })).toBeNull();

    expect(idx.buildingAt({ x: 41, z: 31 })).toBe('b1');
    expect(idx.buildingAt({ x: 60, z: 60 })).toBeNull();
  });

  it('pickAt prefers nodes over segments and respects filters', () => {
    const { doc } = crossDoc();
    const idx = new PickIndex(doc);
    expect(pickAt(idx, { x: 1, z: 1 })?.kind).toBe('node');
    expect(pickAt(idx, { x: 1, z: 1 }, { nodes: false })?.kind).toBe('segment');
    expect(pickAt(idx, { x: 300, z: 300 })).toBeNull();
  });
});
