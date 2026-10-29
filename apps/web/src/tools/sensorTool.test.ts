import { describe, expect, it, vi } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, IdGen, MAX_GHOST_POINTS, roadHalfWidth, sensorPose, type CityDoc, type Command, type Sensor, type Vec2 } from '@smartcity/shared';
import { compileNetwork, compileSensorCoverage, type RoadGraph } from '@smartcity/sim';
import { ClientStore } from '../app/store';
import { crossDoc, road } from '../test/fixtures';
import { PickIndex } from './picking';
import { JUNCTION_AIM, ROAD_CHANGED, sectorOutline, SensorTool, sensorSpot, wrapPi, type FrameScheduler } from './sensorTool';
import type { ToolContext, ToolPointer } from './types';

const dir = (yaw: number): Vec2 => ({ x: Math.cos(yaw), z: Math.sin(yaw) });
const dotv = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;

/** Travel direction of the lane nearest to `p` (graph lane tangent at the closest vertex pair). */
function laneDirNear(graph: RoadGraph, p: Vec2): Vec2 {
  let best = { d: Infinity, v: { x: 1, z: 0 } };
  for (const l of graph.lanes) {
    for (let i = 0; i + 1 < l.points.length; i++) {
      const a = l.points[i]!;
      const b = l.points[i + 1]!;
      const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < best.d && len > 0) best = { d, v: { x: (b.x - a.x) / len, z: (b.z - a.z) / len } };
    }
  }
  return best.v;
}

function straight(roadTypeId = 'road-2'): CityDoc {
  const doc = createEmptyDoc();
  road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('t'), roadTypeId);
  return doc;
}

function poseOf(doc: CityDoc, idx: PickIndex, p: Vec2) {
  const spot = sensorSpot(doc, idx, p)!;
  const s: Sensor = { id: 'x', kind: 'cctv', segmentId: spot.segmentId, t: spot.t, side: spot.side, heading: spot.heading, fov: 1, range: 50 };
  return { spot, pose: sensorPose(doc, s)! };
}

describe('sensorSpot: snap to the sidewalk, default heading', () => {
  it('stands on the cursor side, mid-sidewalk, looking along the traffic next to it (two-way road)', () => {
    const doc = straight();
    const idx = new PickIndex(doc);
    const graph = compileNetwork(doc);
    const rt = doc.roadTypes['road-2']!;
    for (const z of [5, -5]) {
      const { spot, pose } = poseOf(doc, idx, { x: 20, z });
      expect(Math.sign(pose.pos.z)).toBe(Math.sign(z));
      expect(Math.abs(pose.pos.z)).toBeCloseTo(roadHalfWidth(rt) - 1.25, 6);
      expect(spot.t).toBeGreaterThan(0);
      expect(spot.t).toBeLessThan(1);
      // Looks the way the nearest lane runs.
      expect(dotv(dir(pose.yaw), laneDirNear(graph, pose.pos))).toBeGreaterThan(0.99);
    }
    expect(poseOf(doc, idx, { x: 20, z: 5 }).spot.side).not.toBe(poseOf(doc, idx, { x: 20, z: -5 }).spot.side);
  });

  it('one-way roads look along a → b on both sides', () => {
    const doc = straight('oneway-2');
    const idx = new PickIndex(doc);
    const seg = Object.values(doc.segments)[0]!;
    const ab = Math.sign(doc.nodes[seg.b]!.pos.x - doc.nodes[seg.a]!.pos.x);
    for (const z of [4, -4]) expect(Math.sign(Math.cos(poseOf(doc, idx, { x: 0, z }).pose.yaw))).toBe(ab);
  });

  it('near a junction it looks at the junction center; farther away along the travel direction', () => {
    const { doc } = crossDoc();
    const idx = new PickIndex(doc);
    const graph = compileNetwork(doc);
    const near = poseOf(doc, idx, { x: 25, z: 6 });
    const toCenter = Math.atan2(-near.pose.pos.z, -near.pose.pos.x);
    expect(Math.abs(wrapPi(near.pose.yaw - toCenter))).toBeLessThan(1e-9);
    expect(25).toBeLessThan(JUNCTION_AIM);
    // 70 m from the junction; the road's other end is a dead end, not a junction.
    const far = poseOf(doc, idx, { x: 70, z: 6 });
    expect(dotv(dir(far.pose.yaw), laneDirNear(graph, far.pose.pos))).toBeGreaterThan(0.99);
  });

  it('nothing is offered away from roads', () => {
    const doc = straight();
    expect(sensorSpot(doc, new PickIndex(doc), { x: 20, z: 40 })).toBeNull();
  });

  it('sector outlines fit the presence ghost and close on themselves', () => {
    for (const fov of [Math.PI / 9, Math.PI / 2, Math.PI * 2]) {
      const pts = sectorOutline({ x: 0, z: 0 }, 0.3, fov, 100);
      expect(pts.length).toBeLessThanOrEqual(MAX_GHOST_POINTS);
      expect(pts[0]).toEqual(pts[pts.length - 1]);
    }
  });
});

