import { describe, expect, it } from 'vitest';
import type { BuildingType } from '@smartcity/shared';
import { crossDoc } from '../test/fixtures';
import { GhostBuilding } from './ghostBuilding';

const pb = { typeId: 'house', pos: { x: 0, z: 0 }, rotation: 0, color: '#4ade80' };

describe('GhostBuilding', () => {
  it('rebuilds when the design changes even if id, rev and serialized length are unchanged', () => {
    const house = crossDoc().doc.buildingTypes['house']!;
    const a: BuildingType = { ...house, rev: 1 };
    const part = a.parts[0]!;
    // Same JSON length, different geometry: floors 2 -> 3.
    const b: BuildingType = { ...a, parts: [{ ...part, floors: part.floors === 3 ? 2 : 3 }, ...a.parts.slice(1)] };
    expect(JSON.stringify(b.parts).length).toBe(JSON.stringify(a.parts).length);
    const ghost = new GhostBuilding();
    ghost.set(a, pb);
    const first = ghost.group.children[0] as import('three').Mesh;
    ghost.set(b, pb);
    expect(ghost.group.children[0]).not.toBe(first);
  });

  it('keeps the geometry while the same design is only repositioned', () => {
    const type = crossDoc().doc.buildingTypes['house']!;
    const ghost = new GhostBuilding();
    ghost.set(type, pb);
    const first = ghost.group.children[0];
    ghost.set(type, { ...pb, pos: { x: 5, z: 7 }, rotation: 1 });
    expect(ghost.group.children[0]).toBe(first);
    expect(ghost.group.position.x).toBe(5);
    ghost.set(undefined, undefined);
    expect(ghost.group.visible).toBe(false);
  });
});
