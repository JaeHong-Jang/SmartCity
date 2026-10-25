import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  bezierMinRadius,
  checkFillet,
  cloneJson,
  createEmptyDoc,
  filletFloor,
  filletTangent,
  IdGen,
  planCorner,
  planFillet,
  planRoad,
  preferredFilletRadius,
  quadBezier,
  resolvePoint,
  segmentLength,
  segmentsAtNode,
  type CityDoc,
  type Command,
  type Vec2,
} from '../index.js';

const DEG = Math.PI / 180;

/** Smallest radius of curvature of the quadratic Bezier, from its exact derivatives at many parameters. */
function minRadius(p0: Vec2, c: Vec2, p2: Vec2): number {
  let best = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000;
    const d = { x: 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p2.x - c.x), z: 2 * (1 - t) * (c.z - p0.z) + 2 * t * (p2.z - c.z) };
    const dd = { x: 2 * (p0.x - 2 * c.x + p2.x), z: 2 * (p0.z - 2 * c.z + p2.z) };
    const k = Math.abs(d.x * dd.z - d.z * dd.x) / Math.hypot(d.x, d.z) ** 3;
    best = Math.min(best, 1 / k);
  }
  return best;
}

/** Corner geometry: a leg along -x into v = origin, then turning by `deg` (left turns positive z). */
function corner(deg: number, leg = 400): { a: Vec2; v: Vec2; b: Vec2 } {
  const r = deg * DEG;
  return { a: { x: -leg, z: 0 }, v: { x: 0, z: 0 }, b: { x: leg * Math.cos(r), z: leg * Math.sin(r) } };
}

describe('fillet geometry (ADR 0012 §1)', () => {
  it('T from the real minimum curvature radius, not the circular-arc formula (90°: R/√2 trap)', () => {
    // Circular-arc T = R·tan(45°) = R gives a Bezier whose tightest radius is only R/√2.
    expect(bezierMinRadius(20, 90 * DEG)).toBeCloseTo(20 / Math.SQRT2, 9);
    expect(filletTangent(20, 90 * DEG)).toBeCloseTo(20 * Math.SQRT2, 9);
    for (const deg of [10, 45, 90, 120, 150]) {
      const { a, v, b } = corner(deg);
      const t = filletTangent(15, deg * DEG);
      const ua = { x: (a.x - v.x) / 400, z: (a.z - v.z) / 400 };
      const ub = { x: (b.x - v.x) / 400, z: (b.z - v.z) / 400 };
      const real = minRadius({ x: ua.x * t, z: ua.z * t }, v, { x: ub.x * t, z: ub.z * t });
      expect(real).toBeGreaterThanOrEqual(15 * (1 - 1e-6));
      expect(real).toBeLessThan(15 * 1.001);
      expect(bezierMinRadius(t, deg * DEG)).toBeCloseTo(15, 9);
    }
  });

  it('boundaries: < 10° skipped, 10°..150° rounded, > 150° rejected; degenerate input rejected', () => {
    const plan = (deg: number) => planCorner({ ...corner(deg), floor: 10, preferred: 15, roomA: 1e4, roomB: 1e4 });
    expect(plan(9.9).kind).toBe('skip');
    expect(plan(10).kind).toBe('ok');
    expect(plan(150).kind).toBe('ok');
    expect(plan(150.5)).toMatchObject({ kind: 'reject', reason: 'tooSharp' });
    const v = { x: 0, z: 0 };
    expect(planCorner({ a: v, v, b: { x: 10, z: 10 }, floor: 10, preferred: 15, roomA: 99, roomB: 99 })).toMatchObject({ kind: 'reject', reason: 'degenerate' });
    expect(planCorner({ a: { x: NaN, z: 0 }, v, b: { x: 10, z: 10 }, floor: 10, preferred: 15, roomA: 99, roomB: 99 })).toMatchObject({ kind: 'reject', reason: 'degenerate' });
  });

  it('every rounded corner reaches the requested radius and a curve of at least 8 m', () => {
    for (const deg of [10, 12, 30, 45, 60, 90, 120, 135, 150]) {
      const c = corner(deg);
      const p = planCorner({ ...c, floor: 10, preferred: 15, roomA: 1e4, roomB: 1e4 });
      if (p.kind !== 'ok') throw new Error(`${deg}: ${p.kind}`);
      expect(minRadius(p.p0, c.v, p.p2)).toBeGreaterThanOrEqual(15 * (1 - 1e-6));
      expect(p.arcLength).toBeGreaterThanOrEqual(8);
    }
  });

  it('shrinks from the preferred radius to fit, never below the floor (then the corner stays sharp)', () => {
    const c = corner(90);
    const tPref = filletTangent(15, 90 * DEG);
    const tFloor = filletTangent(10, 90 * DEG);
    const fits = planCorner({ ...c, floor: 10, preferred: 15, roomA: (tPref + tFloor) / 2, roomB: 1e4 });
    if (fits.kind !== 'ok') throw new Error(fits.kind);
    expect(fits.t).toBeCloseTo((tPref + tFloor) / 2, 9);
    expect(fits.radius).toBeGreaterThan(10);
    expect(fits.radius).toBeLessThan(15);
    expect(planCorner({ ...c, floor: 10, preferred: 15, roomA: tFloor - 0.01, roomB: 1e4 })).toMatchObject({ kind: 'reject', reason: 'noRoom' });
  });

  it('policy radius: max(floor = half width + 4 m, lane table)', () => {
    const doc = createEmptyDoc();
    expect(filletFloor(doc.roadTypes['road-2']!)).toBe(10);
    expect(preferredFilletRadius(doc.roadTypes['road-2']!)).toBe(15);
    expect(filletFloor(doc.roadTypes['road-6']!)).toBe(17);
    expect(preferredFilletRadius(doc.roadTypes['road-6']!)).toBe(35);
    expect(filletFloor(doc.roadTypes['road-4']!)).toBe(13.5);
    expect(preferredFilletRadius(doc.roadTypes['road-4']!)).toBe(25);
    expect(preferredFilletRadius({ ...doc.roadTypes['road-6']!, lanesForward: 4, lanesBackward: 4 })).toBe(45);
  });
});

