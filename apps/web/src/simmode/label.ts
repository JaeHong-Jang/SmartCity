// Human-readable event labels and map positions (road type name + length, building design name).

import { cumulativeLengths, pointAtLength, sampleSegmentCurve, type CityDoc, type Vec2 } from '@smartcity/shared';
import type { RoadGraph } from '@smartcity/sim';

export interface Place {
  label: string;
  pos: Vec2;
}

const at = (p: Vec2): string => `(${Math.round(p.x)}, ${Math.round(p.z)})`;

function segmentInfo(doc: CityDoc, segmentId: string): { name: string; length: number; mid: Vec2 } | null {
  const seg = doc.segments[segmentId];
  const a = seg && doc.nodes[seg.a];
  const b = seg && doc.nodes[seg.b];
  if (!seg || !a || !b) return null;
  const curve = sampleSegmentCurve(a.pos, b.pos, seg.control);
  const cum = cumulativeLengths(curve);
  const length = cum[cum.length - 1]!;
  return { name: doc.roadTypes[seg.roadTypeId]?.name ?? '도로', length, mid: pointAtLength(curve, cum, length / 2) };
}

export function closurePlace(doc: CityDoc, segmentId: string): Place {
  const i = segmentInfo(doc, segmentId);
  return i ? { label: `${i.name} ${Math.round(i.length)}m 통제 ${at(i.mid)}`, pos: i.mid } : { label: `도로 통제 · ${segmentId}`, pos: { x: 0, z: 0 } };
}

export function accidentPlace(doc: CityDoc, graph: RoadGraph | null, segmentId: string, lane: number, s: number): Place {
  const i = segmentInfo(doc, segmentId);
  const laneIdx = graph?.segments.get(segmentId)?.lanes[lane];
  const l = laneIdx === undefined ? undefined : graph?.lanes[laneIdx];
  const pos = l ? pointAtLength(l.points, l.cum, Math.min(l.length, s + 4.5)) : (i?.mid ?? { x: 0, z: 0 });
  return { label: `${i?.name ?? '도로'} ${lane + 1}차선 사고 ${at(pos)}`, pos };
}

export function surgePlace(doc: CityDoc, buildingId: string, people: number): Place {
  const b = doc.buildings[buildingId];
  if (!b) return { label: `행사 ${people}명`, pos: { x: 0, z: 0 } };
  return { label: `${doc.buildingTypes[b.typeId]?.name ?? '건물'} 행사 ${people}명 ${at(b.pos)}`, pos: b.pos };
}
