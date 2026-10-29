// Document-space picking: nearest node / segment / building / bus stop / parcel / sensor around a ground point,
// accelerated by a uniform spatial hash. Rebuild the index when the doc changes.

import {
  buildingFootprints,
  closestPointOnPolyline,
  cumulativeLengths,
  dist,
  pointAtLength,
  pointInPolygon,
  roadHalfWidth,
  sampleSegmentCurve,
  sensorPose,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';

const CELL = 64;

export interface SegmentHit {
  id: string;
  point: Vec2;
  /** Arc length along the segment from node a. */
  s: number;
  length: number;
  distance: number;
  curve: Vec2[];
}

type Kind = 'n' | 's' | 'b' | 'p' | 'q' | 'c';

export class PickIndex {
  private cells = new Map<string, Set<string>>();
  private curves = new Map<string, Vec2[]>();
  private stopPos = new Map<string, Vec2>();
  private footprints = new Map<string, Vec2[][]>();
  private sensorPos = new Map<string, Vec2>();

  constructor(private readonly doc: CityDoc) {
    for (const n of Object.values(doc.nodes)) this.insert('n', n.id, n.pos, n.pos);
    for (const s of Object.values(doc.segments)) {
      const a = doc.nodes[s.a];
      const b = doc.nodes[s.b];
      if (!a || !b) continue;
      const c = sampleSegmentCurve(a.pos, b.pos, s.control);
      this.curves.set(s.id, c);
      const rt = doc.roadTypes[s.roadTypeId];
      const pad = rt ? roadHalfWidth(rt) : 6;
      const { min, max } = bounds(c, pad);
      this.insert('s', s.id, min, max);
    }
    for (const b of Object.values(doc.buildings)) {
      const t = doc.buildingTypes[b.typeId];
      if (!t) continue;
      const fps = buildingFootprints(b, t);
      this.footprints.set(b.id, fps);
      const { min, max } = bounds(fps.flat(), 0);
      this.insert('b', b.id, min, max);
    }
    for (const st of Object.values(doc.busStops)) {
      const c = this.curves.get(st.segmentId);
      if (!c) continue;
      const cum = cumulativeLengths(c);
      const p = pointAtLength(c, cum, st.t * cum[cum.length - 1]!);
      this.stopPos.set(st.id, p);
      this.insert('p', st.id, p, p);
    }
    for (const pc of Object.values(doc.parcels)) {
      const { min, max } = bounds(pc.polygon, 0);
      this.insert('q', pc.id, min, max);
    }
    for (const sn of Object.values(doc.sensors ?? {})) {
      const pose = sensorPose(doc, sn);
      if (!pose) continue;
      this.sensorPos.set(sn.id, pose.pos);
      this.insert('c', sn.id, pose.pos, pose.pos);
    }
  }

  private insert(kind: Kind, id: string, min: Vec2, max: Vec2): void {
    const x0 = Math.floor(min.x / CELL), x1 = Math.floor(max.x / CELL);
    const z0 = Math.floor(min.z / CELL), z1 = Math.floor(max.z / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`;
        let set = this.cells.get(k);
        if (!set) this.cells.set(k, (set = new Set()));
        set.add(kind + id);
      }
    }
  }

  private near(kind: Kind, p: Vec2, r: number): string[] {
    const out = new Set<string>();
    const x0 = Math.floor((p.x - r) / CELL), x1 = Math.floor((p.x + r) / CELL);
    const z0 = Math.floor((p.z - r) / CELL), z1 = Math.floor((p.z + r) / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const set = this.cells.get(`${x},${z}`);
        if (!set) continue;
        for (const k of set) if (k[0] === kind) out.add(k.slice(1));
      }
    }
    return [...out];
  }

  nearestNode(p: Vec2, r: number): { id: string; distance: number } | null {
    let best: { id: string; distance: number } | null = null;
    for (const id of this.near('n', p, r)) {
      const d = dist(this.doc.nodes[id]!.pos, p);
      if (d <= r && (!best || d < best.distance)) best = { id, distance: d };
    }
    return best;
  }

  /** Nearest segment whose centerline is within `r` meters (r defaults to the road's half width). */
  nearestSegment(p: Vec2, r?: number): SegmentHit | null {
    let best: SegmentHit | null = null;
    for (const id of this.near('s', p, r ?? 25)) {
      const c = this.curves.get(id)!;
      const s = this.doc.segments[id]!;
      const rt = this.doc.roadTypes[s.roadTypeId];
      const limit = r ?? (rt ? roadHalfWidth(rt) : 6);
      const hit = closestPointOnPolyline(c, p);
      if (hit.distance <= limit && (!best || hit.distance < best.distance)) {
        best = { id, point: hit.point, s: hit.s, length: cumulativeLengths(c)[c.length - 1]!, distance: hit.distance, curve: c };
      }
    }
    return best;
  }

  buildingAt(p: Vec2): string | null {
    for (const id of this.near('b', p, 0)) {
      for (const poly of this.footprints.get(id)!) if (pointInPolygon(p, poly)) return id;
    }
    return null;
  }

  nearestStop(p: Vec2, r: number): { id: string; distance: number; pos: Vec2 } | null {
    let best: { id: string; distance: number; pos: Vec2 } | null = null;
    for (const id of this.near('p', p, r)) {
      const q = this.stopPos.get(id)!;
      const d = dist(q, p);
      if (d <= r && (!best || d < best.distance)) best = { id, distance: d, pos: q };
    }
    return best;
  }

  /** Parcel containing p (parcels never overlap). */
  parcelAt(p: Vec2): string | null {
    for (const id of this.near('q', p, 0).sort()) if (pointInPolygon(p, this.doc.parcels[id]!.polygon)) return id;
    return null;
  }

  /** Nearest corner of any parcel within r meters. */
  nearestParcelVertex(p: Vec2, r: number): { id: string; index: number; distance: number } | null {
    let best: { id: string; index: number; distance: number } | null = null;
    for (const id of this.near('q', p, r)) {
      this.doc.parcels[id]!.polygon.forEach((v, index) => {
        const d = dist(v, p);
        if (d <= r && (!best || d < best.distance)) best = { id, index, distance: d };
      });
    }
    return best;
  }

  nearestSensor(p: Vec2, r: number): { id: string; distance: number; pos: Vec2 } | null {
    let best: { id: string; distance: number; pos: Vec2 } | null = null;
    for (const id of this.near('c', p, r)) {
      const q = this.sensorPos.get(id)!;
      const d = dist(q, p);
      if (d <= r && (!best || d < best.distance || (d === best.distance && id < best.id))) best = { id, distance: d, pos: q };
    }
    return best;
  }

  sensorPosition(sensorId: string): Vec2 | undefined {
    return this.sensorPos.get(sensorId);
  }

  stopPosition(stopId: string): Vec2 | undefined {
    return this.stopPos.get(stopId);
  }

  curveOf(segId: string): Vec2[] | undefined {
    return this.curves.get(segId);
  }
}

function bounds(pts: readonly Vec2[], pad: number): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { min: { x: minX - pad, z: minZ - pad }, max: { x: maxX + pad, z: maxZ + pad } };
}

/** Cached index per doc version. */
export class Picker {
  private index: PickIndex | null = null;
  private version = -1;

  get(doc: CityDoc, version: number): PickIndex {
    if (!this.index || version !== this.version) {
      this.index = new PickIndex(doc);
      this.version = version;
    }
    return this.index;
  }
}

export type PickResult =
  | { kind: 'node'; id: string }
  | { kind: 'segment'; id: string }
  | { kind: 'building'; id: string }
  | { kind: 'busStop'; id: string }
  | { kind: 'parcel'; id: string }
  | { kind: 'sensor'; id: string };

/** Pick radius of a sensor pole, meters (it stands on the sidewalk, next to stops and roads). */
export const SENSOR_PICK_RADIUS = 3;

/** Priority: sensor > bus stop > node > building > segment > parcel (parcels only when asked for). */
export function pickAt(
  idx: PickIndex,
  p: Vec2,
  opts: { nodes?: boolean; stops?: boolean; buildings?: boolean; segments?: boolean; parcels?: boolean; sensors?: boolean } = {},
): PickResult | null {
  const { nodes = true, stops = true, buildings = true, segments = true, parcels = false, sensors = true } = opts;
  if (sensors) {
    const sn = idx.nearestSensor(p, SENSOR_PICK_RADIUS);
    if (sn) return { kind: 'sensor', id: sn.id };
  }
  if (stops) {
    const st = idx.nearestStop(p, 4);
    if (st) return { kind: 'busStop', id: st.id };
  }
  if (nodes) {
    const n = idx.nearestNode(p, 6);
    if (n) return { kind: 'node', id: n.id };
  }
  if (buildings) {
    const b = idx.buildingAt(p);
    if (b) return { kind: 'building', id: b };
  }
  if (segments) {
    const s = idx.nearestSegment(p);
    if (s) return { kind: 'segment', id: s.id };
  }
  if (parcels) {
    const q = idx.parcelAt(p);
    if (q) return { kind: 'parcel', id: q };
  }
  return null;
}
