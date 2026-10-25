// "Recently applied by the AI" highlights (pure state): which buildings/lots an applied proposal
// created, where they are, and how long the pulse (6 s) and the beacon (until confirmed, 60 s) last.
// The renderer only reads this; the doc is never touched.

import { bounds, buildingFootprints, sampleSegmentCurve, type BuildingType, type CityDoc, type Command, type Vec2 } from '@smartcity/shared';

export const PULSE_MS = 6000;
export const BEACON_MS = 60_000;
export const MAX_HIGHLIGHTS = 5;

export interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface Highlight {
  id: number;
  /** Short Korean summary shown in the list. */
  label: string;
  buildingIds: string[];
  parcelIds: string[];
  /** Road segments the batch added (a beacon marks each). */
  roadSegmentIds: string[];
  /** Roads that glow: the added segments plus the pieces an existing road was split into. */
  segmentIds: string[];
  /** Area covered by the new things (null = nothing positional, e.g. only designs). */
  bbox: Box | null;
  createdAt: number;
  /** Start of the current pulse (reset by "보기"). */
  pulseFrom: number;
  /** The user pressed "확인": no beacon any more. */
  confirmed: boolean;
}

export interface HighlightState {
  items: Highlight[];
  nextId: number;
}

export const initialHighlights = (): HighlightState => ({ items: [], nextId: 1 });

/** New buildings and lots in a batch (nested batches flattened), in order. */
function leaves(cmd: Command, out: Command[] = []): Command[] {
  if (cmd.type === 'batch') for (const c of cmd.commands) leaves(c, out);
  else out.push(cmd);
  return out;
}

/** Bounding box of points and polygons; null when empty. */
export function boxOf(points: readonly Vec2[]): Box | null {
  if (points.length === 0) return null;
  const b = bounds(points);
  return { minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ };
}

/**
 * Highlight for an applied AI batch, or null when it created no building, lot or road. `designs` supplies
 * building footprints for the bbox (unknown designs count as a point).
 */
export function highlightFromBatch(batch: Command, designs: Record<string, BuildingType | undefined>, now: number, id: number, summary = '', doc?: CityDoc): Highlight | null {
  const buildingIds: string[] = [];
  const parcelIds: string[] = [];
  const roadSegmentIds: string[] = [];
  const segmentIds: string[] = [];
  const pts: Vec2[] = [];
  // Node positions for the road bbox: the doc (if the batch is already applied) plus nodes the batch adds.
  const nodePos = new Map<string, Vec2>(doc ? Object.values(doc.nodes).map((n) => [n.id, n.pos]) : []);
  const all = leaves(batch);
  for (const c of all) if (c.type === 'node.add') nodePos.set(c.node.id, c.node.pos);
  for (const c of all) {
    if (c.type === 'segment.add') {
      roadSegmentIds.push(c.segment.id);
      segmentIds.push(c.segment.id);
      const a = nodePos.get(c.segment.a);
      const b = nodePos.get(c.segment.b);
      if (a && b) pts.push(...sampleSegmentCurve(a, b, c.segment.control, 8));
    } else if (c.type === 'segment.split') {
      segmentIds.push(...c.segmentIds);
    }
  }
  for (const c of all) {
    if (c.type === 'building.place') {
      buildingIds.push(c.building.id);
      const t = designs[c.building.typeId];
      if (t) pts.push(...buildingFootprints(c.building, t).flat());
      else pts.push(c.building.pos);
    } else if (c.type === 'parcel.upsert') {
      parcelIds.push(c.parcel.id);
      pts.push(...c.parcel.polygon);
    }
  }
  if (buildingIds.length === 0 && parcelIds.length === 0 && roadSegmentIds.length === 0) return null;
  const parts = [buildingIds.length ? `건물 ${buildingIds.length}` : '', roadSegmentIds.length ? `도로 ${roadSegmentIds.length}` : '', parcelIds.length ? `필지 ${parcelIds.length}` : ''].filter(Boolean);
  return { id, label: summary.trim().slice(0, 60) || parts.join(' · '), buildingIds, parcelIds, roadSegmentIds, segmentIds, bbox: boxOf(pts), createdAt: now, pulseFrom: now, confirmed: false };
}

