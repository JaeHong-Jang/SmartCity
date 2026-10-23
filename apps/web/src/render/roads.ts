// Road meshes merged per 256 m chunk (one draw call each): asphalt + junction polygons,
// sidewalks/curbs and lane markings, separated by small height offsets.
// Each update diffs per-item geometry signatures and rebuilds only the chunks that changed.

import * as THREE from 'three';
import { carriagewayWidth, slicePolyline, type RoadType, type Vec2 } from '@smartcity/shared';
import { MeshBuilder } from './meshBuilder';
import type { RoadNetworkGeom, RoadSegGeom, RoadNodeGeom } from './roadNetwork';

export const CHUNK_SIZE = 256;
export const Y_ROAD = 0.06;
export const Y_MARK = 0.08;
export const Y_WALK = 0.2;

const C_ASPHALT = new THREE.Color('#3b3f45');
const C_JUNCTION = new THREE.Color('#3b3f45');
const C_BUS = new THREE.Color('#9a3434');
const C_YELLOW = new THREE.Color('#f2c230');
const C_WHITE = new THREE.Color('#e9ecef');
const C_WALK = new THREE.Color('#b9b5ab');
const C_CURB = new THREE.Color('#9d9a92');
const C_SHOULDER = new THREE.Color('#6d7077');

export const chunkKey = (p: Vec2): string => `${Math.floor(p.x / CHUNK_SIZE)},${Math.floor(p.z / CHUNK_SIZE)}`;

interface ChunkMeshes {
  mesh: THREE.Mesh;
}

interface ItemRecord {
  sig: string;
  chunk: string;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

function segSig(g: RoadSegGeom, net: RoadNetworkGeom): string {
  const first = g.centerline[0]!;
  const last = g.centerline[g.centerline.length - 1]!;
  const mid = g.centerline[g.centerline.length >> 1]!;
  const deg = (n: string): number => net.nodes.get(n)?.segments.length ?? 0;
  return [r2(first.x), r2(first.z), r2(mid.x), r2(mid.z), r2(last.x), r2(last.z), g.centerline.length, r2(g.setbackA), r2(g.setbackB), JSON.stringify(g.roadType), deg(g.a) >= 3, deg(g.b) >= 3].join('|');
}

function nodeSig(n: RoadNodeGeom): string {
  return n.polygon.map((p) => `${r2(p.x)},${r2(p.z)}`).join(';');
}

const midpoint = (g: RoadSegGeom): Vec2 => g.centerline[g.centerline.length >> 1]!;

export class RoadLayer {
  readonly group = new THREE.Group();
  private chunks = new Map<string, ChunkMeshes>();
  private segRecords = new Map<string, ItemRecord>();
  private nodeRecords = new Map<string, ItemRecord>();
  /** One material for everything so each chunk is a single draw call; layers are separated by height. */
  private readonly mat: THREE.MeshStandardMaterial;
  /** Number of chunks rebuilt by the last update (for tests and stats). */
  lastRebuilt = 0;

  constructor() {
    this.group.name = 'roads';
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  }

  update(net: RoadNetworkGeom): void {
    const dirty = new Set<string>();
    const nextSeg = new Map<string, ItemRecord>();
    for (const g of net.segments.values()) {
      const rec = { sig: segSig(g, net), chunk: chunkKey(midpoint(g)) };
      nextSeg.set(g.id, rec);
      const old = this.segRecords.get(g.id);
      if (!old || old.sig !== rec.sig || old.chunk !== rec.chunk) {
        dirty.add(rec.chunk);
        if (old) dirty.add(old.chunk);
      }
    }
    for (const [id, old] of this.segRecords) if (!nextSeg.has(id)) dirty.add(old.chunk);

    const nextNode = new Map<string, ItemRecord>();
    for (const n of net.nodes.values()) {
      if (n.polygon.length < 3) continue;
      const rec = { sig: nodeSig(n), chunk: chunkKey(n.pos) };
      nextNode.set(n.id, rec);
      const old = this.nodeRecords.get(n.id);
      if (!old || old.sig !== rec.sig || old.chunk !== rec.chunk) {
        dirty.add(rec.chunk);
        if (old) dirty.add(old.chunk);
      }
    }
    for (const [id, old] of this.nodeRecords) if (!nextNode.has(id)) dirty.add(old.chunk);

    this.segRecords = nextSeg;
    this.nodeRecords = nextNode;
    this.lastRebuilt = dirty.size;
    for (const key of dirty) this.rebuildChunk(key, net);
  }

