import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, IdGen, type Command, type RoadSegment, type Vec2 } from '@smartcity/shared';
import { ClientStore, translateError } from '../app/store';
import { RoadTool } from './roadTool';
import type { ToolContext, ToolPointer } from './types';

// Node globals for the timing test (the web tsconfig has no Node types).
declare const process: { hrtime: { bigint(): bigint }; stderr: { write(s: string): void } };

/** Road tool on a store whose dispatch is applied at once (as the server would). Screen: 2 px per meter. */
function setup(seed: Command[] = []) {
  const store = new ClientStore('main', '나');
  store.receive({ t: 'welcome', clientId: 'me', tag: 'T', color: '#ff0000', room: 'main', seq: 0, doc: createEmptyDoc(), peers: [] });
  let seq = 1;
  const apply = (cmd: Command) => store.receive({ t: 'applied', seq: seq++, cmd, by: 'other' });
  for (const c of seed) apply(c);
  const sent: Command[] = [];
  const dispatch = vi.fn((cmd: Command) => {
    sent.push(cmd);
    apply(cmd);
    return 1;
  });
  const ids = new IdGen('T');
  const ctx: ToolContext = { store, dispatch, ids: () => ids, changed: () => {}, pan: { start: () => true, move: () => {}, end: () => {} }, focus: () => {} };
  const tool = new RoadTool(ctx);
  const at = (p: Vec2, extra: Partial<ToolPointer> = {}): ToolPointer => ({ pos: p, client: { x: p.x * 2, y: p.z * 2 }, button: 0, shift: false, ctrl: false, alt: false, mPerPx: 0.5, ...extra });
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const click = (p: Vec2, dt = 1000) => {
    clock += dt;
    tool.onPointerMove(at(p));
    tool.onPointerDown(at(p));
    tool.onPointerUp(at(p));
  };
  const drag = (path: Vec2[]) => {
    clock += 1000;
    tool.onPointerMove(at(path[0]!));
    tool.onPointerDown(at(path[0]!));
    for (const p of path.slice(1)) tool.onPointerMove(at(p));
    tool.onPointerUp(at(path[path.length - 1]!));
  };
  const segs = (): RoadSegment[] => Object.values(store.getState().doc.segments);
  return { store, tool, sent, click, drag, at, segs, now };
}

const batch = (c: Command | undefined): Command[] => (c?.type === 'batch' ? c.commands : []);

describe('RoadTool straight mode (b1)', () => {
  it('angle snap gives an exact 45° road whose committed end is the previewed one', () => {
    const { tool, sent, click, at, segs } = setup();
    click({ x: 0, z: 0 });
    tool.onPointerMove(at({ x: 30, z: 31.5 }));
    const preview = tool.preview();
    expect(preview.label?.text).toMatch(/^43\.0 m · 135° · 각도$/);
    click({ x: 30, z: 31.5 });
    expect(sent).toHaveLength(1);
    const end = batch(sent[0]).find((c) => c.type === 'node.add' && c.node.pos.x !== 0);
    expect(end?.type === 'node.add' && end.node.pos.x).toBeCloseTo(43 * Math.SQRT1_2, 12);
    expect(end?.type === 'node.add' && end.node.pos.z).toBeCloseTo(43 * Math.SQRT1_2, 12);
    // The preview drew exactly this end.
    const ribbon = preview.lines[0]!.pts;
    expect(ribbon[ribbon.length - 1]!.x).toBeCloseTo(43 * Math.SQRT1_2, 12);
    expect(segs()).toHaveLength(1);
  });

  it('a double click ends the stroke without a duplicate point; Enter ends it too', () => {
    const { tool, sent, click, store } = setup();
    click({ x: 0, z: 0 });
    click({ x: 96, z: 0 });
    click({ x: 96, z: 0 }, 200);
    expect(sent).toHaveLength(1);
    expect(store.getState().toolHint).toMatch(/^도로 시작점을 클릭하세요/);
    expect(Object.keys(store.getState().doc.nodes)).toHaveLength(2);
    click({ x: 0, z: 96 });
    click({ x: 96, z: 96 });
    tool.onKey({ type: 'keydown', key: 'Enter' } as KeyboardEvent);
    expect(store.getState().toolHint).toMatch(/^도로 시작점을 클릭하세요/);
    expect(sent).toHaveLength(2);
  });

  it('a drag draws one piece (press = start, release = end)', () => {
    const { sent, drag, segs } = setup();
    drag([{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 64, z: 0 }]);
    expect(sent).toHaveLength(1);
    expect(segs()).toHaveLength(1);
  });
});

