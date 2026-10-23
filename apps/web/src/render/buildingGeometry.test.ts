import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cloneJson, createEmptyDoc, partArea, SMART_CITY_PRESETS, type BuildingPart, type BuildingType } from '@smartcity/shared';
import { bakeBuildingGeometry, roofRows, SURFACE } from './buildingGeometry';
import { BuildingLayer } from './buildings';

const part = (p: Partial<BuildingPart>): BuildingPart => ({
  offset: { x: 0, z: 0 },
  width: 10,
  depth: 8,
  floors: 3,
  floorHeight: 3,
  baseHeight: 0,
  roof: 'flat',
  color: '#cccccc',
  roofColor: '#666666',
  ...p,
});

const L_SHAPE = [
  { x: 0, z: 0 },
  { x: 20, z: 0 },
  { x: 20, z: 8 },
  { x: 8, z: 8 },
  { x: 8, z: 20 },
  { x: 0, z: 20 },
];

/** Sum of triangle areas whose surface flag and facing match. */
function area(g: THREE.BufferGeometry, flag: number, minNy = 0.9): number {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const wall = g.getAttribute('aWall');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let sum = 0;
  for (let i = 0; i < pos.count; i += 3) {
    if (wall.getZ(i) !== flag || nor.getY(i) < minNy) continue;
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

/** Every triangle's winding agrees with its stored normal (no inverted faces). */
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
    if (b.cross(c).dot(n) <= 0) return false;
  }
  return true;
}

describe('bakeBuildingGeometry', () => {
  it('bakes a box volume: 4 walls + flat roof, all attributes per vertex', () => {
    const g = bakeBuildingGeometry({ parts: [part({})] });
    // 4 walls × 2 triangles + 2 roof triangles.
    expect(g.getAttribute('position').count).toBe((8 + 2) * 3);
    for (const name of ['normal', 'color', 'aWall', 'aFacade']) expect(g.getAttribute(name).count).toBe(30);
    expect(area(g, SURFACE.roof)).toBeCloseTo(80, 6);
    expect(windingMatchesNormals(g)).toBe(true);
    expect(g.boundingBox!.max.y).toBeCloseTo(9);
  });

  it('stores wall u/v in metres and the facade parameters', () => {
    const g = bakeBuildingGeometry({ parts: [part({ facade: { style: 'curtain', windowRatio: 0.8, ground: 'shop' } })] });
    const wall = g.getAttribute('aWall');
    const fac = g.getAttribute('aFacade');
    let maxU = 0;
    let maxV = 0;
    for (let i = 0; i < wall.count; i++) {
      if (wall.getZ(i) > 0) {
        maxU = Math.max(maxU, wall.getX(i));
        maxV = Math.max(maxV, wall.getY(i));
        expect(wall.getX(i)).toBeLessThanOrEqual(wall.getZ(i) + 1e-9);
      }
    }
    expect(maxU).toBe(10);
    expect(maxV).toBe(9);
    expect([fac.getX(0), fac.getY(0), fac.getZ(0), fac.getW(0)].map((v) => Math.round(v * 100) / 100)).toEqual([3, 2, 0.8, 1]);
  });

  it('extrudes an L-shaped footprint with a flat roof whose area matches partArea', () => {
    const p = part({ footprint: L_SHAPE, width: 20, depth: 20, offset: { x: 10, z: 10 } });
    const g = bakeBuildingGeometry({ parts: [p] });
    // 6 walls × 2 + (6 − 2) roof triangles.
    expect(g.getAttribute('position').count).toBe((12 + 4) * 3);
    expect(area(g, SURFACE.roof)).toBeCloseTo(partArea(p), 6);
    expect(windingMatchesNormals(g)).toBe(true);
    // Clockwise input gives the same outward walls.
    const cw = bakeBuildingGeometry({ parts: [{ ...p, footprint: [...L_SHAPE].reverse() }] });
    expect(windingMatchesNormals(cw)).toBe(true);
    expect(area(cw, SURFACE.roof)).toBeCloseTo(partArea(p), 6);
  });

  it('enforces flat roofs on drawn footprints, pitched roofs only on rectangles', () => {
    const drawn = bakeBuildingGeometry({ parts: [part({ footprint: L_SHAPE, roof: 'gable' })] });
    expect(drawn.boundingBox!.max.y).toBeCloseTo(9);
    expect(area(drawn, SURFACE.roof)).toBeCloseTo(256, 6);
    const gable = bakeBuildingGeometry({ parts: [part({ roof: 'gable' })] });
    expect(gable.boundingBox!.max.y).toBeGreaterThan(9 + 3);
    expect(windingMatchesNormals(gable)).toBe(true);
    const pyramid = bakeBuildingGeometry({ parts: [part({ roof: 'pyramid' })] });
    expect(pyramid.getAttribute('position').count).toBe((8 + 4) * 3);
    expect(windingMatchesNormals(pyramid)).toBe(true);
  });

  it('adds an underside only for raised volumes', () => {
    const g = bakeBuildingGeometry({ parts: [part({}), part({ baseHeight: 9, width: 6, depth: 6 })] });
    expect(g.getAttribute('position').count).toBe((10 + 8 + 2 + 2) * 3);
    expect(area(g, SURFACE.roof, -2) - area(g, SURFACE.roof)).toBeCloseTo(36, 6);
  });

  it('covers the solar and green shares of the usable top roof only', () => {
    const smart = { solarRoof: 0.5, greenRoof: 0.3, evChargers: 0, sensors: false, dronePort: false };
    const p = part({ width: 30, depth: 30, floors: 2 });
    const g = bakeBuildingGeometry({ parts: [p], smart });
    const usable = roofRows(partOutlineOf(p)).reduce((s, r) => s + r.area, 0);
    // Panels cover 72.5 % of each 2 m row (rows have walkways), planting covers whole rows.
    expect(area(g, SURFACE.solar)).toBeCloseTo(usable * 0.5 * 0.725, 1);
    expect(area(g, SURFACE.green)).toBeCloseTo(usable * 0.3, 1);
    // Equipment stays inside the roof and just above it.
    const box = g.boundingBox!;
    expect(box.max.y).toBeLessThan(6 + 0.5);
    expect(box.max.x).toBeLessThanOrEqual(15);

    // A tower standing on the podium: only the tower roof gets equipment.
    const stacked = bakeBuildingGeometry({ parts: [p, part({ width: 10, depth: 10, baseHeight: 6, floors: 10 })], smart });
    const pos = stacked.getAttribute('position');
    const wall = stacked.getAttribute('aWall');
    for (let i = 0; i < pos.count; i++) if (wall.getZ(i) === SURFACE.solar) expect(pos.getY(i)).toBeGreaterThan(36);
  });

  it('draws a drone pad with markings when enabled', () => {
    const g = bakeBuildingGeometry({ parts: [part({ width: 30, depth: 30 })], smart: { solarRoof: 0.4, greenRoof: 0.4, evChargers: 0, sensors: false, dronePort: true } });
    expect(area(g, SURFACE.pad)).toBeGreaterThan(20);
    expect(area(g, SURFACE.mark)).toBeGreaterThan(3);
  });

  it('bakes every smart-city preset without inverted faces', () => {
    for (const t of SMART_CITY_PRESETS) {
      const g = bakeBuildingGeometry(t);
      expect(g.getAttribute('position').count).toBeGreaterThan(0);
      expect(windingMatchesNormals(g)).toBe(true);
    }
  });
});

