import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, IdGen, planRoad, planRoadChain, resolvePoint, segmentsAtNode, type CityDoc, type Command } from '../index.js';

function draw(doc: CityDoc, ids: IdGen, a: { x: number; z: number }, b: { x: number; z: number }, control?: { x: number; z: number }) {
  const plan = planRoad(doc, { start: resolvePoint(doc, a), end: resolvePoint(doc, b), control, roadTypeId: 'road-2' }, ids);
  expect(plan.error).toBeUndefined();
  const r = applyCommand(doc, plan.command!);
  expect(r).toEqual({ ok: true });
  return plan;
}

describe('planRoad', () => {
  it('draws a free road between two grid points', () => {
    const doc = createEmptyDoc();
    draw(doc, new IdGen('t'), { x: 1, z: -2 }, { x: 97, z: 3 });
    expect(Object.values(doc.nodes).map((n) => n.pos)).toEqual([
      { x: 0, z: 0 },
      { x: 96, z: 0 },
    ]);
    expect(Object.keys(doc.segments)).toHaveLength(1);
  });

  it('snaps to an existing node and continues the road', () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('t');
    draw(doc, ids, { x: 0, z: 0 }, { x: 96, z: 0 });
    draw(doc, ids, { x: 98, z: 2 }, { x: 96, z: 96 });
    expect(Object.keys(doc.nodes)).toHaveLength(3);
    const corner = Object.values(doc.nodes).find((n) => n.pos.x === 96 && n.pos.z === 0)!;
    expect(segmentsAtNode(doc, corner.id)).toHaveLength(2);
  });

  it('splits an existing road when connecting to its middle (T junction)', () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('t');
    draw(doc, ids, { x: 0, z: 0 }, { x: 96, z: 0 });
    draw(doc, ids, { x: 48, z: 1 }, { x: 48, z: 80 });
    expect(Object.keys(doc.segments)).toHaveLength(3);
    const mid = Object.values(doc.nodes).find((n) => Math.abs(n.pos.x - 48) < 1e-6 && Math.abs(n.pos.z) < 1e-6)!;
    expect(segmentsAtNode(doc, mid.id)).toHaveLength(3);
  });

  it('creates a 4-way intersection where two roads cross', () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('t');
    draw(doc, ids, { x: -48, z: 0 }, { x: 48, z: 0 });
    draw(doc, ids, { x: 0, z: -48 }, { x: 0, z: 48 });
    expect(Object.keys(doc.segments)).toHaveLength(4);
    const center = Object.values(doc.nodes).find((n) => Math.abs(n.pos.x) < 1e-6 && Math.abs(n.pos.z) < 1e-6)!;
    expect(segmentsAtNode(doc, center.id)).toHaveLength(4);
  });

  it('crosses several roads in one stroke', () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('t');
    for (const x of [0, 40, 80]) draw(doc, ids, { x, z: -48 }, { x, z: 48 });
    draw(doc, ids, { x: -40, z: 0 }, { x: 120, z: 0 });
    // 3 vertical roads split in two + 4 pieces of the horizontal road
    expect(Object.keys(doc.segments)).toHaveLength(10);
  });

  it('splits a curved new road at crossings', () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('t');
    draw(doc, ids, { x: 0, z: -48 }, { x: 0, z: 96 });
    draw(doc, ids, { x: -64, z: 0 }, { x: 64, z: 0 }, { x: 0, z: 40 });
    const curved = Object.values(doc.segments).filter((s) => s.control);
    expect(curved).toHaveLength(2);
  });

  it('refuses a road that runs along an existing one (Sol review #8)', () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('t');
    draw(doc, ids, { x: 0, z: 0 }, { x: 96, z: 0 });
    const plan = planRoad(doc, { start: resolvePoint(doc, { x: 0, z: 0 }), end: resolvePoint(doc, { x: 192, z: 0 }), roadTypeId: 'road-2' }, ids);
    expect(plan.error).toBe('기존 도로와 겹칩니다');
    // Continuing straight from the end node is still fine.
    draw(doc, ids, { x: 96, z: 0 }, { x: 192, z: 0 });
  });

  it('refuses degenerate roads', () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('t');
    const p = resolvePoint(doc, { x: 0, z: 0 });
    expect(planRoad(doc, { start: p, end: p, roadTypeId: 'road-2' }, ids).error).toBeDefined();
    expect(planRoad(doc, { start: p, end: resolvePoint(doc, { x: 100, z: 0 }), roadTypeId: 'nope' }, ids).error).toBeDefined();
  });
});