describe('RoadTool curve mode (b2)', () => {
  const seed: Command[] = [
    { type: 'node.add', node: { id: 'A', pos: { x: -96, z: 0 } } },
    { type: 'node.add', node: { id: 'B', pos: { x: 0, z: 0 } } },
    { type: 'segment.add', segment: { id: 'ab', a: 'A', b: 'B', roadTypeId: 'road-2' } },
  ];

  it('from a dead end the curve leaves along the road with the control half a chord out', () => {
    const { store, sent, click, segs } = setup(seed);
    store.setToolOptions({ roadMode: 'curve' });
    click({ x: 0, z: 0 });
    click({ x: 64, z: 48 });
    expect(sent).toHaveLength(1);
    const curve = segs().find((s) => s.control)!;
    expect(curve.control).toEqual({ x: 40, z: 0 });
    // The next piece continues the curve's end tangent (40,0) → (64,48).
    click({ x: 96, z: 160 });
    const next = segs().find((s) => s.control && s.id !== curve.id)!;
    const c = next.control!;
    const dir = { x: 64 - 40, z: 48 - 0 };
    expect(Math.abs((c.x - 64) * dir.z - (c.z - 48) * dir.x)).toBeLessThan(1e-9);
  });

  it('pressing on the end point and dragging moves the handle along the tangent', () => {
    const { store, sent, click, drag, segs } = setup(seed);
    store.setToolOptions({ roadMode: 'curve' });
    click({ x: 0, z: 0 });
    drag([{ x: 64, z: 48 }, { x: 50, z: 30 }, { x: 24, z: 30 }]);
    expect(sent).toHaveLength(1);
    expect(segs().find((s) => s.control)!.control).toEqual({ x: 24, z: 0 });
  });

  it('from empty space: start, control, end (3 clicks); or press on the start and drag to aim', () => {
    const { store, click, segs } = setup();
    store.setToolOptions({ roadMode: 'curve' });
    click({ x: 0, z: 0 });
    click({ x: 48, z: 0 });
    click({ x: 64, z: 64 });
    expect(segs().find((s) => s.control)!.control).toEqual({ x: 48, z: 0 });
    const { store: s2, drag: drag2, click: click2, segs: segs2 } = setup();
    s2.setToolOptions({ roadMode: 'curve' });
    drag2([{ x: 0, z: 200 }, { x: 10, z: 200 }, { x: 20, z: 200 }]);
    click2({ x: 64, z: 248 });
    const c = segs2().find((s) => s.control)!.control!;
    expect(c.z).toBeCloseTo(200, 9);
    expect(c.x).toBeGreaterThan(0);
  });

  it('refuses a curve tighter than the radius floor, with the reason', () => {
    const { store, tool, sent, click, at } = setup(seed);
    store.setToolOptions({ roadMode: 'curve' });
    click({ x: 0, z: 0 });
    tool.onPointerMove(at({ x: -8, z: 24 }));
    expect(tool.preview().label).toMatchObject({ error: true });
    expect(tool.preview().label!.text).toMatch(/곡선이 너무 급합니다/);
    click({ x: -8, z: 24 });
    expect(sent).toHaveLength(0);
  });
});

/** S curve from (0,0) to (192,0), sampled every 2 m. */
const sPath = (): Vec2[] => Array.from({ length: 97 }, (_, i) => ({ x: i * 2, z: 48 * Math.sin((i / 96) * 2 * Math.PI) }));

