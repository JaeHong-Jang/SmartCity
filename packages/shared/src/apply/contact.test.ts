// Road contact checks: correctness at the contract boundaries, deterministic work (evaluations), atomic
// refusal when the transaction budget runs out, and cost on large / adversarial cities.
//
// Timing: the regular run asserts results and evaluation counts, and wall-clock times only with bounds of
// at least 10× what was measured on the development machine (slow CI must not flake). SC_PERF=1 runs the
// same tests with the tight bounds (the numbers in the reports) and prints the measurements.
import { describe, it, expect } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, type Command } from '../index.js';
import { CONTACT_BUDGET, crossedRoad, curvesTouch } from './roads.js';
declare const process: { env: Record<string, string | undefined>; hrtime: { bigint(): bigint }; stderr: { write(s: string): void } };
const now = () => Number(process.hrtime.bigint()) / 1e6;
const PERF = process.env.SC_PERF === '1';
/** A wall-clock bound: tight under SC_PERF=1, 10× looser otherwise. */
const within = (ms: number): number => (PERF ? ms : ms * 10);
const report = (s: string): void => {
  if (PERF) process.stderr.write(s);
};
it('crossedRoad stays fast with thousands of long curves (far, crossing, near-miss, long parallel near-miss)', () => {
  const out: string[] = [];
  for (const n of [1000, 5000]) {
    const doc = createEmptyDoc();
    for (let i = 0; i < n; i++) {
      doc.nodes[`a${i}`] = { id: `a${i}`, pos: { x: -1800, z: -1500 + 0.06 * i } };
      doc.nodes[`b${i}`] = { id: `b${i}`, pos: { x: 1800, z: -1500 + 0.06 * i } };
      doc.segments[`s${i}`] = { id: `s${i}`, a: `a${i}`, b: `b${i}`, roadTypeId: 'road-2', control: { x: 0, z: -1300 + 0.06 * i } };
    }
    for (const [name, a, b] of [['far', { x: 0, z: 1000 }, { x: 100, z: 1000 }], ['crossing', { x: 0, z: -1600 }, { x: 0, z: -1000 }], ['near-clear', { x: -50, z: -1405 }, { x: 50, z: -1405 }], ['parallel-0.08', { x: 0, z: 0 }, { x: 0, z: 0 }]] as const) {
      const t = [];
      let hit: unknown = null;
      for (let k = 0; k < 5; k++) { const t0 = now(); hit = crossedRoad(doc, name === 'parallel-0.08' ? { a: { x: -1800, z: -1500.08 }, b: { x: 1800, z: -1500.08 }, control: { x: 0, z: -1300.08 } } : { a, b }, () => false, () => []); t.push(now() - t0); }
      t.sort((p, q) => p - q);
      expect(t[2]!).toBeLessThan(within(100));
      out.push(`${n} ${name}: median ${t[2]!.toFixed(1)} ms max ${t[4]!.toFixed(1)} hit=${(hit as { road: { id: string } } | null)?.road.id ?? null}`);
    }
  }
  report(`[contact perf]\n${out.join('\n')}\n`);
}, 60_000);

type V = { x: number; z: number };
const quad = (a: V, control: V | undefined, b: V) => ({ a, b, ...(control ? { control } : {}) });

it('Sol P5b recheck 3: two collinear curves exactly 0.05 m apart are decided at once (no runaway subdivision)', () => {
  const doc = createEmptyDoc();
  const road = (id: string, z: number): Command => ({
    type: 'batch',
    commands: [
      { type: 'node.add', node: { id: `${id}1`, pos: { x: -1800, z } } },
      { type: 'node.add', node: { id: `${id}2`, pos: { x: 1800, z } } },
      { type: 'segment.add', segment: { id, a: `${id}1`, b: `${id}2`, roadTypeId: 'road-2', control: { x: -800, z } } },
    ],
  });
  expect(applyCommand(doc, road('A', 0))).toEqual({ ok: true });
  const t0 = now();
  expect(applyCommand(doc, road('B', 0.05))).toEqual({ ok: true });
  expect(now() - t0).toBeLessThan(within(50));
  // Deterministic work: the two collinear curves are decided in one evaluation.
  const budget = { left: CONTACT_BUDGET };
  expect(curvesTouch(quad({ x: -1800, z: 0 }, { x: -800, z: 0 }, { x: 1800, z: 0 }), quad({ x: -1800, z: 0.05 }, { x: -800, z: 0.05 }, { x: 1800, z: 0.05 }), [], budget)).toBe('clear');
  expect(CONTACT_BUDGET - budget.left).toBe(1);
});

