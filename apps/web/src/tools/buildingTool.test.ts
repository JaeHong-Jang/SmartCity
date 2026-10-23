import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, IdGen, roadHalfWidth, rotateY } from '@smartcity/shared';
import { road } from '../test/fixtures';
import { PickIndex } from './picking';
import { alignToRoad, frontExtent, placementValid, SETBACK_MARGIN } from './buildingTool';

describe('alignToRoad', () => {
  const doc = createEmptyDoc();
  road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('t'));
  const idx = new PickIndex(doc);
  const house = doc.buildingTypes.house!;
  const hw = roadHalfWidth(doc.roadTypes['road-2']!);

  for (const side of [1, -1]) {
    it(`faces the road from the ${side > 0 ? '+z' : '-z'} side and sits outside the sidewalk`, () => {
      const p = alignToRoad(doc, idx, house, { x: 10, z: 15 * side })!;
      expect(p).not.toBeNull();
      // Local +z (front) must point at the road.
      const front = rotateY({ x: 0, z: 1 }, p.rotation);
      expect(front.z * -side).toBeCloseTo(1, 6);
      expect(p.pos.x).toBeCloseTo(10, 6);
      expect(Math.abs(p.pos.z)).toBeCloseTo(hw + SETBACK_MARGIN + frontExtent(house), 6);
      expect(placementValid(doc, house, p)).toBe(true);
      expect(applyCommand(doc, { type: 'building.place', building: { id: `b${side}`, typeId: 'house', pos: p.pos, rotation: p.rotation } }).ok).toBe(true);
    });
  }

  it('returns null far from roads, and a building on the road is invalid', () => {
    expect(alignToRoad(doc, idx, house, { x: 0, z: 200 })).toBeNull();
    expect(placementValid(doc, house, { pos: { x: 0, z: 0 }, rotation: 0, segmentId: null })).toBe(false);
  });
});
