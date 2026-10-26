// Rounded volumes in the simulation (ADR 0012 §4): the pedestrian graph puts a round tower's door on its
// shared `partOutline` (the chord facing the sidewalk), the same way on every build.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, partOutline, type BuildingPart } from '@smartcity/shared';
import { compileNetwork } from './network/compile.js';
import { buildPedGraph } from './network/pedGraph.js';
import { apply } from './testkit.js';

const tower: BuildingPart = { offset: { x: 0, z: 0 }, width: 16, depth: 16, floors: 8, floorHeight: 3.2, baseHeight: 0, roof: 'flat', color: '#cccccc', roofColor: '#555555', round: 8 };

describe('rounded buildings in the pedestrian graph', () => {
  it('puts the door on the rounded outline, deterministically', () => {
    const doc = apply(createEmptyDoc('r', 1), [
      { type: 'node.add', node: { id: 'a', pos: { x: -100, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
      { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      { type: 'buildingType.upsert', buildingType: { id: 'round-tower', name: '원형 타워', zone: 'office', parts: [tower] } },
      { type: 'building.place', building: { id: 't', typeId: 'round-tower', pos: { x: 3, z: -20 }, rotation: 0 } },
    ]);
    const build = () => buildPedGraph(doc, compileNetwork(doc));
    const pg = build();
    const a = pg.access[pg.buildingIds.indexOf('t')]!;
    expect(a).not.toBeNull();
    const door = { x: pg.x[a.door]!, z: pg.z[a.door]! };
    // On a chord of the circle facing the road (north side), within the arc tolerance of the circle.
    const r = Math.hypot(door.x - 3, door.z + 20);
    expect(r).toBeGreaterThan(8 - 0.05);
    expect(r).toBeLessThanOrEqual(8);
    expect(door.z).toBeGreaterThan(-20 + 7.9);
    expect(Math.abs(door.x - 3)).toBeLessThan(1);
    // The door is a chord midpoint of the 32-chord circle, not of the 16 m square (its face would be at z = −12).
    expect(partOutline(tower).length).toBe(32);
    const again = build();
    expect([again.x[again.access[0]!.door], again.z[again.access[0]!.door]]).toEqual([door.x, door.z]);
  });
});
