// compileNetwork: CityDoc nodes/segments → lanes, connectors, conflict table, junction polygons and
// street features (crosswalks, speed bumps, school zones; ADR 0008 §3).
// Pure and deterministic (segments and nodes are visited in sorted-id order). Renderers use it too.

import {
  add,
  angleBetween,
  carriagewayWidth,
  cubicBezier,
  cumulativeLengths,
  dist,
  laneOffset,
  normalize,
  offsetPolyline,
  pointAtLength,
  rightNormal,
  roadHalfWidth,
  sampleSegmentCurve,
  scale,
  slicePolyline,
  sub,
  tangentAtLength,
  type CityDoc,
  type NodeId,
  type RoadSegment,
  type RoadType,
  type TravelDir,
  type Vec2,
} from '@smartcity/shared';
import { SCHOOL_ZONE_SPEED, type CompiledNode, type CompiledSegment, type Connector, type Crossing, type Lane, type RoadGraph, type Turn } from '../types.js';

const DEG = Math.PI / 180;
const STRAIGHT_ANGLE = 35 * DEG;
const CONTINUE_ANGLE = 20 * DEG;
export const CONFLICT_DISTANCE = 2.5;
const MIN_LANE_LENGTH = 2;
const MIN_CONNECTOR_SPEED = 2;
/** Extra lane trim at a junction end with a crosswalk: the crossing zone in front of the stop line. */
export const CROSSWALK_ZONE = 4;
/** Zebra width along the road. */
export const ZEBRA_WIDTH = 3;

interface SegInfo {
  seg: RoadSegment;
  rt: RoadType;
  pts: Vec2[];
  cum: number[];
  length: number;
  setbackA: number;
  setbackB: number;
  /** Junction crosswalk at end a / b. */
  cwA: boolean;
  cwB: boolean;
  laneStartA: number;
  laneStartB: number;
  fwd: number[];
  bwd: number[];
}

/** One end of a segment at a node. `out` is the unit tangent pointing away from the node. */
interface End {
  info: SegInfo;
  atA: boolean;
  out: Vec2;
}

