import { describe, expect, it } from 'vitest';
import { applyCommand, closestPointOnPolyline, createEmptyDoc } from '@smartcity/shared';
import type * as THREE from 'three';
import { crossDoc, road } from '../test/fixtures';
import { buildRoadNetwork, fallbackNetwork, type RoadNetworkGeom } from './roadNetwork';
import { C_HEDGE, C_MEDIAN, C_MEDIAN_GRASS, C_WALK, medianPieces, RoadLayer, Y_MARK, Y_WALK } from './roads';
import { BUMP_HEIGHT, medianClipChecks, resetMedianClipChecks } from './streetMarks';

describe('RoadLayer chunk rebuilds', () => {
  it('rebuilds only chunks whose roads changed', () => {
    const { doc, ids } = crossDoc();
    const layer = new RoadLayer();
    layer.update(fallbackNetwork(doc));
    const initial = layer.chunkCount;
    expect(initial).toBeGreaterThan(0);
    expect(layer.lastRebuilt).toBe(initial);

    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);

    // A road far away touches exactly one new chunk.
    road(doc, { x: 1000, z: 1000 }, { x: 1040, z: 1000 }, ids);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(1);
    expect(layer.chunkCount).toBe(initial + 1);
    // Each chunk is a single merged mesh (one draw call).
    expect(layer.group.children.length).toBe(layer.chunkCount);
  });
});

describe('RoadLayer street facilities', () => {
  const firstSegment = (doc: ReturnType<typeof crossDoc>['doc']): string => Object.keys(doc.segments).sort()[0]!;

  it('rebuilds only the touched chunk when a speed bump or school zone changes', () => {
    const { doc, ids } = crossDoc();
    road(doc, { x: 1000, z: 1000 }, { x: 1040, z: 1000 }, ids);
    const layer = new RoadLayer();
    layer.update(fallbackNetwork(doc));
    expect(layer.chunkCount).toBe(2);
    const seg = firstSegment(doc);

    expect(applyCommand(doc, { type: 'feature.upsert', feature: { id: 'f1', segmentId: seg, kind: 'speedBump', t: 0.5 } }).ok).toBe(true);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(1);

    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);

    expect(applyCommand(doc, { type: 'segment.setSchoolZone', id: seg, schoolZone: true }).ok).toBe(true);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBeGreaterThanOrEqual(1);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);

    expect(applyCommand(doc, { type: 'feature.remove', id: 'f1' }).ok).toBe(true);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBeGreaterThanOrEqual(1);
  });

  it('rebuilds the roads at a junction when its control or crosswalk legs change', () => {
    const { doc } = crossDoc();
    const layer = new RoadLayer();
    layer.update(fallbackNetwork(doc));
    const center = Object.values(doc.nodes).find((n) => n.pos.x === 0 && n.pos.z === 0)!;
    const legs = Object.keys(doc.segments).sort().slice(0, 2);
    const r = applyCommand(doc, { type: 'intersection.set', control: { nodeId: center.id, kind: 'allStop', crosswalkLegs: legs, yellow: 3, allRed: 2, offset: 0 } });
    expect(r.ok).toBe(true);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBeGreaterThanOrEqual(1);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);
  });

  it('draws crossings from the compiled network and moves nothing when there are none', () => {
    const { doc } = crossDoc();
    const net = fallbackNetwork(doc);
    const plain = new RoadLayer();
    plain.update(net);
    const withCrossing = new RoadLayer();
    const seg = net.segments.get(firstSegment(doc))!;
    const mid = seg.length / 2;
    seg.crossings.push({
      index: 0,
      id: 'c0',
      kind: 'midblock',
      segmentId: seg.id,
      s: mid,
      a: { x: -mid, z: 4 },
      b: { x: -mid, z: -4 },
      width: 4,
      polygon: [
        { x: -mid - 2, z: 4 },
        { x: -mid + 2, z: 4 },
        { x: -mid + 2, z: -4 },
        { x: -mid - 2, z: -4 },
      ],
      signal: false,
      schoolZone: false,
    });
    withCrossing.update(net);
    const tris = (l: RoadLayer): number => l.group.children.reduce((n, m) => n + (m as THREE.Mesh).geometry.getAttribute('position').count / 3, 0);
    expect(tris(withCrossing)).toBeGreaterThan(tris(plain));
  });
});