it('adversarial contact inputs return within the budget and the time limit, with the contracted answers', () => {
  const lines: string[] = [];
  const cases: [string, ReturnType<typeof quad>, ReturnType<typeof quad>, 'contact' | 'clear' | 'either'][] = [
    ['collinear quads at exactly eps', quad({ x: -1800, z: 0 }, { x: -800, z: 0 }, { x: 1800, z: 0 }), quad({ x: -1800, z: 0.05 }, { x: -800, z: 0.05 }, { x: 1800, z: 0.05 }), 'clear'],
    ['collinear quads at eps + 1e-6', quad({ x: -1800, z: 0 }, { x: -800, z: 0 }, { x: 1800, z: 0 }), quad({ x: -1800, z: 0.050001 }, { x: -800, z: 0.050001 }, { x: 1800, z: 0.050001 }), 'clear'],
    ['collinear quads at eps − 1e-6', quad({ x: -1800, z: 0 }, { x: -800, z: 0 }, { x: 1800, z: 0 }), quad({ x: -1800, z: 0.049999 }, { x: -800, z: 0.049999 }, { x: 1800, z: 0.049999 }), 'contact'],
    ['parallel straights at exactly eps', quad({ x: -1800, z: 0 }, undefined, { x: 1800, z: 0 }), quad({ x: -1800, z: 0.05 }, undefined, { x: 1800, z: 0.05 }), 'clear'],
    ['fold-back collinear quad vs line at eps', quad({ x: 0, z: 0 }, { x: 1000, z: 0 }, { x: 200, z: 0 }), quad({ x: -100, z: 0.05 }, undefined, { x: 1500, z: 0.05 }), 'clear'],
    ['long curve translated by eps', quad({ x: -1800, z: 0 }, { x: 0, z: 400 }, { x: 1800, z: 0 }), quad({ x: -1800, z: 0.05 }, { x: 0, z: 400.05 }, { x: 1800, z: 0.05 }), 'contact'],
    ['near-tangent long curve, eps + 1e-6 below the apex', quad({ x: -1800, z: 0 }, { x: 0, z: -200 }, { x: 1800, z: 0 }), quad({ x: -1800, z: -100.050001 }, undefined, { x: 1800, z: -100.050001 }), 'clear'],
    ['near-tangent long curve, eps − 1e-6 below the apex', quad({ x: -1800, z: 0 }, { x: 0, z: -200 }, { x: 1800, z: 0 }), quad({ x: -1800, z: -100.049999 }, undefined, { x: 1800, z: -100.049999 }), 'either'],
    ['near-tangent long curve, 0.0498 below the apex', quad({ x: -1800, z: 0 }, { x: 0, z: -200 }, { x: 1800, z: 0 }), quad({ x: -1800, z: -100.0498 }, undefined, { x: 1800, z: -100.0498 }), 'contact'],
    ['flat 2 km curve and its copy 0.05 m up (≈0.05·cos θ apart everywhere)', quad({ x: -1000, z: 0 }, { x: 0, z: 10 }, { x: 1000, z: 0 }), quad({ x: -1000, z: 0.05 }, { x: 0, z: 10.05 }, { x: 1000, z: 0.05 }), 'either'],
    ['flat 2 km curve and its copy 0.0501 m up', quad({ x: -1000, z: 0 }, { x: 0, z: 10 }, { x: 1000, z: 0 }), quad({ x: -1000, z: 0.0501 }, { x: 0, z: 10.0501 }, { x: 1000, z: 0.0501 }), 'clear'],
    ['two flat curves touching at eps over km', quad({ x: -1800, z: 0 }, { x: 0, z: 1 }, { x: 1800, z: 0 }), quad({ x: -1800, z: 0.55 }, { x: 0, z: 0.55 }, { x: 1800, z: 0.55 }), 'either'],
  ];
  for (const [name, a, b, expected] of cases) {
    const budget = { left: CONTACT_BUDGET };
    const t0 = now();
    const r = curvesTouch(a, b, [], budget);
    const ms = now() - t0;
    lines.push(`${name}: ${r} in ${ms.toFixed(2)} ms, ${CONTACT_BUDGET - budget.left} evaluations`);
    expect(r, name).not.toBe('budget');
    if (expected !== 'either') expect(r, name).toBe(expected);
    expect(ms, name).toBeLessThan(within(50));
    expect(CONTACT_BUDGET - budget.left, name).toBeLessThan(10_000);
  }
  report(`[contact adversarial]\n${lines.join('\n')}\n`);
});