/** A → V → C, two straight road-2 roads `sa` (A→V) and `sb` (V→C). */
function cornerDoc(c: Vec2 = { x: 0, z: 100 }, a: Vec2 = { x: -100, z: 0 }, roadTypeId = 'road-2'): CityDoc {
  const doc = createEmptyDoc();
  const r = applyCommand(doc, {
    type: 'batch',
    commands: [
      { type: 'node.add', node: { id: 'A', pos: a } },
      { type: 'node.add', node: { id: 'V', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'C', pos: c } },
      { type: 'segment.add', segment: { id: 'sa', a: 'A', b: 'V', roadTypeId } },
      { type: 'segment.add', segment: { id: 'sb', a: 'V', b: 'C', roadTypeId } },
    ],
  });
  expect(r).toEqual({ ok: true });
  return doc;
}

const FILLET: Command = { type: 'road.fillet', nodeId: 'V', ids: { a: 'fa', b: 'fb', seg: 'fc' } };

function refused(doc: CityDoc, cmd: Command, match: RegExp): void {
  const before = JSON.stringify(doc);
  const r = applyCommand(doc, cmd);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(match);
  // Deep equality: a rollback restores every entry, though a re-added key may move in iteration order.
  expect(doc).toEqual(JSON.parse(before));
}