describe('RoadLayer smooth joints (fillets, ADR 0012 §1)', () => {
  /** A → V → C corner of road-2, rounded by road.fillet (new nodes fa, fb; curve fc). */
  function filletDoc() {
    const doc = createEmptyDoc();
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'A', pos: { x: -100, z: 0 } } },
        { type: 'node.add', node: { id: 'V', pos: { x: 0, z: 0 } } },
        { type: 'node.add', node: { id: 'C', pos: { x: 0, z: 100 } } },
        { type: 'segment.add', segment: { id: 'sa', a: 'A', b: 'V', roadTypeId: 'road-2' } },
        { type: 'segment.add', segment: { id: 'sb', a: 'V', b: 'C', roadTypeId: 'road-2' } },
        { type: 'road.fillet', nodeId: 'V', ids: { a: 'fa', b: 'fb', seg: 'fc' } },
      ],
    });
    expect(r).toEqual({ ok: true });
    return doc;
  }

  it('marks the curve ends as smooth joints (compiled and fallback) and leaves sharp corners alone', () => {
    const doc = filletDoc();
    for (const net of [buildRoadNetwork(doc), fallbackNetwork(doc)]) {
      expect(net.nodes.get('fa')!.joint).toBeDefined();
      expect(net.nodes.get('fb')!.joint).toBeDefined();
      expect(net.nodes.get('A')!.joint).toBeUndefined();
    }
    const sharp = createEmptyDoc();
    applyCommand(sharp, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'A', pos: { x: -100, z: 0 } } },
        { type: 'node.add', node: { id: 'V', pos: { x: 0, z: 0 } } },
        { type: 'node.add', node: { id: 'C', pos: { x: 0, z: 100 } } },
        { type: 'segment.add', segment: { id: 'sa', a: 'A', b: 'V', roadTypeId: 'road-2' } },
        { type: 'segment.add', segment: { id: 'sb', a: 'V', b: 'C', roadTypeId: 'road-2' } },
      ],
    });
    expect(buildRoadNetwork(sharp).nodes.get('V')!.joint).toBeUndefined();
  });

  it('the straight road and the curve share their edge points at the joint (no wedge, gap or overlap)', () => {
    const doc = filletDoc();
    const net = buildRoadNetwork(doc);
    /** Mesh vertices (x, z) of one road drawn alone. */
    const vertices = (segId: string): { x: number; z: number }[] => {
      const layer = new RoadLayer();
      layer.update({ ...net, segments: new Map([[segId, net.segments.get(segId)!]]) });
      const out: { x: number; z: number }[] = [];
      for (const m of layer.group.children as THREE.Mesh[]) {
        const a = m.geometry.getAttribute('position').array as Float32Array;
        for (let i = 0; i < a.length; i += 3) out.push({ x: a[i]!, z: a[i + 2]! });
      }
      return out;
    };
    const p0 = doc.nodes.fa!.pos;
    const straight = vertices('sa');
    const curve = vertices('fc');
    // At fa the joint runs along +x: curb (±3.5) and outer sidewalk edge (±6) of both roads end on the same
    // points. Without the shared end direction the curve's edges would start up to ~0.3 m off them.
    for (const edge of [-6, -3.5, 3.5, 6]) {
      const target = { x: p0.x, z: p0.z + edge };
      for (const vs of [straight, curve]) expect(Math.min(...vs.map((q) => Math.hypot(q.x - target.x, q.z - target.z)))).toBeLessThan(1e-3);
    }
    // And the curve is drawn from the node itself (no junction cut, no polygon at the joint).
    expect(Math.min(...curve.map((q) => Math.abs(q.x - p0.x)))).toBeLessThan(1e-3);
  });
});