it('running out of the budget is a defined, conservative result', () => {
  const r = curvesTouch(quad({ x: -1800, z: 0 }, { x: 0, z: 400 }, { x: 1800, z: 0 }), quad({ x: -1800, z: 0.05 }, { x: 0, z: 400.05 }, { x: 1800, z: 0.05 }), [], { left: 3 });
  expect(r).toBe('budget');
});

/** Sol P5b recheck 4: a legacy city whose roads overlap; group g has 43 curves 0.0501 m above the one added. */
function denseLegacy(groups: number) {
  const doc = createEmptyDoc();
  for (let g = 0; g < groups; g++) {
    const z = -1500 + 20 * g;
    for (let k = 0; k < 43; k++) {
      const id = `e${g}_${k}`;
      doc.nodes[`${id}a`] = { id: `${id}a`, pos: { x: -1000, z: z + 0.0501 } };
      doc.nodes[`${id}b`] = { id: `${id}b`, pos: { x: 1000, z: z + 0.0501 } };
      doc.segments[id] = { id, a: `${id}a`, b: `${id}b`, roadTypeId: 'road-2', control: { x: 0, z: z + 10.0501 } };
    }
  }
  const batch = (n: number): Command => ({
    type: 'batch',
    commands: Array.from({ length: n }, (_, g): Command[] => {
      const z = -1500 + 20 * g;
      return [
        { type: 'node.add', node: { id: `n${g}a`, pos: { x: -1000, z } } },
        { type: 'node.add', node: { id: `n${g}b`, pos: { x: 1000, z } } },
        { type: 'segment.add', segment: { id: `n${g}`, a: `n${g}a`, b: `n${g}b`, roadTypeId: 'road-2', control: { x: 0, z: z + 10 } } },
      ];
    }).flat(),
  });
  return { doc, batch };
}

it('one contact budget for the whole transaction: a many-road batch on a dense legacy city is refused atomically and fast', () => {
  const { doc, batch } = denseLegacy(150);
  const before = JSON.stringify(Object.keys(doc.segments).length);
  // Two roads fit in the shared allowance (each costs ~200k evaluations here).
  const small = cloneJson(doc);
  expect(applyCommand(small, batch(2))).toEqual({ ok: true });
  const t0 = now();
  const r = applyCommand(doc, batch(150));
  const ms = now() - t0;
  report(`[contact budget] 150-road batch on the dense legacy fixture: refused after ${ms.toFixed(0)} ms\n`);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe('the new road could not be checked against nearby roads (contact check limit)');
  expect(JSON.stringify(Object.keys(doc.segments).length)).toBe(before);
  expect(doc.segments.n0).toBeUndefined();
  expect(ms).toBeLessThan(within(400));
  // Trusted apply (sim worker, confirmed state, log replay) never runs the check.
  const t1 = now();
  expect(applyCommand(cloneJson(doc), batch(150), { trusted: true })).toEqual({ ok: true });
  expect(now() - t1).toBeLessThan(within(400));
}, 60_000);