function partOutlineOf(p: BuildingPart) {
  const hw = p.width / 2;
  const hd = p.depth / 2;
  return [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd },
  ];
}

describe('BuildingLayer', () => {
  const meshes = (layer: BuildingLayer) => layer.group.children as THREE.InstancedMesh[];

  it('uses one instanced mesh per design and rebakes only changed designs', () => {
    const doc = createEmptyDoc();
    for (let i = 0; i < 20; i++) doc.buildings[`b${i}`] = { id: `b${i}`, typeId: i % 2 ? 'house' : 'school', pos: { x: i * 50, z: 0 }, rotation: 0 };
    const layer = new BuildingLayer();
    layer.update(doc);
    expect(layer.meshCount).toBe(2);
    const school = meshes(layer).find((m) => m.name === 'buildings-school')!;
    const house = meshes(layer).find((m) => m.name === 'buildings-house')!;
    expect(school.count).toBe(10);

    // Moving a building keeps the geometry; capacity grows ×2 past 16.
    doc.buildings.b0!.pos = { x: 5, z: 5 };
    for (let i = 20; i < 40; i++) doc.buildings[`b${i}`] = { id: `b${i}`, typeId: 'school', pos: { x: i * 50, z: 100 }, rotation: 1 };
    layer.update(doc);
    const school2 = meshes(layer).find((m) => m.name === 'buildings-school')!;
    expect(school2.count).toBe(30);
    expect(school2.geometry).toBe(school.geometry);
    expect(meshes(layer).find((m) => m.name === 'buildings-house')).toBe(house);

    // A new revision of one design rebakes that design only.
    const next: BuildingType = { ...cloneJson(doc.buildingTypes.school!), rev: (doc.buildingTypes.school!.rev ?? 0) + 1 };
    next.parts[0]!.floors = 6;
    doc.buildingTypes.school = next;
    layer.update(doc);
    expect(meshes(layer).find((m) => m.name === 'buildings-school')!.geometry).not.toBe(school.geometry);
    expect(meshes(layer).find((m) => m.name === 'buildings-house')!.geometry).toBe(house.geometry);

    // A resynced doc with equal content keeps the cache.
    const before = meshes(layer).find((m) => m.name === 'buildings-school')!.geometry;
    const resynced = cloneJson(doc);
    layer.update(resynced);
    expect(meshes(layer).find((m) => m.name === 'buildings-school')!.geometry).toBe(before);

    for (const id of Object.keys(resynced.buildings)) if (resynced.buildings[id]!.typeId === 'house') delete resynced.buildings[id];
    layer.update(resynced);
    expect(layer.meshCount).toBe(1);
  });
});
