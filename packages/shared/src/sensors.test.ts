// Roadside sensors (ADR 0013 §4): commands, validation, the bus-stop cascade (split / fillet / removal),
// doc round trips and the v7 → v8 migration.

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  checkFillet,
  cloneJson,
  createEmptyDoc,
  docProblem,
  docToCommands,
  DOC_VERSION,
  LIMITS,
  normalizeDoc,
  sensorPose,
  sensorShapeError,
  type CityDoc,
  type Command,
  type Sensor,
} from './index.js';

function apply(doc: CityDoc, cmds: Command[]): CityDoc {
  for (const c of cmds) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error}`);
  }
  return doc;
}

/** a(0,0) → b(200,0) → c(200,200): two straight road-2 legs meeting at a right-angle corner b. */
function corner(): CityDoc {
  return apply(createEmptyDoc('s', 3), [
    { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
    { type: 'node.add', node: { id: 'b', pos: { x: 200, z: 0 } } },
    { type: 'node.add', node: { id: 'c', pos: { x: 200, z: 200 } } },
    { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
    { type: 'segment.add', segment: { id: 'bc', a: 'b', b: 'c', roadTypeId: 'road-2' } },
  ]);
}

const cam = (id: string, segmentId: string, t: number, over: Partial<Sensor> = {}): Sensor => ({ id, kind: 'cctv', segmentId, t, side: 'right', heading: 0, fov: Math.PI / 2, range: 120, ...over });
const place = (s: Sensor): Command => ({ type: 'sensor.place', sensor: s });

describe('sensor commands and validation', () => {
  it('places, updates the view and removes; refuses id collisions and unknown sensors', () => {
    const doc = corner();
    expect(applyCommand(doc, place(cam('s1', 'ab', 0.5)))).toEqual({ ok: true });
    expect(doc.sensors.s1).toEqual(cam('s1', 'ab', 0.5));
    expect(applyCommand(doc, place(cam('s1', 'bc', 0.5)))).toEqual({ ok: false, error: 'sensor exists' });
    expect(applyCommand(doc, { type: 'sensor.update', id: 's1', kind: 'radar', heading: 1, fov: 0.3, range: 200 })).toEqual({ ok: true });
    expect(doc.sensors.s1).toEqual({ ...cam('s1', 'ab', 0.5), kind: 'radar', heading: 1, fov: 0.3, range: 200 });
    // Omitted fields stay; the mount never changes through update.
    expect(applyCommand(doc, { type: 'sensor.update', id: 's1', range: 50 })).toEqual({ ok: true });
    expect(doc.sensors.s1).toMatchObject({ segmentId: 'ab', t: 0.5, side: 'right', kind: 'radar', range: 50 });
    expect(applyCommand(doc, { type: 'sensor.update', id: 'nope', range: 50 }).ok).toBe(false);
    expect(applyCommand(doc, { type: 'sensor.remove', id: 's1' })).toEqual({ ok: true });
    expect(doc.sensors).toEqual({});
    expect(applyCommand(doc, { type: 'sensor.remove', id: 's1' })).toEqual({ ok: false, error: 'unknown sensor' });
  });

  it('refuses non-finite or out-of-range values, bad kinds, sides and segments; extra fields are dropped', () => {
    const doc = corner();
    const bad: Partial<Sensor>[] = [
      { t: NaN },
      { t: 1.01 },
      { heading: Infinity },
      { heading: 7 },
      { fov: 0 },
      { fov: 7 },
      { range: 1 },
      { range: LIMITS.sensorRangeMax + 1 },
      { range: NaN },
      { kind: 'loop' as Sensor['kind'] },
      { side: 'up' as Sensor['side'] },
      { segmentId: 'nope' },
      { id: '__proto__' },
    ];
    for (const b of bad) expect(applyCommand(doc, place({ ...cam('x', 'ab', 0.5), ...b })).ok, JSON.stringify(b)).toBe(false);
    expect(applyCommand(doc, { type: 'sensor.update', id: 'x', fov: 0.3 }).ok).toBe(false);
    expect(applyCommand(doc, place({ ...cam('x', 'ab', 0.5), extra: 1 } as Sensor))).toEqual({ ok: true });
    expect(Object.keys(doc.sensors.x!).sort()).toEqual(['fov', 'heading', 'id', 'kind', 'range', 'segmentId', 'side', 't']);
    expect(applyCommand(doc, { type: 'sensor.update', id: 'x', heading: NaN }).ok).toBe(false);
    expect(doc.sensors.x!.heading).toBe(0);
  });

  it('a batch with a failing sensor command changes nothing (atomic)', () => {
    const doc = corner();
    const before = cloneJson(doc);
    expect(applyCommand(doc, { type: 'batch', commands: [place(cam('s1', 'ab', 0.5)), { type: 'sensor.update', id: 's1', range: 9 }, place(cam('s1', 'bc', 0.2))] }).ok).toBe(false);
    expect(doc).toEqual(before);
  });

  it('capacity: refused past LIMITS.sensors, accepted on trusted replay', () => {
    const doc = corner();
    for (let i = 0; i < LIMITS.sensors; i++) doc.sensors[`f${i}`] = cam(`f${i}`, 'ab', 0.5);
    expect(applyCommand(doc, place(cam('one', 'ab', 0.5)))).toEqual({ ok: false, error: 'too many sensors' });
    expect(applyCommand(doc, place(cam('one', 'ab', 0.5)), { trusted: true })).toEqual({ ok: true });
  });
});

describe('sensors follow their road like bus stops', () => {
  const near = (p: { x: number; z: number } | undefined, q: { x: number; z: number } | undefined, eps: number): boolean => !!p && !!q && Math.abs(p.x - q.x) <= eps && Math.abs(p.z - q.z) <= eps;

  it('segment.split moves sensors to the piece they are on and keeps their world pose', () => {
    const doc = apply(corner(), [place(cam('s1', 'ab', 0.25, { side: 'left', heading: 0.4 })), place(cam('s2', 'ab', 0.75))]);
    const before = Object.values(doc.sensors).map((s) => sensorPose(doc, s)!);
    expect(applyCommand(doc, { type: 'segment.split', id: 'ab', t: 0.5, nodeId: 'm', segmentIds: ['ab1', 'ab2'] })).toEqual({ ok: true });
    expect(doc.sensors.s1).toMatchObject({ segmentId: 'ab1', t: 0.5, side: 'left', heading: 0.4 });
    expect(doc.sensors.s2).toMatchObject({ segmentId: 'ab2', t: 0.5 });
    const after = Object.values(doc.sensors).map((s) => sensorPose(doc, s)!);
    for (let i = 0; i < 2; i++) {
      expect(near(after[i]!.pos, before[i]!.pos, 1e-9)).toBe(true);
      expect(after[i]!.yaw).toBeCloseTo(before[i]!.yaw, 9);
    }
  });

  it('a split of a curved road keeps the pose within the arc sampling tolerance', () => {
    const doc = corner();
    apply(doc, [
      { type: 'node.add', node: { id: 'd', pos: { x: 0, z: 300 } } },
      { type: 'segment.add', segment: { id: 'cd', a: 'c', b: 'd', roadTypeId: 'road-2', control: { x: 100, z: 400 } } },
      place(cam('s', 'cd', 0.3)),
    ]);
    const before = sensorPose(doc, doc.sensors.s!)!;
    expect(applyCommand(doc, { type: 'segment.split', id: 'cd', t: 0.6, nodeId: 'm', segmentIds: ['cd1', 'cd2'] })).toEqual({ ok: true });
    expect(doc.sensors.s!.segmentId).toBe('cd1');
    expect(near(sensorPose(doc, doc.sensors.s!)!.pos, before.pos, 0.5)).toBe(true);
  });

  it('road.fillet refuses a sensor in the cut stretch and remaps one on the kept stretch', () => {
    const cut = apply(corner(), [place(cam('s', 'ab', 0.98))]);
    expect(checkFillet(cut, 'b')).toEqual({ ok: false, error: 'cannot round the corner: a sensor is in the corner' });
    const doc = apply(corner(), [place(cam('s', 'ab', 0.25)), place(cam('t', 'bc', 0.5, { side: 'left' }))]);
    const before = Object.values(doc.sensors).map((s) => sensorPose(doc, s)!);
    expect(applyCommand(doc, { type: 'road.fillet', nodeId: 'b', ids: { a: 'fa', b: 'fb', seg: 'fs' } })).toEqual({ ok: true });
    expect(doc.sensors.s!.segmentId).toBe('ab');
    expect(doc.sensors.s!.t).toBeGreaterThan(0.25);
    const after = Object.values(doc.sensors).map((s) => sensorPose(doc, s)!);
    for (let i = 0; i < 2; i++) expect(near(after[i]!.pos, before[i]!.pos, 1e-6)).toBe(true);
  });

  it('segment.remove removes its sensors; node.move keeps t; setType keeps the sensor', () => {
    const doc = apply(corner(), [place(cam('s', 'ab', 0.5)), place(cam('t', 'bc', 0.5))]);
    expect(applyCommand(doc, { type: 'node.move', id: 'a', pos: { x: -40, z: 0 } })).toEqual({ ok: true });
    expect(doc.sensors.s!.t).toBe(0.5);
    expect(applyCommand(doc, { type: 'segment.setType', id: 'bc', roadTypeId: 'road-4' })).toEqual({ ok: true });
    expect(doc.sensors.t).toBeDefined();
    expect(applyCommand(doc, { type: 'segment.remove', id: 'ab' })).toEqual({ ok: true });
    expect(Object.keys(doc.sensors)).toEqual(['t']);
  });

  it('sensorPose: sidewalk middle of the chosen side, yaw = road tangent + heading (+π/2 = right)', () => {
    const doc = corner();
    const rt = doc.roadTypes['road-2']!;
    const off = (rt.lanesForward + rt.lanesBackward) * rt.laneWidth * 0.5 + 1.25;
    // ab runs along +x: its right side (rightNormal) is +z.
    expect(sensorPose(doc, cam('s', 'ab', 0.5))).toEqual({ pos: { x: 100, z: off }, yaw: 0 });
    const left = sensorPose(doc, cam('s', 'ab', 0.5, { side: 'left', heading: Math.PI / 2 }))!;
    expect(left.pos).toEqual({ x: 100, z: -off });
    expect(left.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(sensorPose(doc, cam('s', 'nope', 0.5))).toBeNull();
  });
});

describe('sensor documents', () => {
  it('docToCommands replays to the same roads and sensors (sensors after their roads)', () => {
    const doc = apply(corner(), [place(cam('z', 'bc', 0.1, { kind: 'smartpole', fov: 2 * Math.PI, range: 40 })), place(cam('a', 'ab', 0.9, { side: 'left', heading: -2 }))]);
    const cmds = docToCommands(doc);
    expect(cmds.filter((c) => c.type === 'sensor.place').map((c) => (c as { sensor: Sensor }).sensor.id)).toEqual(['a', 'z']);
    expect(cmds.findIndex((c) => c.type === 'sensor.place')).toBeGreaterThan(cmds.findIndex((c) => c.type === 'segment.add'));
    const replay = createEmptyDoc('s', 3);
    for (const c of cmds) expect(applyCommand(replay, c), c.type).toEqual({ ok: true });
    // Designs get a new revision on replay (upsert); everything on the roads comes back as it was.
    expect({ n: replay.nodes, s: replay.segments, x: replay.sensors }).toEqual({ n: doc.nodes, s: doc.segments, x: doc.sensors });
  });

  it('v7 → v8 adds the empty sensors collection and changes nothing else; docProblem checks sensors', () => {
    expect(DOC_VERSION).toBe(9);
    const v7 = { ...cloneJson(corner()), version: 7 } as Partial<CityDoc>;
    delete v7.sensors;
    const before = cloneJson(v7);
    const v8 = normalizeDoc(v7 as CityDoc);
    expect(v8.version).toBe(DOC_VERSION);
    expect(v8.sensors).toEqual({});
    const { sensors: _added, ...rest } = v8;
    expect({ ...rest, version: 7 }).toEqual(before);
    expect(docProblem(v8)).toBeNull();
    const withSensor = apply(corner(), [place(cam('s', 'ab', 0.5))]);
    expect(docProblem(withSensor)).toBeNull();
    // Sol P6b-1 #2: the same enum and range rules as sensor.place (one validator), not only "is a number".
    const BAD = [{ segmentId: 'gone' }, { heading: 'x' }, { range: null }, { id: 'other' }, { kind: 'bogus' }, { side: 'wrong' }, { t: 2 }, { fov: 0 }, { range: -1 }, { heading: 7 }, { fov: NaN }];
    for (const bad of BAD) {
      const s = { ...withSensor.sensors.s!, ...bad } as Sensor;
      if (!('segmentId' in bad) && !('id' in bad)) expect(sensorShapeError(s), JSON.stringify(bad)).not.toBeNull();
      if (!('segmentId' in bad) && !('id' in bad)) expect(applyCommand(corner(), place(s)).ok, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of BAD) {
      const d = cloneJson(withSensor);
      Object.assign(d.sensors.s!, bad);
      expect(docProblem(d), JSON.stringify(bad)).toBe('doc.sensors["s"] is malformed');
    }
    const arr = cloneJson(withSensor) as unknown as { sensors: unknown };
    arr.sensors = [];
    expect(docProblem(arr)).toBe('doc.sensors is not a keyed collection');
  });
});