describe('road.fillet command', () => {
  it('rounds a 90° corner: roads keep their ids, corner node replaced by a curve with control = corner', () => {
    const doc = cornerDoc();
    expect(applyCommand(doc, FILLET)).toEqual({ ok: true });
    const t = filletTangent(15, 90 * DEG);
    expect(doc.nodes.V).toBeUndefined();
    expect(doc.nodes.fa!.pos.x).toBeCloseTo(-t, 9);
    expect(doc.nodes.fb!.pos.z).toBeCloseTo(t, 9);
    expect(doc.segments.sa).toMatchObject({ a: 'A', b: 'fa' });
    expect(doc.segments.sb).toMatchObject({ a: 'fb', b: 'C' });
    expect(doc.segments.fc).toEqual({ id: 'fc', a: 'fa', b: 'fb', roadTypeId: 'road-2', control: { x: 0, z: 0 } });
    expect(segmentLength(doc, doc.segments.sa!)).toBeCloseTo(100 - t, 9);
    expect(minRadius(doc.nodes.fa!.pos, { x: 0, z: 0 }, doc.nodes.fb!.pos)).toBeGreaterThanOrEqual(15 * (1 - 1e-6));
    expect(segmentsAtNode(doc, 'fa')).toHaveLength(2);
  });

  it('follows the travel direction of one-way roads and refuses head-to-head ones', () => {
    const doc = cornerDoc({ x: 0, z: 100 }, { x: -100, z: 0 }, 'oneway-2');
    // sb runs V → C, sa runs A → V: flow sa → sb, the curve runs fa → fb.
    expect(applyCommand(cloneJson(doc), FILLET)).toEqual({ ok: true });
    const back = cloneJson(doc);
    expect(applyCommand(back, { type: 'batch', commands: [{ type: 'segment.remove', id: 'sb' }, { type: 'node.add', node: { id: 'C', pos: { x: 0, z: 100 } } }, { type: 'segment.add', segment: { id: 'sb', a: 'C', b: 'V', roadTypeId: 'oneway-2' } }] }).ok).toBe(true);
    refused(back, FILLET, /opposite directions/);
    // sa reversed too (V → A, C → V): flow sb → sa, so the curve runs fb → fa.
    const rev = cornerDoc({ x: 0, z: 100 }, { x: -100, z: 0 }, 'oneway-2');
    applyCommand(rev, { type: 'batch', commands: [{ type: 'segment.remove', id: 'sa' }, { type: 'segment.remove', id: 'sb' }, { type: 'node.add', node: { id: 'A', pos: { x: -100, z: 0 } } }, { type: 'node.add', node: { id: 'C', pos: { x: 0, z: 100 } } }, { type: 'node.add', node: { id: 'V', pos: { x: 0, z: 0 } } }, { type: 'segment.add', segment: { id: 'sa', a: 'V', b: 'A', roadTypeId: 'oneway-2' } }, { type: 'segment.add', segment: { id: 'sb', a: 'C', b: 'V', roadTypeId: 'oneway-2' } }] });
    expect(applyCommand(rev, FILLET)).toEqual({ ok: true });
    expect(rev.segments.fc).toMatchObject({ a: 'fb', b: 'fa' });
  });

  it('refuses every unsupported corner with a reason and leaves the doc untouched', () => {
    const add = (doc: CityDoc, cmds: Command[]) => expect(applyCommand(doc, { type: 'batch', commands: cmds })).toEqual({ ok: true });
    refused(createEmptyDoc(), FILLET, /unknown node/);
    let doc = cornerDoc();
    add(doc, [{ type: 'node.add', node: { id: 'D', pos: { x: 60, z: -60 } } }, { type: 'segment.add', segment: { id: 'sd', a: 'V', b: 'D', roadTypeId: 'road-2' } }]);
    refused(doc, FILLET, /exactly two roads/);
    doc = cornerDoc();
    add(doc, [{ type: 'segment.remove', id: 'sb' }, { type: 'node.add', node: { id: 'C', pos: { x: 0, z: 100 } } }, { type: 'segment.add', segment: { id: 'sb', a: 'V', b: 'C', roadTypeId: 'road-2', control: { x: 20, z: 50 } } }]);
    refused(doc, FILLET, /only straight roads/);
    doc = cornerDoc();
    add(doc, [{ type: 'segment.setType', id: 'sb', roadTypeId: 'road-4' }]);
    refused(doc, FILLET, /differ in type/);
    doc = cornerDoc();
    add(doc, [{ type: 'segment.setSchoolZone', id: 'sb', schoolZone: true }]);
    refused(doc, FILLET, /school zone/);
    doc = cornerDoc();
    add(doc, [{ type: 'intersection.set', control: { nodeId: 'V', kind: 'allStop', yellow: 3, allRed: 2, offset: 0 } }]);
    refused(doc, FILLET, /own control settings/);
    refused(cornerDoc({ x: 100, z: 5 }), FILLET, /almost straight/);
    refused(cornerDoc({ x: -100, z: 20 }), FILLET, /too sharp/);
    refused(cornerDoc({ x: 0, z: 20 }), FILLET, /not enough room/);
    refused(cornerDoc(), { ...FILLET, radius: 9 } as Command, /fillet radius out of range/);
    doc = cornerDoc();
    add(doc, [{ type: 'closure.set', closure: { segmentId: 'sa', reason: 'x' } }]);
    refused(doc, FILLET, /closed/);
    doc = cornerDoc();
    add(doc, [{ type: 'busStop.add', stop: { id: 'p', segmentId: 'sa', t: 0.9, dir: 'forward' } }]);
    refused(doc, FILLET, /bus stop is in the corner/);
    doc = cornerDoc();
    add(doc, [
      { type: 'busStop.add', stop: { id: 'p', segmentId: 'sa', t: 0.2, dir: 'forward' } },
      { type: 'busStop.add', stop: { id: 'q', segmentId: 'sb', t: 0.9, dir: 'forward' } },
      { type: 'busLine.upsert', line: { id: 'L', name: 'L', color: '#123456', stopIds: ['p', 'q'], vehicleTypeId: 'city-bus', buses: 1 } },
    ]);
    refused(doc, FILLET, /bus line serves the roads/);
    doc = cornerDoc();
    add(doc, [{ type: 'feature.upsert', feature: { id: 'cw', segmentId: 'sa', kind: 'crosswalk', t: 0.7 } }]);
    refused(doc, FILLET, /crosswalk is in the corner/);
    doc = cornerDoc();
    add(doc, [{ type: 'feature.upsert', feature: { id: 'bump', segmentId: 'sb', kind: 'speedBump', t: 0.25 } }]);
    refused(doc, FILLET, /speed bump is in the corner/);
    doc = cornerDoc();
    const lot = [{ x: -30, z: -8 }, { x: -14, z: -8 }, { x: -14, z: -30 }, { x: -30, z: -30 }];
    add(doc, [{ type: 'parcel.upsert', parcel: { id: 'lot', polygon: lot, zone: 'residential', regulation: { coverage: 0.6, far: 2, maxHeight: 30, setback: 1 }, auto: true, frontage: { segmentId: 'sa', side: 'right' } } }]);
    refused(doc, FILLET, /lot faces the corner/);
    refused(cornerDoc(), { ...FILLET, ids: { a: 'A', b: 'fb', seg: 'fc' } } as Command, /invalid fillet node ids/);
    refused(cornerDoc(), { ...FILLET, ids: { a: 'fa', b: 'fb', seg: 'sa' } } as Command, /segment exists/);
  });

  it('keeps stops and features outside the corner at their world position', () => {
    const doc = cornerDoc();
    expect(
      applyCommand(doc, {
        type: 'batch',
        commands: [
          { type: 'busStop.add', stop: { id: 'p', segmentId: 'sa', t: 0.3, dir: 'forward' } },
          { type: 'feature.upsert', feature: { id: 'cw', segmentId: 'sb', kind: 'crosswalk', t: 0.6 } },
          { type: 'feature.upsert', feature: { id: 'sbump', segmentId: 'sa', kind: 'speedBump', t: 0.5 } },
        ],
      }),
    ).toEqual({ ok: true });
    expect(applyCommand(doc, FILLET)).toEqual({ ok: true });
    const t = filletTangent(15, 90 * DEG);
    // On sa (A at x = -100 → fa at x = -t): the stop stays at x = -70, the bump at x = -50; the crosswalk on sb at z = 60.
    expect(-100 + doc.busStops.p!.t * (100 - t)).toBeCloseTo(-70, 9);
    expect(-100 + doc.features.sbump!.t * (100 - t)).toBeCloseTo(-50, 9);
    expect(t + doc.features.cw!.t * (100 - t)).toBeCloseTo(60, 9);
  });

  it('length budget: both ends of one road share it (T_left + T_right + 8 m ≤ L)', () => {
    // Z shape: P → V1 → V2 → Q with a 40 m middle road between two 90° corners.
    const doc = createEmptyDoc();
    const nodes: [string, Vec2][] = [['P', { x: 0, z: -80 }], ['V1', { x: 0, z: 0 }], ['V2', { x: 40, z: 0 }], ['Q', { x: 40, z: 80 }]];
    expect(
      applyCommand(doc, {
        type: 'batch',
        commands: [
          ...nodes.map(([id, pos]): Command => ({ type: 'node.add', node: { id, pos } })),
          { type: 'segment.add', segment: { id: 's1', a: 'P', b: 'V1', roadTypeId: 'road-2' } },
          { type: 'segment.add', segment: { id: 's2', a: 'V1', b: 'V2', roadTypeId: 'road-2' } },
          { type: 'segment.add', segment: { id: 's3', a: 'V2', b: 'Q', roadTypeId: 'road-2' } },
        ],
      }),
    ).toEqual({ ok: true });
    // Alone, V1 would take the preferred 21.2 m; it leaves V2 its minimum (floor radius) instead.
    const first = checkFillet(doc, 'V1');
    if (!first.ok) throw new Error(first.error);
    const tFloor = filletTangent(10, 90 * DEG);
    expect(first.geometry.t).toBeCloseTo(40 - tFloor - 8.001, 6);
    expect(applyCommand(doc, { type: 'road.fillet', nodeId: 'V1', ids: { a: 'a1', b: 'b1', seg: 'c1' } })).toEqual({ ok: true });
    const second = checkFillet(doc, 'V2');
    if (!second.ok) throw new Error(second.error);
    expect(second.geometry.radius).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(applyCommand(doc, { type: 'road.fillet', nodeId: 'V2', ids: { a: 'a2', b: 'b2', seg: 'c2' } })).toEqual({ ok: true });
    const middle = segmentLength(doc, doc.segments.s2!);
    expect(first.geometry.t + second.geometry.t + middle).toBeCloseTo(40, 9);
    expect(middle).toBeGreaterThanOrEqual(8);
  });

  it('reserves the junction at a far end of degree 3', () => {
    const doc = cornerDoc({ x: 0, z: 40 });
    // C becomes a T junction: half width 6 + 1 + crosswalk zone 4 = 11 m reserved on sb.
    expect(applyCommand(doc, { type: 'batch', commands: [{ type: 'node.add', node: { id: 'E', pos: { x: 50, z: 40 } } }, { type: 'node.add', node: { id: 'W', pos: { x: -50, z: 40 } } }, { type: 'segment.add', segment: { id: 'se', a: 'C', b: 'E', roadTypeId: 'road-2' } }, { type: 'segment.add', segment: { id: 'sw', a: 'W', b: 'C', roadTypeId: 'road-2' } }] })).toEqual({ ok: true });
    const r = checkFillet(doc, 'V');
    if (!r.ok) throw new Error(r.error);
    expect(r.geometry.t).toBeCloseTo(40 - 11 - 8.001, 6);
  });

  it('a failing batch rolls the fillet back', () => {
    const doc = cornerDoc();
    refused(doc, { type: 'batch', commands: [FILLET, { type: 'segment.remove', id: 'nope' }] }, /unknown segment/);
  });

  it('concurrent edits after planning: the stale fillet is refused as a whole', () => {
    const edits: [string, Command][] = [
      ['a road added at the corner', { type: 'batch', commands: [{ type: 'node.add', node: { id: 'D', pos: { x: 60, z: -60 } } }, { type: 'segment.add', segment: { id: 'sd', a: 'V', b: 'D', roadTypeId: 'road-2' } }] }],
      ['a road moved', { type: 'node.move', id: 'A', pos: { x: -100, z: -16 } }],
      ['the corner moved', { type: 'node.move', id: 'V', pos: { x: 8, z: 0 } }],
      ['a road split', { type: 'segment.split', id: 'sa', t: 0.3, nodeId: 'm', segmentIds: ['sa1', 'sa2'] }],
      ['a road removed', { type: 'segment.remove', id: 'sb' }],
    ];
    for (const [what, edit] of edits) {
      const doc = cornerDoc();
      const plan = planFillet(doc, 'V', new IdGen('u1'));
      expect(plan.command, what).not.toBeNull();
      expect(applyCommand(doc, edit), what).toEqual({ ok: true });
      const before = JSON.stringify(doc);
      expect(applyCommand(doc, plan.command!).ok, what).toBe(false);
      expect(doc, what).toEqual(JSON.parse(before));
    }
  });

  it('an explicit radius is used (and still shrinks to fit, never below the floor)', () => {
    const doc = cornerDoc();
    const plan = planFillet(doc, 'V', new IdGen('u'), 20);
    expect(plan.radius).toBeCloseTo(20, 9);
    expect(plan.command).toMatchObject({ type: 'road.fillet', radius: 20 });
    expect(applyCommand(doc, plan.command!)).toEqual({ ok: true });
    const curve = Object.values(doc.segments).find((s) => s.control)!;
    expect(minRadius(doc.nodes[curve.a]!.pos, curve.control!, doc.nodes[curve.b]!.pos)).toBeGreaterThanOrEqual(20 * (1 - 1e-6));
    // 100 m legs fit at most T = 91.999 m: radius 65 (T 91.9) fits, 70 (T 99) shrinks to that room.
    expect(planFillet(cornerDoc(), 'V', new IdGen('u'), 70).radius).toBeCloseTo((100 - 8.001) / Math.SQRT2, 6);
  });

  it('Sol #1: a curve over a manual building or an automatic lot is refused, at planning time too', () => {
    const doc = cornerDoc();
    expect(applyCommand(doc, { type: 'building.place', building: { id: 'h', typeId: 'house', pos: { x: -12, z: 12 }, rotation: 0 }, ifClear: true })).toEqual({ ok: true });
    const check = checkFillet(doc, 'V');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/curve would cross a building/);
    refused(doc, FILLET, /curve would cross a building/);
    expect(doc.buildings.h).toBeDefined();
    const lots = cornerDoc();
    const lot = [{ x: -16, z: 8 }, { x: -8, z: 8 }, { x: -8, z: 16 }, { x: -16, z: 16 }];
    expect(applyCommand(lots, { type: 'parcel.upsert', parcel: { id: 'lot', polygon: lot, zone: 'residential', regulation: { coverage: 0.6, far: 2, maxHeight: 30, setback: 1 }, auto: true } })).toEqual({ ok: true });
    refused(lots, FILLET, /curve would cross a zoned lot/);
  });

  it('trusted replay computes the same result', () => {
    const live = cornerDoc();
    const replay = cloneJson(live);
    expect(applyCommand(live, FILLET)).toEqual({ ok: true });
    expect(applyCommand(replay, FILLET, { trusted: true })).toEqual({ ok: true });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(live));
  });
});