describe('crossings are revalidated when a road is applied (Sol P5b #5)', () => {
  const vertical: Command = {
    type: 'batch',
    commands: [
      { type: 'node.add', node: { id: 'N', pos: { x: 0, z: -48 } } },
      { type: 'node.add', node: { id: 'S', pos: { x: 0, z: 48 } } },
      { type: 'segment.add', segment: { id: 'ns', a: 'N', b: 'S', roadTypeId: 'road-2' } },
    ],
  };

  it('a stale plan (chain or single road) is refused whole once someone built a road across it', () => {
    for (const chain of [true, false]) {
      const doc = createEmptyDoc();
      const ids = new IdGen('t');
      const start = resolvePoint(doc, { x: -96, z: 0 });
      const end = resolvePoint(doc, { x: 96, z: 0 });
      const plan = chain
        ? planRoadChain(doc, { start, end, roadTypeId: 'road-2', pieces: [{ pos: { x: -16, z: 0 } }, { pos: { x: 96, z: 0 } }] }, ids)
        : planRoad(doc, { start, end, roadTypeId: 'road-2' }, ids);
      expect(plan.command).not.toBeNull();
      expect(applyCommand(doc, vertical)).toEqual({ ok: true });
      const before = cloneJson(doc);
      const r = applyCommand(doc, plan.command!);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/cross another road without a junction/);
      expect(doc).toEqual(before);
    }
  });

  it('the planner itself splits at crossings and passes; trusted replay is not re-judged', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, vertical)).toEqual({ ok: true });
    const fresh = planRoad(doc, { start: resolvePoint(doc, { x: -96, z: 0 }), end: resolvePoint(doc, { x: 96, z: 0 }), roadTypeId: 'road-2' }, new IdGen('t'));
    expect(applyCommand(cloneJson(doc), fresh.command!)).toEqual({ ok: true });
    const raw: Command = {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'W', pos: { x: -96, z: 0 } } },
        { type: 'node.add', node: { id: 'E', pos: { x: 96, z: 0 } } },
        { type: 'segment.add', segment: { id: 'we', a: 'W', b: 'E', roadTypeId: 'road-2' } },
      ],
    };
    expect(applyCommand(cloneJson(doc), raw).ok).toBe(false);
    expect(applyCommand(cloneJson(doc), raw, { trusted: true })).toEqual({ ok: true });
  });
});

describe('planRoadChain (P5b free drawing)', () => {
  it('crossing-node policy: a junction exactly where the stroke crosses, or the road end within 8 m of it', () => {
    const doc = createEmptyDoc();
    expect(
      applyCommand(doc, {
        type: 'batch',
        commands: [
          { type: 'node.add', node: { id: 'N', pos: { x: 50, z: -5 } } },
          { type: 'node.add', node: { id: 'S', pos: { x: 50, z: 100 } } },
          { type: 'segment.add', segment: { id: 'ns', a: 'N', b: 'S', roadTypeId: 'road-2' } },
          { type: 'node.add', node: { id: 'N2', pos: { x: 150, z: -50 } } },
          { type: 'node.add', node: { id: 'S2', pos: { x: 150, z: 100 } } },
          { type: 'segment.add', segment: { id: 'ns2', a: 'N2', b: 'S2', roadTypeId: 'road-2' } },
        ],
      }),
    ).toEqual({ ok: true });
    const plan = planRoadChain(
      doc,
      {
        start: { kind: 'free', pos: { x: 0, z: 0 } },
        end: { kind: 'free', pos: { x: 200, z: 0 } },
        roadTypeId: 'road-2',
        pieces: [{ pos: { x: 50, z: 0 }, road: 'ns' }, { pos: { x: 150, z: 0 }, road: 'ns2' }, { pos: { x: 200, z: 0 } }],
      },
      new IdGen('t'),
    );
    expect(plan.error).toBeUndefined();
    const ends = plan.added.map((a) => a.b);
    // 5 m from the end of ns: its end node (50,-5) is used (bounded move); mid-road on ns2: exactly (150,0).
    expect(ends[0]).toEqual({ x: 50, z: -5 });
    expect(ends).toContainEqual({ x: 150, z: 0 });
    const r = applyCommand(doc, plan.command!);
    expect(r).toEqual({ ok: true });
  });

  it('checks the combined batch: too many pieces is a reason, not a refused send (Sol P5b #6)', () => {
    const doc = createEmptyDoc();
    const pieces = Array.from({ length: 500 }, (_, i) => ({ pos: { x: -2000 + 8 * (i + 1), z: 0 } }));
    const plan = planRoadChain(doc, { start: { kind: 'free', pos: { x: -2000, z: 0 } }, end: { kind: 'free', pos: { x: 2000, z: 0 } }, roadTypeId: 'road-2', pieces }, new IdGen('t'));
    expect(plan.command).toBeNull();
    expect(plan.error).toMatch(/너무 깁니다/);
  });
});

