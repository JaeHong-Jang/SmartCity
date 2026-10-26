import { describe, expect, it } from 'vitest';
import { applyCommand, bezierMinRadius, createEmptyDoc, polylineLength, quadBezier, sampleSegmentCurve, type CityDoc, type Command, type Vec2 } from '@smartcity/shared';
import {
  dashes,
  defaultControl,
  endTangent,
  finalCurveProblem,
  handleControl,
  isDoubleClick,
  pieceLabel,
  quadFoldsBack,
  quadMinRadius,
  rdp,
  RoadIndex,
  neighbourhoodDoc,
  rdpTolerance,
  simplifyStroke,
  snapCursor,
  splinePieces,
  strokePieces,
  type SnapHold,
} from './drawInput';

function docWith(cmds: Command[]): CityDoc {
  const doc = createEmptyDoc();
  expect(applyCommand(doc, { type: 'batch', commands: cmds })).toEqual({ ok: true });
  return doc;
}

const road = (id: string, a: Vec2, b: Vec2, control?: Vec2): Command[] => [
  { type: 'node.add', node: { id: `${id}a`, pos: a } },
  { type: 'node.add', node: { id: `${id}b`, pos: b } },
  { type: 'segment.add', segment: { id, a: `${id}a`, b: `${id}b`, roadTypeId: 'road-2', ...(control ? { control } : {}) } },
];

describe('magnet snapping (b1)', () => {
  const doc = docWith(road('r', { x: 0, z: 0 }, { x: 100, z: 0 }));
  const snap = (cursor: Vec2, extra: Partial<Parameters<typeof snapCursor>[0]> = {}) => snapCursor({ doc, cursor, mPerPx: 0.5, gridStep: 8, ...extra });

  it('priority: road end > point on a road > angle guide > grid > free', () => {
    expect(snap({ x: 2, z: 1 })).toMatchObject({ kind: 'node', id: 'ra' });
    expect(snap({ x: 50, z: 3 })).toMatchObject({ kind: 'road', id: 'r', pos: { x: 50, z: 0 }, ref: { kind: 'split', segmentId: 'r' } });
    // Near a road end (< 8 m along it) the road hit becomes that end node, as the planner does.
    expect(snap({ x: 95, z: 4 })).toMatchObject({ kind: 'node', id: 'rb' });
    expect(snap({ x: 30, z: 31 + 50 }, { from: { x: 0, z: 50 } }).kind).toBe('angle');
    expect(snap({ x: 17.5, z: 30.2 })).toMatchObject({ kind: 'grid', pos: { x: 16, z: 32 } });
    // Zoomed in: the 12 px radius is only 0.6 m, so the cursor stays free.
    expect(snap({ x: 18.9, z: 30.2 }, { mPerPx: 0.05 }).kind).toBe('free');
    expect(snap({ x: 2, z: 1 }, { disabled: true }).kind).toBe('free');
  });

  it('ties are deterministic: distance, then id', () => {
    const two = docWith([...road('p', { x: -50, z: 0 }, { x: -10, z: 0 }), ...road('q', { x: 10, z: 0 }, { x: 50, z: 0 })]);
    // Equidistant to pb (-10,0) and qa (10,0): the lower id wins.
    expect(snapCursor({ doc: two, cursor: { x: 0, z: 0 }, mPerPx: 1, gridStep: 0 }).id).toBe('pb');
    expect(snapCursor({ doc: two, cursor: { x: 0.5, z: 0 }, mPerPx: 1, gridStep: 0 }).id).toBe('qa');
  });

  it('hysteresis in screen pixels: enter 12 px, leave 18 px, no flicker at the boundary', () => {
    const single = docWith(road('r', { x: 0, z: 0 }, { x: 0, z: -200 }));
    let held: SnapHold | null = null;
    const step = (d: number): string => {
      const r = snapCursor({ doc: single, cursor: { x: d, z: 0.01 }, mPerPx: 1, gridStep: 0, held });
      held = r.kind === 'free' ? null : { kind: r.kind, id: r.id };
      return r.kind;
    };
    expect([13, 11.9, 12.1, 11.9, 12.1, 15, 17.9, 18.1, 15, 12.5].map(step)).toEqual(['free', 'node', 'node', 'node', 'node', 'node', 'node', 'free', 'free', 'free']);
    // Pixels, not meters: the same 15 m is inside the radius when zoomed out (2 m/px).
    expect(snapCursor({ doc: single, cursor: { x: 15, z: 0 }, mPerPx: 2, gridStep: 0 }).kind).toBe('node');
  });

  it('angle guides: exact multiples of 15°, also relative to the roads at the start; whole-meter length', () => {
    const from = { x: 0, z: 50 };
    const a = snap({ x: 30, z: 81 }, { from });
    expect(a.kind).toBe('angle');
    expect(Math.atan2(a.pos.z - from.z, a.pos.x - from.x)).toBeCloseTo(Math.PI / 4, 12);
    expect(Math.hypot(a.pos.x - from.x, a.pos.z - from.z)).toBeCloseTo(43, 12);
    // A road leaving at 10°: guides at 10° + k·15° (here 55°) beat the absolute 60° when closer.
    const ref = { x: Math.cos((10 * Math.PI) / 180), z: Math.sin((10 * Math.PI) / 180) };
    const target = (55 * Math.PI) / 180;
    const b = snap({ x: 60 * Math.cos(target) + 0.3, z: 50 + 60 * Math.sin(target) }, { from, refDirs: [ref] });
    expect(b.kind).toBe('angle');
    expect((Math.atan2(b.pos.z - from.z, b.pos.x - from.x) * 180) / Math.PI).toBeCloseTo(55, 9);
  });

  it('length and bearing label, dashed guides', () => {
    expect(pieceLabel({ x: 0, z: 0 }, { x: 0, z: -43 })).toBe('43.0 m · 0°');
    expect(pieceLabel({ x: 0, z: 0 }, { x: 30, z: 0 })).toBe('30.0 m · 90°');
    const d = dashes({ x: 0, z: 0 }, { x: 10, z: 0 }, 3, 2);
    expect(d.map((p) => [p[0]!.x, p[1]!.x])).toEqual([
      [0, 3],
      [5, 8],
    ]);
  });
});