export function compileNetwork(doc: CityDoc): RoadGraph {
  const infos: SegInfo[] = [];
  const ends = new Map<NodeId, End[]>();
  const pushEnd = (id: NodeId, e: End): void => {
    const list = ends.get(id);
    if (list) list.push(e);
    else ends.set(id, [e]);
  };

  for (const id of Object.keys(doc.segments).sort()) {
    const seg = doc.segments[id]!;
    const rt = doc.roadTypes[seg.roadTypeId];
    const a = doc.nodes[seg.a];
    const b = doc.nodes[seg.b];
    if (!rt || !a || !b) continue;
    const pts = sampleSegmentCurve(a.pos, b.pos, seg.control);
    const cum = cumulativeLengths(pts);
    const length = cum[cum.length - 1]!;
    if (length < 1e-6) continue;
    const info: SegInfo = { seg, rt, pts, cum, length, setbackA: 0, setbackB: 0, cwA: false, cwB: false, laneStartA: 0, laneStartB: 0, fwd: [], bwd: [] };
    infos.push(info);
    pushEnd(seg.a, { info, atA: true, out: normalize(sub(pts[1]!, pts[0]!)) });
    pushEnd(seg.b, { info, atA: false, out: normalize(sub(pts[pts.length - 2]!, pts[pts.length - 1]!)) });
  }

  // Setbacks: the junction area is cut away from every segment end. Junctions of degree ≥ 3 get a
  // crosswalk on every leg with sidewalks that `crosswalkLegs` lists (omitted = all).
  for (const [nodeId, list] of ends) {
    const legs = doc.intersections[nodeId]?.crosswalkLegs;
    for (const e of list) {
      const cw = list.length >= 3 && e.info.rt.sidewalk && (!legs || legs.includes(e.info.seg.id));
      if (e.atA) e.info.cwA = cw;
      else e.info.cwB = cw;
    }
    let sb: number;
    if (list.length === 1) sb = 0;
    else if (
      list.length === 2 &&
      list[0]!.info.rt.id === list[1]!.info.rt.id &&
      Math.abs(angleBetween(scale(list[0]!.out, -1), list[1]!.out)) < CONTINUE_ANGLE
    )
      sb = 1;
    else sb = Math.max(...list.map((e) => roadHalfWidth(e.info.rt))) + 1;
    for (const e of list) {
      if (e.atA) e.info.setbackA = sb;
      else e.info.setbackB = sb;
    }
  }

  const lanes: Lane[] = [];
  const laneById = new Map<string, number>();
  const segments = new Map<string, CompiledSegment>();
  for (const info of infos) {
    const maxTotal = Math.max(0, info.length - MIN_LANE_LENGTH);
    const total = info.setbackA + info.setbackB;
    if (total > maxTotal) {
      const k = maxTotal / total;
      info.setbackA *= k;
      info.setbackB *= k;
    }
    // Lanes stop short of the crossing zone; a lane that would get too short drops its crosswalks.
    info.laneStartA = info.setbackA + (info.cwA ? CROSSWALK_ZONE : 0);
    info.laneStartB = info.setbackB + (info.cwB ? CROSSWALK_ZONE : 0);
    if (info.length - info.laneStartA - info.laneStartB < MIN_LANE_LENGTH) {
      info.cwA = info.cwB = false;
      info.laneStartA = info.setbackA;
      info.laneStartB = info.setbackB;
    }
    const trim = slicePolyline(info.pts, info.laneStartA, info.length - info.laneStartB);
    const { rt, seg } = info;
    const speedLimit = seg.schoolZone ? Math.min(rt.speedLimit, SCHOOL_ZONE_SPEED) : rt.speedLimit;
    const addLane = (dir: TravelDir, i: number, n: number, points: Vec2[]): number => {
      const cum = cumulativeLengths(points);
      const lane: Lane = {
        index: lanes.length,
        id: `${seg.id}|${dir === 'forward' ? 'f' : 'b'}|${i}`,
        segmentId: seg.id,
        dir,
        laneIndex: i,
        fromNode: dir === 'forward' ? seg.a : seg.b,
        toNode: dir === 'forward' ? seg.b : seg.a,
        points,
        cum,
        length: Math.max(cum[cum.length - 1]!, 0.1),
        speedLimit,
        busOnly: rt.busOnlyRightLane && n > 1 && i === n - 1,
        out: [],
      };
      lanes.push(lane);
      laneById.set(lane.id, lane.index);
      return lane.index;
    };
    for (let i = 0; i < rt.lanesForward; i++)
      info.fwd.push(addLane('forward', i, rt.lanesForward, offsetPolyline(trim, laneOffset(rt, 'forward', i))));
    for (let i = 0; i < rt.lanesBackward; i++)
      info.bwd.push(addLane('backward', i, rt.lanesBackward, offsetPolyline(trim, laneOffset(rt, 'backward', i)).reverse()));
    segments.set(seg.id, {
      id: seg.id,
      roadType: { ...rt },
      centerline: info.pts,
      setbackA: info.setbackA,
      setbackB: info.setbackB,
      length: info.length,
      halfWidth: roadHalfWidth(rt),
      closed: Object.prototype.hasOwnProperty.call(doc.closures, seg.id),
      lanes: [...info.fwd, ...info.bwd],
      laneStartA: info.laneStartA,
      laneStartB: info.laneStartB,
      speedBumps: [],
      schoolZone: seg.schoolZone === true,
    });
  }

  const connectors: Connector[] = [];
  const nodes = new Map<NodeId, CompiledNode>();
  for (const nodeId of Object.keys(doc.nodes).sort()) {
    const node = doc.nodes[nodeId]!;
    const list = ends.get(nodeId) ?? [];
    const first = connectors.length;
    buildConnectors(nodeId, list, lanes, connectors);
    buildConflicts(connectors, first);
    const ctrl = doc.intersections[nodeId];
    nodes.set(nodeId, {
      id: nodeId,
      pos: { x: node.pos.x, z: node.pos.z },
      segments: list.map((e) => e.info.seg.id),
      polygon: list.length >= 2 ? junctionPolygon(node.pos, list) : [],
      signalized: ctrl ? ctrl.kind === 'signal' : list.length >= 3,
    });
  }

  const crossings = buildFeatures(doc, infos, segments, nodes);
  return { lanes, connectors, segments, nodes, laneById, crossings };
}