describe('road contact at apply time (Sol P5b recheck)', () => {
  const add = (doc: CityDoc, id: string, a: { x: number; z: number }, b: { x: number; z: number }, control?: { x: number; z: number }) =>
    applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: `${id}a`, pos: a } },
        { type: 'node.add', node: { id: `${id}b`, pos: b } },
        { type: 'segment.add', segment: { id, a: `${id}a`, b: `${id}b`, roadTypeId: 'road-2', ...(control ? { control } : {}) } },
      ],
    });

  it('#1 a stale plan is refused whole when someone built a road along it (collinear overlap)', () => {
    for (const chain of [true, false]) {
      const doc = createEmptyDoc();
      const ids = new IdGen('t');
      const start = resolvePoint(doc, { x: -96, z: 0 });
      const end = resolvePoint(doc, { x: 96, z: 0 });
      const plan = chain
        ? planRoadChain(doc, { start, end, roadTypeId: 'road-2', pieces: [{ pos: { x: -16, z: 0 } }, { pos: { x: 96, z: 0 } }] }, ids)
        : planRoad(doc, { start, end, roadTypeId: 'road-2' }, ids);
      expect(add(doc, 'other', { x: 0, z: 0 }, { x: 192, z: 0 })).toEqual({ ok: true });
      const before = cloneJson(doc);
      const r = applyCommand(doc, plan.command!);
      expect(r.ok, chain ? 'chain' : 'single').toBe(false);
      if (!r.ok) expect(r.error).toMatch(/cross another road without a junction/);
      expect(doc).toEqual(before);
    }
  });

  it('#1 a collinear end-to-end touch is contact unless it is the same node', () => {
    const doc = createEmptyDoc();
    expect(add(doc, 'r', { x: 96, z: 0 }, { x: 192, z: 0 })).toEqual({ ok: true });
    expect(add(cloneJson(doc), 'n', { x: 0, z: 0 }, { x: 96, z: 0 }).ok).toBe(false);
    const shared = cloneJson(doc);
    expect(
      applyCommand(shared, { type: 'batch', commands: [{ type: 'node.add', node: { id: 'w', pos: { x: 0, z: 0 } } }, { type: 'segment.add', segment: { id: 'n', a: 'w', b: 'ra', roadTypeId: 'road-2' } }] }),
    ).toEqual({ ok: true });
  });

  it('#2 a curve touching a road tangentially between its samples is contact; the tolerance is 0.05 m', () => {
    const base = createEmptyDoc();
    expect(add(base, 'r', { x: -100, z: 0 }, { x: 100, z: 0 })).toEqual({ ok: true });
    // Apex z = 0.25·25 + 0.5·c + 0.25·25 = 12.5 + c/2.
    const apex = (c: number) => add(cloneJson(base), 'c', { x: -50, z: 25 }, { x: 50, z: 25 }, { x: 0, z: c });
    expect(apex(-25).ok).toBe(false); // touches at (0,0)
    expect(apex(-24.92).ok).toBe(false); // 0.04 m: contact
    expect(apex(-24.88)).toEqual({ ok: true }); // 0.06 m: clear
    expect(apex(-24.8)).toEqual({ ok: true }); // 0.10 m: clear
  });

  it('#3 a stroke crossing resolves on the crossed road only, not on a nearby node of another road', () => {
    const doc = createEmptyDoc();
    expect(add(doc, 'A', { x: 50, z: -5 }, { x: 50, z: 100 })).toEqual({ ok: true });
    expect(add(doc, 'B', { x: 53, z: 1 }, { x: 90, z: 60 })).toEqual({ ok: true });
    const plan = planRoadChain(
      doc,
      { start: { kind: 'free', pos: { x: 0, z: 0 } }, end: { kind: 'free', pos: { x: 100, z: 0 } }, roadTypeId: 'road-2', pieces: [{ pos: { x: 50, z: 0 }, road: 'A' }, { pos: { x: 100, z: 0 } }] },
      new IdGen('t'),
    );
    expect(plan.error).toBeUndefined();
    expect(plan.added[0]!.b).toEqual({ x: 50, z: -5 });
    expect(applyCommand(doc, plan.command!)).toEqual({ ok: true });
  });
});

