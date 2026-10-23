import {
  add,
  bounds,
  boundsOverlap,
  intersectionArea,
  pointInPolygon,
  polygonArea,
  rotateY,
  sampleSegmentCurve,
  segmentDistance,
  type Vec2,
} from '../geometry.js';
import type { Building, BuildingPart, BuildingType, CityDoc, Zone } from '../model.js';
import { roadHalfWidth } from '../roads.js';

/** Outline of a part in the building frame: its stored footprint, or the offset/width/depth rectangle. */
export function partOutline(p: BuildingPart): Vec2[] {
  if (p.footprint && p.footprint.length >= 3) return p.footprint;
  const hw = p.width / 2;
  const hd = p.depth / 2;
  return [
    { x: p.offset.x - hw, z: p.offset.z - hd },
    { x: p.offset.x + hw, z: p.offset.z - hd },
    { x: p.offset.x + hw, z: p.offset.z + hd },
    { x: p.offset.x - hw, z: p.offset.z + hd },
  ];
}

/** World-space outline polygon of one building part. */
export function partFootprint(b: Pick<Building, 'pos' | 'rotation'>, p: BuildingPart): Vec2[] {
  return partOutline(p).map((v) => add(b.pos, rotateY(v, b.rotation)));
}

/** Plan area of one floor of a part, m². */
export const partArea = (p: BuildingPart): number => polygonArea(partOutline(p));

export function buildingFootprints(b: Pick<Building, 'pos' | 'rotation'>, type: BuildingType): Vec2[][] {
  return type.parts.map((p) => partFootprint(b, p));
}

/** Total gross floor area, used by the demand model to scale trips. */
export function floorArea(type: BuildingType): number {
  return type.parts.reduce((sum, p) => sum + partArea(p) * p.floors, 0);
}

export interface BuildingMetrics {
  /** 건축면적: plan area of the parts that stand on the ground, m². */
  footprintArea: number;
  /** 연면적, m². */
  grossFloorArea: number;
  /** Gross floor area per use (mixed-use buildings split here). */
  areaByUse: Record<Zone, number>;
  /** Top of the highest part, m. */
  height: number;
  /** Area of the topmost roofs (where nothing stands on them), approximated per part, m². */
  roofArea: number;
}

export function buildingMetrics(type: BuildingType): BuildingMetrics {
  const areaByUse: Record<Zone, number> = { residential: 0, commercial: 0, office: 0, industrial: 0, public: 0 };
  let footprintArea = 0;
  let grossFloorArea = 0;
  let height = 0;
  let roofArea = 0;
  for (const p of type.parts) {
    const a = partArea(p);
    const top = p.baseHeight + p.floors * p.floorHeight;
    grossFloorArea += a * p.floors;
    areaByUse[p.use ?? type.zone] += a * p.floors;
    if (p.baseHeight < 0.5) footprintArea += a;
    height = Math.max(height, top);
    // Exposed roof = plan area minus what volumes standing directly on it cover.
    let covered = 0;
    for (const q of type.parts) if (q !== p && Math.abs(q.baseHeight - top) < 0.5) covered += intersectionArea(partOutline(p), partOutline(q));
    roofArea += Math.max(0, a - covered);
  }
  return { footprintArea, grossFloorArea, areaByUse, height, roofArea };
}

/** Slack so a building placed flush against the sidewalk edge does not count as touching it. */
const ROAD_CLEARANCE_EPS = 0.05;

/**
 * True if any footprint overlaps a road surface (sidewalks included). Exact: segment-to-segment
 * distance between road centerlines and footprint edges, plus centerlines running inside a footprint.
 * The server runs the same test, so the client's red preview and acceptance always agree.
 */
export function buildingBlocksRoad(doc: CityDoc, b: Pick<Building, 'pos' | 'rotation'>, type: BuildingType): boolean {
  // Stacked volumes often repeat the same outline: test each distinct outline once.
  const seen = new Set<string>();
  const polys = buildingFootprints(b, type).filter((p) => {
    const k = JSON.stringify(p);
    return !seen.has(k) && (seen.add(k), true);
  });
  const box = bounds(polys.flat());
  for (const seg of Object.values(doc.segments)) {
    const rt = doc.roadTypes[seg.roadTypeId];
    const a = doc.nodes[seg.a];
    const z = doc.nodes[seg.b];
    if (!rt || !a || !z) continue;
    const hw = roadHalfWidth(rt) - ROAD_CLEARANCE_EPS;
    // A quadratic Bezier stays inside the hull of its control points: cheap rejection first.
    if (!boundsOverlap(box, bounds(seg.control ? [a.pos, z.pos, seg.control] : [a.pos, z.pos]), hw)) continue;
    const curve = sampleSegmentCurve(a.pos, z.pos, seg.control);
    // Long curves have loose hulls: reject piece by piece before the exact distance tests.
    for (let i = 1; i < curve.length; i++) {
      const p = curve[i - 1]!;
      const q = curve[i]!;
      const piece = { minX: Math.min(p.x, q.x), minZ: Math.min(p.z, q.z), maxX: Math.max(p.x, q.x), maxZ: Math.max(p.z, q.z) };
      if (!boundsOverlap(box, piece, hw)) continue;
      for (const poly of polys) {
        if (pointInPolygon(p, poly) || pointInPolygon(q, poly)) return true;
        for (let k = 0; k < poly.length; k++) {
          if (segmentDistance(p, q, poly[k]!, poly[(k + 1) % poly.length]!) < hw) return true;
        }
      }
    }
  }
  return false;
}
