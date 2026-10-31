// Road meshes merged per 256 m chunk (one draw call each): asphalt + junction polygons,
// sidewalks/curbs and lane markings, separated by small height offsets.
// Each update diffs per-item geometry signatures and rebuilds only the chunks that changed.
// Sidewalks are red paving bricks drawn by the shared material in world X/Z (ADR 0014 §2, P7a: no
// texture, no extra draw call); far away they fade into the bricks' average color (C_WALK).
// Medians (P7c-2, ADR 0014 §4) are raised curbed islands — grass and a low hedge when planted, concrete
// otherwise — cut where the lanes stop at a junction and at every crosswalk; speed bumps skip them.

import * as THREE from 'three';
import { add, carriagewayWidth, cumulativeLengths, medianWidth, offsetPolyline, scale, slicePolyline, sub, type RoadType, type Vec2 } from '@smartcity/shared';
import { MeshBuilder } from './meshBuilder';
import type { RoadNetworkGeom, RoadSegGeom, RoadNodeGeom } from './roadNetwork';
import { BUMP_LENGTH, speedBump, zebra } from './streetMarks';

export const CHUNK_SIZE = 256;
export const Y_ROAD = 0.06;
export const Y_MARK = 0.08;
export const Y_WALK = 0.2;

const C_ASPHALT = new THREE.Color('#3b3f45');
const C_JUNCTION = new THREE.Color('#3b3f45');
const C_BUS = new THREE.Color('#9a3434');
const C_YELLOW = new THREE.Color('#f2c230');
const C_WHITE = new THREE.Color('#e9ecef');
/** Paving bricks (보도블록): three tones and the joints, 30 × 15 cm in running bond. */
const BRICK_TONES = [new THREE.Color('#a4573f'), new THREE.Color('#8c4636'), new THREE.Color('#b39783')];
const BRICK_WEIGHTS = [0.45, 0.35, 0.2];
const C_MORTAR = new THREE.Color('#948a7f');
const BRICK = { x: 0.3, z: 0.15, joint: 0.012 };
/** Share of a sidewalk covered by joints (drawn at 85 % mortar). */
const JOINT_SHARE = 1 - (1 - (2 * BRICK.joint) / BRICK.x) * (1 - (2 * BRICK.joint) / BRICK.z);
/** Sidewalk vertex color: the bricks' average, which the shader also uses to find the sidewalk. */
export const C_WALK = BRICK_TONES.reduce((c, t, i) => c.add(t.clone().multiplyScalar(BRICK_WEIGHTS[i]!)), new THREE.Color(0, 0, 0))
  .multiplyScalar(1 - 0.85 * JOINT_SHARE)
  .add(C_MORTAR.clone().multiplyScalar(0.85 * JOINT_SHARE));
const C_CURB = new THREE.Color('#9d9a92');
const C_SHOULDER = new THREE.Color('#6d7077');
const C_SCHOOL = new THREE.Color('#7a4638');
/** Median: grass and hedge (exact vertex colors: the shader gives them the lawn's night tone), concrete. */
export const C_MEDIAN_GRASS = new THREE.Color('#5f7d47');
export const C_HEDGE = new THREE.Color('#3d6234');
export const C_MEDIAN = new THREE.Color('#a8a59d');
/** Concrete curb top along the edges of a planted median, meters. */
const MEDIAN_EDGE = 0.25;
/** Low hedge (관목 띠) along a planted median: height, widest, ends kept back from a cut median end, meters. */
const HEDGE = { height: 0.6, maxWidth: 1.4, inset: 1 };
/** The median stops this far from a crosswalk's zebra, meters. */
export const MEDIAN_CROSS_GAP = 0.6;
/** Shorter median pieces (between two close crosswalks) are left out, meters. */
const MEDIAN_MIN_PIECE = 1;

export const chunkKey = (p: Vec2): string => `${Math.floor(p.x / CHUNK_SIZE)},${Math.floor(p.z / CHUNK_SIZE)}`;

interface ChunkMeshes {
  mesh: THREE.Mesh;
}