describe('Sol P5b recheck 2', () => {
  const node = (id: string, x: number, z: number): Command => ({ type: 'node.add', node: { id, pos: { x, z } } });

  it('#1 sharing one node does not excuse a crossing near the other end', () => {
    const doc = createEmptyDoc();
    expect(
      applyCommand(doc, {
        type: 'batch',
        commands: [node('a', 0, 0), node('c', 1000, 100), { type: 'segment.add', segment: { id: 'curve', a: 'a', b: 'c', roadTypeId: 'road-2', control: { x: 1248.875, z: -100 } } }],
      }),
    ).toEqual({ ok: true });
    // The curve passes (999.5, 0): 0.5 m from b, which is not a node of the curve.
    const r = applyCommand(doc, { type: 'batch', commands: [node('b', 1000, 0), { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cross another road without a junction/);
  });

  it('#3 contact is decided on the true curve at the 0.05 m boundary (no subdivision blind spot)', () => {
    const base = createEmptyDoc();
    expect(applyCommand(base, { type: 'batch', commands: [node('w', -100, 0), node('e', 100, 0), { type: 'segment.add', segment: { id: 'r', a: 'w', b: 'e', roadTypeId: 'road-2' } }] })).toEqual({ ok: true });
    const curve = (dz: number) =>
      applyCommand(cloneJson(base), {
        type: 'batch',
        commands: [node('p', -50, 25.080008 + dz), node('q', 50, 25.020008 + dz), { type: 'segment.add', segment: { id: 'c', a: 'p', b: 'q', roadTypeId: 'road-2', control: { x: 0, z: -24.949992 + dz } } }],
      });
    // Contract (CONTACT_PRECISION 5e-5): < 0.0499 m always contact, ≥ 0.05 m never, in between either way.
    // Sol's 0.049999 m sits inside that band, so the reject case is moved just below it (0.049889 m).
    expect(curve(-0.00011).ok).toBe(false); // true minimum 0.049889 m
    expect(curve(0.000004)).toEqual({ ok: true }); // 0.050003 m
  });

  it('#2 a stroke may cross (or end on) a road an earlier piece of the same stroke split', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, { type: 'batch', commands: [node('A1', 0, -100), node('A2', 0, 200), { type: 'segment.add', segment: { id: 'A', a: 'A1', b: 'A2', roadTypeId: 'road-2' } }] })).toEqual({ ok: true });
    const start = resolvePoint(doc, { x: 0, z: 0 });
    const end = resolvePoint(doc, { x: 0, z: 100 });
    expect([start.kind, end.kind]).toEqual(['split', 'split']);
    const plan = planRoadChain(
      doc,
      { start, end, roadTypeId: 'road-2', pieces: [{ pos: { x: 50, z: 50 }, control: { x: 50, z: 0 } }, { pos: { x: 0, z: 100 }, control: { x: 50, z: 100 } }] },
      new IdGen('t'),
    );
    expect(plan.error).toBeUndefined();
    expect(applyCommand(doc, plan.command!)).toEqual({ ok: true });
    // Crossing the same road twice through a stroke-internal split, by road id.
    const doc2 = createEmptyDoc();
    expect(applyCommand(doc2, { type: 'batch', commands: [node('A1', 0, -100), node('A2', 0, 200), { type: 'segment.add', segment: { id: 'A', a: 'A1', b: 'A2', roadTypeId: 'road-2' } }] })).toEqual({ ok: true });
    const twice = planRoadChain(
      doc2,
      {
        start: { kind: 'free', pos: { x: -50, z: 0 } },
        end: { kind: 'free', pos: { x: -50, z: 100 } },
        roadTypeId: 'road-2',
        pieces: [{ pos: { x: 0, z: 0 }, road: 'A' }, { pos: { x: 50, z: 50 }, control: { x: 50, z: 0 } }, { pos: { x: 0, z: 100 }, road: 'A', control: { x: 50, z: 100 } }, { pos: { x: -50, z: 100 } }],
      },
      new IdGen('u'),
    );
    expect(twice.error).toBeUndefined();
    expect(applyCommand(doc2, twice.command!)).toEqual({ ok: true });
  });

  it('#2 a road gone for another reason (someone else removed it) still refuses with the reason', () => {
    const doc = createEmptyDoc();
    const plan = planRoadChain(doc, { start: { kind: 'free', pos: { x: -50, z: 0 } }, end: { kind: 'free', pos: { x: 50, z: 0 } }, roadTypeId: 'road-2', pieces: [{ pos: { x: 0, z: 0 }, road: 'removed' }, { pos: { x: 50, z: 0 } }] }, new IdGen('t'));
    expect(plan.command).toBeNull();
    expect(plan.error).toBe('교차한 도로가 바뀌었습니다. 다시 그리세요');
    expect(plan.failedPiece).toBe(0);
  });
});
