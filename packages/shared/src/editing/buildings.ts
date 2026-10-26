import {
  add,
  bounds,
  boundsOverlap,
  intersectionArea,
  pointInPolygon,
  polygonArea,
  polygonsOverlap,
  rotateY,
  sampleSegmentCurve,
  segmentDistance,
  type Vec2,
} from '../geometry.js';
import type { Building, BuildingPart, BuildingType, CityDoc, RoadSegment, Zone } from '../model.js';
import { roadHalfWidth } from '../roads.js';

/**
 * Outline of a part before rounding: its stored footprint, or the offset/width/depth rectangle. The
 * studio and the footprint painter reopen designs from this (cells cover the rectangle, not the arcs).
 */
export function partBaseOutline(p: BuildingPart): Vec2[] {
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

/** Largest distance (m) between a rounded corner's arc and its chords (ADR 0012 §4). */
export const ROUND_TOLERANCE = 0.05;

/**
 * Chords per quarter arc, by radius: the first row whose radius bound covers r. Bounds are
 * ROUND_TOLERANCE / (1 − cos(π / 4n)) rounded down, so the sagitta never exceeds the tolerance.
 * The last row covers the largest possible radius (round ≤ min(width, depth)/2 ≤ 150 m).
 */
export const ARC_SEGMENTS: readonly (readonly [maxRadius: number, segments: number])[] = [
  [0.17, 1],
  [0.65, 2],
  [1.46, 3],
  [2.6, 4],
  [5.84, 6],
  [10.38, 8],
  [23.35, 12],
  [41.5, 16],
  [93.38, 24],
  [166.01, 32],
];

export const arcSegments = (r: number): number => (ARC_SEGMENTS.find(([max]) => r <= max) ?? ARC_SEGMENTS.at(-1)!)[1];

/**
 * cos/sin of x ∈ [0, π/4] from a fixed Taylor polynomial: only + − × ÷, so every JS engine gives the
 * same bits (Math.cos/sin may differ in the last bit between engines, and the server's checks and the
 * client's preview must agree on the outline).
 */
function cosSin(x: number): [number, number] {
  const x2 = x * x;
  let c = 1;
  let s = 1;
  let tc = 1;
  let ts = 1;
  for (let k = 1; k <= 10; k++) {
    tc = (-tc * x2) / ((2 * k - 1) * (2 * k));
    ts = (-ts * x2) / ((2 * k) * (2 * k + 1));
    c += tc;
    s += ts;
  }
  return [c, s * x];
}

const arcs = new Map<number, [number, number][]>();

/** (cos, sin) of k·π/(2n) for k = 0..n (memoized: n comes from the fixed table). */
function quarterArc(n: number): [number, number][] {
  const memo = arcs.get(n);
  if (memo) return memo;
  const out: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    // Mirror the upper half of the quarter so the polynomial only sees angles ≤ π/4.
    if (2 * k <= n) out.push(cosSin((Math.PI * k) / (2 * n)));
    else {
      const [c, s] = cosSin((Math.PI * (n - k)) / (2 * n));
      out.push([s, c]);
    }
  }
  arcs.set(n, out);
  return out;
}

/** Outline coordinates of rounded parts are snapped to 1 µm. */
const snap = (v: number): number => Math.round(v * 1e6) / 1e6;

/** A part's outline with, per edge i (outline[i] → outline[i+1]), the rounded corner it belongs to. */
export interface PartOutlineEdges {
  outline: Vec2[];
  /**
   * Corner index of each edge's arc (0 = +x −z, 1 = +x +z, 2 = −x +z, 3 = −x −z) or −1 for a
   * straight edge. Empty for parts without rounding (every edge straight).
   */
  arcCorner: number[];
}

/**
 * Outline of a part in the building frame (ADR 0012 §4), shared by collision, area, picking, ghosts,
 * meshes and the simulation. Without `round` (omitted or 0): the stored footprint or the rectangle,
 * unchanged. With `round` = r > 0 on a rectangle: the rounded rectangle, counter-clockwise in (x, z),
 * starting where the bottom edge (min z) leaves the min-x corner arc, each corner replaced by
 * `arcSegments(r)` chords inscribed in the arc, coordinates snapped to 1 µm, repeated points removed
 * (r = min(width, depth)/2 gives a circle for a square, a capsule otherwise). Areas use this polygon.
 */