describe('RoadTool free mode (b3)', () => {
  it('a dragged S becomes one batch of connected tangent-continuous curve pieces', () => {
    const { store, sent, drag, segs } = setup();
    store.setToolOptions({ roadMode: 'free' });
    drag(sPath());
    expect(sent).toHaveLength(1);
    const s = segs();
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s.filter((x) => x.control).length).toBeGreaterThanOrEqual(2);
    // One chain: every inner node joins exactly two pieces.
    const deg = new Map<string, number>();
    for (const x of s) for (const n of [x.a, x.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
    expect([...deg.values()].filter((d) => d === 1)).toHaveLength(2);
    expect([...deg.values()].every((d) => d <= 2)).toBe(true);
  });

  it('crossing an existing road makes a junction where the stroke crossed it', () => {
    const { store, sent, drag, segs } = setup([
      { type: 'node.add', node: { id: 'N', pos: { x: 96, z: -100 } } },
      { type: 'node.add', node: { id: 'S', pos: { x: 96, z: 100 } } },
      { type: 'segment.add', segment: { id: 'ns', a: 'N', b: 'S', roadTypeId: 'road-2' } },
    ]);
    store.setToolOptions({ roadMode: 'free' });
    drag(sPath());
    expect(sent).toHaveLength(1);
    const doc = store.getState().doc;
    const junction = Object.values(doc.nodes).find((n) => Math.abs(n.pos.x - 96) < 1e-9 && Math.abs(n.pos.z) < 1);
    expect(junction).toBeDefined();
    expect(segs().filter((x) => x.a === junction!.id || x.b === junction!.id)).toHaveLength(4);
  });

  it('a stroke too sharp for the road is refused with the reason (nothing sent)', () => {
    const { store, tool, sent, at, segs } = setup();
    store.setToolOptions({ roadMode: 'free' });
    const zig = [
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: 40, z: 0 },
      { x: 20, z: 4 },
      { x: 0, z: 8 },
      { x: 20, z: 12 },
      { x: 40, z: 16 },
    ];
    tool.onPointerMove(at(zig[0]!));
    tool.onPointerDown(at(zig[0]!));
    for (const p of zig.slice(1)) tool.onPointerMove(at(p));
    expect(tool.preview().label).toMatchObject({ error: true });
    expect(tool.preview().label!.text).toMatch(/곡선이 너무 급합니다|자기 자신과 교차/);
    tool.onPointerUp(at(zig[zig.length - 1]!));
    expect(sent).toHaveLength(0);
    expect(segs()).toHaveLength(0);
  });
});