interface ItemRecord {
  sig: string;
  chunk: string;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Road types are replaced, never edited in place, so their serialization can be cached per object. */
const roadTypeSigs = new WeakMap<RoadType, string>();
function roadTypeSig(rt: RoadType): string {
  let sig = roadTypeSigs.get(rt);
  if (sig === undefined) roadTypeSigs.set(rt, (sig = JSON.stringify(rt)));
  return sig;
}

function segSig(g: RoadSegGeom, net: RoadNetworkGeom): string {
  const first = g.centerline[0]!;
  const last = g.centerline[g.centerline.length - 1]!;
  const mid = g.centerline[g.centerline.length >> 1]!;
  const deg = (n: string): number => net.nodes.get(n)?.segments.length ?? 0;
  const control = (n: string): string => net.nodes.get(n)?.control ?? '';
  const joint = (n: string): string => {
    const j = net.nodes.get(n)?.joint;
    return j ? `${Math.round(j.x * 1e4)},${Math.round(j.z * 1e4)}` : '';
  };
  const crossings = g.crossings.map((c) => `${c.id}:${c.signal ? 1 : 0}:${c.polygon.map((p) => `${r2(p.x)},${r2(p.z)}`).join(';')}`).join('/');
  return [
    r2(first.x), r2(first.z), r2(mid.x), r2(mid.z), r2(last.x), r2(last.z), g.centerline.length, r2(g.setbackA), r2(g.setbackB),
    roadTypeSig(g.roadType), deg(g.a) >= 3, deg(g.b) >= 3,
    r2(g.laneStartA), r2(g.laneStartB), g.speedBumps.map(r2).join(','), g.schoolZone, control(g.a), control(g.b), joint(g.a), joint(g.b), crossings,
  ].join('|');
}

function nodeSig(n: RoadNodeGeom): string {
  return n.polygon.map((p) => `${r2(p.x)},${r2(p.z)}`).join(';');
}

function groupByChunk(records: Map<string, ItemRecord>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, rec] of records) {
    const list = out.get(rec.chunk);
    if (list) list.push(id);
    else out.set(rec.chunk, [id]);
  }
  return out;
}

const midpoint = (g: RoadSegGeom): Vec2 => g.centerline[g.centerline.length >> 1]!;

export class RoadLayer {
  readonly group = new THREE.Group();
  private chunks = new Map<string, ChunkMeshes>();
  private segRecords = new Map<string, ItemRecord>();
  private nodeRecords = new Map<string, ItemRecord>();
  /** Segment / node ids per chunk, in record order, so a dirty chunk does not scan every item. */
  private segsByChunk = new Map<string, string[]>();
  private nodesByChunk = new Map<string, string[]>();
  /** One material for everything so each chunk is a single draw call; layers are separated by height. */
  private readonly mat: THREE.MeshStandardMaterial;
  /** Number of chunks rebuilt by the last update (for tests and stats). */
  lastRebuilt = 0;

  private readonly uNight = { value: 0 };

  constructor() {
    this.group.name = 'roads';
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    brickSidewalks(this.mat, this.uNight);
  }