describe('planRoad automatic fillet (new multi-point roads)', () => {
  /** Draw a polyline the way the road tool does: one batch per click, rounding the previous corner. */
  function drawPolyline(doc: CityDoc, pts: Vec2[], fillet: boolean): string[] {
    const ids = new IdGen('t');
    const errors: string[] = [];
    let corner: string | null = null;
    for (let i = 1; i < pts.length; i++) {
      const start = resolvePoint(doc, pts[i - 1]!);
      const end = resolvePoint(doc, pts[i]!);
      const plan = planRoad(doc, { start, end, roadTypeId: 'road-2', filletStart: fillet && start.kind === 'node' && start.nodeId === corner }, ids);
      expect(plan.error).toBeUndefined();
      if (plan.filletError) errors.push(plan.filletError);
      expect(applyCommand(doc, plan.command!)).toEqual({ ok: true });
      const cmds = plan.command!.type === 'batch' ? plan.command!.commands : [];
      const last = cmds.filter((c) => c.type === 'segment.add').pop();
      corner = end.kind === 'free' && last?.type === 'segment.add' ? last.segment.b : null;
    }
    return errors;
  }

  it('rounds every corner of a new 4-point road (curves with control = corner)', () => {
    const doc = createEmptyDoc();
    const errors = drawPolyline(doc, [{ x: 0, z: 0 }, { x: 96, z: 0 }, { x: 96, z: 96 }, { x: 0, z: 96 }], true);
    expect(errors).toEqual([]);
    const curves = Object.values(doc.segments).filter((s) => s.control);
    expect(curves.map((s) => s.control).sort((p, q) => p!.z - q!.z)).toEqual([{ x: 96, z: 0 }, { x: 96, z: 96 }]);
    expect(Object.keys(doc.segments)).toHaveLength(5);
    // Every node is a dead end or a smooth degree-2 joint; the corners themselves are gone.
    expect(Object.values(doc.nodes).some((n) => n.pos.x === 96 && (n.pos.z === 0 || n.pos.z === 96))).toBe(false);
  });

  it('without the option (or from an existing road end) corners stay sharp', () => {
    const doc = createEmptyDoc();
    drawPolyline(doc, [{ x: 0, z: 0 }, { x: 96, z: 0 }, { x: 96, z: 96 }], false);
    expect(Object.values(doc.segments).some((s) => s.control)).toBe(false);
  });

  it('Sol #2: the tangent points come by role, whatever the order of the segment ids', () => {
    for (const prevId of ['aaa', 'zzz']) {
      const doc = createEmptyDoc();
      expect(
        applyCommand(doc, {
          type: 'batch',
          commands: [
            { type: 'node.add', node: { id: 'A', pos: { x: -96, z: 0 } } },
            { type: 'node.add', node: { id: 'V', pos: { x: 0, z: 0 } } },
            { type: 'segment.add', segment: { id: prevId, a: 'A', b: 'V', roadTypeId: 'road-2' } },
          ],
        }),
      ).toEqual({ ok: true });
      const plan = planRoad(doc, { start: resolvePoint(doc, { x: 0, z: 0 }), end: resolvePoint(doc, { x: 0, z: 96 }), roadTypeId: 'road-2', filletStart: true }, new IdGen('t'));
      const t = filletTangent(15, 90 * DEG);
      const f = plan.fillet!;
      expect(f.onPrev.x, prevId).toBeCloseTo(-t, 9);
      expect(f.onNew.z, prevId).toBeCloseTo(t, 9);
      expect(f.onNew.x, prevId).toBeCloseTo(0, 9);
      expect(f.curve[0]).toEqual(f.onPrev);
      expect(f.curve[f.curve.length - 1]).toEqual(f.onNew);
      expect(applyCommand(doc, plan.command!)).toEqual({ ok: true });
      // The committed new straight road starts exactly at the previewed point.
      const straight = Object.values(doc.segments).find((s) => s.id !== prevId && !s.control)!;
      const startPos = doc.nodes[straight.a]!.pos;
      expect(startPos.x).toBeCloseTo(f.onNew.x, 9);
      expect(startPos.z).toBeCloseTo(f.onNew.z, 9);
    }
  });

  it('Sol #3: when only the fillet is impossible the road is still built, the corner stays sharp, with a reason', () => {
    const doc = createEmptyDoc();
    expect(
      applyCommand(doc, {
        type: 'batch',
        commands: [
          { type: 'node.add', node: { id: 'A', pos: { x: -100, z: 0 } } },
          { type: 'node.add', node: { id: 'V', pos: { x: 0, z: 0 } } },
          { type: 'segment.add', segment: { id: 'av', a: 'A', b: 'V', roadTypeId: 'road-2' } },
          { type: 'node.add', node: { id: 'X', pos: { x: -10, z: 1 } } },
          { type: 'node.add', node: { id: 'Y', pos: { x: -10, z: 20 } } },
          { type: 'segment.add', segment: { id: 'xy', a: 'X', b: 'Y', roadTypeId: 'road-2' } },
        ],
      }),
    ).toEqual({ ok: true });
    const start = { kind: 'node' as const, nodeId: 'V', pos: { x: 0, z: 0 } };
    const plan = planRoad(doc, { start, end: { kind: 'free', pos: { x: 0, z: 100 } }, roadTypeId: 'road-2', filletStart: true }, new IdGen('t'));
    expect(plan.fillet).toBeUndefined();
    expect(plan.filletError).toMatch(/cross another road/);
    expect(plan.command!.type === 'batch' && plan.command!.commands.some((c) => c.type === 'road.fillet')).toBe(false);
    expect(applyCommand(doc, plan.command!)).toEqual({ ok: true });
    expect(segmentsAtNode(doc, 'V')).toHaveLength(2);
    expect(Object.values(doc.segments).some((s) => s.control)).toBe(false);
  });

  it('a corner that cannot be rounded stays sharp, the road is still drawn and the reason reported', () => {
    const doc = createEmptyDoc();
    const errors = drawPolyline(doc, [{ x: 0, z: 0 }, { x: 16, z: 0 }, { x: 16, z: 96 }], true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not enough room/);
    expect(Object.keys(doc.segments)).toHaveLength(2);
  });
});