/** Add (newest last), keeping at most MAX_HIGHLIGHTS. */
export function addHighlight(s: HighlightState, h: Omit<Highlight, 'id'>): HighlightState {
  const item: Highlight = { ...h, id: s.nextId };
  return { items: [...s.items, item].slice(-MAX_HIGHLIGHTS), nextId: s.nextId + 1 };
}

const mapOne = (s: HighlightState, id: number, f: (h: Highlight) => Highlight): HighlightState =>
  s.items.some((h) => h.id === id) ? { ...s, items: s.items.map((h) => (h.id === id ? f(h) : h)) } : s;

/** "확인": the beacon goes away. */
export const confirmHighlight = (s: HighlightState, id: number): HighlightState => mapOne(s, id, (h) => (h.confirmed ? h : { ...h, confirmed: true }));

/** "보기": pulse again from `now`. */
export const replayHighlight = (s: HighlightState, id: number, now: number): HighlightState => mapOne(s, id, (h) => ({ ...h, pulseFrom: now }));

export const isPulsing = (h: Highlight, now: number): boolean => now - h.pulseFrom < PULSE_MS;
export const hasBeacon = (h: Highlight, now: number): boolean => !h.confirmed && now - h.createdAt < BEACON_MS;
export const isActive = (h: Highlight, now: number): boolean => isPulsing(h, now) || hasBeacon(h, now);

/** Highlights that still need drawing at `now`. Empty = the renderer does nothing. */
export const activeHighlights = (s: HighlightState, now: number): Highlight[] => s.items.filter((h) => isActive(h, now));

/** Earliest time after `now` at which some highlight changes phase (pulse or beacon ends); Infinity = never. */
export function nextTransition(s: HighlightState, now: number): number {
  let t = Infinity;
  for (const h of s.items) {
    const pulseEnd = h.pulseFrom + PULSE_MS;
    if (pulseEnd > now && pulseEnd < t) t = pulseEnd;
    const beaconEnd = h.createdAt + BEACON_MS;
    if (!h.confirmed && beaconEnd > now && beaconEnd < t) t = beaconEnd;
  }
  return t;
}

/** Ids that still exist in the doc (deleted ones are skipped silently). */
export function liveTargets(h: Highlight, doc: CityDoc): { buildingIds: string[]; parcelIds: string[]; roadSegmentIds: string[]; segmentIds: string[] } {
  return {
    buildingIds: h.buildingIds.filter((id) => id in doc.buildings),
    parcelIds: h.parcelIds.filter((id) => id in (doc.parcels ?? {})),
    roadSegmentIds: h.roadSegmentIds.filter((id) => id in doc.segments),
    segmentIds: h.segmentIds.filter((id) => id in doc.segments),
  };
}

/** Box around the things of `h` that still exist (falls back to the stored bbox when the doc has none). */
export function liveBox(h: Highlight, doc: CityDoc): Box | null {
  const { buildingIds, parcelIds, segmentIds } = liveTargets(h, doc);
  const pts: Vec2[] = [];
  for (const id of buildingIds) {
    const b = doc.buildings[id]!;
    const t = doc.buildingTypes[b.typeId];
    if (t) pts.push(...buildingFootprints(b, t).flat());
    else pts.push(b.pos);
  }
  for (const id of parcelIds) pts.push(...doc.parcels[id]!.polygon);
  for (const id of segmentIds) {
    const sg = doc.segments[id]!;
    pts.push(...sampleSegmentCurve(doc.nodes[sg.a]!.pos, doc.nodes[sg.b]!.pos, sg.control, 8));
  }
  return boxOf(pts);
}

/** Camera distance that frames a box of this size (meters). */
export function fitDistance(box: Box): number {
  const span = Math.max(box.maxX - box.minX, box.maxZ - box.minZ);
  return Math.min(700, Math.max(70, span * 1.8));
}