it('Sol P5b recheck 4 #2: a nearly collinear quad keeps its deviation bound (≥ 0.05 m is never contact)', () => {
  const a = quad({ x: -1800, z: 0 }, { x: 0, z: 8e-10 }, { x: 1800, z: 0 });
  const b = quad({ x: -5, z: -0.0499999998 }, undefined, { x: 5, z: -0.0499999998 });
  expect(curvesTouch(a, b, [])).toBe('clear');
  expect(curvesTouch(a, quad({ x: -5, z: -0.0498 }, undefined, { x: 5, z: -0.0498 }), [])).toBe('contact');
});

it('Sol P5b recheck 5: no full-city scans per road — 333 far roads in one batch on a 15,000-road city', () => {
  const lines: string[] = [];
  for (const n of [5000, 15000]) {
    const doc = createEmptyDoc();
    for (let i = 0; i < n; i++) {
      const x = -1800 + 25 * (i % 100);
      const z = -1500 + 20 * Math.floor(i / 100);
      doc.nodes[`p${i}`] = { id: `p${i}`, pos: { x, z } };
      doc.nodes[`q${i}`] = { id: `q${i}`, pos: { x: x + 10, z } };
      doc.segments[`s${i}`] = { id: `s${i}`, a: `p${i}`, b: `q${i}`, roadTypeId: 'road-2' };
    }
    const cmds: Command[] = [];
    for (let j = 0; j < 333; j++) {
      const x = 1000 + 200 * (j % 3);
      const z = -1500 + 25 * Math.floor(j / 3);
      cmds.push(
        { type: 'node.add', node: { id: `a${j}`, pos: { x, z } } },
        { type: 'node.add', node: { id: `b${j}`, pos: { x: x + 100, z } } },
        { type: 'segment.add', segment: { id: `n${j}`, a: `a${j}`, b: `b${j}`, roadTypeId: 'road-2' } },
      );
    }
    const t0 = now();
    expect(applyCommand(doc, { type: 'batch', commands: cmds })).toEqual({ ok: true });
    const ms = now() - t0;
    lines.push(`${n} existing roads + 333-road batch (999 commands): ${ms.toFixed(0)} ms`);
    expect(Object.keys(doc.segments)).toHaveLength(n + 333);
    expect(ms).toBeLessThan(within(n === 15000 ? 100 : 60));
  }
  report(`[recheck 5]\n${lines.join('\n')}\n`);
}, 60_000);

it('the transaction index follows the batch: roads added, split or moved earlier in it are checked', () => {
  const node = (id: string, x: number, z: number): Command => ({ type: 'node.add', node: { id, pos: { x, z } } });
  const seg = (id: string, a: string, b: string): Command => ({ type: 'segment.add', segment: { id, a, b, roadTypeId: 'road-2' } });
  // Added earlier in the same batch.
  const doc = createEmptyDoc();
  const r1 = applyCommand(doc, { type: 'batch', commands: [node('a', 0, 0), node('b', 100, 0), seg('x', 'a', 'b'), node('c', 50, -50), node('d', 50, 50), seg('y', 'c', 'd')] });
  expect(r1.ok).toBe(false);
  expect(doc.segments).toEqual({});
  // Split earlier in the batch: the new pieces are found.
  const base = createEmptyDoc();
  expect(applyCommand(base, { type: 'batch', commands: [node('a', 0, 0), node('b', 100, 0), seg('x', 'a', 'b')] })).toEqual({ ok: true });
  const split = cloneJson(base);
  expect(applyCommand(split, { type: 'batch', commands: [{ type: 'segment.split', id: 'x', t: 0.5, nodeId: 'm', segmentIds: ['x1', 'x2'] }, node('c', 25, -50), node('d', 25, 50), seg('y', 'c', 'd')] }).ok).toBe(false);
  // Moved earlier in the batch: checked where it is now, not where it was.
  const moved = cloneJson(base);
  const move: Command = { type: 'node.move', id: 'b', pos: { x: 100, z: 100 } };
  // y crosses only where x used to be (z = 0): accepted; without the move it is refused.
  const across: Command[] = [node('c', 40, -10), node('d', 60, 10), seg('y', 'c', 'd')];
  expect(applyCommand(cloneJson(moved), { type: 'batch', commands: [move, ...across] })).toEqual({ ok: true });
  expect(applyCommand(cloneJson(moved), { type: 'batch', commands: across }).ok).toBe(false);
  expect(applyCommand(cloneJson(moved), { type: 'batch', commands: [move, node('c', 60, 30), node('d', 40, 70), seg('y', 'c', 'd')] }).ok).toBe(false);
});

