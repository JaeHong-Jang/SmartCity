import { describe, expect, it } from 'vitest';
import { createEmptyDoc, pointInPolygon, polygonArea, type CityDoc } from '@smartcity/shared';
import * as THREE from 'three';
import { blockFaces, MAX_BLOCK_AREA, PavingLayer, pavingShapes, Y_LAWN, Y_PAVE } from './paving';
import { Y_ROAD } from './roads';

/** n × n grid of nodes `spacing` apart, every neighbor joined by a 2-lane road. */
function grid(n: number, spacing: number): CityDoc {
  const doc = createEmptyDoc();
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) doc.nodes[`n${i}_${j}`] = { id: `n${i}_${j}`, pos: { x: i * spacing, z: j * spacing } };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) doc.segments[`x${i}_${j}`] = { id: `x${i}_${j}`, a: `n${i}_${j}`, b: `n${i + 1}_${j}`, roadTypeId: 'road-2' };
      if (j + 1 < n) doc.segments[`z${i}_${j}`] = { id: `z${i}_${j}`, a: `n${i}_${j}`, b: `n${i}_${j + 1}`, roadTypeId: 'road-2' };
    }
  }
  return doc;
}

describe('city ground (paving)', () => {
  it('finds every bounded block of the road grid, not the outside', () => {
    const faces = blockFaces(grid(3, 100));
    expect(faces).toHaveLength(4);
    for (const f of faces) expect(polygonArea(f)).toBeCloseTo(10_000, 6);
  });

  it('walks around dead ends and follows curved roads', () => {
    const doc = grid(2, 100);
    doc.nodes.spur = { id: 'spur', pos: { x: 50, z: 40 } };
    doc.segments.spur = { id: 'spur', a: 'n0_0', b: 'spur', roadTypeId: 'road-2' };
    // Bulge the bottom edge outward: the block grows by the curve's area (2/3 · 100 m · 20 m sag).
    doc.segments.x0_0!.control = { x: 50, z: -40 };
    const faces = blockFaces(doc);
    expect(faces).toHaveLength(1);
    expect(polygonArea(faces[0]!)).toBeGreaterThan(10_000 + 1250);
    expect(polygonArea(faces[0]!)).toBeLessThan(10_000 + 1340);
  });

  it('leaves huge faces (open land between distant roads) unpaved', () => {
    const big = Math.sqrt(MAX_BLOCK_AREA) * 1.5;
    expect(blockFaces(grid(2, big))).toHaveLength(0);
  });

  it('paves built-up blocks, aprons buildings outside them, lawn on green lots', () => {
    const doc = grid(3, 100);
    // A factory (40 × 26 m) covers ~10 % of its block: paved. One house elsewhere keeps its yard.
    doc.buildings.b1 = { id: 'b1', typeId: 'factory', pos: { x: 50, z: 30 }, rotation: 0 };
    doc.buildings.b2 = { id: 'b2', typeId: 'house', pos: { x: 150, z: 30 }, rotation: 0 };
    doc.parcels.p1 = { id: 'p1', polygon: [{ x: 120, z: 120 }, { x: 180, z: 120 }, { x: 180, z: 180 }, { x: 120, z: 180 }], zone: 'green', regulation: { coverage: 0.2, far: 0.2, maxHeight: 10, setback: 0 } };
    const s = pavingShapes(doc);
    // The factory's block, then the house's apron (10 × 9 grown by 4 m, 7 m in front); the factory
    // needs no apron inside its paved block.
    expect(s.paved).toHaveLength(2);
    expect(polygonArea(s.paved[0]!)).toBeCloseTo(10_000, 6);
    expect(pointInPolygon({ x: 50, z: 50 }, s.paved[0]!)).toBe(true);
    expect(polygonArea(s.paved[1]!)).toBeCloseTo((10 + 8) * (9 + 4 + 7), 6);
    expect(s.lawn).toHaveLength(1);
  });

  it("keeps a green lot green inside a paved block (Sol's repro: factory + park in one block)", () => {
    const doc = grid(2, 100);
    doc.buildings.f = { id: 'f', typeId: 'factory', pos: { x: 50, z: 30 }, rotation: 0 };
    doc.parcels.park = { id: 'park', polygon: [{ x: 10, z: 60 }, { x: 90, z: 60 }, { x: 90, z: 90 }, { x: 10, z: 90 }], zone: 'green', regulation: { coverage: 0.2, far: 0.2, maxHeight: 10, setback: 0 } };
    const s = pavingShapes(doc);
    expect(s.paved.some((p) => pointInPolygon({ x: 50, z: 75 }, p))).toBe(true);
    const layer = new PavingLayer();
    layer.update(doc);
    layer.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(50, 10, 75), new THREE.Vector3(0, -1, 0));
    // (A point on a triangulation diagonal is hit twice by the same mesh: keep the first hit per mesh.)
    const hits = ray.intersectObjects(layer.group.children, false).filter((h, i, all) => all.findIndex((o) => o.object === h.object) === i);
    expect(hits.map((h) => h.object.name)).toEqual(['paving-lawn', 'paving-concrete']);
    expect(hits[0]!.point.y).toBeCloseTo(Y_LAWN, 6);
    expect(hits[1]!.point.y).toBeCloseTo(Y_PAVE, 6);
    // Both stay under the road surface.
    expect(Y_LAWN).toBeLessThan(Y_ROAD);
    layer.dispose();
  });

  it('turns the apron with the building (front toward its road)', () => {
    const doc = createEmptyDoc();
    doc.buildings.b1 = { id: 'b1', typeId: 'house', pos: { x: 0, z: 0 }, rotation: Math.PI / 2 };
    const [apron] = pavingShapes(doc).paved;
    // rotation π/2 turns local +Z (front) into world +X: the long 7 m side is at +x.
    const xs = apron!.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(4.5 + 7, 6);
    expect(Math.min(...xs)).toBeCloseTo(-4.5 - 4, 6);
  });
});
