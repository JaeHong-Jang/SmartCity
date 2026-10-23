// Zoning: lays out lots (Parcel with auto + frontage) along a road side (ADR 0009 §4). Pure and
// deterministic; the zoning tool computes the lots and submits them as one parcel.upsert batch.

import type { Command } from '../commands.js';
import {
  angleBetween,
  bounds,
  boundsOverlap,
  cumulativeLengths,
  dist,
  normalize,
  pointAtLength,
  polygonsOverlap,
  rightNormal,
  sampleSegmentCurve,
  scale,
  sub,
  add,
  tangentAtLength,
  type Bounds,
  type Vec2,
} from '../geometry.js';
import { segmentsAtNode } from '../apply/validate.js';
import type { CityDoc, Parcel, RoadSegment, Zone } from '../model.js';
import { DEFAULT_REGULATIONS } from '../planning.js';
import { roadHalfWidth } from '../roads.js';
import { buildingFootprints, polygonsBlockRoad } from './buildings.js';

/** Zoning grid cell, m. */
export const ZONING_CELL = 8;
/** Pedestrian crossing zone kept free next to a junction with crosswalks (matches the sim compiler). */
const CROSSWALK_ZONE = 4;
/** Two roads of one type that continue within this angle meet without a junction setback (sim: CONTINUE_ANGLE). */
const CONTINUE_ANGLE = (20 * Math.PI) / 180;
/** A lot corner may be this far (m) from the true offset curve on curved roads. */
const CURVE_TOLERANCE = 1;

/** Direction pointing away from `nodeId` along the segment. */
function outwardDir(pts: readonly Vec2[], atA: boolean): Vec2 {
  return atA ? normalize(sub(pts[1]!, pts[0]!)) : normalize(sub(pts[pts.length - 2]!, pts[pts.length - 1]!));
}

/** Arc length at one end that lots must not use: junction setback plus crosswalk zone. */
function endClearance(doc: CityDoc, seg: RoadSegment, atA: boolean): number {
  const nodeId = atA ? seg.a : seg.b;
  const here = segmentsAtNode(doc, nodeId);
  if (here.length <= 1) return 0;
  const rt = doc.roadTypes[seg.roadTypeId]!;
  if (here.length === 2) {
    const other = here.find((s) => s.id !== seg.id)!;
    if (other.roadTypeId === seg.roadTypeId && doc.nodes[other.a] && doc.nodes[other.b]) {
      const mine = sampleSegmentCurve(doc.nodes[seg.a]!.pos, doc.nodes[seg.b]!.pos, seg.control);
      const theirs = sampleSegmentCurve(doc.nodes[other.a]!.pos, doc.nodes[other.b]!.pos, other.control);
      const d1 = outwardDir(mine, atA);
      const d2 = outwardDir(theirs, other.a === nodeId);
      if (Math.abs(angleBetween(scale(d1, -1), d2)) < CONTINUE_ANGLE) return 1;
    }
  }
  let hw = roadHalfWidth(rt);
  for (const s of here) {
    const t = doc.roadTypes[s.roadTypeId];
    if (t) hw = Math.max(hw, roadHalfWidth(t));
  }
  // Conservative: a crosswalk zone wherever the junction could have one (3+ legs and a sidewalk).
  return hw + 1 + (here.length >= 3 && rt.sidewalk ? CROSSWALK_ZONE : 0);
}

/** Lot widths in cells (2 = 16 m, 3 = 24 m) that exactly use `cells` cells, preferring 24 m. */
function lotWidths(cells: number): number[] {
  const out: number[] = [];
  let triples = Math.floor(cells / 3);
  const rest = cells % 3;
  if (rest === 1) {
    if (triples === 0) return [];
    triples--;
  }
  for (let i = 0; i < triples; i++) out.push(3);
  if (rest === 2) out.push(2);
  if (rest === 1) out.push(2, 2);
  return out;
}

/**
 * Lots along one side of a segment between arc fractions t0 and t1 (clipped by the junction setbacks).
 * Lots are 16 or 24 m wide and `depthCells` × 8 m deep; vertex order is front edge first (a→b order),
 * then the back edge. Lots that would overlap a road, a parcel or a building, or leave the map, are
 * omitted; indices in the ids still count the omitted positions, so ids are stable.
 */
