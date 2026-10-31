import { describe, expect, it } from 'vitest';
import { carriagewayWidth, closestPointOnPolyline, createEmptyDoc, type CityDoc, type Vec2 } from '@smartcity/shared';
import * as THREE from 'three';
import { buildRoadNetwork } from './roadNetwork';
import { medianPieces } from './roads';
import {
  CROSSING_CLEAR,
  ENTRY_CLEAR,
  JUNCTION_CLEAR,
  LAMP_INSET,
  MEDIAN_TREE_MIN_WIDTH,
  placeSegment,
  segmentContexts,
  SENSOR_CLEAR,
  STOP_CLEAR,
  StreetscapeLayer,
  TREE_INSET,
  TREE_NEAR,
  type SegmentStreetscape,
} from './streetscape';
import { createMountains } from './mountains';

/** A straight chain of road-4 segments through `xs` along z = 0 (s1, s2, …). */
function chain(xs: number[], control?: { seg: number; at: { x: number; z: number }; end: { x: number; z: number } }): CityDoc {
  const doc = createEmptyDoc();
  xs.forEach((x, i) => (doc.nodes[`n${i}`] = { id: `n${i}`, pos: { x, z: 0 } }));
  if (control) doc.nodes[`n${control.seg}`]!.pos = control.end;
  for (let i = 1; i < xs.length; i++) doc.segments[`s${i}`] = { id: `s${i}`, a: `n${i - 1}`, b: `n${i}`, roadTypeId: 'road-4', ...(control && control.seg === i ? { control: control.at } : {}) };
  return doc;
}

/** Every placed tree and lamp of a layer, sorted (for comparing two layers). */
function spots(layer: StreetscapeLayer): string {
  const all = layer.near(0, 0, 1e9);
  const key = (p: Vec2) => `${p.x.toFixed(6)},${p.z.toFixed(6)}`;
  return [all.trees.map(key).sort().join(' '), all.lamps.map(key).sort().join(' ')].join(' | ');
}

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** n × n grid of nodes `spacing` apart, every neighbor joined by a road of `type`. */
function grid(n: number, spacing: number, type = 'road-4'): CityDoc {
  const doc = createEmptyDoc();
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) doc.nodes[`n${i}_${j}`] = { id: `n${i}_${j}`, pos: { x: i * spacing, z: j * spacing } };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) doc.segments[`x${i}_${j}`] = { id: `x${i}_${j}`, a: `n${i}_${j}`, b: `n${i + 1}_${j}`, roadTypeId: type };
      if (j + 1 < n) doc.segments[`z${i}_${j}`] = { id: `z${i}_${j}`, a: `n${i}_${j}`, b: `n${i}_${j + 1}`, roadTypeId: type };
    }
  }
  return doc;
}

function place(doc: CityDoc, seg: string): SegmentStreetscape {
  const net = buildRoadNetwork(doc);
  return placeSegment(net.segments.get(seg)!, segmentContexts(doc, net).get(seg)!);
}

/** Arc length and signed side (+1 right of a → b) of `p` along segment `seg`. */
function along(doc: CityDoc, seg: string, p: Vec2): { s: number; off: number } {
  const g = buildRoadNetwork(doc).segments.get(seg)!;
  const c = closestPointOnPolyline(g.centerline, p);
  const a = g.centerline[0]!;
  const b = g.centerline[g.centerline.length - 1]!;
  const side = Math.sign((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x));
  return { s: c.s, off: side * c.distance };
}