export const partOutline = (p: BuildingPart): Vec2[] => partOutlineEdges(p).outline;

/** `partOutline` plus which edges are chords of a rounded corner (from the construction, not guessed). */
export function partOutlineEdges(p: BuildingPart): PartOutlineEdges {
  if (!p.round || p.round <= 0 || (p.footprint && p.footprint.length >= 3)) return { outline: partBaseOutline(p), arcCorner: [] };
  const r = Math.min(p.round, p.width / 2, p.depth / 2);
  const x0 = p.offset.x - p.width / 2;
  const x1 = p.offset.x + p.width / 2;
  const z0 = p.offset.z - p.depth / 2;
  const z1 = p.offset.z + p.depth / 2;
  const arc = quarterArc(arcSegments(r));
  // Each point with the edge that leaves it: an arc chord of its corner, or the straight side after the arc.
  const pts: { v: Vec2; edge: number }[] = [];
  // Corners in order (+x −z), (+x +z), (−x +z), (−x −z); each arc from its incoming edge to its outgoing one.
  const corners = [
    [x1 - r, z0 + r, (c: number, s: number) => [s, -c]],
    [x1 - r, z1 - r, (c: number, s: number) => [c, s]],
    [x0 + r, z1 - r, (c: number, s: number) => [-s, c]],
    [x0 + r, z0 + r, (c: number, s: number) => [-c, -s]],
  ] as const;
  corners.forEach(([cx, cz, map], corner) => {
    arc.forEach(([c, s], k) => {
      const [dx, dz] = map(c, s);
      pts.push({ v: { x: snap(cx + r * dx!), z: snap(cz + r * dz!) }, edge: k < arc.length - 1 ? corner : -1 });
    });
  });
  pts.unshift(pts.pop()!);
  // A repeated point means the edge between them has no length: the surviving point takes the later edge.
  const out: { v: Vec2; edge: number }[] = [];
  for (const q of pts) {
    const prev = out.at(-1);
    if (prev && prev.v.x === q.v.x && prev.v.z === q.v.z) prev.edge = q.edge;
    else out.push({ ...q });
  }
  while (out.length > 1 && out[0]!.v.x === out.at(-1)!.v.x && out[0]!.v.z === out.at(-1)!.v.z) out.pop();
  return { outline: out.map((q) => q.v), arcCorner: out.map((q) => q.edge) };
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
/** True if the building would overlap the footprint of any other building (ids other than its own). */
export function buildingOverlapsBuildings(doc: CityDoc, b: Pick<Building, 'id' | 'pos' | 'rotation'>, type: BuildingType): boolean {
  const polys = buildingFootprints(b, type);
  const box = bounds(polys.flat());
  for (const o of Object.values(doc.buildings)) {
    if (o.id === b.id) continue;
    const t = doc.buildingTypes[o.typeId];
    if (!t) continue;
    const other = buildingFootprints(o, t);
    if (!boundsOverlap(box, bounds(other.flat()), 0)) continue;
    if (polys.some((p) => other.some((q) => polygonsOverlap(p, q)))) return true;
  }
  return false;
}

export function buildingBlocksRoad(doc: CityDoc, b: Pick<Building, 'pos' | 'rotation'>, type: BuildingType): boolean {
  // Stacked volumes often repeat the same outline: test each distinct outline once.
  const seen = new Set<string>();
  const polys = buildingFootprints(b, type).filter((p) => {
    const k = JSON.stringify(p);
    return !seen.has(k) && (seen.add(k), true);
  });
  return polygonsBlockRoad(doc, polys);
}

/** True if any polygon overlaps the surface of the given roads (default: every road), sidewalks included. */
export function polygonsBlockRoad(doc: CityDoc, polys: readonly Vec2[][], segments: readonly RoadSegment[] = Object.values(doc.segments)): boolean {
  const box = bounds(polys.flat());
  for (const seg of segments) {
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