describe('Sol P5b review regressions (tool)', () => {
  it('#1 a click sends where the button was released (the latest preview), not where it was pressed', () => {
    const { tool, sent, click, at } = setup();
    click({ x: 0, z: 0 });
    // Shift: no snapping. Press at (50,10), move 4 px (below the drag slop), release at (52,10).
    tool.onPointerMove(at({ x: 50, z: 10 }, { shift: true }));
    tool.onPointerDown(at({ x: 50, z: 10 }, { shift: true }));
    tool.onPointerMove(at({ x: 52, z: 10 }, { shift: true }));
    const preview = tool.preview().lines[0]!.pts;
    tool.onPointerUp(at({ x: 52, z: 10 }, { shift: true }));
    expect(preview[preview.length - 1]).toEqual({ x: 52, z: 10 });
    const end = batch(sent[0]).find((c) => c.type === 'node.add' && c.node.pos.x !== 0);
    expect(end?.type === 'node.add' && end.node.pos).toEqual({ x: 52, z: 10 });
  });

  it('#2 free drawing previews and checks the planned roads (crossing moved to the road end node), and sends exactly those', () => {
    const { store, tool, sent, at, segs } = setup([
      { type: 'node.add', node: { id: 'N', pos: { x: 50, z: -5 } } },
      { type: 'node.add', node: { id: 'S', pos: { x: 50, z: 100 } } },
      { type: 'segment.add', segment: { id: 'ns', a: 'N', b: 'S', roadTypeId: 'road-2' } },
    ]);
    store.setToolOptions({ roadMode: 'free' });
    const path = Array.from({ length: 51 }, (_, i) => ({ x: i * 2, z: 0 }));
    tool.onPointerMove(at(path[0]!));
    tool.onPointerDown(at(path[0]!));
    for (const p of path.slice(1)) tool.onPointerMove(at(p));
    const shown = tool.preview().lines.filter((l) => l.width > 1).map((l) => [l.pts[0], l.pts[l.pts.length - 1]]);
    tool.onPointerUp(at(path[path.length - 1]!));
    expect(sent).toHaveLength(1);
    const doc = store.getState().doc;
    const built = segs()
      .filter((s) => s.id !== 'ns')
      .filter((s) => doc.nodes[s.a]!.pos.z <= 0 && doc.nodes[s.b]!.pos.z <= 0)
      .map((s) => [doc.nodes[s.a]!.pos, doc.nodes[s.b]!.pos]);
    expect(shown).toContainEqual([{ x: 0, z: 0 }, { x: 50, z: -5 }]);
    expect(built).toContainEqual([{ x: 0, z: 0 }, { x: 50, z: -5 }]);
    expect(shown.length).toBe(built.length);
  });

  it('#3 a free stroke that runs out and comes straight back is refused', () => {
    const { store, sent, drag } = setup();
    store.setToolOptions({ roadMode: 'free' });
    drag([...Array.from({ length: 51 }, (_, i) => ({ x: i * 2, z: 0 })), ...Array.from({ length: 40 }, (_, i) => ({ x: 98 - i * 2, z: 0 }))]);
    expect(sent).toHaveLength(0);
  });

  it('#4 mode keys stay off the camera keys and a held key toggles once', () => {
    const { store, tool } = setup();
    const key = (k: string, repeat = false) => tool.onKey({ type: 'keydown', key: k, repeat } as KeyboardEvent);
    for (const k of ['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'W', 'D', 'F']) {
      expect(key(k), k).toBe(false);
      expect(store.getState().toolOptions.roadMode).toBe('straight');
    }
    expect(key('b')).toBe(true);
    expect(store.getState().toolOptions.roadMode).toBe('free');
    expect(key('b', true)).toBe(true);
    expect(store.getState().toolOptions.roadMode).toBe('free');
    expect(key('c')).toBe(true);
    expect(store.getState().toolOptions.roadMode).toBe('curve');
    const fillet = store.getState().toolOptions.autoFillet;
    expect(key('t')).toBe(true);
    expect(key('t', true)).toBe(true);
    expect(store.getState().toolOptions.autoFillet).toBe(!fillet);
  });

  it('#7 free-draw replans stay fast in a big city (1000 and 5000 roads, 49-point stroke)', () => {
    const timings: string[] = [];
    for (const n of [1000, 5000]) {
      const { store, tool, at } = setup();
      // Build the grid directly (a fixture: not the code under test).
      const doc = store.getState().doc;
      const side = Math.ceil(Math.sqrt(n / 2)) + 1;
      const step = Math.floor(3800 / side);
      const off = (side * step) / 2;
      for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) doc.nodes[`g${i}_${j}`] = { id: `g${i}_${j}`, pos: { x: i * step - off, z: j * step - off } };
      let count = 0;
      for (let i = 0; i < side && count < n; i++)
        for (let j = 0; j < side && count < n; j++) {
          if (i + 1 < side) doc.segments[`gh${i}_${j}`] = { id: `gh${i}_${j}`, a: `g${i}_${j}`, b: `g${i + 1}_${j}`, roadTypeId: 'road-2' };
          if (j + 1 < side) doc.segments[`gv${i}_${j}`] = { id: `gv${i}_${j}`, a: `g${i}_${j}`, b: `g${i}_${j + 1}`, roadTypeId: 'road-2' };
          count += 2;
        }
      store.setToolOptions({ roadMode: 'free' });
      const pts = Array.from({ length: 49 }, (_, i) => ({ x: -100 + i * 4, z: 79 + 28 * Math.sin((i / 48) * 2 * Math.PI) }));
      tool.onPointerMove(at(pts[0]!));
      tool.onPointerDown(at(pts[0]!));
      const times: number[] = [];
      for (const p of pts.slice(1)) {
        const s0 = realNow();
        tool.onPointerMove(at(p));
        times.push(realNow() - s0);
      }
      // The measured replans really planned the stroke (crossing grid roads).
      expect(tool.preview().label?.text).toMatch(/^자유 곡선 .* \d+조각/);
      times.sort((a, b) => a - b);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const label = tool.preview().label?.text;
      const r0 = realNow();
      tool.onPointerUp(at(pts[pts.length - 1]!));
      const release = realNow() - r0;
      timings.push(`${n} → ${Object.keys(doc.segments).length} roads (${label}): replan avg ${avg.toFixed(2)} ms, p90 ${times[Math.floor(times.length * 0.9)]!.toFixed(2)} ms, max ${times[times.length - 1]!.toFixed(2)} ms; release+whole-doc check ${release.toFixed(1)} ms`);
      expect(avg).toBeLessThan(50);
    }
    process.stderr.write(`[P5b perf] ${timings.join(" | ")}\n`);
  });
});