describe('street trees and lamps (streetscape)', () => {
  // x1_1 runs along +x at z = 100 from (100, 100) to (200, 100), between two 4-way junctions.
  const SEG = 'x1_1';

  it('lines both sidewalks at the curb, deterministically, clear of the junctions', () => {
    const doc = grid(3, 100);
    const p = place(doc, SEG);
    expect(p.trees.length).toBeGreaterThanOrEqual(12);
    expect(p.lamps.length).toBeGreaterThanOrEqual(4);
    expect(place(doc, SEG)).toEqual(p);
    const g = buildRoadNetwork(doc).segments.get(SEG)!;
    const curb = carriagewayWidth(g.roadType) / 2;
    for (const t of p.trees) {
      const { s, off } = along(doc, SEG, t);
      expect(Math.abs(off)).toBeCloseTo(curb + TREE_INSET, 5);
      expect(s).toBeGreaterThanOrEqual(g.laneStartA + JUNCTION_CLEAR - 1e-6);
      expect(s).toBeLessThanOrEqual(g.length - g.laneStartB - JUNCTION_CLEAR + 1e-6);
    }
    for (const l of p.lamps) expect(Math.abs(along(doc, SEG, l).off)).toBeCloseTo(curb + LAMP_INSET, 5);
    // Both sides planted.
    expect(new Set(p.trees.map((t) => Math.sign(along(doc, SEG, t).off))).size).toBe(2);
    // One species per street.
    expect(new Set(p.trees.map((t) => t.species)).size).toBe(1);
  });

  it('roads without sidewalks get none', () => {
    const doc = grid(3, 100);
    doc.roadTypes['bare'] = { ...doc.roadTypes['road-4']!, id: 'bare', sidewalk: false };
    doc.segments[SEG]!.roadTypeId = 'bare';
    expect(place(doc, SEG)).toEqual({ trees: [], lamps: [] });
  });

  it('keeps clear of a bus stop and a sensor on their side only, and of a mid-block crosswalk', () => {
    const doc = grid(3, 100);
    const before = place(doc, SEG);
    doc.busStops.st = { id: 'st', segmentId: SEG, t: 0.3, dir: 'forward' };
    doc.sensors.cam = { id: 'cam', kind: 'cctv', segmentId: SEG, t: 0.7, side: 'left', heading: 0, fov: 1, range: 60 };
    const after = place(doc, SEG);
    const g = buildRoadNetwork(doc).segments.get(SEG)!;
    for (const t of after.trees) {
      const { s, off } = along(doc, SEG, t);
      if (off > 0) expect(Math.abs(s - 0.3 * g.length)).toBeGreaterThanOrEqual(STOP_CLEAR);
      if (off < 0) expect(Math.abs(s - 0.7 * g.length)).toBeGreaterThanOrEqual(SENSOR_CLEAR);
    }
    expect(after.trees.length).toBeLessThan(before.trees.length);
    // The other sides are untouched near the stop / sensor.
    const near = (list: SegmentStreetscape['trees'], s0: number, side: number) => list.filter((t) => Math.sign(along(doc, SEG, t).off) === side && Math.abs(along(doc, SEG, t).s - s0) < STOP_CLEAR).length;
    expect(near(after.trees, 0.3 * g.length, -1)).toBe(near(before.trees, 0.3 * g.length, -1));

    doc.features.cw = { id: 'cw', segmentId: SEG, kind: 'crosswalk', t: 0.5 };
    const net = buildRoadNetwork(doc);
    const cw = net.segments.get(SEG)!.crossings.find((c) => c.kind === 'midblock')!;
    expect(cw).toBeDefined();
    for (const t of placeSegment(net.segments.get(SEG)!, segmentContexts(doc, net).get(SEG)!).trees) expect(Math.abs(along(doc, SEG, t).s - cw.s)).toBeGreaterThan(cw.width / 2);
  });

  it('leaves the entrance of a building facing the road open', () => {
    const doc = grid(3, 100);
    const before = place(doc, SEG);
    // A shop on the left of x1_1 (z < 100), its front (+z local) toward the road.
    doc.buildings.b = { id: 'b', typeId: 'shop', pos: { x: 150, z: 80 }, rotation: 0 };
    const after = place(doc, SEG);
    const s0 = along(doc, SEG, { x: 150, z: 100 }).s;
    const left = (p: SegmentStreetscape) => p.trees.filter((t) => along(doc, SEG, t).off < 0);
    for (const t of left(after)) expect(Math.abs(along(doc, SEG, t).s - s0)).toBeGreaterThanOrEqual(ENTRY_CLEAR);
    expect(left(after).length).toBeLessThan(left(before).length);
    // Turned away from the road: no entrance on this sidewalk.
    doc.buildings.b.rotation = Math.PI;
    expect(place(doc, SEG)).toEqual(before);
  });

  it('rebuilds only the chunk whose segment changed, and nothing for unrelated edits', () => {
    // 600 m across: several 256 m chunks.
    const doc = grid(4, 200);
    const layer = new StreetscapeLayer();
    layer.update(doc, buildRoadNetwork(doc));
    const all = layer.stats();
    expect(all.trees).toBeGreaterThan(100);
    expect(all.chunks).toBeGreaterThan(3);
    expect(all.lastRebuilt).toBe(all.chunks);

    layer.update(doc, buildRoadNetwork(doc));
    expect(layer.stats().lastRebuilt).toBe(0);

    doc.busStops.st = { id: 'st', segmentId: 'x1_1', t: 0.5, dir: 'forward' };
    layer.update(doc, buildRoadNetwork(doc));
    expect(layer.stats().lastRebuilt).toBe(1);
    expect(layer.stats().trees).toBeLessThan(all.trees);
    const stop = { x: 300, z: 200 + 8 };
    expect(layer.near(stop.x, stop.z, STOP_CLEAR - 1).trees).toHaveLength(0);

    doc.sensors.cam = { id: 'cam', kind: 'radar', segmentId: 'z2_0', t: 0.5, side: 'right', heading: 0, fov: 1, range: 60 };
    layer.update(doc, buildRoadNetwork(doc));
    expect(layer.stats().lastRebuilt).toBe(1);
    layer.dispose();
  });

  it('puts near trees in the detailed LOD and the rest farther out', () => {
    const doc = grid(4, 200);
    const layer = new StreetscapeLayer();
    layer.update(doc, buildRoadNetwork(doc));
    const cam = new THREE.Vector3(300, 2, 200);
    layer.frame(cam, 50);
    const st = layer.stats();
    const near = layer.near(300, 200, TREE_NEAR - 3).trees.length;
    expect(st.drawn.tree0).toBeGreaterThanOrEqual(near);
    expect(st.drawn.tree0).toBeLessThan(st.trees / 4);
    expect(st.drawn.tree1).toBeGreaterThan(0);
    // The far LOD holds every other tree in range (its shader cuts the inner ring out).
    expect(st.drawn.tree0 + st.drawn.tree2).toBeGreaterThanOrEqual(st.trees - st.drawn.tree1);
    expect(st.drawn.lamp0 + st.drawn.lamp1).toBeGreaterThanOrEqual(st.lamps);
    layer.dispose();
  });

  // Sol's repro: a stop at the very end of one road clears the start of the road continuing it.
  it('keeps clear of a stop or sensor on a neighboring road, across a chunk boundary', () => {
    // A straight segment's chunk is that of its end point: s1 ends at x = 100 (chunk 0), s2 at x = 300 (chunk 1).
    const doc = chain([10, 100, 300]);
    const layer = new StreetscapeLayer();
    layer.update(doc, buildRoadNetwork(doc));
    const stop = { x: 10 + 0.999 * 90, z: -(7 + TREE_INSET) };
    expect(layer.near(stop.x, stop.z, STOP_CLEAR - 0.01).trees.some((t) => t.x > 100)).toBe(true);
    doc.busStops.st = { id: 'st', segmentId: 's1', t: 0.999, dir: 'backward' };
    layer.update(doc, buildRoadNetwork(doc));
    expect(layer.stats().lastRebuilt).toBe(2);
    expect(layer.near(stop.x, stop.z, STOP_CLEAR - 0.01).trees).toEqual([]);
    // The far sidewalk keeps its trees.
    expect(layer.near(stop.x, -stop.z, STOP_CLEAR).trees.length).toBeGreaterThan(0);

    delete doc.busStops.st;
    doc.sensors.cam = { id: 'cam', kind: 'cctv', segmentId: 's1', t: 0.999, side: 'right', heading: 0, fov: 1, range: 60 };
    layer.update(doc, buildRoadNetwork(doc));
    expect(layer.near(stop.x, -stop.z, SENSOR_CLEAR - 0.01).trees).toEqual([]);
    layer.dispose();
  });

  it('a split road (two pieces) and a fillet curve: avoidance reaches across the joint', () => {
    // Split: the same road in two collinear pieces at x = 100.
    const split = chain([0, 100, 200]);
    split.busStops.st = { id: 'st', segmentId: 's2', t: 0.01, dir: 'forward' };
    const a = new StreetscapeLayer();
    a.update(split, buildRoadNetwork(split));
    const g2 = buildRoadNetwork(split).segments.get('s2')!;
    const at = { x: 100 + 0.01 * g2.length, z: 7 + TREE_INSET };
    expect(a.near(at.x, at.z, STOP_CLEAR - 0.01).trees).toEqual([]);
    // Fillet: s2 curves away from the end of s1 tangentially; a sensor at the end of s1.
    const fil = chain([0, 100, 160], { seg: 2, at: { x: 140, z: 0 }, end: { x: 160, z: 40 } });
    fil.sensors.cam = { id: 'cam', kind: 'radar', segmentId: 's1', t: 0.995, side: 'left', heading: 0, fov: 1, range: 60 };
    const b = new StreetscapeLayer();
    b.update(fil, buildRoadNetwork(fil));
    expect(buildRoadNetwork(fil).nodes.get('n1')!.joint).toBeDefined();
    expect(b.near(99.5, -(7 + TREE_INSET), SENSOR_CLEAR - 0.01).trees).toEqual([]);
    a.dispose();
    b.dispose();
  });

  // Sol's repro: a 2 mm sensor move changed the placements but not the (rounded) signature.
  it('an edit of any size rebuilds what it changes: the cache equals a fresh build', () => {
    const doc = chain([0, 200]);
    doc.sensors.cam = { id: 'cam', kind: 'cctv', segmentId: 's1', t: 32.36007513196848 / 200, side: 'right', heading: 0, fov: 1, range: 60 };
    const layer = new StreetscapeLayer();
    layer.update(doc, buildRoadNetwork(doc));
    doc.sensors.cam = { ...doc.sensors.cam!, t: 32.358075131968484 / 200 };
    layer.update(doc, buildRoadNetwork(doc));
    const fresh = new StreetscapeLayer();
    fresh.update(doc, buildRoadNetwork(doc));
    expect(spots(layer)).toBe(spots(fresh));
    layer.dispose();
    fresh.dispose();
  });

  it('after a seeded sequence of random edits the cache equals a fresh build from the final doc', () => {
    for (const seed of [1, 2, 3]) {
      const rnd = lcg(seed);
      const doc = grid(4, 160);
      const segs = Object.keys(doc.segments);
      const layer = new StreetscapeLayer();
      layer.update(doc, buildRoadNetwork(doc));
      for (let step = 0; step < 40; step++) {
        const r = rnd();
        const seg = segs[Math.floor(rnd() * segs.length)]!;
        const id = `x${Math.floor(rnd() * 4)}`;
        if (r < 0.25) doc.busStops[id] = { id, segmentId: seg, t: rnd(), dir: rnd() < 0.5 ? 'forward' : 'backward' };
        else if (r < 0.45) doc.sensors[id] = { id, kind: 'cctv', segmentId: seg, t: rnd(), side: rnd() < 0.5 ? 'left' : 'right', heading: 0, fov: 1, range: 60 };
        else if (r < 0.6 && doc.sensors[id]) doc.sensors[id] = { ...doc.sensors[id]!, t: Math.min(1, doc.sensors[id]!.t + (rnd() - 0.5) * 0.0002) };
        else if (r < 0.75) doc.buildings[id] = { id, typeId: 'shop', pos: { x: 20 + rnd() * 440, z: 20 + rnd() * 440 }, rotation: Math.floor(rnd() * 4) * (Math.PI / 2) };
        else if (r < 0.85) doc.features[id] = { id, segmentId: seg, kind: 'crosswalk', t: 0.2 + rnd() * 0.6 };
        else {
          delete doc.busStops[id];
          delete doc.sensors[id];
          delete doc.buildings[id];
          delete doc.features[id];
        }
        layer.update(doc, buildRoadNetwork(doc));
      }
      const fresh = new StreetscapeLayer();
      fresh.update(doc, buildRoadNetwork(doc));
      expect(spots(layer), `seed ${seed}`).toBe(spots(fresh));
      expect(layer.stats().trees).toBe(fresh.stats().trees);
      layer.dispose();
      fresh.dispose();
    }
  });

  it('low quality: shorter tree LODs, no tree shadows, one mountain ring', () => {
    const doc = grid(4, 200);
    const layer = new StreetscapeLayer();
    layer.update(doc, buildRoadNetwork(doc));
    const cam = new THREE.Vector3(300, 2, 200);
    layer.frame(cam, 50);
    const normal = layer.stats();
    expect(normal.treeShadows).toBe(true);
    layer.setQuality('low');
    layer.frame(cam, 50);
    const low = layer.stats();
    expect(low.quality).toBe('low');
    expect(low.treeShadows).toBe(false);
    expect(low.drawn.tree0).toBeLessThan(normal.drawn.tree0);
    expect(low.drawn.tree1).toBeLessThan(normal.drawn.tree1);
    expect(low.drawn.lamp1).toBeLessThan(normal.drawn.lamp1);
    layer.setQuality('normal');
    layer.frame(cam, 50);
    expect(layer.stats().drawn).toEqual(normal.drawn);
    layer.dispose();

    const m = createMountains();
    expect(m.rings).toBe(3);
    m.setQuality('low');
    expect(m.rings).toBe(1);
    m.setQuality('normal');
    expect(m.rings).toBe(3);
    m.dispose();
  });
});