describe('RoadLayer medians (P7c-2, ADR 0014 §4)', () => {
  /** Two road-8-median boulevards crossing at (0, 0); a crosswalk halfway along E, a speed bump halfway along W. */
  function medianCross(planted = true) {
    const doc = createEmptyDoc();
    if (!planted) doc.roadTypes['road-8-median'] = { ...doc.roadTypes['road-8-median']!, median: { width: 6, planted: false } };
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        ...(
          [
            ['c', 0, 0],
            ['w', -200, 0],
            ['e', 200, 0],
            ['n', 0, -200],
            ['s', 0, 200],
          ] as const
        ).map(([id, x, z]) => ({ type: 'node.add' as const, node: { id, pos: { x, z } } })),
        { type: 'segment.add', segment: { id: 'W', a: 'w', b: 'c', roadTypeId: 'road-8-median' } },
        { type: 'segment.add', segment: { id: 'E', a: 'c', b: 'e', roadTypeId: 'road-8-median' } },
        { type: 'segment.add', segment: { id: 'N', a: 'n', b: 'c', roadTypeId: 'road-8-median' } },
        { type: 'segment.add', segment: { id: 'S', a: 'c', b: 's', roadTypeId: 'road-8-median' } },
        { type: 'feature.upsert', feature: { id: 'cw', segmentId: 'E', kind: 'crosswalk', t: 0.5 } },
        { type: 'feature.upsert', feature: { id: 'sb', segmentId: 'W', kind: 'speedBump', t: 0.5 } },
      ],
    });
    expect(r).toEqual({ ok: true });
    return doc;
  }

  interface Tri {
    pts: { x: number; y: number; z: number }[];
    color: [number, number, number];
  }
  function triangles(layer: RoadLayer): Tri[] {
    const out: Tri[] = [];
    for (const m of layer.group.children as THREE.Mesh[]) {
      const p = m.geometry.getAttribute('position').array as Float32Array;
      const c = m.geometry.getAttribute('color').array as Float32Array;
      for (let i = 0; i < p.length; i += 9) {
        out.push({ pts: [0, 3, 6].map((k) => ({ x: p[i + k]!, y: p[i + k + 1]!, z: p[i + k + 2]! })), color: [c[i]!, c[i + 1]!, c[i + 2]!] });
      }
    }
    return out;
  }
  const isColor = (t: Tri, c: THREE.Color, tol = 1e-3) => Math.abs(t.color[0] - c.r) < tol && Math.abs(t.color[1] - c.g) < tol && Math.abs(t.color[2] - c.b) < tol;
  /** Triangles of the E-W boulevard (z = 0) away from the N-S one, with every vertex inside the median (|z| ≤ 3). */
  const onEwMedian = (tris: Tri[]) => tris.filter((t) => t.pts.every((q) => Math.abs(q.z) <= 3 + 1e-3 && Math.abs(q.x) > 20));

  it('a raised planted island (grass, hedge, curbs) stopping before the junction and cut at the crosswalk', () => {
    const doc = medianCross();
    const net = buildRoadNetwork(doc);
    const layer = new RoadLayer();
    layer.update(net);
    const tris = triangles(layer);
    const top = tris.filter((t) => t.pts.every((q) => Math.abs(q.y - Y_WALK) < 1e-4 && Math.abs(q.z) <= 3 + 1e-3));
    const grass = top.filter((t) => isColor(t, C_MEDIAN_GRASS));
    expect(grass.length).toBeGreaterThan(0);
    // Hedge: 0.6 m above the island, narrower than it.
    const hedge = tris.filter((t) => isColor(t, C_HEDGE));
    expect(hedge.length).toBeGreaterThan(0);
    expect(Math.max(...hedge.flatMap((t) => t.pts.map((q) => q.y)))).toBeCloseTo(Y_WALK + 0.6, 4);
    expect(Math.max(...hedge.flatMap((t) => t.pts.map((q) => Math.min(Math.abs(q.z), Math.abs(q.x)))))).toBeLessThanOrEqual(0.7 + 1e-3);

    // Junction: no island inside the crosswalk zone of any of the four roads (it stops where the lanes start).
    const start = net.segments.get('E')!.laneStartA;
    expect(start).toBeGreaterThan(net.segments.get('E')!.setbackA);
    const raised = tris.filter((t) => isColor(t, C_MEDIAN_GRASS) || isColor(t, C_HEDGE));
    for (const t of raised) for (const q of t.pts) expect(Math.max(Math.abs(q.x), Math.abs(q.z))).toBeGreaterThanOrEqual(start - 1e-3);

    // Mid-block crosswalk on E: the island and the hedge are cut across the zebra.
    const cw = net.segments.get('E')!.crossings.find((c) => c.kind === 'midblock')!;
    const pieces = medianPieces(start, 200 - net.segments.get('E')!.laneStartB, net.segments.get('E')!.crossings);
    expect(pieces.length).toBe(2);
    for (const t of onEwMedian(raised).filter((t) => t.pts[0]!.x > 0)) for (const q of t.pts) expect(Math.abs(q.x - cw.s)).toBeGreaterThanOrEqual(cw.width / 2);
    // The yellow line along each curb (0.1 … 0.25 m outside it) is cut with it.
    const yellow = tris.filter((t) => t.pts.every((q) => Math.abs(q.y - Y_MARK) < 1e-4 && Math.abs(q.z) >= 3.1 - 1e-3 && Math.abs(q.z) <= 3.25 + 1e-3 && Math.abs(q.x) > 20));
    expect(yellow.length).toBeGreaterThan(0);
    for (const t of yellow) for (const q of t.pts) if (q.x > 0) expect(Math.abs(q.x - cw.s)).toBeGreaterThanOrEqual(cw.width / 2);
    // Curb faces: vertical, from below the asphalt up to the island top, at ±3.
    const curbs = tris.filter((t) => t.pts.some((q) => Math.abs(q.y - Y_WALK) < 1e-4) && t.pts.some((q) => q.y < 0.05) && t.pts.every((q) => Math.abs(Math.abs(q.z) - 3) < 1e-3) && t.pts.every((q) => Math.abs(q.x) > 20));
    expect(curbs.length).toBeGreaterThan(0);
  });

  it('never matches the sidewalk brick color (the shader keys bricks on it)', () => {
    for (const planted of [true, false]) {
      const layer = new RoadLayer();
      layer.update(buildRoadNetwork(medianCross(planted)));
      const island = onEwMedian(triangles(layer)).filter((t) => t.pts.every((q) => q.y >= Y_WALK - 1e-4));
      expect(island.length).toBeGreaterThan(0);
      for (const t of island) expect(isColor(t, C_WALK, 0.003)).toBe(false);
      // Unplanted: plain concrete, no grass or hedge.
      if (!planted) {
        expect(island.some((t) => isColor(t, C_MEDIAN))).toBe(true);
        expect(island.some((t) => isColor(t, C_MEDIAN_GRASS) || isColor(t, C_HEDGE))).toBe(false);
      }
    }
  });

  it('speed bumps cover both driving areas, never the median', () => {
    const doc = medianCross();
    const net = buildRoadNetwork(doc);
    const layer = new RoadLayer();
    layer.update(net);
    const w = net.segments.get('W')!;
    const bumpX = -200 + w.speedBumps[0]!;
    // Bump vertices: between the marking height and its crest, within the bump's 2 m along the road.
    const bump = triangles(layer).filter((t) => t.pts.every((q) => q.y > Y_MARK + 0.002 && q.y < Y_MARK + 0.006 + BUMP_HEIGHT && Math.abs(q.x - bumpX) <= 1 + 1e-3));
    expect(bump.length).toBeGreaterThan(0);
    const zs = bump.flatMap((t) => t.pts.map((q) => q.z));
    expect(Math.min(...zs.map(Math.abs))).toBeCloseTo(3, 3);
    expect(Math.max(...zs.map(Math.abs))).toBeCloseTo(17, 3);
    expect(zs.some((z) => z < 0) && zs.some((z) => z > 0)).toBe(true);
  });

  // Sol's repro: on a curve the bump's cross-sections must follow the median curbs, not one center tangent.
  it('on a curved boulevard the bump stays out of the median (every vertex ≥ 3 m from the center line)', () => {
    const doc = createEmptyDoc();
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'a', pos: { x: -100, z: 0 } } },
        { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
        { type: 'segment.add', segment: { id: 'c', a: 'a', b: 'b', roadTypeId: 'road-8-median', control: { x: 0, z: 200 } } },
        { type: 'feature.upsert', feature: { id: 'sb', segmentId: 'c', kind: 'speedBump', t: 0.5 } },
      ],
    });
    expect(r).toEqual({ ok: true });
    const net = buildRoadNetwork(doc);
    const g = net.segments.get('c')!;
    const layer = new RoadLayer();
    layer.update(net);
    const apex = { x: 0, z: 100 };
    const bump = triangles(layer)
      .flatMap((t) => t.pts)
      .filter((q) => q.y > Y_MARK + 0.002 && q.y < Y_MARK + 0.006 + BUMP_HEIGHT && Math.hypot(q.x - apex.x, q.z - apex.z) < 20);
    expect(bump.length).toBeGreaterThan(0);
    const d = bump.map((q) => closestPointOnPolyline(g.centerline, q).distance);
    // float32 positions: 1e-4 m.
    expect(Math.min(...d)).toBeGreaterThanOrEqual(3 - 1e-4);
    expect(Math.max(...d)).toBeLessThan(17 + 0.01);
    // Both driving areas are covered, right up to the median curbs.
    const side = bump.map((q) => Math.sign(q.z - closestPointOnPolyline(g.centerline, q).point.z));
    expect(side.includes(1) && side.includes(-1)).toBe(true);
    expect(Math.min(...d)).toBeLessThan(3 + 0.01);
  });

  // Sol's recheck repro: on a hairpin the offsets fold over other parts of the curve; corners too close to
  // the whole center line are clipped, and no bump vertex lies on the drawn median grass.
  it('on a hairpin the bump is clipped out of the median', () => {
    const doc = createEmptyDoc();
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'a', pos: { x: -20, z: 0 } } },
        { type: 'node.add', node: { id: 'b', pos: { x: 20, z: 0 } } },
        { type: 'segment.add', segment: { id: 'c', a: 'a', b: 'b', roadTypeId: 'road-8-median', control: { x: 0, z: 200 } } },
        { type: 'feature.upsert', feature: { id: 'sb', segmentId: 'c', kind: 'speedBump', t: 0.5 } },
      ],
    });
    expect(r).toEqual({ ok: true });
    const net = buildRoadNetwork(doc);
    const g = net.segments.get('c')!;
    const layer = new RoadLayer();
    layer.update(net);
    const tris = triangles(layer);
    const near = (q: { x: number; z: number }) => Math.hypot(q.x, q.z - 100) < 25;
    const bump = tris.flatMap((t) => t.pts).filter((q) => q.y > Y_MARK + 0.002 && q.y < Y_MARK + 0.006 + BUMP_HEIGHT && near(q));
    expect(bump.length).toBeGreaterThan(0);
    for (const q of bump) expect(closestPointOnPolyline(g.centerline, q).distance).toBeGreaterThanOrEqual(3 - 1e-4);
    // XZ inside a median grass triangle (strictly, barycentric).
    const grass = tris.filter((t) => isColor(t, C_MEDIAN_GRASS) && t.pts.every(near));
    expect(grass.length).toBeGreaterThan(0);
    const inside = (q: { x: number; z: number }, t: Tri) => {
      const [p0, p1, p2] = t.pts as [Tri['pts'][0], Tri['pts'][0], Tri['pts'][0]];
      const d = (p1.z - p2.z) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.z - p2.z);
      const u = ((p1.z - p2.z) * (q.x - p2.x) + (p2.x - p1.x) * (q.z - p2.z)) / d;
      const v = ((p2.z - p0.z) * (q.x - p2.x) + (p0.x - p2.x) * (q.z - p2.z)) / d;
      return u > 1e-6 && v > 1e-6 && 1 - u - v > 1e-6;
    };
    expect(bump.filter((q) => grass.some((t) => inside(q, t)))).toEqual([]);
  });

  // Sol's recheck 2 repro: adding a bump to a long curved boulevard rebuilds every bump on it; the median clip
  // scanned the whole center line (2,238 points) per corner and the update took ~1.2 s. The normal run counts
  // the clip's point-to-chord distance checks (deterministic); SC_PERF=1 also times the bumps against the
  // same road without bumps (a 3 km curve costs ~150 ms to draw by itself, unchanged from before P7c-2).
  it('perf: a 31st bump on a 3 km curved boulevard adds little to its rebuild', () => {
    const boulevard = (bumps: number) => {
      const doc = createEmptyDoc();
      const r = applyCommand(doc, {
        type: 'batch',
        commands: [
          { type: 'node.add', node: { id: 'a', pos: { x: -1000, z: 0 } } },
          { type: 'node.add', node: { id: 'b', pos: { x: 1000, z: 0 } } },
          { type: 'segment.add', segment: { id: 'c', a: 'a', b: 'b', roadTypeId: 'road-8-median', control: { x: 0, z: 2000 } } },
          ...Array.from({ length: bumps }, (_, i) => ({ type: 'feature.upsert' as const, feature: { id: `sb${i}`, segmentId: 'c', kind: 'speedBump' as const, t: i < 30 ? 0.15 + i * 0.02 : 0.85 } })),
        ],
      });
      expect(r).toEqual({ ok: true });
      return doc;
    };
    // The edit itself: 30 bumps, then a 31st (only this road's chunk is rebuilt, all its bumps with it).
    const doc = boulevard(30);
    const layer = new RoadLayer();
    layer.update(buildRoadNetwork(doc));
    expect(applyCommand(doc, { type: 'feature.upsert', feature: { id: 'sb30', segmentId: 'c', kind: 'speedBump', t: 0.85 } }).ok).toBe(true);
    const net = buildRoadNetwork(doc);
    expect(net.segments.get('c')!.centerline.length).toBeGreaterThan(2000);
    resetMedianClipChecks();
    layer.update(net);
    expect(layer.lastRebuilt).toBe(1);
    // Only chords within the bump's box (+ the median half width) are checked: measured 615,600 distance checks
    // for the 31 bumps, where scanning the whole center line per corner did 52,533,708.
    const checks = medianClipChecks();
    expect(checks).toBeGreaterThan(0);
    expect(checks).toBeLessThan(2_000_000);
    const strict = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SC_PERF === '1';
    if (!strict) return;
    /** Median of 3 fresh builds, ms. */
    const time = (n: RoadNetworkGeom) => {
      const t: number[] = [];
      for (let k = 0; k < 3; k++) {
        const l = new RoadLayer();
        const t0 = performance.now();
        l.update(n);
        t.push(performance.now() - t0);
      }
      return t.sort((p, q) => p - q)[1]!;
    };
    const plain = buildRoadNetwork(boulevard(0));
    time(plain);
    const bumps = time(net) - time(plain);
    // Measured ~20 ms alone.
    expect(bumps).toBeLessThan(60);
  });

  it('a median edit rebuilds the chunks of its roads', () => {
    const doc = medianCross();
    const layer = new RoadLayer();
    layer.update(buildRoadNetwork(doc));
    layer.update(buildRoadNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);
    expect(applyCommand(doc, { type: 'roadType.upsert', roadType: { ...doc.roadTypes['road-8-median']!, median: { width: 6, planted: false } } }).ok).toBe(true);
    layer.update(buildRoadNetwork(doc));
    expect(layer.lastRebuilt).toBeGreaterThan(0);
    expect(onEwMedian(triangles(layer)).some((t) => isColor(t, C_MEDIAN_GRASS))).toBe(false);
  });
});
