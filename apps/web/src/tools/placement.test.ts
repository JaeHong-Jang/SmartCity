import { describe, expect, it, vi } from 'vitest';
import {
  applyCommand,
  cloneJson,
  createEmptyDoc,
  cumulativeLengths,
  dist,
  dot,
  IdGen,
  planRoad,
  pointAtLength,
  resolvePoint,
  rotateY,
  roadHalfWidth,
  sampleSegmentCurve,
  sub,
  tangentAtLength,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';
import { ClientStore } from '../app/store';
import { GhostBuilding } from '../render/ghostBuilding';
import { road } from '../test/fixtures';
import { BuildingTool, placementValid } from './buildingTool';
import {
  alignOnCurve,
  buildingWidth,
  facingAngle,
  magnetDelta,
  PlacementSolver,
  PoseSpring,
  RoadSelector,
  RotateGesture,
  ROT_STEP,
  SPRING_MAX_DT,
  snapRotation,
  SWITCH_MARGIN,
  wrapAngle,
} from './placement';
import { PickIndex } from './picking';
import type { ToolContext, ToolPointer } from './types';

function curvedDoc(control: Vec2 = { x: 0, z: 90 }, a: Vec2 = { x: -90, z: 0 }, b: Vec2 = { x: 90, z: 0 }): CityDoc {
  const doc = createEmptyDoc();
  const plan = planRoad(doc, { start: resolvePoint(doc, a), end: resolvePoint(doc, b), control, roadTypeId: 'road-2' }, new IdGen('t'));
  if (!plan.command) throw new Error(plan.error);
  expect(applyCommand(doc, plan.command).ok).toBe(true);
  return doc;
}

describe('PoseSpring', () => {
  it('converges exactly onto the target and then reports settled', () => {
    const sp = new PoseSpring();
    sp.snapTo(0, 0, 0);
    let frames = 0;
    while (sp.step(1 / 60, 10, -4, 1)) frames++;
    expect(frames).toBeGreaterThan(5);
    expect(frames).toBeLessThan(120);
    expect([sp.x, sp.z, sp.r]).toEqual([10, -4, 1]);
    expect(sp.step(1 / 60, 10, -4, 1)).toBe(false);
  });

  it('never overshoots (critically damped) from rest', () => {
    const sp = new PoseSpring();
    sp.snapTo(0, 0, 0);
    let prev = 0;
    while (sp.step(1 / 60, 20, 0, 0)) {
      expect(sp.x).toBeGreaterThanOrEqual(prev);
      expect(sp.x).toBeLessThanOrEqual(20);
      prev = sp.x;
    }
  });

  it('turns the short way around ±180°', () => {
    const sp = new PoseSpring();
    sp.snapTo(0, 0, 3.0);
    sp.step(1 / 60, 0, 0, -3.0);
    // 3.0 → -3.0 is 0.283 rad through π, not 6 rad back through 0.
    expect(Math.abs(wrapAngle(sp.r - 3.0))).toBeLessThan(0.3);
    expect(Math.abs(sp.r)).toBeGreaterThan(2.9);
    for (let i = 0; i < 200; i++) sp.step(1 / 60, 0, 0, -3.0);
    expect(sp.r).toBeCloseTo(-3.0, 9);
  });

  it('is frame-rate stable: huge dt is clamped, 30 fps and 144 fps land on the same pose', () => {
    const a = new PoseSpring();
    const b = new PoseSpring();
    a.snapTo(0, 0, 0);
    b.snapTo(0, 0, 0);
    a.step(10, 100, 0, 0);
    b.step(SPRING_MAX_DT, 100, 0, 0);
    expect(a.x).toBe(b.x);
    expect(a.x).toBeLessThan(100);
    const slow = new PoseSpring();
    const fast = new PoseSpring();
    slow.snapTo(0, 0, 0);
    fast.snapTo(0, 0, 0);
    for (let i = 0; i < 15; i++) slow.step(1 / 30, 50, 0, 0);
    for (let i = 0; i < 72; i++) fast.step(1 / 144, 50, 0, 0);
    expect(Math.abs(slow.x - fast.x)).toBeLessThan(0.01);
  });

  it('adopts the first pose without animating, and reset starts over', () => {
    const sp = new PoseSpring();
    expect(sp.step(1 / 60, 5, 5, 1)).toBe(false);
    expect([sp.x, sp.z]).toEqual([5, 5]);
    sp.reset();
    expect(sp.active).toBe(false);
    sp.step(1 / 60, 90, 0, 0);
    expect(sp.x).toBe(90);
  });
});

describe('RoadSelector', () => {
  const doc = createEmptyDoc();
  road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('a'));
  road(doc, { x: -96, z: 30 }, { x: 96, z: 30 }, new IdGen('b'));
  const idx = new PickIndex(doc);

  it('does not flip between two roads when the cursor jitters around the midline', () => {
    const sel = new RoadSelector();
    const ids: (string | undefined)[] = [];
    for (const z of [8, 12, 14, 16, 15, 14.5, 15.5, 14, 16, 15, 14, 16]) ids.push(sel.pick(doc, idx, { x: 0, z })?.id);
    expect(new Set(ids).size).toBe(1);
    let changes = 0;
    for (const z of [10, 14, 15, 16, 17, 18, 19, 20, 22, 20, 17, 16, 15, 14, 13]) {
      const before = sel.id;
      sel.pick(doc, idx, { x: 0, z });
      if (sel.id !== before) changes++;
    }
    expect(changes).toBeLessThanOrEqual(2); // down to the far road once, back once
    expect(SWITCH_MARGIN).toBeGreaterThan(0);
  });

  it('switches only once the other road is clearly closer', () => {
    const sel = new RoadSelector();
    const first = sel.pick(doc, idx, { x: 0, z: 10 })!.id;
    expect(sel.pick(doc, idx, { x: 0, z: 16 })!.id).toBe(first);
    expect(sel.pick(doc, idx, { x: 0, z: 24 })!.id).not.toBe(first);
  });

  it('lock keeps the road even when another is closer or the cursor is far; removal invalidates', () => {
    const sel = new RoadSelector();
    const first = sel.pick(doc, idx, { x: 0, z: 5 })!.id;
    expect(sel.toggleLock()).toBe(true);
    expect(sel.pick(doc, idx, { x: 0, z: 28 })!.id).toBe(first);
    expect(sel.pick(doc, idx, { x: 0, z: 400 })!.id).toBe(first);
    expect(sel.toggleLock()).toBe(false);
    sel.toggleLock();
    const gone = cloneJson(doc);
    delete gone.segments[first];
    const hit = sel.pick(gone, new PickIndex(gone), { x: 0, z: 5 });
    expect(hit === null || hit.id !== first).toBe(true);
    expect(sel.locked).toBe(false);
    expect(sel.id).not.toBe(first);
  });
});