describe('median trees (P7c-2)', () => {
  const SEG = 'x1_1';
  const medianTrees = (doc: CityDoc, p: SegmentStreetscape) => p.trees.filter((t) => Math.abs(along(doc, SEG, t).off) < 1e-6);

  it('one row on the center line of a planted median, clear of the junctions and a crosswalk, inside the island', () => {
    const doc = grid(3, 160, 'road-8-median');
    doc.features.cw = { id: 'cw', segmentId: SEG, kind: 'crosswalk', t: 0.5 };
    const net = buildRoadNetwork(doc);
    const g = net.segments.get(SEG)!;
    const p = placeSegment(g, segmentContexts(doc, net).get(SEG)!);
    const row = medianTrees(doc, p);
    expect(row.length).toBeGreaterThanOrEqual(8);
    expect(placeSegment(g, segmentContexts(doc, net).get(SEG)!)).toEqual(p);
    // Same species as the sidewalks (one per street); the sidewalks keep their rows.
    expect(new Set(p.trees.map((t) => t.species)).size).toBe(1);
    expect(p.trees.length - row.length).toBeGreaterThanOrEqual(12);
    const cw = g.crossings.find((c) => c.kind === 'midblock')!;
    const pieces = medianPieces(g.laneStartA, g.length - g.laneStartB, g.crossings);
    for (const t of row) {
      const { s } = along(doc, SEG, t);
      expect(s).toBeGreaterThanOrEqual(g.laneStartA + JUNCTION_CLEAR - 1e-6);
      expect(s).toBeLessThanOrEqual(g.length - g.laneStartB - JUNCTION_CLEAR + 1e-6);
      expect(Math.abs(s - cw.s)).toBeGreaterThanOrEqual(cw.width / 2 + CROSSING_CLEAR);
      // On the drawn island (the median is cut at the crosswalk).
      expect(pieces.some(([a, b]) => s > a && s < b)).toBe(true);
    }
    // Trees on both sides of the crosswalk.
    expect(row.some((t) => along(doc, SEG, t).s < cw.s) && row.some((t) => along(doc, SEG, t).s > cw.s)).toBe(true);
  });

  // Sol's repro: on a narrow road a stop's clear radius (9 m) reaches the median row.
  it('a narrow median road: the median row keeps clear of a stop and a sensor on either side', () => {
    const doc = createEmptyDoc();
    doc.roadTypes.narrow = { ...doc.roadTypes['road-2']!, id: 'narrow', median: { width: 2, planted: true } };
    doc.nodes.a = { id: 'a', pos: { x: 0, z: 0 } };
    doc.nodes.b = { id: 'b', pos: { x: 200, z: 0 } };
    doc.segments.s = { id: 's', a: 'a', b: 'b', roadTypeId: 'narrow' };
    const onMedian = (p: SegmentStreetscape) => p.trees.filter((t) => Math.abs(t.z) < 1e-6);
    const placed = () => {
      const net = buildRoadNetwork(doc);
      return { p: placeSegment(net.segments.get('s')!, segmentContexts(doc, net).get('s')!), g: net.segments.get('s')! };
    };
    const before = onMedian(placed().p);
    expect(before.length).toBeGreaterThan(10);
    const t0 = before[Math.floor(before.length / 2)]!;
    const curb = carriagewayWidth(doc.roadTypes.narrow!) / 2;
    doc.busStops.st = { id: 'st', segmentId: 's', t: t0.x / 200, dir: 'forward' };
    const { p } = placed();
    const after = onMedian(p);
    expect(after.length).toBeLessThan(before.length);
    // The stop's clear circle is on the forward sidewalk's planting line (right of a → b: −z here or +z, either way |z| = curb + inset).
    for (const t of after) expect(Math.hypot(t.x - t0.x, Math.abs(t.z) - (curb + TREE_INSET))).toBeGreaterThanOrEqual(STOP_CLEAR);
    delete doc.busStops.st;
    doc.sensors.cam = { id: 'cam', kind: 'cctv', segmentId: 's', t: t0.x / 200, side: 'left', heading: 0, fov: 1, range: 60 };
    const withSensor = onMedian(placed().p);
    for (const t of withSensor) expect(Math.hypot(t.x - t0.x, Math.abs(t.z) - (curb + TREE_INSET))).toBeGreaterThanOrEqual(SENSOR_CLEAR);
  });

  it('none on a concrete or too narrow median; a planted median without sidewalks keeps its row', () => {
    const doc = grid(3, 100, 'road-8-median');
    const rt = doc.roadTypes['road-8-median']!;
    doc.roadTypes['road-8-median'] = { ...rt, median: { width: 6, planted: false } };
    expect(medianTrees(doc, place(doc, SEG))).toEqual([]);
    doc.roadTypes['road-8-median'] = { ...rt, median: { width: MEDIAN_TREE_MIN_WIDTH - 0.5, planted: true } };
    expect(medianTrees(doc, place(doc, SEG))).toEqual([]);
    doc.roadTypes['road-8-median'] = { ...rt, sidewalk: false };
    const bare = place(doc, SEG);
    expect(bare.lamps).toEqual([]);
    expect(bare.trees.length).toBeGreaterThan(0);
    expect(medianTrees(doc, bare)).toEqual(bare.trees);
  });

  it('the signature sees every median change: planted, width, sidewalks, a crosswalk', () => {
    const doc = grid(3, 100, 'road-8-median');
    const layer = new StreetscapeLayer();
    layer.update(doc, buildRoadNetwork(doc));
    const fresh = () => {
      const f = new StreetscapeLayer();
      f.update(doc, buildRoadNetwork(doc));
      const out = { spots: spots(f), trees: f.stats().trees };
      f.dispose();
      return out;
    };
    const planted = layer.stats().trees;
    const rt = doc.roadTypes['road-8-median']!;
    const steps: (() => void)[] = [
      () => (doc.roadTypes['road-8-median'] = { ...rt, median: { width: 6, planted: false } }),
      () => (doc.roadTypes['road-8-median'] = { ...rt, median: { width: 6, planted: true } }),
      () => (doc.features.cw = { id: 'cw', segmentId: SEG, kind: 'crosswalk', t: 0.5 }),
      () => (doc.roadTypes['road-8-median'] = { ...rt, sidewalk: false }),
      () => (doc.roadTypes['road-8-median'] = { ...rt, sidewalk: false, median: { width: 6.000001, planted: true } }),
    ];
    for (const [i, step] of steps.entries()) {
      step();
      layer.update(doc, buildRoadNetwork(doc));
      expect(layer.stats().lastRebuilt, `step ${i}`).toBeGreaterThan(0);
      const f = fresh();
      expect(spots(layer), `step ${i}`).toBe(f.spots);
      expect(layer.stats().trees).toBe(f.trees);
    }
    expect(planted).toBeGreaterThan(0);
    layer.dispose();
  });

  it('low quality: median trees go to the cheaper LODs like the sidewalk ones', () => {
    const doc = grid(4, 200, 'road-8-median');
    const layer = new StreetscapeLayer();
    layer.update(doc, buildRoadNetwork(doc));
    // On the median of x1_1 (z = 200), at eye level.
    const cam = new THREE.Vector3(300, 2, 200);
    layer.frame(cam, 50);
    const normal = layer.stats();
    const nearRow = layer.near(300, 200, 30).trees.filter((t) => Math.abs(t.z - 200) < 1e-6).length;
    expect(nearRow).toBeGreaterThan(2);
    expect(normal.drawn.tree0).toBeGreaterThanOrEqual(layer.near(300, 200, TREE_NEAR - 3).trees.length);
    layer.setQuality('low');
    layer.frame(cam, 50);
    const low = layer.stats();
    expect(low.drawn.tree0).toBeLessThan(normal.drawn.tree0);
    expect(low.drawn.tree0).toBeGreaterThanOrEqual(layer.near(300, 200, 35 - 3).trees.length);
    expect(low.drawn.tree1).toBeLessThan(normal.drawn.tree1);
    expect(low.treeShadows).toBe(false);
    layer.dispose();
  });
});
