// Sensor coverage (ADR 0013 §3, §4): view sector → lane intervals and buildings. Checked against a dense
// point-in-sector sampling of every lane (closed boundaries), on straight and curved roads.

import { describe, expect, it } from 'vitest';
import { createEmptyDoc, sensorPose, type CityDoc, type Command, type Sensor } from '@smartcity/shared';
import { compileNetwork } from '../network/compile.js';
import { apply, gridDoc } from '../testkit.js';
import type { RoadGraph } from '../types.js';
import { compileSensorCoverage, sensorCoverage, type SensorCoverage } from './coverage.js';

const cam = (id: string, segmentId: string, t: number, over: Partial<Sensor> = {}): Sensor => ({ id, kind: 'cctv', segmentId, t, side: 'right', heading: 0, fov: Math.PI / 2, range: 120, ...over });

/** The sector rule itself (distance ≤ range, angle ≤ fov/2), independent of the implementation. */
function inside(doc: CityDoc, s: Sensor, p: { x: number; z: number }): boolean {
  const pose = sensorPose(doc, s)!;
  const dx = p.x - pose.pos.x;
  const dz = p.z - pose.pos.z;
  if (Math.hypot(dx, dz) > s.range) return false;
  if (s.fov >= 2 * Math.PI) return true;
  let d = Math.atan2(dz, dx) - pose.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d) <= s.fov / 2;
}

/** Every 0.25 m of every lane: covered by an interval ⇔ inside the sector (except within 2 cm of an edge). */
function checkAgainstSampling(doc: CityDoc, graph: RoadGraph, s: Sensor, cov: SensorCoverage): number {
  let checked = 0;
  for (const l of graph.lanes) {
    const mine = cov.lanes.filter((iv) => iv.laneId === l.id);
    for (const iv of mine) expect(iv.sFrom).toBeLessThanOrEqual(iv.sTo);
    for (let k = 1; k < mine.length; k++) expect(mine[k]!.sFrom).toBeGreaterThan(mine[k - 1]!.sTo);
    for (let at = 0; at <= l.length; at += 0.25) {
      let i = 0;
      while (i < l.cum.length - 2 && l.cum[i + 1]! < at) i++;
      const u = (at - l.cum[i]!) / (l.cum[i + 1]! - l.cum[i]! || 1);
      const p = { x: l.points[i]!.x + (l.points[i + 1]!.x - l.points[i]!.x) * u, z: l.points[i]!.z + (l.points[i + 1]!.z - l.points[i]!.z) * u };
      const covered = mine.some((iv) => at >= iv.sFrom - 1e-6 && at <= iv.sTo + 1e-6);
      if (mine.some((iv) => Math.abs(at - iv.sFrom) < 0.02 || Math.abs(at - iv.sTo) < 0.02)) continue;
      expect(covered, `${l.id} @${at}`).toBe(inside(doc, s, p));
      checked++;
    }
  }
  return checked;
}