/** Junction crosswalks, mid-block crosswalks and speed bumps. Crossings are sorted by id. */
function buildFeatures(doc: CityDoc, infos: SegInfo[], segments: Map<string, CompiledSegment>, nodes: Map<NodeId, CompiledNode>): Crossing[] {
  const crossings: Crossing[] = [];
  const byId = new Map(infos.map((i) => [i.seg.id, i]));
  const make = (info: SegInfo, id: string, kind: Crossing['kind'], s: number, signal: boolean, nodeId?: NodeId): void => {
    const c = pointAtLength(info.pts, info.cum, s);
    const t = tangentAtLength(info.pts, info.cum, Math.max(1e-6, Math.min(info.length, s)));
    const n = rightNormal(t);
    const hw = carriagewayWidth(info.rt) / 2;
    const a = add(c, scale(n, hw));
    const b = add(c, scale(n, -hw));
    const h = scale(t, ZEBRA_WIDTH / 2);
    const cr: Crossing = {
      index: 0,
      id,
      kind,
      segmentId: info.seg.id,
      s,
      a,
      b,
      width: ZEBRA_WIDTH,
      polygon: [sub(a, h), add(a, h), add(b, h), sub(b, h)],
      signal,
      schoolZone: info.seg.schoolZone === true,
    };
    if (nodeId !== undefined) cr.nodeId = nodeId;
    crossings.push(cr);
  };
  for (const info of infos) {
    const { seg } = info;
    if (info.cwA) make(info, `${seg.a}|${seg.id}`, 'junction', info.setbackA + CROSSWALK_ZONE / 2, nodes.get(seg.a)!.signalized, seg.a);
    if (info.cwB) make(info, `${seg.b}|${seg.id}`, 'junction', info.length - info.setbackB - CROSSWALK_ZONE / 2, nodes.get(seg.b)!.signalized, seg.b);
  }
  for (const id of Object.keys(doc.features ?? {}).sort()) {
    const f = doc.features[id]!;
    const info = byId.get(f.segmentId);
    if (!info) continue;
    const s = f.t * info.length;
    if (f.kind === 'speedBump') {
      segments.get(f.segmentId)!.speedBumps.push(s);
      continue;
    }
    // A mid-block crosswalk needs sidewalks and its whole zone on the lanes, clear of the junction zones.
    if (!info.rt.sidewalk || s < info.laneStartA + CROSSWALK_ZONE || info.length - s < info.laneStartB + CROSSWALK_ZONE) continue;
    make(info, f.id, 'midblock', s, f.signal === true);
  }
  for (const cs of segments.values()) cs.speedBumps.sort((p, q) => p - q);
  crossings.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  crossings.forEach((c, i) => (c.index = i));
  return crossings;
}

const endTangent = (l: Lane): Vec2 => normalize(sub(l.points[l.points.length - 1]!, l.points[l.points.length - 2]!));
const startTangent = (l: Lane): Vec2 => normalize(sub(l.points[1]!, l.points[0]!));

function classify(theta: number): Turn {
  if (Math.abs(theta) < STRAIGHT_ANGLE) return 'straight';
  return theta > 0 ? 'right' : 'left';
}

function buildConnectors(nodeId: NodeId, list: End[], lanes: Lane[], out: Connector[]): void {
  const deg = list.length;
  const made = new Set<string>();
  const add = (from: number, to: number, turn: Turn): void => {
    const key = `${from}>${to}`;
    if (made.has(key)) return;
    made.add(key);
    const c = makeConnector(out.length, nodeId, lanes[from]!, lanes[to]!, turn);
    out.push(c);
    lanes[from]!.out.push(c.index);
  };
  const groups = list.map((e) => ({ end: e, inc: e.atA ? e.info.bwd : e.info.fwd, outg: e.atA ? e.info.fwd : e.info.bwd }));

  for (const g of groups) {
    const nIn = g.inc.length;
    if (nIn === 0) continue;
    const inDir = endTangent(lanes[g.inc[0]!]!);
    const options: { outg: number[]; turn: Turn; theta: number }[] = [];
    for (const h of groups) {
      const nOut = h.outg.length;
      if (nOut === 0) continue;
      const same = h === g;
      if (same && deg !== 1) continue;
      const theta = angleBetween(inDir, startTangent(lanes[h.outg[0]!]!));
      const turn: Turn = same ? 'uturn' : classify(theta);
      options.push({ outg: h.outg, turn, theta });
      for (let i = 0; i < nIn; i++) {
        const from = g.inc[i]!;
        if (turn === 'uturn') {
          add(from, h.outg[Math.min(i, nOut - 1)]!, turn);
        } else if (turn === 'straight' || deg === 2) {
          // Straight (and any continuation through a degree-2 node) keeps lanes, plus lane-shift connectors.
          const j = Math.min(i, nOut - 1);
          add(from, h.outg[j]!, turn);
          if (j - 1 >= 0) add(from, h.outg[j - 1]!, turn);
          if (j + 1 < nOut) add(from, h.outg[j + 1]!, turn);
        } else if (turn === 'right') {
          if (nIn === 1 || i === nIn - 1) {
            add(from, h.outg[nOut - 1]!, turn);
            if (nOut > 1 && lanes[h.outg[nOut - 1]!]!.busOnly) add(from, h.outg[nOut - 2]!, turn);
          }
        } else if (nIn === 1 || i === 0) {
          add(from, h.outg[0]!, turn);
        }
      }
    }
    // Every incoming lane gets at least one way out: fall back to the most straight-ahead option.
    if (options.length === 0) continue;
    let best = options[0]!;
    for (const o of options) if (Math.abs(o.theta) < Math.abs(best.theta)) best = o;
    for (let i = 0; i < nIn; i++) {
      const from = g.inc[i]!;
      if (lanes[from]!.out.length > 0) continue;
      const nOut = best.outg.length;
      const j = best.turn === 'right' ? nOut - 1 : best.turn === 'left' ? 0 : Math.min(i, nOut - 1);
      add(from, best.outg[j]!, best.turn);
    }
  }
}