/** Wall clock that the per-test performance.now spy does not replace. */
const realNow = (): number => Number(process.hrtime.bigint()) / 1e6;

describe('Sol P5b recheck regressions (tool)', () => {
  it('#3 free stroke crossing road A is resolved on A even with road B’s end node nearby', () => {
    const { store, tool, sent, at, segs } = setup([
      { type: 'node.add', node: { id: 'A1', pos: { x: 50, z: -5 } } },
      { type: 'node.add', node: { id: 'A2', pos: { x: 50, z: 100 } } },
      { type: 'segment.add', segment: { id: 'A', a: 'A1', b: 'A2', roadTypeId: 'road-2' } },
      { type: 'node.add', node: { id: 'B1', pos: { x: 53, z: 1 } } },
      { type: 'node.add', node: { id: 'B2', pos: { x: 90, z: 60 } } },
      { type: 'segment.add', segment: { id: 'B', a: 'B1', b: 'B2', roadTypeId: 'road-2' } },
    ]);
    store.setToolOptions({ roadMode: 'free' });
    const path = Array.from({ length: 51 }, (_, i) => ({ x: i * 2, z: 0 }));
    tool.onPointerMove(at(path[0]!));
    tool.onPointerDown(at(path[0]!));
    for (const p of path.slice(1)) tool.onPointerMove(at(p));
    expect(tool.preview().label?.error).toBeFalsy();
    tool.onPointerUp(at(path[path.length - 1]!));
    expect(sent).toHaveLength(1);
    const atA1 = segs().filter((s) => s.a === 'A1' || s.b === 'A1');
    expect(atA1.length).toBe(3);
    expect(segs().filter((s) => s.a === 'B1' || s.b === 'B1')).toHaveLength(1);
  });
});

describe('Sol P5b recheck 2 (tool)', () => {
  it('#2 a half-circle stroke leaving road A and coming back onto A is built (one batch)', () => {
    const { store, tool, sent, at, segs } = setup([
      { type: 'node.add', node: { id: 'A1', pos: { x: 0, z: -100 } } },
      { type: 'node.add', node: { id: 'A2', pos: { x: 0, z: 200 } } },
      { type: 'segment.add', segment: { id: 'A', a: 'A1', b: 'A2', roadTypeId: 'road-2' } },
    ]);
    store.setToolOptions({ roadMode: 'free' });
    const pts = Array.from({ length: 49 }, (_, i) => {
      const th = -Math.PI / 2 + (i / 48) * Math.PI;
      return { x: 50 * Math.cos(th) + 0, z: 50 + 50 * Math.sin(th) };
    });
    tool.onPointerMove(at(pts[0]!));
    tool.onPointerDown(at(pts[0]!));
    for (const p of pts.slice(1)) tool.onPointerMove(at(p));
    expect(tool.preview().label?.error).toBeFalsy();
    tool.onPointerUp(at(pts[pts.length - 1]!));
    expect(sent).toHaveLength(1);
    // A is now in three pieces with two new junctions on it, joined by the curve.
    expect(segs().filter((s) => !s.control && Math.abs(store.getState().doc.nodes[s.a]!.pos.x) < 1e-9 && Math.abs(store.getState().doc.nodes[s.b]!.pos.x) < 1e-9)).toHaveLength(3);
  });
});

describe('contact budget refusal (Sol P5b recheck 4)', () => {
  it('is shown with a Korean reason', () => {
    expect(translateError('the new road could not be checked against nearby roads (contact check limit)')).toBe('주변 도로와의 간격을 끝까지 확인하지 못했습니다 (검사 한도). 조금 떨어뜨려 다시 그리세요');
  });
});
