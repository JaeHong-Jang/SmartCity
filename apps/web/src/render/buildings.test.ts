import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson } from '@smartcity/shared';
import type { SimSnapshot } from '@smartcity/sim';
import { crossDoc } from '../test/fixtures';
import { BuildingLayer, buildingCapacity, occupancyLevel } from './buildings';

describe('window light level', () => {
  it('is people over capacity, 0.6 without a known capacity, 0 when empty', () => {
    expect(occupancyLevel(0, 1, 10)).toBe(0);
    expect(occupancyLevel(5, 1, 10)).toBe(0.5);
    expect(occupancyLevel(50, 1, 10)).toBe(1);
    expect(occupancyLevel(2, 5, 10)).toBe(1);
    expect(occupancyLevel(3, 1, 0)).toBe(0.6);
  });

  it('writes per-instance aOccupancy from the snapshot in building id order', () => {
    const { doc } = crossDoc();
    for (const [id, x] of [['bA', 30], ['bB', 60]] as const) {
      expect(applyCommand(doc, { type: 'building.place', building: { id, typeId: 'house', pos: { x, z: 30 }, rotation: 0 } }).ok).toBe(true);
    }
    const layer = new BuildingLayer();
    layer.update(doc);
    const cap = buildingCapacity(doc.buildingTypes['house']!);
    expect(cap).toBeGreaterThan(0);

    const snap = {
      buildingIds: ['bA', 'bB'],
      occupancy: new Float32Array([cap / 2, 0]),
      stats: { citizens: { scale: 1 } },
    } as unknown as SimSnapshot;
    layer.setOccupancy(snap);
    const mesh = layer.group.children[0] as unknown as { geometry: { getAttribute(n: string): { array: Float32Array } } };
    const occ = mesh.geometry.getAttribute('aOccupancy').array;
    const slots = [...(layer as unknown as { slotOf: Map<string, { slot: number }> }).slotOf];
    const level = (id: string): number => occ[slots.find(([k]) => k === id)![1].slot]!;
    expect(level('bA')).toBeCloseTo(0.5, 5);
    expect(level('bB')).toBe(0);

    // No citizen data at all: a modest default so the night city is not black.
    layer.setOccupancy({ buildingIds: [], occupancy: new Float32Array(0), stats: {} } as unknown as SimSnapshot);
    expect(level('bA')).toBeGreaterThan(0);
    expect(level('bA')).toBeLessThan(0.5);
  });

  it('shares the night uniform with the material', () => {
    const layer = new BuildingLayer();
    layer.setNight(0.75);
    expect((layer as unknown as { material: { userData: { uNight: { value: number } } } }).material.userData.uNight.value).toBe(0.75);
  });
});

describe('design cache', () => {
  it('rebakes when only the props differ between two docs with the same revision (Sol 2b-sim #5)', () => {
    const { doc: a } = crossDoc();
    expect(applyCommand(a, { type: 'building.place', building: { id: 'b1', typeId: 'house', pos: { x: 30, z: 30 }, rotation: 0 } }).ok).toBe(true);
    const b = cloneJson(a);
    b.buildingTypes['house']!.props = [{ kind: 'ac', pos: { x: 0, y: 2, z: 0 }, rot: 0, size: 1, color: '#dddddd' }];
    const layer = new BuildingLayer();
    const verts = (): number => (layer.group.children[0] as unknown as { geometry: { getAttribute(n: string): { count: number } } }).geometry.getAttribute('position').count;
    layer.update(a);
    const before = verts();
    layer.update(b);
    expect(verts()).toBeGreaterThan(before);
  });
});
