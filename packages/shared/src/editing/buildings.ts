import { add, closestPointOnPolyline, rotateY, sampleSegmentCurve, type Vec2 } from '../geometry.js';
import type { Building, BuildingPart, BuildingType, CityDoc } from '../model.js';
import { roadHalfWidth } from '../roads.js';

/** World-space corner polygon of one building part. */
export function partFootprint(b: Pick<Building, 'pos' | 'rotation'>, p: BuildingPart): Vec2[] {
  const hw = p.width / 2;
  const hd = p.depth / 2;
  const local: Vec2[] = [
    { x: p.offset.x - hw, z: p.offset.z - hd },
    { x: p.offset.x + hw, z: p.offset.z - hd },
    { x: p.offset.x + hw, z: p.offset.z + hd },
    { x: p.offset.x - hw, z: p.offset.z + hd },
  ];
  return local.map((v) => add(b.pos, rotateY(v, b.rotation)));
}

export function buildingFootprints(b: Pick<Building, 'pos' | 'rotation'>, type: BuildingType): Vec2[][] {
  return type.parts.map((p) => partFootprint(b, p));
}

/** Total gross floor area, used by the demand model to scale trips. */
export function floorArea(type: BuildingType): number {
  return type.parts.reduce((sum, p) => sum + p.width * p.depth * p.floors, 0);
}

/** True if any footprint corner or edge midpoint lies on a road surface. */
export function buildingBlocksRoad(doc: CityDoc, b: Pick<Building, 'pos' | 'rotation'>, type: BuildingType): boolean {
  const probes: Vec2[] = [];
  for (const poly of buildingFootprints(b, type)) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      probes.push(p, { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 });
    }
  }
  probes.push(b.pos);
  for (const seg of Object.values(doc.segments)) {
    const rt = doc.roadTypes[seg.roadTypeId];
    if (!rt) continue;
    const curve = sampleSegmentCurve(doc.nodes[seg.a]!.pos, doc.nodes[seg.b]!.pos, seg.control);
    const hw = roadHalfWidth(rt);
    if (probes.some((p) => closestPointOnPolyline(curve, p).distance < hw)) return true;
  }
  return false;
}