/** a(0,0) → b(100,0) arched by control (50, 200), and a straight road e → f below it. */
function arch(): CityDoc {
  const cmds: Command[] = [
    { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
    { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
    { type: 'segment.add', segment: { id: 'arch', a: 'a', b: 'b', roadTypeId: 'road-2', control: { x: 50, z: 200 } } },
    { type: 'node.add', node: { id: 'e', pos: { x: 30, z: -30 } } },
    { type: 'node.add', node: { id: 'f', pos: { x: 70, z: -30 } } },
    { type: 'segment.add', segment: { id: 'ef', a: 'e', b: 'f', roadTypeId: 'road-2' } },
  ];
  return apply(createEmptyDoc('arch', 2), cmds);
}

describe('sensor coverage', () => {
  it('a CCTV along a straight grid road: intervals match the sector sampling on every lane', () => {
    const doc = gridDoc(3, 150, 'road-4', 2);
    const graph = compileNetwork(doc);
    for (const s of [cam('c', 'h_0_1', 0.2), cam('c', 'h_0_1', 0.5, { side: 'left', heading: Math.PI / 2, fov: 2.5, range: 60 }), cam('r', 'v_1_0', 0.5, { kind: 'radar', fov: Math.PI / 9, range: 200 })]) {
      const cov = sensorCoverage(doc, graph, s);
      expect(cov.lanes.length).toBeGreaterThan(0);
      expect(checkAgainstSampling(doc, graph, s, cov)).toBeGreaterThan(500);
    }
  });

  it('a lane that enters and leaves the sector twice (curve) keeps two intervals', () => {
    const doc = arch();
    const graph = compileNetwork(doc);
    const s = cam('p', 'ef', 0.5, { kind: 'smartpole', fov: 2 * Math.PI, range: 75 });
    const cov = sensorCoverage(doc, graph, s);
    const archLane = graph.lanes.find((l) => l.segmentId === 'arch')!;
    expect(cov.lanes.filter((iv) => iv.laneId === archLane.id).length).toBe(2);
    checkAgainstSampling(doc, graph, s, cov);
    // A wide (> 180°) sector and a narrow one on the same curve.
    for (const fov of [4, 0.6]) {
      const w = cam('w', 'ef', 0.5, { side: 'left', heading: -Math.PI / 2, fov, range: 150 });
      checkAgainstSampling(doc, graph, w, sensorCoverage(doc, graph, w));
    }
  });

  it('boundaries are closed: a building exactly at the range is covered; radar sees no buildings', () => {
    const doc = gridDoc(3, 150, 'road-4', 2);
    const s = cam('c', 'h_0_1', 0.5, { heading: Math.PI / 2, fov: 2 * Math.PI, range: 60 });
    const pose = sensorPose(doc, s)!;
    apply(doc, [
      { type: 'building.place', building: { id: 'edge', typeId: 'house', pos: { x: pose.pos.x, z: pose.pos.z + 60 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'out', typeId: 'house', pos: { x: pose.pos.x + 30, z: pose.pos.z + 60 }, rotation: 0 } },
    ]);
    const graph = compileNetwork(doc);
    expect(sensorCoverage(doc, graph, s).buildings).toEqual(['edge']);
    expect(sensorCoverage(doc, graph, { ...s, kind: 'radar' }).buildings).toEqual([]);
  });

  it('is deterministic and independent of the order sensors were added (id order)', () => {
    const build = (ids: string[]): CityDoc => {
      const doc = gridDoc(3, 150, 'road-4', 2);
      return apply(
        doc,
        ids.map((id, i) => ({ type: 'sensor.place', sensor: cam(id, i % 2 ? 'h_0_1' : 'v_1_0', 0.3 + 0.1 * i) }) as Command),
      );
    };
    const a = build(['s1', 's2', 's3']);
    const b = apply(gridDoc(3, 150, 'road-4', 2), ['s3', 's1', 's2'].map((id) => ({ type: 'sensor.place', sensor: a.sensors[id]! }) as Command));
    const ca = compileSensorCoverage(a, compileNetwork(a));
    expect(ca.map((c) => c.sensorId)).toEqual(['s1', 's2', 's3']);
    expect(compileSensorCoverage(b, compileNetwork(b))).toEqual(ca);
    expect(compileSensorCoverage(a, compileNetwork(a))).toEqual(ca);
  });
});

describe('malformed sensors (Sol P6b-1 #2)', () => {
  it('a sensor that skipped validation (unchecked doc copy) covers nothing instead of crashing the sim', () => {
    const doc = gridDoc(3, 150, 'road-4', 2);
    doc.sensors = { bad: { ...cam('bad', 'h_0_1', 0.5), kind: 'bogus' as Sensor['kind'] }, ok: cam('ok', 'h_0_1', 0.5) };
    const graph = compileNetwork(doc);
    expect(compileSensorCoverage(doc, graph).map((c) => c.sensorId)).toEqual(['ok']);
    expect(sensorCoverage(doc, graph, doc.sensors.bad!).lanes).toEqual([]);
  });
});