function setup(doc: CityDoc = straight(), schedule?: FrameScheduler) {
  const store = new ClientStore('main', '나');
  store.receive({ t: 'welcome', clientId: 'me', tag: 'T', color: '#ff0000', room: 'main', seq: 0, doc, peers: [] });
  store.set({ tool: 'sensor' });
  const dispatch = vi.fn((_cmd: Command, _ghost?: Vec2[][]) => 1);
  let graph: RoadGraph | null = compileNetwork(store.getState().doc);
  const changed = vi.fn();
  const ctx: ToolContext = { store, dispatch, ids: () => new IdGen('T'), changed, pan: { start: () => true, move: () => {}, end: () => {} }, focus: () => {}, roadGraph: () => graph };
  const tool = new SensorTool(ctx, () => new PickIndex(store.getState().doc), schedule);
  const at = (x: number, z: number, cx = x, cy = z): ToolPointer => ({ pos: { x, z }, client: { x: cx, y: cy }, button: 0, shift: false, ctrl: false, alt: false });
  return { store, tool, dispatch, at, changed, setGraph: (g: RoadGraph | null) => (graph = g) };
}

describe('SensorTool', () => {
  it('the previewed coverage is exactly what the simulation compiles once the sensor is placed (one command)', () => {
    for (const kind of ['cctv', 'radar', 'smartpole'] as const) {
      const { store, tool, dispatch, at } = setup(crossDoc().doc);
      store.setToolOptions({ sensorKind: kind });
      tool.onPointerMove(at(30, -6));
      const preview = tool.previewCoverage()!;
      expect(preview.lanes.length).toBeGreaterThan(0);
      tool.onPointerDown(at(30, -6));
      tool.onPointerUp(at(30, -6));
      expect(dispatch).toHaveBeenCalledTimes(1);
      const cmd = dispatch.mock.calls[0]![0] as Extract<Command, { type: 'sensor.place' }>;
      expect(cmd.type).toBe('sensor.place');
      expect(cmd.sensor.kind).toBe(kind);
      const after = cloneJson(store.getState().doc);
      expect(applyCommand(after, cmd).ok).toBe(true);
      const sim = compileSensorCoverage(after, compileNetwork(after)).find((c) => c.sensorId === cmd.sensor.id)!;
      expect(sim.lanes).toEqual(preview.lanes);
      expect(sim.buildings).toEqual(preview.buildings);
      expect([sim.x, sim.z, sim.yaw]).toEqual([preview.x, preview.z, preview.yaw]);
    }
  });

  it('computes the coverage at most once per frame, however many moves arrive', () => {
    const frames: (() => void)[] = [];
    const { tool, at } = setup(straight(), (cb) => frames.push(cb));
    for (const x of [-40, -20, 0, 20, 40]) tool.onPointerMove(at(x, 5));
    expect(frames).toHaveLength(1);
    expect(tool.previewCoverage()).toBeNull(); // not computed yet: the preview shows the sector alone
    frames.shift()!();
    expect(tool.previewCoverage()).not.toBeNull();
    expect(tool.preview().lines.some((l) => l.color === '#facc15')).toBe(true);
    tool.onPointerMove(at(45, 5));
    expect(frames).toHaveLength(1);
  });

  it('wheel and , . rotate the view while a spot is offered (Esc resets); elsewhere the wheel keeps zooming', () => {
    const { tool, at } = setup();
    const wheel = (deltaY: number, shiftKey = false) => ({ deltaY, deltaX: 0, shiftKey }) as WheelEvent;
    tool.onPointerMove(at(20, 30));
    expect(tool.candidate()).toBeNull();
    expect(tool.onWheel(wheel(100))).toBe(false);
    tool.onPointerMove(at(20, 5));
    const h0 = tool.candidate()!.heading;
    expect(tool.onWheel(wheel(100))).toBe(true);
    expect(wrapPi(tool.candidate()!.heading - h0)).toBeCloseTo(Math.PI / 12, 9);
    // Real key events: with Shift held the characters are < and >; the physical key decides.
    expect(tool.onKey({ type: 'keydown', key: '<', code: 'Comma', shiftKey: true } as KeyboardEvent)).toBe(true);
    expect(wrapPi(tool.candidate()!.heading - h0)).toBeCloseTo(Math.PI / 12 - Math.PI / 36, 9);
    expect(tool.onKey({ type: 'keydown', key: '>', code: 'Period', shiftKey: true } as KeyboardEvent)).toBe(true);
    expect(wrapPi(tool.candidate()!.heading - h0)).toBeCloseTo(Math.PI / 12, 9);
    expect(tool.onKey({ type: 'keydown', key: '.', code: 'Period', shiftKey: false } as KeyboardEvent)).toBe(true);
    expect(wrapPi(tool.candidate()!.heading - h0)).toBeCloseTo(Math.PI / 6, 9);
    tool.onKey({ type: 'keydown', key: 'Escape' } as KeyboardEvent);
    expect(tool.candidate()!.heading).toBeCloseTo(h0, 12);
  });

  it("a collaborator's fillet between press and release cancels the placement (Sol's repro), a fresh click places it", () => {
    const doc = createEmptyDoc();
    const ids = new IdGen('t');
    road(doc, { x: 0, z: 0 }, { x: 200, z: 0 }, ids);
    road(doc, { x: 200, z: 0 }, { x: 200, z: 200 }, ids);
    const { store, tool, dispatch, at } = setup(doc);
    tool.onPointerMove(at(190, 5));
    tool.onPointerDown(at(190, 5));
    const corner = Object.values(store.getState().doc.nodes).find((n) => n.pos.x === 200 && n.pos.z === 0)!;
    // The peer's fillet arrives as an applied command (the controller re-runs the pointer move on doc changes).
    store.receive({ t: 'applied', seq: 1, by: 'peer', cmd: { type: 'road.fillet', nodeId: corner.id, ids: { a: 'fa', b: 'fb', seg: 'fs' } } });
    expect(Object.keys(store.getState().doc.nodes)).not.toContain(corner.id);
    tool.onPointerMove(at(190, 5));
    tool.onPointerUp(at(190, 5));
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getState().toasts.at(-1)?.text).toBe(ROAD_CHANGED);
    // Without the intermediate move (release right after the change) it is refused as well.
    tool.onPointerDown(at(100, 5));
    const start = Object.values(store.getState().doc.nodes).find((n) => n.pos.x === 0 && n.pos.z === 0)!;
    store.receive({ t: 'applied', seq: 2, by: 'peer', cmd: { type: 'node.move', id: start.id, pos: { x: -20, z: 0 } } });
    tool.onPointerUp(at(100, 5));
    expect(dispatch).not.toHaveBeenCalled();
    // A new click on the changed road places the sensor where it was clicked.
    tool.onPointerMove(at(150, 5));
    tool.onPointerDown(at(150, 5));
    tool.onPointerUp(at(150, 5));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const cmd = dispatch.mock.calls[0]![0] as Extract<Command, { type: 'sensor.place' }>;
    const pose = sensorPose(store.getState().doc, cmd.sensor)!;
    expect(Math.abs(pose.pos.x - 150)).toBeLessThan(1);
  });

  it('dragging from the spot aims the sensor at the release point', () => {
    const { tool, dispatch, at, store } = setup();
    tool.onPointerMove(at(0, 5));
    tool.onPointerDown(at(0, 5, 100, 100));
    tool.onPointerMove(at(40, 60, 160, 40));
    tool.onPointerUp(at(40, 60, 160, 40));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const cmd = dispatch.mock.calls[0]![0] as Extract<Command, { type: 'sensor.place' }>;
    const pose = sensorPose(store.getState().doc, cmd.sensor)!;
    expect(Math.abs(wrapPi(pose.yaw - Math.atan2(60 - pose.pos.z, 40 - pose.pos.x)))).toBeLessThan(1e-9);
    // The ghost sent with the command is the sector outline (pending pulse until the server answers).
    expect(dispatch.mock.calls[0]![1]![0]!.length).toBeGreaterThan(3);
  });

  it('shares the sector outline as the presence ghost', () => {
    const { tool, at } = setup();
    expect(tool.ghost()).toEqual([]);
    tool.onPointerMove(at(10, -5));
    const g = tool.ghost();
    expect(g.length).toBeGreaterThan(3);
    expect(g.length).toBeLessThanOrEqual(MAX_GHOST_POINTS);
  });
});
