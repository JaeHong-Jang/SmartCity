// Road geometry the renderer draws, taken from the sim's compileNetwork(doc). If the sim is not
// available (or throws), a local approximation with the same setback rules is used instead so the
// editor keeps working. Pure functions; no Three.js here.

import {
  angleBetween,
  cumulativeLengths,
  normalize,
  pointAtLength,
  rightNormal,
  roadHalfWidth,
  sampleSegmentCurve,
  scale,
  add,
  sub,
  tangentAtLength,
  type CityDoc,
  type RoadType,
  type Vec2,
} from '@smartcity/shared';
import { compileNetwork, type Crossing, type RoadGraph } from '@smartcity/sim';

export interface RoadSegGeom {
  id: string;
  roadType: RoadType;
  centerline: Vec2[];
  setbackA: number;
  setbackB: number;
  length: number;
  halfWidth: number;
  closed: boolean;
  a: string;
  b: string;
  /** Arc length from each end where the lanes (and stop lines) start: setback + crosswalk zone. */
  laneStartA: number;
  laneStartB: number;
  /** Arc lengths from node a of speed bumps. */
  speedBumps: number[];
  schoolZone: boolean;
  /** Crosswalks (junction and mid-block) on this segment. */
  crossings: Crossing[];
}

export interface RoadNodeGeom {
  id: string;
  pos: Vec2;
  segments: string[];
  polygon: Vec2[];
  signalized: boolean;
  /** Control kind and crosswalk legs from the doc, for change detection (a segment's markings depend on them). */
  control: string;
}

export interface RoadNetworkGeom {
  segments: Map<string, RoadSegGeom>;
  nodes: Map<string, RoadNodeGeom>;
  /** All crossings in RoadGraph.crossings order (snapshot.crossings is indexed the same way). */
  crossings: Crossing[];
  /** The real compiled graph (lanes, connectors) when the sim is available. */
  graph: RoadGraph | null;
}

/** Signature of a node's doc-side control settings. */
export function controlSig(doc: CityDoc, nodeId: string): string {
  const c = doc.intersections[nodeId];
  return c ? `${c.kind}:${c.crosswalkLegs ? c.crosswalkLegs.join(',') : '*'}` : 'auto';
}

/** Speed bump positions (arc length from node a) taken from the doc's road features. */
function docSpeedBumps(doc: CityDoc, segId: string, length: number): number[] {
  const out: number[] = [];
  for (const f of Object.values(doc.features ?? {})) if (f.segmentId === segId && f.kind === 'speedBump') out.push(f.t * length);
  return out.sort((x, y) => x - y);
}

let warned = false;

export function buildRoadNetwork(doc: CityDoc, compile: (doc: CityDoc) => RoadGraph = compileNetwork): RoadNetworkGeom {
  try {
    const graph = compile(doc);
    const segments = new Map<string, RoadSegGeom>();
    for (const [id, cs] of graph.segments) {
      const s = doc.segments[id];
      if (!s) continue;
      segments.set(id, {
        id,
        roadType: cs.roadType,
        centerline: cs.centerline,
        setbackA: cs.setbackA,
        setbackB: cs.setbackB,
        length: cs.length,
        halfWidth: cs.halfWidth,
        closed: cs.closed,
        a: s.a,
        b: s.b,
        laneStartA: cs.laneStartA,
        laneStartB: cs.laneStartB,
        speedBumps: cs.speedBumps,
        schoolZone: cs.schoolZone,
        crossings: [],
      });
    }
    const crossings = graph.crossings;
    for (const c of crossings) segments.get(c.segmentId)?.crossings.push(c);
    const nodes = new Map<string, RoadNodeGeom>();
    for (const [id, n] of graph.nodes) nodes.set(id, { id, pos: n.pos, segments: n.segments, polygon: n.polygon, signalized: n.signalized, control: controlSig(doc, id) });
    return { segments, nodes, crossings, graph };
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn('[roads] compileNetwork 사용 불가, 단순 도로 형상으로 대체합니다:', (e as Error).message);
    }
    return fallbackNetwork(doc);
  }
}

/** Setback of a node for the fallback geometry (same rule as packages/sim/AGENTS.md). */
export function nodeSetback(doc: CityDoc, nodeId: string, segIds: string[]): number {
  if (segIds.length <= 1) return 0;
  const types = segIds.map((id) => doc.roadTypes[doc.segments[id]!.roadTypeId]!);
  if (segIds.length === 2 && types[0]!.id === types[1]!.id) {
    const d0 = leaveDir(doc, segIds[0]!, nodeId);
    const d1 = leaveDir(doc, segIds[1]!, nodeId);
    // Straight continuation: leaving directions are (nearly) opposite.
    if (Math.abs(angleBetween(d0, scale(d1, -1))) < (20 * Math.PI) / 180) return 1;
  }
  return Math.max(...types.map(roadHalfWidth)) + 1;
}