describe('Sol P5b recheck 6', () => {
  const node = (id: string, x: number, z: number): Command => ({ type: 'node.add', node: { id, pos: { x, z } } });
  const road = (id: string, a: V, b: V, ifClear = true): Command[] => [
    node(`${id}a`, a.x, a.z),
    node(`${id}b`, b.x, b.z),
    { type: 'segment.add', segment: { id, a: `${id}a`, b: `${id}b`, roadTypeId: 'road-2' }, ...(ifClear ? { ifClear: true as const } : {}) },
  ];

  it('#1 a design enlarged earlier in the batch is checked at its new size', () => {
    const doc = createEmptyDoc();
    const house = doc.buildingTypes.house!;
    const part = { ...house.parts[0]!, offset: { x: 0, z: 0 }, width: 10, depth: 10, roof: 'flat' as const };
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: { ...house, id: 'bt', name: 'bt', parts: [part], rev: undefined } })).toEqual({ ok: true });
    expect(applyCommand(doc, { type: 'building.place', building: { id: 'b', typeId: 'bt', pos: { x: 0, z: 0 }, rotation: 0 } })).toEqual({ ok: true });
    const enlarged = { ...doc.buildingTypes.bt!, parts: [{ ...part, width: 300, depth: 300 }] };
    const batch: Command = {
      type: 'batch',
      commands: [...road('far', { x: 1000, z: 1000 }, { x: 1040, z: 1000 }), { type: 'buildingType.upsert', buildingType: enlarged }, ...road('inside', { x: 100, z: 80 }, { x: 140, z: 80 })],
    };
    const before = cloneJson(doc);
    const r = applyCommand(doc, batch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('road would cross a building');
    expect(doc).toEqual(before);
    // Without the far road first (no index yet) the answer is the same.
    const r2 = applyCommand(cloneJson(doc), { type: 'batch', commands: [{ type: 'buildingType.upsert', buildingType: enlarged }, ...road('inside', { x: 100, z: 80 }, { x: 140, z: 80 })] });
    expect(r2.ok).toBe(false);
  });

  it('#1 a building moved or placed earlier in the batch is where it is now', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, { type: 'building.place', building: { id: 'h', typeId: 'house', pos: { x: 0, z: 0 }, rotation: 0 } })).toEqual({ ok: true });
    const r = applyCommand(cloneJson(doc), {
      type: 'batch',
      commands: [...road('far', { x: 1000, z: 1000 }, { x: 1040, z: 1000 }), { type: 'building.move', id: 'h', pos: { x: 120, z: 80 }, rotation: 0 }, ...road('through', { x: 100, z: 80 }, { x: 140, z: 80 })],
    });
    expect(r.ok).toBe(false);
  });

  it('#2 long diagonals are filed along their path, not their whole box: one far road on 15,000 diagonals', () => {
    const doc = createEmptyDoc();
    for (let i = 0; i < 15000; i++) {
      doc.nodes[`d${i}a`] = { id: `d${i}a`, pos: { x: -1800, z: -1800 } };
      doc.nodes[`d${i}b`] = { id: `d${i}b`, pos: { x: 1800, z: 1800 } };
      doc.segments[`d${i}`] = { id: `d${i}`, a: `d${i}a`, b: `d${i}b`, roadTypeId: 'road-2' };
    }
    const t0 = now();
    const r = applyCommand(doc, { type: 'batch', commands: road('far', { x: 1000, z: -1000 }, { x: 1100, z: -1000 }, false) });
    const ms = now() - t0;
    report(`[recheck 6 #2] one far road on 15,000 identical 5 km diagonals: ${JSON.stringify(r)} in ${ms.toFixed(0)} ms\n`);
    // Building the index is not charged (lead decision, recheck 7): the far road is simply accepted.
    expect(r).toEqual({ ok: true });
    expect(ms).toBeLessThan(within(250));
  });

  it('#3 removing roads decides orphan nodes from the adjacency: 1,000 removals on a 15,000-road city', () => {
    const doc = createEmptyDoc();
    for (let i = 0; i < 15000; i++) {
      const x = -1800 + 25 * (i % 100);
      const z = -1500 + 20 * Math.floor(i / 100);
      doc.nodes[`p${i}`] = { id: `p${i}`, pos: { x, z } };
      doc.nodes[`q${i}`] = { id: `q${i}`, pos: { x: x + 10, z } };
      doc.segments[`s${i}`] = { id: `s${i}`, a: `p${i}`, b: `q${i}`, roadTypeId: 'road-2' };
    }
    const t0 = now();
    expect(applyCommand(doc, { type: 'batch', commands: Array.from({ length: 1000 }, (_, i): Command => ({ type: 'segment.remove', id: `s${i}` })) })).toEqual({ ok: true });
    const ms = now() - t0;
    report(`[recheck 6 #3] 1,000 removals on 15,000 roads: ${ms.toFixed(0)} ms\n`);
    expect(Object.keys(doc.segments)).toHaveLength(14000);
    expect(doc.nodes.p0).toBeUndefined();
    expect(doc.nodes.p1000).toBeDefined();
    expect(ms).toBeLessThan(within(100));
  });
});

