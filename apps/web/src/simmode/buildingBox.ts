// Axis-aligned footprint box and height of a building, for overlays drawn over it.

import { buildingFootprints, type CityDoc } from '@smartcity/shared';

export interface BuildingBox {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export function buildingBox(doc: CityDoc, id: string): BuildingBox | null {
  const b = doc.buildings[id];
  const t = b && doc.buildingTypes[b.typeId];
  if (!b || !t) return null;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const poly of buildingFootprints(b, t)) {
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const h = Math.max(6, ...t.parts.map((p) => p.baseHeight + p.floors * p.floorHeight));
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ, h };
}