  private rebuildChunk(key: string, net: RoadNetworkGeom): void {
    const old = this.chunks.get(key);
    if (old) {
      this.group.remove(old.mesh);
      old.mesh.geometry.dispose();
      this.chunks.delete(key);
    }
    const b = new MeshBuilder();
    for (const [id, rec] of this.segRecords) {
      if (rec.chunk !== key) continue;
      buildSegment(net.segments.get(id)!, net, b);
    }
    for (const [id, rec] of this.nodeRecords) {
      if (rec.chunk !== key) continue;
      b.polygon(net.nodes.get(id)!.polygon, Y_ROAD, C_JUNCTION);
    }
    if (b.empty) return;
    const mesh = new THREE.Mesh(b.build(), this.mat);
    mesh.name = `road-chunk-${key}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.chunks.set(key, { mesh });
    this.group.add(mesh);
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  dispose(): void {
    for (const c of this.chunks.values()) c.mesh.geometry.dispose();
    this.chunks.clear();
    this.mat.dispose();
  }
}

/** Lateral offsets of lane dividers, per direction, matching shared laneOffset(). */
function dividerOffsets(rt: RoadType): { forward: number[]; backward: number[] } {
  const w = rt.laneWidth;
  const forward: number[] = [];
  const backward: number[] = [];
  if (rt.lanesBackward === 0) {
    const n = rt.lanesForward;
    for (let i = 1; i < n; i++) forward.push((i - n / 2) * w);
  } else {
    for (let k = 1; k < rt.lanesForward; k++) forward.push(k * w);
    for (let k = 1; k < rt.lanesBackward; k++) backward.push(-k * w);
  }
  return { forward, backward };
}

function buildSegment(g: RoadSegGeom, net: RoadNetworkGeom, b: MeshBuilder): void {
  const s0 = g.setbackA;
  const s1 = g.length - g.setbackB;
  if (s1 - s0 < 0.2) return;
  const pts = slicePolyline(g.centerline, s0, s1);
  const rt = g.roadType;
  const cw = carriagewayWidth(rt);
  const hc = cw / 2;
  const w = rt.laneWidth;
  const oneWay = rt.lanesBackward === 0;

  b.band(pts, -hc, hc, Y_ROAD, C_ASPHALT);

  // Bus-only lanes: red surface on the curb lane of each direction.
  if (rt.busOnlyRightLane) {
    if (oneWay) b.band(pts, hc - w, hc, Y_MARK - 0.01, C_BUS);
    else {
      b.band(pts, (rt.lanesForward - 1) * w, rt.lanesForward * w, Y_MARK - 0.01, C_BUS);
      b.band(pts, -rt.lanesBackward * w, -(rt.lanesBackward - 1) * w, Y_MARK - 0.01, C_BUS);
    }
  }

  // Sidewalks (raised, with curb faces) or a narrow shoulder.
  const hw = g.halfWidth;
  if (rt.sidewalk) {
    b.band(pts, hc, hw, Y_WALK, C_WALK);
    b.band(pts, -hw, -hc, Y_WALK, C_WALK);
    b.wall(pts, hc, Y_ROAD - 0.02, Y_WALK, C_CURB);
    b.wall(pts, -hc, Y_ROAD - 0.02, Y_WALK, C_CURB);
    b.wall(pts, hw, 0, Y_WALK, C_CURB);
    b.wall(pts, -hw, 0, Y_WALK, C_CURB);
  } else {
    b.band(pts, hc, hw, Y_ROAD, C_SHOULDER);
    b.band(pts, -hw, -hc, Y_ROAD, C_SHOULDER);
  }

  // Edge lines.
  b.band(pts, hc - 0.35, hc - 0.2, Y_MARK, C_WHITE);
  b.band(pts, -hc + 0.2, -hc + 0.35, Y_MARK, C_WHITE);

  // Center line: double solid yellow on two-way roads.
  if (!oneWay) {
    b.band(pts, -0.27, -0.12, Y_MARK, C_YELLOW);
    b.band(pts, 0.12, 0.27, Y_MARK, C_YELLOW);
  }

  const div = dividerOffsets(rt);
  for (const o of [...div.forward, ...div.backward]) b.dashed(pts, o, 0.15, 3, 5, Y_MARK, C_WHITE);

  // Stop lines where the road enters a junction (degree ≥ 3).
  const len = s1 - s0;
  if (len > 3) {
    const degB = net.nodes.get(g.b)?.segments.length ?? 0;
    const degA = net.nodes.get(g.a)?.segments.length ?? 0;
    if (degB >= 3) {
      const piece = slicePolyline(pts, len - 1.1, len - 0.6);
      if (oneWay) b.band(piece, -hc + 0.3, hc - 0.3, Y_MARK, C_WHITE);
      else b.band(piece, 0.3, hc - 0.3, Y_MARK, C_WHITE);
    }
    if (degA >= 3 && !oneWay) {
      const piece = slicePolyline(pts, 0.6, 1.1);
      b.band(piece, -hc + 0.3, -0.3, Y_MARK, C_WHITE);
    }
  }
}