export function lotsAlongSegment(
  doc: CityDoc,
  segmentId: string,
  side: 'left' | 'right',
  t0: number,
  t1: number,
  depthCells: 1 | 2 | 3 | 4,
  zone: Zone,
  idPrefix: string,
): Parcel[] {
  const seg = doc.segments[segmentId];
  const rt = seg && doc.roadTypes[seg.roadTypeId];
  const na = seg && doc.nodes[seg.a];
  const nb = seg && doc.nodes[seg.b];
  if (!seg || !rt || !na || !nb) return [];
  const pts = sampleSegmentCurve(na.pos, nb.pos, seg.control);
  const cum = cumulativeLengths(pts);
  const total = cum[cum.length - 1]!;
  const lo = Math.min(Math.max(Math.min(t0, t1), 0), 1) * total;
  const hi = Math.min(Math.max(Math.max(t0, t1), 0), 1) * total;
  const start = Math.max(lo, endClearance(doc, seg, true));
  const end = Math.min(hi, total - endClearance(doc, seg, false));
  if (end - start < 2 * ZONING_CELL) return [];

  const widths = lotWidths(Math.floor((end - start) / ZONING_CELL + 1e-9));
  const sign = side === 'right' ? 1 : -1;
  const front = roadHalfWidth(rt);
  const depth = depthCells * ZONING_CELL;
  const regulation = DEFAULT_REGULATIONS[zone];
  const half = doc.meta.halfSize;

  // Obstacles, with bounds computed once per call (a road side can yield hundreds of lots).
  const others = Object.values(doc.parcels).map((p) => ({ box: bounds(p.polygon), polys: [p.polygon] }));
  const buildings = Object.values(doc.buildings).flatMap((b) => {
    const type = doc.buildingTypes[b.typeId];
    if (!type) return [];
    const polys = buildingFootprints(b, type);
    return [{ box: bounds(polys.flat()), polys }];
  });
  const clash = (box: Bounds, poly: Vec2[], list: { box: Bounds; polys: Vec2[][] }[]): boolean =>
    list.some((o) => boundsOverlap(box, o.box, 1e-6) && o.polys.some((q) => polygonsOverlap(q, poly)));

  const lots: Parcel[] = [];
  let s = start;
  widths.forEach((cells, index) => {
    const s0 = s;
    const s1 = s + cells * ZONING_CELL;
    s = s1;
    const p0 = pointAtLength(pts, cum, s0);
    const p1 = pointAtLength(pts, cum, s1);
    if (dist(p0, p1) < 1e-6) return;
    const n = scale(rightNormal(normalize(sub(p1, p0))), sign);
    const f0 = add(p0, scale(n, front));
    const f1 = add(p1, scale(n, front));
    for (const [sAt, corner] of [[s0, f0], [s1, f1]] as const) {
      const ideal = add(pointAtLength(pts, cum, sAt), scale(scale(rightNormal(tangentAtLength(pts, cum, sAt)), sign), front));
      if (dist(ideal, corner) > CURVE_TOLERANCE) return;
    }
    const poly = [f0, f1, add(f1, scale(n, depth)), add(f0, scale(n, depth))];
    if (poly.some((v) => Math.abs(v.x) > half || Math.abs(v.z) > half)) return;
    const box = bounds(poly);
    if (clash(box, poly, others) || clash(box, poly, buildings) || polygonsBlockRoad(doc, [poly])) return;
    lots.push({
      id: `${idPrefix}-${index}`,
      polygon: poly,
      zone,
      regulation: { ...regulation },
      auto: true,
      frontage: { segmentId, side },
    });
  });
  return lots;
}

/** One batch of parcel.upsert (an empty batch for no lots). A batch holds at most LIMITS.batchSize commands. */
export function lotsToCommand(lots: Parcel[]): Command {
  return { type: 'batch', commands: lots.map((parcel) => ({ type: 'parcel.upsert' as const, parcel, ifAbsent: true as const })) };
}