  /** 0 = day … 1 = night (the bricks lose the moonlight's blue cast, as the paving). */
  setNight(night: number): void {
    this.uNight.value = night;
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
      // Smooth joints have no junction polygon: their roads are drawn up to the node.
      if (n.polygon.length < 3 || n.joint) continue;
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
    this.segsByChunk = groupByChunk(nextSeg);
    this.nodesByChunk = groupByChunk(nextNode);
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
    for (const id of this.segsByChunk.get(key) ?? []) buildSegment(net.segments.get(id)!, net, b);
    for (const id of this.nodesByChunk.get(key) ?? []) b.polygon(net.nodes.get(id)!.polygon, Y_ROAD, C_JUNCTION);
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

/** Sidewalk bricks on the road material: where the vertex color is C_WALK, in world X/Z; median greenery's night tone. */
function brickSidewalks(mat: THREE.MeshStandardMaterial, uNight: { value: number }): void {
  mat.customProgramCacheKey = () => 'smartcity-road-brick-v2';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uNight,
      uWalk: { value: C_WALK },
      uBrick0: { value: BRICK_TONES[0] },
      uBrick1: { value: BRICK_TONES[1] },
      uBrick2: { value: BRICK_TONES[2] },
      uMortar: { value: C_MORTAR },
      uGrass: { value: C_MEDIAN_GRASS },
      uHedge: { value: C_HEDGE },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoadWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vRoadWorld;
        uniform float uNight;
        uniform vec3 uWalk;
        uniform vec3 uBrick0;
        uniform vec3 uBrick1;
        uniform vec3 uBrick2;
        uniform vec3 uMortar;
        uniform vec3 uGrass;
        uniform vec3 uHedge;
        float rbHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        #ifdef USE_COLOR
        if (all(lessThan(abs(vColor.rgb - uWalk), vec3(0.003)))) {
          vec2 q = vRoadWorld.xz / vec2(${BRICK.x.toFixed(3)}, ${BRICK.z.toFixed(3)});
          q.x += mod(floor(q.y), 2.0) * 0.5;
          vec2 cell = floor(q);
          vec2 f = fract(q);
          vec2 fw = fwidth(q);
          vec2 jw = vec2(${(BRICK.joint / BRICK.x).toFixed(4)}, ${(BRICK.joint / BRICK.z).toFixed(4)});
          vec2 e = smoothstep(jw - fw * 0.5, jw + fw * 0.5, min(f, 1.0 - f));
          float mortar = 1.0 - min(e.x, e.y);
          float h = rbHash(cell + 0.37);
          vec3 tone = h < ${BRICK_WEIGHTS[0]!.toFixed(2)} ? uBrick0 : (h < ${(BRICK_WEIGHTS[0]! + BRICK_WEIGHTS[1]!).toFixed(2)} ? uBrick1 : uBrick2);
          tone *= 0.9 + 0.2 * rbHash(cell * 1.7 + 3.1);
          // Bricks while a course spans a few pixels, their average beyond (no shimmer).
          float detail = smoothstep(1.5, 4.0, 1.0 / max(max(fw.x, fw.y), 1e-4));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(tone, uMortar, mortar * 0.85), detail);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.56, 0.55, 0.5), uNight);
        } else if (all(lessThan(abs(vColor.rgb - uGrass), vec3(0.003))) || all(lessThan(abs(vColor.rgb - uHedge), vec3(0.003)))) {
          // Median grass and hedge: the lawns' night tone (no moonlit blue on greenery).
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.56, 0.55, 0.5), uNight);
        }
        #endif`,
      );
  };
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
    const m = medianWidth(rt) / 2;
    for (let k = 1; k < rt.lanesForward; k++) forward.push(m + k * w);
    for (let k = 1; k < rt.lanesBackward; k++) backward.push(-m - k * w);
  }
  return { forward, backward };
}

/**
 * Arc-length stretches of a segment's median: the lane stretch [l0, l1] (it stops where the lanes do, before
 * a junction's crosswalk zone) cut at every crosswalk on the segment as at a junction (ADR 0014 §4).
 */
export function medianPieces(l0: number, l1: number, crossings: readonly { s: number; width: number }[]): [number, number][] {
  const cuts = crossings.map((c): [number, number] => [c.s - c.width / 2 - MEDIAN_CROSS_GAP, c.s + c.width / 2 + MEDIAN_CROSS_GAP]).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let a = l0;
  for (const [c0, c1] of cuts) {
    if (c1 <= a) continue;
    if (c0 >= l1) break;
    if (c0 - a >= MEDIAN_MIN_PIECE) out.push([a, c0]);
    a = c1;
  }
  if (l1 - a >= MEDIAN_MIN_PIECE) out.push([a, l1]);
  return out;
}

/** Vertical face across the start and/or end of a polyline, between lateral offsets o1 and o2. */
function endCaps(b: MeshBuilder, pts: readonly Vec2[], o1: number, o2: number, y0: number, y1: number, c: THREE.Color, start: boolean, end: boolean): void {
  const l = offsetPolyline(pts, o1);
  const r = offsetPolyline(pts, o2);
  for (const i of [...(start ? [0] : []), ...(end ? [pts.length - 1] : [])]) {
    const p = l[i]!, q = r[i]!;
    b.tri(p.x, y0, p.z, q.x, y0, q.z, q.x, y1, q.z, c);
    b.tri(p.x, y0, p.z, q.x, y1, q.z, p.x, y1, p.z, c);
  }
}