function makeConnector(index: number, nodeId: NodeId, from: Lane, to: Lane, turn: Turn): Connector {
  const p0 = from.points[from.points.length - 1]!;
  const p3 = to.points[0]!;
  const d0 = endTangent(from);
  const d1 = startTangent(to);
  const d = dist(p0, p3);
  const c0 = add(p0, scale(d0, 0.4 * d));
  const c1 = sub(p3, scale(d1, 0.4 * d));
  const n = Math.max(4, Math.ceil(d / 1.5));
  const points: Vec2[] = [];
  for (let i = 0; i <= n; i++) points.push(cubicBezier(p0, c0, c1, p3, i / n));
  const cum = cumulativeLengths(points);
  const delta = Math.abs(angleBetween(d0, d1));
  const radius = delta < 1e-3 ? Infinity : d / (2 * Math.sin(delta / 2));
  const speedLimit = Math.max(MIN_CONNECTOR_SPEED, Math.min(Math.sqrt(2.5 * radius), to.speedLimit));
  return {
    index,
    id: `${from.id}>${to.id}`,
    nodeId,
    fromLane: from.index,
    toLane: to.index,
    turn,
    points,
    cum,
    length: Math.max(cum[cum.length - 1]!, 0.1),
    speedLimit,
    conflicts: [],
  };
}

interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

function bbox(pts: readonly Vec2[], pad: number): Box {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.x > x1) x1 = p.x;
    if (p.z > z1) z1 = p.z;
  }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

function pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2)) : 0;
  return Math.hypot(a.x + abx * t - p.x, a.z + abz * t - p.z);
}

function segsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2): number => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if the two polylines come closer than `limit` anywhere. */
function polylinesNear(p: readonly Vec2[], q: readonly Vec2[], limit: number): boolean {
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!;
    const b = p[i]!;
    const ax0 = Math.min(a.x, b.x) - limit;
    const ax1 = Math.max(a.x, b.x) + limit;
    const az0 = Math.min(a.z, b.z) - limit;
    const az1 = Math.max(a.z, b.z) + limit;
    for (let j = 1; j < q.length; j++) {
      const c = q[j - 1]!;
      const d = q[j]!;
      if (Math.max(c.x, d.x) < ax0 || Math.min(c.x, d.x) > ax1 || Math.max(c.z, d.z) < az0 || Math.min(c.z, d.z) > az1) continue;
      if (segsCross(a, b, c, d)) return true;
      if (pointSegDist(a, c, d) < limit || pointSegDist(b, c, d) < limit || pointSegDist(c, a, b) < limit || pointSegDist(d, a, b) < limit)
        return true;
    }
  }
  return false;
}

function buildConflicts(cs: Connector[], first: number): void {
  const boxes: Box[] = [];
  for (let i = first; i < cs.length; i++) boxes.push(bbox(cs[i]!.points, CONFLICT_DISTANCE / 2));
  for (let i = first; i < cs.length; i++) {
    const a = cs[i]!;
    const ba = boxes[i - first]!;
    for (let j = i + 1; j < cs.length; j++) {
      const b = cs[j]!;
      if (a.fromLane === b.fromLane) continue;
      let hit = a.toLane === b.toLane;
      if (!hit) {
        const bb = boxes[j - first]!;
        if (ba.x0 > bb.x1 || bb.x0 > ba.x1 || ba.z0 > bb.z1 || bb.z0 > ba.z1) continue;
        hit = polylinesNear(a.points, b.points, CONFLICT_DISTANCE);
      }
      if (hit) {
        a.conflicts.push(j);
        b.conflicts.push(i);
      }
    }
  }
}

/** Corners of every trimmed road end at the node, sorted by angle around the node. */
function junctionPolygon(center: Vec2, list: End[]): Vec2[] {
  const corners: Vec2[] = [];
  for (const e of list) {
    const { pts, cum, length, rt } = e.info;
    const s = e.atA ? e.info.setbackA : length - e.info.setbackB;
    const p = pointAtLength(pts, cum, s);
    const n = rightNormal(tangentAtLength(pts, cum, Math.max(1e-6, Math.min(length, s))));
    const hw = roadHalfWidth(rt);
    corners.push(add(p, scale(n, hw)), add(p, scale(n, -hw)));
  }
  const ang = (p: Vec2): number => Math.atan2(p.z - center.z, p.x - center.x);
  return corners.sort((p, q) => ang(p) - ang(q));
}