describe('arc-length secant alignment on curved roads', () => {
  const doc = curvedDoc();
  const idx = new PickIndex(doc);
  const type = doc.buildingTypes.house!;
  const seg = Object.values(doc.segments)[0]!;
  const curve = sampleSegmentCurve(doc.nodes[seg.a]!.pos, doc.nodes[seg.b]!.pos, seg.control);
  const cum = cumulativeLengths(curve);

  it('rotates to the chord over the building width measured in arc length', () => {
    // Off-apex cursor on the convex (outer, +z... away from the control) side.
    const cursor: Vec2 = { x: -50, z: -12 };
    const hit = idx.nearestSegment(cursor, 40)!;
    expect(hit).not.toBeNull();
    const p = alignOnCurve(doc, type, hit, cursor, 0);
    const w = buildingWidth(type);
    const pa = pointAtLength(curve, cum, hit.s - w / 2);
    const pb = pointAtLength(curve, cum, hit.s + w / 2);
    const chord = sub(pb, pa);
    // Front (+z local) points to the road, perpendicular to the chord.
    const front = rotateY({ x: 0, z: 1 }, p.rotation);
    expect(Math.abs(dot(front, chord)) / Math.hypot(chord.x, chord.z)).toBeLessThan(1e-9);
    const t = tangentAtLength(curve, cum, hit.s);
    const dTan = Math.abs(dot(front, t));
    expect(dTan).toBeLessThan(0.2); // close to, but computed from the secant
    expect(placementValid(doc, type, p)).toBe(true);
  });

  it('keeps the margin from the road on the inside of a tight curve (no overlap)', () => {
    const tight = curvedDoc({ x: 0, z: 40 }, { x: -40, z: 0 }, { x: 40, z: 0 });
    const tidx = new PickIndex(tight);
    const cursor: Vec2 = { x: 0, z: 25 }; // inside the bend
    const hit = tidx.nearestSegment(cursor, 40)!;
    const p = alignOnCurve(tight, tight.buildingTypes.house!, hit, cursor, 0);
    expect(p.segmentId).toBe(hit.id);
    expect(placementValid(tight, tight.buildingTypes.house!, p)).toBe(true);
    const rt = tight.roadTypes['road-2']!;
    expect(roadHalfWidth(rt)).toBeGreaterThan(0);
  });

  it('keeps one side near the centerline (side hysteresis) and reports the chosen side', () => {
    const flat = createEmptyDoc();
    road(flat, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('s'));
    const fidx = new PickIndex(flat);
    const solver = new PlacementSolver();
    const house = flat.buildingTypes.house!;
    const o = { rotation: 0, step: 0 as const, free: false };
    const up = solver.solve(flat, fidx, house, { x: 0, z: 10 }, o);
    const wobble = solver.solve(flat, fidx, house, { x: 0, z: -0.5 }, o);
    expect(wobble.side).toBe(up.side);
    const across = solver.solve(flat, fidx, house, { x: 0, z: -15 }, o);
    expect(across.side).toBe(-(up.side!));
  });
});