/**
 * One median piece of half width `m` along `pts`: an island raised to the sidewalk height (trees stand on it
 * at Y_WALK) behind curbs; planted = grass with concrete edges and a low hedge, else concrete. Ends on a
 * smooth joint stay open (the median continues on the next road).
 */
function buildMedian(b: MeshBuilder, pts: Vec2[], m: number, planted: boolean, openStart: boolean, openEnd: boolean): void {
  const y0 = Y_ROAD - 0.02;
  b.wall(pts, m, y0, Y_WALK, C_CURB);
  b.wall(pts, -m, y0, Y_WALK, C_CURB);
  endCaps(b, pts, -m, m, y0, Y_WALK, C_CURB, !openStart, !openEnd);
  if (!planted || m <= 2 * MEDIAN_EDGE) {
    b.band(pts, -m, m, Y_WALK, C_MEDIAN);
    return;
  }
  b.band(pts, m - MEDIAN_EDGE, m, Y_WALK, C_CURB);
  b.band(pts, -m, -m + MEDIAN_EDGE, Y_WALK, C_CURB);
  b.band(pts, -m + MEDIAN_EDGE, m - MEDIAN_EDGE, Y_WALK, C_MEDIAN_GRASS);
  // The hedge leaves 0.4 m of grass each side.
  const hh = Math.min(HEDGE.maxWidth / 2, m - MEDIAN_EDGE - 0.4);
  const cum = cumulativeLengths(pts);
  const len = cum[cum.length - 1]!;
  const h0 = openStart ? 0 : HEDGE.inset;
  const h1 = openEnd ? len : len - HEDGE.inset;
  if (hh < 0.2 || h1 - h0 < 0.5) return;
  const hp = h0 > 0 || h1 < len ? slicePolyline(pts, h0, h1) : pts;
  const top = Y_WALK + HEDGE.height;
  b.band(hp, -hh, hh, top, C_HEDGE);
  b.wall(hp, hh, Y_WALK, top, C_HEDGE);
  b.wall(hp, -hh, Y_WALK, top, C_HEDGE);
  endCaps(b, hp, -hh, hh, Y_WALK, top, C_HEDGE, !openStart, !openEnd);
}

/** Travel direction (a → b) of `g` at its end on a smooth joint node, or null. */
function jointTravelDir(net: RoadNetworkGeom, g: RoadSegGeom, atA: boolean): Vec2 | null {
  const n = net.nodes.get(atA ? g.a : g.b);
  if (!n?.joint) return null;
  const away = n.segments[0] === g.id ? n.joint : scale(n.joint, -1);
  return atA ? away : scale(away, -1);
}

const PIN = 0.05;

/**
 * Pin the end directions of a polyline: a tiny first/last piece along `start`/`end`, so offsets
 * (bands, curbs) at a smooth joint use the joint's shared normal on both roads and meet exactly.
 */
function pinEnds(pts: Vec2[], start: Vec2 | null, end: Vec2 | null): Vec2[] {
  const out = pts.slice();
  const chord = (i: number): number => Math.hypot(out[i + 1]!.x - out[i]!.x, out[i + 1]!.z - out[i]!.z);
  if (start && out.length >= 2 && chord(0) > 3 * PIN) out.splice(1, 0, add(out[0]!, scale(start, PIN)));
  if (end && out.length >= 2 && chord(out.length - 2) > 3 * PIN) out.splice(out.length - 1, 0, sub(out[out.length - 1]!, scale(end, PIN)));
  return out;
}