describe('Sol P5b recheck 7: buildings are filed by their real footprint; building the index is not charged', () => {
  /** 5,000 short roads in the west; `houses` 10×9 m houses in the east; the design's part offset `off`. */
  function city(houses: number, off: number) {
    const doc = createEmptyDoc();
    for (let i = 0; i < 5000; i++) {
      const x = -1950 + 18 * (i % 50);
      const z = -1750 + 35 * Math.floor(i / 50);
      doc.nodes[`p${i}`] = { id: `p${i}`, pos: { x, z } };
      doc.nodes[`q${i}`] = { id: `q${i}`, pos: { x: x + 8, z } };
      doc.segments[`s${i}`] = { id: `s${i}`, a: `p${i}`, b: `q${i}`, roadTypeId: 'road-2' };
    }
    const house = doc.buildingTypes.house!;
    const part = { ...house.parts[0]!, offset: { x: off, z: off }, width: 10, depth: 9, roof: 'flat' as const };
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: { ...house, id: 'h109', name: 'h109', parts: [part], rev: undefined } })).toEqual({ ok: true });
    for (let i = 0; i < houses; i++) {
      const x = -800 + 14 * (i % 200);
      const z = -1700 + 14 * Math.floor(i / 200);
      doc.buildings[`b${i}`] = { id: `b${i}`, typeId: 'h109', pos: { x: x - off, z: z - off }, rotation: 0 };
    }
    return doc;
  }
  const far: Command = {
    type: 'batch',
    commands: [
      { type: 'node.add', node: { id: 'fa', pos: { x: -1800, z: 1850 } } },
      { type: 'node.add', node: { id: 'fb', pos: { x: -1700, z: 1850 } } },
      { type: 'segment.add', segment: { id: 'far', a: 'fa', b: 'fb', roadTypeId: 'road-2' }, ifClear: true },
    ],
  };

  it('the same city with offset (0,0) or (200,200) designs gives the same result (40,000 and 50,000 houses)', () => {
    const lines: string[] = [];
    for (const houses of [40_000, 50_000]) {
      const results: unknown[] = [];
      for (const off of [0, 200]) {
        const doc = city(houses, off);
        const t0 = now();
        const r = applyCommand(doc, far);
        const ms = now() - t0;
        lines.push(`${houses} houses, part offset ${off}: ${JSON.stringify(r)} in ${ms.toFixed(0)} ms`);
        expect(r, `${houses}/${off}`).toEqual({ ok: true });
        expect(ms).toBeLessThan(within(150));
        results.push(doc.segments.far);
      }
      expect(results[0]).toEqual(results[1]);
    }
    report(`[recheck 7]\n${lines.join('\n')}\n`);
  }, 60_000);

  it('an offset design is still found where its footprint really is', () => {
    const doc = city(200, 200);
    // House b0 stands at (-805..-795, -1704.5..-1695.5); a road through it is refused, one beside its origin is not.
    const through: Command = {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'ta', pos: { x: -830, z: -1700 } } },
        { type: 'node.add', node: { id: 'tb', pos: { x: -770, z: -1700 } } },
        { type: 'segment.add', segment: { id: 't', a: 'ta', b: 'tb', roadTypeId: 'road-2' }, ifClear: true },
      ],
    };
    const r = applyCommand(cloneJson(doc), through);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('road would cross a building');
  });
});