function curveOf(doc: CityDoc, segId: string): Vec2[] {
  const s = doc.segments[segId]!;
  return sampleSegmentCurve(doc.nodes[s.a]!.pos, doc.nodes[s.b]!.pos, s.control);
}

/** Unit direction leaving `nodeId` along the segment. */
function leaveDir(doc: CityDoc, segId: string, nodeId: string): Vec2 {
  const pts = curveOf(doc, segId);
  const s = doc.segments[segId]!;
  return s.a === nodeId ? normalize(sub(pts[1]!, pts[0]!)) : normalize(sub(pts[pts.length - 2]!, pts[pts.length - 1]!));
}

export function fallbackNetwork(doc: CityDoc): RoadNetworkGeom {
  const atNode = new Map<string, string[]>();
  const segIds = Object.keys(doc.segments).sort();
  for (const id of segIds) {
    const s = doc.segments[id]!;
    for (const n of [s.a, s.b]) {
      let list = atNode.get(n);
      if (!list) atNode.set(n, (list = []));
      list.push(id);
    }
  }
  const setback = new Map<string, number>();
  for (const [n, list] of atNode) setback.set(n, nodeSetback(doc, n, list));

  const segments = new Map<string, RoadSegGeom>();
  for (const id of segIds) {
    const s = doc.segments[id]!;
    const rt = doc.roadTypes[s.roadTypeId]!;
    const centerline = curveOf(doc, id);
    const cum = cumulativeLengths(centerline);
    const length = cum[cum.length - 1]!;
    let sa = setback.get(s.a) ?? 0;
    let sb = setback.get(s.b) ?? 0;
    // Very short roads between big junctions: keep at least a sliver.
    if (sa + sb > length - 0.5) {
      const k = Math.max(0, length - 0.5) / Math.max(1e-6, sa + sb);
      sa *= k;
      sb *= k;
    }
    segments.set(id, {
      id,
      roadType: rt,
      centerline,
      setbackA: sa,
      setbackB: sb,
      length,
      halfWidth: roadHalfWidth(rt),
      closed: id in doc.closures,
      a: s.a,
      b: s.b,
      laneStartA: sa,
      laneStartB: sb,
      speedBumps: docSpeedBumps(doc, id, length),
      schoolZone: !!s.schoolZone,
      crossings: [],
    });
  }

  const nodes = new Map<string, RoadNodeGeom>();
  for (const nid of Object.keys(doc.nodes).sort()) {
    const node = doc.nodes[nid]!;
    const list = atNode.get(nid) ?? [];
    const corners: Vec2[] = [];
    if (list.length >= 2) {
      for (const sid of list) {
        const g = segments.get(sid)!;
        const fromA = g.a === nid;
        const cum = cumulativeLengths(g.centerline);
        const sAt = fromA ? g.setbackA : g.length - g.setbackB;
        const p = pointAtLength(g.centerline, cum, sAt);
        const t = tangentAtLength(g.centerline, cum, Math.min(Math.max(sAt, 0.01), g.length - 0.01));
        const n = rightNormal(t);
        corners.push(add(p, scale(n, g.halfWidth)), add(p, scale(n, -g.halfWidth)));
      }
    }
    const c = node.pos;
    const polygon = corners.length >= 3 ? sortAround(c, dedupe(corners)) : [];
    const custom = doc.intersections[nid];
    const signalized = custom ? custom.kind === 'signal' : list.length >= 3;
    nodes.set(nid, { id: nid, pos: node.pos, segments: list, polygon: polygon.length >= 3 ? polygon : [], signalized, control: controlSig(doc, nid) });
  }
  return { segments, nodes, crossings: [], graph: null };
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) if (!out.some((q) => Math.abs(q.x - p.x) < 0.01 && Math.abs(q.z - p.z) < 0.01)) out.push(p);
  return out;
}

function sortAround(c: Vec2, pts: Vec2[]): Vec2[] {
  return pts.sort((p, q) => Math.atan2(p.z - c.z, p.x - c.x) - Math.atan2(q.z - c.z, q.x - c.x));
}

/** Arc-length span of the drivable part of a segment (between the two junction areas). */
export function trimmedSpan(g: RoadSegGeom): [number, number] {
  return [g.setbackA, g.length - g.setbackB];
}