function buildSegment(g: RoadSegGeom, net: RoadNetworkGeom, b: MeshBuilder): void {
  // Ends on a smooth joint run to the node (no junction cut); elsewhere the junction setback applies.
  const ja = jointTravelDir(net, g, true);
  const jb = jointTravelDir(net, g, false);
  const s0 = ja ? 0 : g.setbackA;
  const s1 = jb ? g.length : g.length - g.setbackB;
  if (s1 - s0 < 0.2) return;
  const pts = pinEnds(slicePolyline(g.centerline, s0, s1), ja, jb);
  const rt = g.roadType;
  const cw = carriagewayWidth(rt);
  const hc = cw / 2;
  const w = rt.laneWidth;
  const oneWay = rt.lanesBackward === 0;
  // Half the median: each direction's lanes start at its edge (shared laneOffset).
  const m = medianWidth(rt) / 2;

  b.band(pts, -hc, hc, Y_ROAD, g.schoolZone ? C_SCHOOL : C_ASPHALT);

  // Bus-only lanes: red surface on the curb lane of each direction.
  if (rt.busOnlyRightLane) {
    if (oneWay) b.band(pts, hc - w, hc, Y_MARK - 0.01, C_BUS);
    else {
      b.band(pts, m + (rt.lanesForward - 1) * w, m + rt.lanesForward * w, Y_MARK - 0.01, C_BUS);
      b.band(pts, -m - rt.lanesBackward * w, -m - (rt.lanesBackward - 1) * w, Y_MARK - 0.01, C_BUS);
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

  // Lane markings start where the lanes do (after the crosswalk zone at junction ends).
  const l0 = ja ? 0 : Math.max(s0, g.laneStartA);
  const l1 = jb ? g.length : Math.min(s1, g.length - g.laneStartB);
  const len = l1 - l0;
  const pieces = m > 0 && len > 0.2 ? medianPieces(l0, l1, g.crossings) : [];
  if (len > 0.2) {
    const lanePts = pinEnds(slicePolyline(g.centerline, l0, l1), ja, jb);
    // Center line: double solid yellow on two-way roads; with a median, the island and a yellow line along each curb.
    if (m > 0) {
      for (const [p0, p1] of pieces) {
        const openStart = p0 === l0 && !!ja;
        const openEnd = p1 === l1 && !!jb;
        const mp = pinEnds(slicePolyline(g.centerline, p0, p1), openStart ? ja : null, openEnd ? jb : null);
        buildMedian(b, mp, m, rt.median!.planted, openStart, openEnd);
        b.band(mp, m + 0.1, m + 0.25, Y_MARK, C_YELLOW);
        b.band(mp, -m - 0.25, -m - 0.1, Y_MARK, C_YELLOW);
      }
    } else if (!oneWay) {
      b.band(lanePts, -0.27, -0.12, Y_MARK, C_YELLOW);
      b.band(lanePts, 0.12, 0.27, Y_MARK, C_YELLOW);
    }
    const div = dividerOffsets(rt);
    for (const o of [...div.forward, ...div.backward]) b.dashed(lanePts, o, 0.15, 3, 5, Y_MARK, C_WHITE);

    // Stop lines where the road enters a junction (degree ≥ 3), at the lane end.
    if (len > 3) {
      const degB = net.nodes.get(g.b)?.segments.length ?? 0;
      const degA = net.nodes.get(g.a)?.segments.length ?? 0;
      if (degB >= 3) {
        const piece = slicePolyline(lanePts, len - 1.1, len - 0.6);
        if (oneWay) b.band(piece, -hc + 0.3, hc - 0.3, Y_MARK, C_WHITE);
        else b.band(piece, m + 0.3, hc - 0.3, Y_MARK, C_WHITE);
      }
      if (degA >= 3 && !oneWay) {
        const piece = slicePolyline(lanePts, 0.6, 1.1);
        b.band(piece, -hc + 0.3, -m - 0.3, Y_MARK, C_WHITE);
      }
    }
    // School zone: yellow ladder marks along both edges of the carriageway.
    if (g.schoolZone) {
      b.dashed(lanePts, hc - 0.9, 0.5, 1.2, 1.2, Y_MARK, C_YELLOW);
      b.dashed(lanePts, -hc + 0.9, 0.5, 1.2, 1.2, Y_MARK, C_YELLOW);
    }
  }

  for (const c of g.crossings) zebra(b, c.polygon, c.a, c.b, Y_MARK, C_WHITE);
  // Speed bumps cover the two driving areas only where the median runs (not across it).
  for (const s of g.speedBumps) {
    const onMedian = pieces.some(([p0, p1]) => s + BUMP_LENGTH / 2 > p0 && s - BUMP_LENGTH / 2 < p1);
    speedBump(b, g.centerline, s, hc, Y_MARK + 0.005, onMedian ? m : 0);
  }
}