describe('Sol P5b recheck 8: building changes are re-filed lazily, once, and only when their geometry changed', () => {
  function town(houses: number) {
    const doc = createEmptyDoc();
    for (let i = 0; i < 5000; i++) {
      const x = -1950 + 18 * (i % 50);
      const z = -1750 + 35 * Math.floor(i / 50);
      doc.nodes[`p${i}`] = { id: `p${i}`, pos: { x, z } };
      doc.nodes[`q${i}`] = { id: `q${i}`, pos: { x: x + 8, z } };
      doc.segments[`s${i}`] = { id: `s${i}`, a: `p${i}`, b: `q${i}`, roadTypeId: 'road-2' };
    }
    const house = doc.buildingTypes.house!;
    const part = { ...house.parts[0]!, offset: { x: 0, z: 0 }, width: 10, depth: 9, roof: 'flat' as const };
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: { ...house, id: 'h109', name: 'h109', parts: [part], rev: undefined } })).toEqual({ ok: true });
    for (let i = 0; i < houses; i++) doc.buildings[`b${i}`] = { id: `b${i}`, typeId: 'h109', pos: { x: -800 + 14 * (i % 200), z: -1700 + 14 * Math.floor(i / 200) }, rotation: 0 };
    return doc;
  }
  let n = 0;
  const road = (a: V, b: V): Command[] => {
    const id = `r${n++}`;
    return [
      { type: 'node.add', node: { id: `${id}a`, pos: a } },
      { type: 'node.add', node: { id: `${id}b`, pos: b } },
      { type: 'segment.add', segment: { id, a: `${id}a`, b: `${id}b`, roadTypeId: 'road-2' }, ifClear: true },
    ];
  };

  it('100 renames of a 40,000-house design in one batch stay cheap (no re-filing)', () => {
    const doc = town(40_000);
    const renames = Array.from({ length: 100 }, (_, k): Command => ({ type: 'buildingType.upsert', buildingType: { ...doc.buildingTypes.h109!, name: `집 ${k}` } }));
    const t0 = now();
    const r = applyCommand(doc, { type: 'batch', commands: [...road({ x: -1800, z: 1850 }, { x: -1700, z: 1850 }), ...renames, ...road({ x: -1800, z: 1900 }, { x: -1700, z: 1900 })] });
    const ms = now() - t0;
    report(`[recheck 8] 100 renames on 40,000 houses (+2 ifClear roads): ${ms.toFixed(0)} ms\n`);
    expect(r).toEqual({ ok: true });
    expect(doc.buildingTypes.h109!.name).toBe('집 99');
    expect(ms).toBeLessThan(within(100));
  });

  it('994 building moves then an ifClear road (a full 1,000-command batch): moved buildings are checked where they ended up', () => {
    const doc = town(40_000);
    const moves = Array.from({ length: 994 }, (_, i): Command => ({ type: 'building.move', id: `b${i}`, pos: { x: -800 + 14 * (i % 200), z: 1000 + 14 * Math.floor(i / 200) }, rotation: 0 }));
    const t0 = now();
    const r = applyCommand(cloneJson(doc), { type: 'batch', commands: [...road({ x: -1800, z: 1850 }, { x: -1700, z: 1850 }), ...moves, ...road({ x: -1800, z: 1900 }, { x: -1700, z: 1900 })] });
    const ms = now() - t0;
    report(`[recheck 8] 994 moves on 40,000 houses (+2 ifClear roads, 1,000 commands): ${ms.toFixed(0)} ms\n`);
    expect(r).toEqual({ ok: true });
    expect(ms).toBeLessThan(within(150));
    // A road through a moved building's new place is refused; through its old place, accepted.
    expect(applyCommand(cloneJson(doc), { type: 'batch', commands: [...road({ x: -1800, z: 1850 }, { x: -1700, z: 1850 }), ...moves, ...road({ x: -830, z: 1000 }, { x: -770, z: 1000 })] }).ok).toBe(false);
    expect(applyCommand(cloneJson(doc), { type: 'batch', commands: [...road({ x: -1800, z: 1850 }, { x: -1700, z: 1850 }), moves[1]!, ...road({ x: -820, z: -1700 }, { x: -780, z: -1700 })] }).ok).toBe(false); // b0 still there
  });

  it('a design enlarged twice then shrunk in one batch matches applying the commands one by one', () => {
    const base = createEmptyDoc();
    const house = base.buildingTypes.house!;
    const part = { ...house.parts[0]!, offset: { x: 0, z: 0 }, width: 10, depth: 10, roof: 'flat' as const };
    expect(applyCommand(base, { type: 'buildingType.upsert', buildingType: { ...house, id: 'bt', name: 'bt', parts: [part], rev: undefined } })).toEqual({ ok: true });
    expect(applyCommand(base, { type: 'building.place', building: { id: 'b', typeId: 'bt', pos: { x: 0, z: 0 }, rotation: 0 } })).toEqual({ ok: true });
    const size = (w: number): Command => ({ type: 'buildingType.upsert', buildingType: { ...base.buildingTypes.bt!, parts: [{ ...part, width: w, depth: w }] } });
    const sequences: [string, Command[]][] = [
      ['enlarged, road at z 40', [...road({ x: 1000, z: 1000 }, { x: 1040, z: 1000 }), size(100), ...road({ x: -20, z: 40 }, { x: 20, z: 40 })]],
      ['enlarged twice, road at z 90', [...road({ x: 1000, z: 1000 }, { x: 1040, z: 1000 }), size(100), ...road({ x: 1000, z: 1100 }, { x: 1040, z: 1100 }), size(200), ...road({ x: -20, z: 90 }, { x: 20, z: 90 })]],
      ['enlarged twice then shrunk, road at z 40', [...road({ x: 1000, z: 1000 }, { x: 1040, z: 1000 }), size(100), ...road({ x: 1000, z: 1100 }, { x: 1040, z: 1100 }), size(200), ...road({ x: 1000, z: 1200 }, { x: 1040, z: 1200 }), size(10), ...road({ x: -20, z: 40 }, { x: 20, z: 40 })]],
      ['enlarged twice then shrunk, road through it', [...road({ x: 1000, z: 1000 }, { x: 1040, z: 1000 }), size(100), size(200), size(10), ...road({ x: -20, z: 2 }, { x: 20, z: 2 })]],
    ];
    const outcomes: string[] = [];
    for (const [name, cmds] of sequences) {
      const batched = applyCommand(cloneJson(base), { type: 'batch', commands: cmds });
      // Reference: the same commands one by one, each its own transaction (a fresh index every time).
      const seq = cloneJson(base);
      let reference: { ok: boolean } = { ok: true };
      for (const c of cmds) {
        reference = applyCommand(seq, c);
        if (!reference.ok) break;
      }
      expect(batched.ok, name).toBe(reference.ok);
      outcomes.push(`${name}: ${batched.ok ? 'ok' : 'refused'}`);
    }
    expect(outcomes).toEqual(['enlarged, road at z 40: refused', 'enlarged twice, road at z 90: refused', 'enlarged twice then shrunk, road at z 40: ok', 'enlarged twice then shrunk, road through it: refused']);
  });
});