describe('magnetDelta', () => {
  it('pulls flush against a neighbour inside the reach, stays free outside', () => {
    expect(magnetDelta(5, [{ min: -20, max: -4.2 }])).toBeCloseTo(0.8); // abut: -4.2 + 5
    expect(magnetDelta(5, [{ min: -20, max: -10 }])).toBeNull();
    expect(magnetDelta(5, [])).toBeNull();
    // nearest candidate wins
    expect(magnetDelta(5, [{ min: 8, max: 20 }, { min: -20, max: -4.5 }])).toBeCloseTo(0.5);
  });

  it('snaps a placement next to an existing building on the same road', () => {
    const doc = createEmptyDoc();
    road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('m'));
    const idx = new PickIndex(doc);
    const house = doc.buildingTypes.house!;
    const w = buildingWidth(house);
    const solver = new PlacementSolver();
    const first = solver.solve(doc, idx, house, { x: 0, z: 14 }, { rotation: 0, step: 0, free: false });
    doc.buildings.n1 = { id: 'n1', typeId: 'house', pos: first.pos, rotation: first.rotation };
    const idx2 = new PickIndex(doc);
    const near = solver.solve(doc, idx2, house, { x: w + 1.0, z: 14 }, { rotation: 0, step: 0, free: false });
    expect(near.pos.x).toBeCloseTo(first.pos.x + w, 6);
    const far = solver.solve(doc, idx2, house, { x: w + 6.2, z: 14 }, { rotation: 0, step: 0, free: false });
    expect(far.pos.x).toBeCloseTo(w + 6.2, 6);
  });
});

describe('rotation', () => {
  it('accumulates cursor travel around the anchor, ignoring the dead zone', () => {
    const g = new RotateGesture({ x: 0, z: 0 }, 0.5, { x: 10, z: 0 });
    expect(g.move({ x: 0.5, z: 0.5 })).toBeCloseTo(0.5); // inside the dead zone: unchanged
    const quarter = g.move({ x: 0, z: 10 });
    expect(Math.abs(Math.abs(quarter - 0.5) - Math.PI / 2)).toBeLessThan(1e-9);
    // continuous across the ±π seam
    const g2 = new RotateGesture({ x: 0, z: 0 }, 0, { x: 0, z: 10 });
    const a = g2.move({ x: -10, z: 0 });
    const b = g2.move({ x: 0, z: -10 });
    expect(Math.abs(b)).toBeCloseTo(Math.PI, 9);
    expect(Math.abs(a)).toBeCloseTo(Math.PI / 2, 9);
    expect(facingAngle({ x: 0, z: 1 })).toBe(0);
  });

  it('snaps to 15° steps unless disabled', () => {
    expect(snapRotation(0.27, true)).toBeCloseTo(ROT_STEP);
    expect(snapRotation(0.27, false)).toBeCloseTo(0.27);
  });
});

