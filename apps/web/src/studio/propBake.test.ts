import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PROP_KINDS, type BuildingProp } from '@smartcity/shared';
import { bakeBuildingGeometry, SURFACE } from '../render/buildingGeometry';
import { propBox } from './props';

function windingMatchesNormals(g: THREE.BufferGeometry): boolean {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1).sub(a);
    c.fromBufferAttribute(pos, i + 2).sub(a);
    n.fromBufferAttribute(nor, i);
    const cross = b.cross(c);
    // Degenerate triangles (cone tips) have no winding.
    if (cross.length() > 1e-9 && cross.dot(n) <= 0) return false;
  }
  return true;
}

const prop = (kind: BuildingProp['kind'], rot = 0, size = 1): BuildingProp => ({ kind, pos: { x: 4, y: 3.2, z: -2 }, rot, size, color: '#c0392b' });

describe('prop bake', () => {
  it('bakes every prop kind with outward faces, flagged as plain surfaces', () => {
    for (const kind of PROP_KINDS) {
      const g = bakeBuildingGeometry({ parts: [], props: [prop(kind)] });
      const wall = g.getAttribute('aWall');
      expect(wall.count, kind).toBeGreaterThan(0);
      for (let i = 0; i < wall.count; i++) expect(wall.getZ(i)).toBe(SURFACE.prop);
      expect(windingMatchesNormals(g), kind).toBe(true);
    }
  });

  it('stands on its base, faces its rotation and stays inside the picking box', () => {
    for (const kind of PROP_KINDS) {
      for (let rot = 0; rot < 4; rot++) {
        const p = prop(kind, rot, 1.5);
        const box = bakeBuildingGeometry({ parts: [], props: [p] }).boundingBox!;
        const pick = propBox(p);
        expect(box.min.y, kind).toBeCloseTo(3.2, 5);
        // The picking box is an approximation: within 0.5 m of the real extent.
        for (const [a, b] of [
          [box.min.x, pick.min[0]],
          [box.max.x, pick.max[0]],
          [box.min.z, pick.min[2]],
          [box.max.z, pick.max[2]],
          [box.max.y, pick.max[1]],
        ] as const)
          expect(Math.abs(a - b), `${kind} rot ${rot}`).toBeLessThan(0.75);
      }
    }
  });

  it('adds props to the design geometry with their color', () => {
    const part = { offset: { x: 0, z: 0 }, width: 4, depth: 4, floors: 2, floorHeight: 3.2, baseHeight: 0, roof: 'flat' as const, color: '#ffffff', roofColor: '#000000' };
    const plain = bakeBuildingGeometry({ parts: [part] });
    const withProps = bakeBuildingGeometry({ parts: [part], props: [{ kind: 'balcony', pos: { x: 0, y: 3.2, z: 2 }, rot: 0, size: 1, color: '#ff0000' }] });
    expect(withProps.getAttribute('position').count).toBeGreaterThan(plain.getAttribute('position').count);
    // The balcony sticks out of the front wall (+z).
    expect(withProps.boundingBox!.max.z).toBeCloseTo(3.2, 5);
    const col = withProps.getAttribute('color');
    let red = 0;
    for (let i = 0; i < col.count; i++) if (col.getX(i) > 0.9 && col.getY(i) < 0.1) red++;
    expect(red).toBeGreaterThan(0);
  });
});
