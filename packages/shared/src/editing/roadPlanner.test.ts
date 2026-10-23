import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, IdGen, planRoad, resolvePoint, segmentsAtNode, type CityDoc } from '../index.js';

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