describe('curve control rules (b2)', () => {
  it('a dead end continues along the derivative of its curve, not the chord', () => {
    const doc = docWith([...road('s', { x: 0, z: 0 }, { x: 100, z: 0 }), ...road('c', { x: 0, z: 100 }, { x: 100, z: 100 }, { x: 50, z: 150 })]);
    expect(endTangent(doc, 'sb')).toEqual({ x: 1, z: 0 });
    expect(endTangent(doc, 'sa')).toEqual({ x: -1, z: 0 });
    const t = endTangent(doc, 'cb')!;
    expect(t.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(t.z).toBeCloseTo(-Math.SQRT1_2, 12);
  });

  it('default control: on the tangent, half the chord out; the handle slides along the tangent', () => {
    expect(defaultControl({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 40, z: 30 })).toEqual({ x: 25, z: 0 });
    expect(defaultControl({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 0 })).toBeNull();
    expect(handleControl({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 30, z: 17 })).toEqual({ x: 30, z: 0 });
    expect(handleControl({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: -30, z: 17 })).toEqual({ x: 1, z: 0 });
  });

  it('exact minimum radius of any quadratic Bezier', () => {
    // Symmetric fillet: same as the P5a formula.
    const t = 20;
    expect(quadMinRadius({ x: -t, z: 0 }, { x: 0, z: 0 }, { x: 0, z: t })).toBeCloseTo(bezierMinRadius(t, Math.PI / 2), 9);
    // Asymmetric: against dense numeric sampling.
    const p0 = { x: 0, z: 0 };
    const c = { x: 60, z: 5 };
    const p2 = { x: 70, z: 50 };
    let best = Infinity;
    for (let i = 0; i <= 4000; i++) {
      const u = i / 4000;
      const d = { x: 2 * (1 - u) * (c.x - p0.x) + 2 * u * (p2.x - c.x), z: 2 * (1 - u) * (c.z - p0.z) + 2 * u * (p2.z - c.z) };
      const dd = { x: 2 * (p0.x - 2 * c.x + p2.x), z: 2 * (p0.z - 2 * c.z + p2.z) };
      best = Math.min(best, Math.hypot(d.x, d.z) ** 3 / Math.abs(d.x * dd.z - d.z * dd.x));
    }
    expect(quadMinRadius(p0, c, p2)).toBeCloseTo(best, 4);
    expect(quadMinRadius(p0, { x: 5, z: 0 }, { x: 10, z: 0 })).toBe(Infinity);
  });
});

/** S-shaped stroke sampled every 1 m: two 90 m arcs. */
function sStroke(): Vec2[] {
  const out: Vec2[] = [];
  for (let s = 0; s <= 180; s += 1) {
    const x = s;
    const z = 40 * Math.sin((s / 180) * 2 * Math.PI);
    out.push({ x, z });
  }
  return out;
}

describe('free-hand strokes (b3)', () => {
  it('RDP keeps both ends; spacing keeps every piece at least 8 m', () => {
    const path = sStroke();
    const r = rdp(path, 1.5);
    expect(r[0]).toEqual(path[0]);
    expect(r[r.length - 1]).toEqual(path[path.length - 1]);
    expect(r.length).toBeGreaterThan(3);
    const v = simplifyStroke(path, 1.5);
    for (let i = 1; i < v.length; i++) expect(Math.hypot(v[i]!.x - v[i - 1]!.x, v[i]!.z - v[i - 1]!.z)).toBeGreaterThanOrEqual(16 - 1e-9);
    for (const p of splinePieces(v)) expect(polylineLength(sampleSegmentCurve(p.from, p.to, p.control))).toBeGreaterThanOrEqual(8);
    expect(finalCurveProblem(splinePieces(simplifyStroke([{ x: 0, z: 0 }, { x: 50, z: 2 }, { x: 0, z: 10 }, { x: 48, z: 16 }], 1)), 10)).not.toBeNull();
    // A gentle bend close to a neighbour is merged; a sharp short feature is kept (and refused later).
    expect(simplifyStroke([{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 40, z: 3 }, { x: 60, z: 0 }], 0.5)).toEqual([{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 60, z: 0 }]);
    const zig = [{ x: 0, z: 0 }, { x: 50, z: 2 }, { x: 0, z: 10 }, { x: 48, z: 16 }];
    expect(simplifyStroke(zig, 1)).toEqual(zig);
    expect(rdpTolerance(0.1)).toBe(0.5);
    expect(rdpTolerance(0.5)).toBe(1);
    expect(rdpTolerance(5)).toBe(1.5);
  });

  it('B-spline pieces: end points preserved, tangent-continuous joints (C1), on our segment format', () => {
    const v = simplifyStroke(sStroke(), 1.5);
    const pieces = splinePieces(v);
    expect(pieces[0]!.from).toEqual(v[0]);
    expect(pieces[pieces.length - 1]!.to).toEqual(v[v.length - 1]);
    for (let i = 1; i < pieces.length; i++) {
      const a = pieces[i - 1]!;
      const b = pieces[i]!;
      expect(b.from).toEqual(a.to);
      const t0 = { x: a.to.x - a.control!.x, z: a.to.z - a.control!.z };
      const t1 = { x: b.control!.x - b.from.x, z: b.control!.z - b.from.z };
      // Same direction at the joint: cross ≈ 0, dot > 0.
      expect(Math.abs(t0.x * t1.z - t0.z * t1.x) / (Math.hypot(t0.x, t0.z) * Math.hypot(t1.x, t1.z))).toBeLessThan(1e-12);
      expect(t0.x * t1.x + t0.z * t1.z).toBeGreaterThan(0);
    }
    expect(splinePieces([{ x: 0, z: 0 }, { x: 10, z: 0 }])).toEqual([{ from: { x: 0, z: 0 }, to: { x: 10, z: 0 } }]);
  });

  it('crossings of the raw stroke with existing roads are kept exactly as piece ends', () => {
    const path = sStroke();
    const roads = [{ id: 'v', pts: [{ x: 90, z: -100 }, { x: 90, z: 100 }] }];
    const pieces = strokePieces(path, roads, 1.5);
    const cut = pieces.filter((p) => p.crossing);
    expect(cut).toHaveLength(1);
    expect(cut[0]!.crossing).toBe('v');
    expect(cut[0]!.to.x).toBeCloseTo(90, 9);
    // The final curve passes through it.
    const i = pieces.indexOf(cut[0]!);
    expect(pieces[i + 1]!.from).toEqual(cut[0]!.to);
    expect(quadBezier(pieces[i]!.from, pieces[i]!.control ?? pieces[i]!.from, pieces[i]!.to, 1)).toEqual(cut[0]!.to);
  });

  it('the final curve is checked and refused with a reason, never bent to fit', () => {
    expect(finalCurveProblem(splinePieces(simplifyStroke(sStroke(), 1.5)), 10)).toBeNull();
    // A hairpin zig-zag: far tighter than the 10 m floor of a 2-lane road.
    const zig = splinePieces([{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 0, z: 6 }, { x: 40, z: 12 }]);
    expect(finalCurveProblem(zig, 10)).toMatch(/^곡선이 너무 급합니다 \(최소 반경 \d+\.\d m < 10\.0 m\)$/);
    // A loop crossing itself.
    const loop = splinePieces([{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 50, z: 100 }, { x: 50, z: -60 }]);
    expect(finalCurveProblem(loop, 1)).toBe('도로가 자기 자신과 교차합니다');
  });
});

describe('finishing a stroke', () => {
  it('a second click close in time and place is a double click (it adds no point)', () => {
    expect(isDoubleClick(null, { t: 0, x: 0, y: 0 })).toBe(false);
    expect(isDoubleClick({ t: 0, x: 0, y: 0 }, { t: 300, x: 3, y: 3 })).toBe(true);
    expect(isDoubleClick({ t: 0, x: 0, y: 0 }, { t: 400, x: 0, y: 0 })).toBe(false);
    expect(isDoubleClick({ t: 0, x: 0, y: 0 }, { t: 100, x: 9, y: 0 })).toBe(false);
  });
});

describe('Sol P5b review regressions', () => {
  it('#3 a curve that folds back on itself is rejected (zero derivative inside), and RDP keeps the turnaround', () => {
    const p0 = { x: 0, z: 0 };
    const c = { x: 100, z: 0 };
    const p2 = { x: 20, z: 0 };
    expect(quadFoldsBack(p0, c, p2)).toBe(true);
    expect(quadMinRadius(p0, c, p2)).toBe(0);
    expect(finalCurveProblem([{ from: p0, control: c, to: p2 }], 10)).toBe('곡선이 제자리에서 되돌아갑니다');
    // A straight piece with its control on the chord is not a fold-back.
    expect(quadFoldsBack(p0, { x: 10, z: 0 }, { x: 20, z: 0 })).toBe(false);
    expect(quadMinRadius(p0, { x: 10, z: 0 }, { x: 20, z: 0 })).toBe(Infinity);
    // Distance to the chord SEGMENT: the far turnaround survives (it is 80 m off the 0..20 chord).
    expect(rdp([p0, c, p2], 1)).toEqual([p0, c, p2]);
    expect(finalCurveProblem(splinePieces(simplifyStroke([p0, { x: 50, z: 0 }, c, { x: 60, z: 0 }, p2], 1)), 10)).not.toBeNull();
  });

  it('#7 the road index finds exactly the roads near a box, and the planning neighbourhood keeps whole junctions', () => {
    const cmds: Command[] = [];
    for (let i = 0; i < 20; i++) cmds.push(...road(`h${i}`, { x: -1000, z: i * 40 }, { x: 1000, z: i * 40 }));
    cmds.push(...road('far', { x: 1500, z: 1500 }, { x: 1600, z: 1500 }));
    const doc = docWith(cmds);
    const index = new RoadIndex(doc);
    const box = { minX: -10, minZ: 35, maxX: 10, maxZ: 85 };
    expect(index.near(box).map((s) => s.id)).toEqual(['h1', 'h2']);
    const all = Object.values(doc.segments).filter((s) => {
      const a = doc.nodes[s.a]!.pos;
      const b = doc.nodes[s.b]!.pos;
      return Math.max(a.x, b.x) >= box.minX && Math.min(a.x, b.x) <= box.maxX && Math.max(a.z, b.z) >= box.minZ && Math.min(a.z, b.z) <= box.maxZ;
    });
    expect(all.map((s) => s.id).sort()).toEqual(['h1', 'h2']);
    const local = neighbourhoodDoc(doc, index, box);
    expect(Object.keys(local.segments).sort()).toEqual(['h1', 'h2']);
    expect(Object.keys(local.nodes).sort()).toEqual(['h1a', 'h1b', 'h2a', 'h2b']);
  });
});