describe('BuildingTool target pose', () => {
  function setup() {
    const store = new ClientStore('main', '나');
    const doc = createEmptyDoc();
    road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('t'));
    store.receive({ t: 'welcome', clientId: 'me', tag: 'T', color: '#ff0000', room: 'main', seq: 0, doc, peers: [] });
    const dispatch = vi.fn(() => 1);
    const ctx: ToolContext = { store, dispatch, ids: () => new IdGen('T'), changed: () => {}, pan: { start: () => true, move: () => {}, end: () => {} }, focus: () => {} };
    const tool = new BuildingTool(ctx, () => new PickIndex(store.getState().doc));
    const at = (x: number, z: number): ToolPointer => ({ pos: { x, z }, client: { x, y: z }, button: 0, shift: false, ctrl: false, alt: false });
    const key = (type: 'keydown' | 'keyup', code: string, extra: Partial<KeyboardEvent> = {}) => ({ type, code, key: code.replace('Key', '').toLowerCase(), repeat: false, ...extra }) as KeyboardEvent;
    return { store, tool, dispatch, at, key };
  }

  it('a click right after a fast move commands exactly the target pose', () => {
    const { tool, dispatch, at } = setup();
    for (const x of [-60, -20, 40, 70]) tool.onPointerMove(at(x, 15));
    const shown = tool.preview().building!;
    tool.onPointerDown(at(80, 17));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const cmd = (dispatch.mock.calls[0] as unknown as [{ type: string; building: { pos: Vec2; rotation: number } }])[0];
    const target = tool.preview().building!;
    expect(cmd.type).toBe('building.place');
    expect(cmd.building.pos).toEqual(target.pos);
    expect(cmd.building.rotation).toBe(target.rotation);
    expect(cmd.building.pos.x).not.toBeCloseTo(shown.pos.x, 3);
    expect(target.settle).toBe(1); // the ghost is told to jump
  });

  it('hold T and move rotates continuously; Escape and blur reset', () => {
    const { store, tool, dispatch, at, key } = setup();
    tool.onPointerMove(at(0, 60)); // far from the road: free placement at the snapped point
    const anchor = tool.preview().building!.pos;
    tool.onKey(key('keydown', 'KeyT'));
    tool.onKey(key('keydown', 'KeyT', { repeat: true })); // key repeat is ignored
    tool.onPointerMove(at(anchor.x + 20, anchor.z));
    const turned = tool.preview().building!;
    expect(turned.pos).toEqual(anchor); // the building stays put
    expect(Math.abs(wrapAngle(turned.rotation))).toBeCloseTo(Math.PI / 2, 6);
    tool.onKey(key('keyup', 'KeyT'));
    expect(Math.abs(store.getState().toolOptions.buildingRotation)).toBeCloseTo(Math.PI / 2, 6);
    expect(dispatch).not.toHaveBeenCalled();

    // Escape mid-turn restores: the stored angle is not touched.
    const before = store.getState().toolOptions.buildingRotation;
    tool.onPointerMove(at(0, 60));
    tool.onKey(key('keydown', 'KeyT'));
    tool.onPointerMove(at(20, 60));
    tool.onKey(key('keydown', 'Escape', { key: 'Escape' }));
    tool.onKey(key('keyup', 'KeyT'));
    expect(store.getState().toolOptions.buildingRotation).toBe(before);
    // Blur mid-turn: no stray state either.
    tool.onPointerMove(at(0, 60));
    tool.onKey(key('keydown', 'KeyT'));
    tool.onBlur();
    tool.onKey(key('keyup', 'KeyT'));
    expect(store.getState().toolOptions.buildingRotation).toBe(before);
  });

  it('a quick tap of T adds one 15° step', () => {
    const { store, tool, at, key } = setup();
    tool.onPointerMove(at(0, 60));
    const start = store.getState().toolOptions.buildingRotation;
    tool.onKey(key('keydown', 'KeyT'));
    tool.onKey(key('keyup', 'KeyT'));
    expect(wrapAngle(store.getState().toolOptions.buildingRotation - start)).toBeCloseTo(ROT_STEP, 9);
  });

  it('L locks the road and keeps aligning to it away from other roads', () => {
    const { tool, at, key } = setup();
    tool.onPointerMove(at(0, 10));
    tool.onKey(key('keydown', 'KeyL'));
    tool.onPointerMove(at(0, 300));
    expect(tool.preview().building!.pos.z).toBeGreaterThan(0);
    expect(dist(tool.preview().building!.pos, { x: 0, z: 300 })).toBeGreaterThan(200); // aligned to the road, not at the cursor
    tool.onKey(key('keydown', 'KeyL'));
    tool.onPointerMove(at(0, 300));
    expect(Math.abs(tool.preview().building!.pos.z - 300)).toBeLessThanOrEqual(4); // free again: snapped to the 8 m grid
  });

  it('a click publishes the settle to the renderer: the shown ghost equals the command at once', () => {
    const { store, dispatch, at } = setup();
    const ghost = new GhostBuilding();
    let tool!: BuildingTool;
    const ctx: ToolContext = { store, dispatch, ids: () => new IdGen('T'), changed: () => ghost.set(store.getState().doc.buildingTypes.house, tool.preview().building), pan: { start: () => true, move: () => {}, end: () => {} }, focus: () => {} };
    tool = new BuildingTool(ctx, () => new PickIndex(store.getState().doc));
    tool.onPointerMove(at(-60, 60));
    tool.onPointerMove(at(-20, 60));
    expect(ghost.group.position.x).toBeLessThan(-40); // easing lags behind the target
    tool.onPointerDown(at(80, 60));
    const cmd = (dispatch.mock.calls[0] as unknown as [{ building: { pos: Vec2 } }])[0];
    expect(cmd.building.pos.x).toBeGreaterThan(70);
    expect(ghost.group.position.x).toBe(cmd.building.pos.x);
    expect(ghost.group.position.z).toBe(cmd.building.pos.z);
  });

  it('releasing T keeps the placement where it was; only a later pointer move re-places it', () => {
    const { tool, dispatch, at, key } = setup();
    tool.onPointerMove(at(0, 10)); // aligned to the road
    const aligned = tool.preview().building!.pos;
    tool.onKey(key('keydown', 'KeyT'));
    tool.onKey(key('keyup', 'KeyT'));
    expect(tool.preview().building!.pos).toEqual(aligned);
    expect(dispatch).not.toHaveBeenCalled();
    tool.onPointerMove(at(0, 16)); // the next move re-places it, now freely
    expect(tool.preview().building!.pos).toEqual({ x: 0, z: 16 });
  });

  it('T key-up while a text field has focus still ends the turn (controller)', async () => {
    const { ToolController } = await import('./controller');
    const win = new EventTarget();
    const doc = { activeElement: null as unknown };
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = [g.window, g.document];
    g.window = win;
    g.document = doc;
    try {
      const { store, at } = setup();
      const dom = new EventTarget() as unknown as HTMLElement;
      const ctl = new ToolController(store, { dispatch: () => 1, ids: () => new IdGen('T') } as never, dom, () => ({ x: 0, z: 60 }), () => {}, () => {}, { pan: { start: () => true, move: () => {}, end: () => {} }, focus: () => {}, cursor: () => {} });
      store.set({ tool: 'building' });
      void at;
      const ev = (type: string, code: string) => Object.assign(new Event(type), { code, key: 't', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
      const move = Object.assign(new Event('pointermove'), { clientX: 1, clientY: 1, button: 0, shiftKey: false, ctrlKey: false, altKey: false });
      dom.dispatchEvent(move);
      win.dispatchEvent(ev('keydown', 'KeyT'));
      doc.activeElement = { tagName: 'INPUT' };
      win.dispatchEvent(new Event('focusin')); // focus moves into an input: gesture cancelled
      win.dispatchEvent(ev('keyup', 'KeyT'));
      doc.activeElement = null;
      const before = store.getState().toolOptions.buildingRotation;
      dom.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 9, clientY: 9, button: 0, shiftKey: false, ctrlKey: false, altKey: false }));
      expect(store.getState().toolOptions.buildingRotation).toBe(before);
      ctl.dispose();
    } finally {
      [g.window, g.document] = saved;
    }
  });
});
