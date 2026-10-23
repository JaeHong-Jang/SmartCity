import { describe, expect, it } from 'vitest';
import { createEmptyDoc, dist, type Command } from '@smartcity/shared';
import { apply, crossDoc } from '../testkit.js';
import { compileNetwork, CROSSWALK_ZONE } from './compile.js';
import { SCHOOL_ZONE_SPEED } from '../types.js';
import { Simulation } from '../simulation.js';
import { crossingSignature } from './crossings.js';

const ctrl = (extra: Record<string, unknown>): Command =>
  ({ type: 'intersection.set', control: { nodeId: 'c', kind: 'signal', yellow: 3, allRed: 2, offset: 0, ...extra } }) as Command;

describe('street features in compileNetwork', () => {
  it('puts a crosswalk on every leg of a 4-way junction and trims all lanes by the 4 m zone', () => {
    const g = compileNetwork(crossDoc(120));
    expect(g.crossings.map((c) => c.id)).toEqual(['c|E', 'c|N', 'c|S', 'c|W']);
    expect(g.crossings.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    for (const c of g.crossings) {
      const seg = g.segments.get(c.segmentId)!;
      expect(c.kind).toBe('junction');
      expect(c.nodeId).toBe('c');
      expect(c.signal).toBe(true);
      expect(c.width).toBe(3);
      expect(c.polygon).toHaveLength(4);
      // Curb to curb across the 2 × 3.5 m carriageway, centered in the zone in front of the stop line.
      expect(dist(c.a, c.b)).toBeCloseTo(7);
      expect(c.s).toBeCloseTo(seg.length - seg.setbackB - CROSSWALK_ZONE / 2);
      expect(seg.laneStartB).toBeCloseTo(seg.setbackB + CROSSWALK_ZONE);
      expect(seg.laneStartA).toBe(0);
      // Both the incoming and the outgoing lane of the leg are trimmed.
      for (const l of seg.lanes) expect(g.lanes[l]!.length).toBeCloseTo(120 - seg.laneStartB, 1);
    }
    // The setback (junction polygon, sidewalks) itself is unchanged.
    expect(g.segments.get('W')!.setbackB).toBeCloseTo(7);
  });

  it('respects crosswalkLegs: [] = none, a subset = only those legs', () => {
    const none = compileNetwork(apply(crossDoc(120), [ctrl({ crosswalkLegs: [] })]));
    expect(none.crossings).toEqual([]);
    for (const seg of none.segments.values()) {
      expect(seg.laneStartB).toBe(seg.setbackB);
      for (const l of seg.lanes) expect(none.lanes[l]!.length).toBeCloseTo(120 - seg.setbackB, 1);
    }
    const some = compileNetwork(apply(crossDoc(120), [ctrl({ crosswalkLegs: ['N'] })]));
    expect(some.crossings.map((c) => c.id)).toEqual(['c|N']);
    expect(some.segments.get('N')!.laneStartB).toBeCloseTo(some.segments.get('N')!.setbackB + 4);
    expect(some.segments.get('S')!.laneStartB).toBe(some.segments.get('S')!.setbackB);
  });

  it('builds no crosswalk on roads without sidewalks, at degree-2 nodes or dead ends', () => {
    const doc = crossDoc(120);
    apply(doc, [
      { type: 'roadType.upsert', roadType: { id: 'alley', name: 'alley', lanesForward: 1, lanesBackward: 1, laneWidth: 3, speedLimit: 8, sidewalk: false, busOnlyRightLane: false } },
      { type: 'segment.setType', id: 'E', roadTypeId: 'alley' },
    ]);
    const g = compileNetwork(doc);
    expect(g.crossings.map((c) => c.id)).toEqual(['c|N', 'c|S', 'c|W']);
    expect(g.segments.get('E')!.laneStartB).toBe(g.segments.get('E')!.setbackB);

    const line = apply(createEmptyDoc(), [
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
      { type: 'node.add', node: { id: 'c', pos: { x: 200, z: 0 } } },
      { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'bc', a: 'b', b: 'c', roadTypeId: 'road-2' } },
    ]);
    expect(compileNetwork(line).crossings).toEqual([]);
  });

  it('drops the junction crosswalks of a segment whose lanes would get shorter than 2 m', () => {
    // Two 4-way junctions 17 m apart on road-2: setbacks 7 + 7 leave 3 m, crosswalk zones would leave −5 m.
    const doc = createEmptyDoc();
    const cmds: Command[] = [];
    for (const [id, x] of [['c1', 0], ['c2', 17]] as const) {
      cmds.push({ type: 'node.add', node: { id, pos: { x, z: 0 } } });
      cmds.push({ type: 'node.add', node: { id: `${id}n`, pos: { x, z: -100 } } });
      cmds.push({ type: 'node.add', node: { id: `${id}s`, pos: { x, z: 100 } } });
      cmds.push({ type: 'segment.add', segment: { id: `${id}N`, a: `${id}n`, b: id, roadTypeId: 'road-2' } });
      cmds.push({ type: 'segment.add', segment: { id: `${id}S`, a: `${id}s`, b: id, roadTypeId: 'road-2' } });
    }
    cmds.push({ type: 'node.add', node: { id: 'w', pos: { x: -100, z: 0 } } });
    cmds.push({ type: 'node.add', node: { id: 'e', pos: { x: 117, z: 0 } } });
    cmds.push({ type: 'segment.add', segment: { id: 'W', a: 'w', b: 'c1', roadTypeId: 'road-2' } });
    cmds.push({ type: 'segment.add', segment: { id: 'M', a: 'c1', b: 'c2', roadTypeId: 'road-2' } });
    cmds.push({ type: 'segment.add', segment: { id: 'E', a: 'c2', b: 'e', roadTypeId: 'road-2' } });
    const g = compileNetwork(apply(doc, cmds));
    const m = g.segments.get('M')!;
    expect(m.laneStartA).toBe(m.setbackA);
    expect(m.laneStartB).toBe(m.setbackB);
    expect(g.lanes[m.lanes[0]!]!.length).toBeCloseTo(3, 1);
    expect(g.crossings.some((c) => c.segmentId === 'M')).toBe(false);
    expect(g.crossings.filter((c) => c.nodeId === 'c1').map((c) => c.segmentId).sort()).toEqual(['W', 'c1N', 'c1S']);
  });

  it('places mid-block crosswalks only where the whole zone lies on the lanes', () => {
    const doc = apply(crossDoc(120), [
      { type: 'feature.upsert', feature: { id: 'x1', segmentId: 'W', kind: 'crosswalk', t: 0.5, signal: true } },
      // 12 m from the junction end: allowed by the document, but inside setback + zone (7 + 4 + 4).
      { type: 'feature.upsert', feature: { id: 'x2', segmentId: 'E', kind: 'crosswalk', t: 0.9 } },
      { type: 'feature.upsert', feature: { id: 'x3', segmentId: 'N', kind: 'crosswalk', t: 0.25 } },
    ]);
    const g = compileNetwork(doc);
    const mids = g.crossings.filter((c) => c.kind === 'midblock');
    expect(mids.map((c) => c.id)).toEqual(['x1', 'x3']);
    const x1 = mids[0]!;
    expect(x1.segmentId).toBe('W');
    expect(x1.s).toBeCloseTo(60);
    expect(x1.signal).toBe(true);
    expect(x1.nodeId).toBeUndefined();
    expect(mids[1]!.signal).toBe(false);
    // Crossings stay sorted by id with dense indexes.
    expect(g.crossings.map((c) => c.id)).toEqual([...g.crossings.map((c) => c.id)].sort());
    g.crossings.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('records speed bumps by arc length and limits school-zone lanes to 30 km/h', () => {
    const doc = apply(crossDoc(120, 'road-4'), [
      { type: 'feature.upsert', feature: { id: 'b2', segmentId: 'W', kind: 'speedBump', t: 0.5 } },
      { type: 'feature.upsert', feature: { id: 'b1', segmentId: 'W', kind: 'speedBump', t: 0.25 } },
      { type: 'segment.setSchoolZone', id: 'N', schoolZone: true },
    ]);
    const g = compileNetwork(doc);
    expect(g.segments.get('W')!.speedBumps).toEqual([30, 60]);
    expect(g.segments.get('E')!.speedBumps).toEqual([]);
    expect(g.segments.get('N')!.schoolZone).toBe(true);
    expect(g.segments.get('W')!.schoolZone).toBe(false);
    for (const l of g.segments.get('N')!.lanes) expect(g.lanes[l]!.speedLimit).toBeCloseTo(SCHOOL_ZONE_SPEED);
    for (const l of g.segments.get('W')!.lanes) expect(g.lanes[l]!.speedLimit).toBeGreaterThan(SCHOOL_ZONE_SPEED);
    for (const c of g.connectors) if (g.lanes[c.toLane]!.segmentId === 'N') expect(c.speedLimit).toBeLessThanOrEqual(SCHOOL_ZONE_SPEED + 1e-9);
  });

  it('signs the crossing list in snapshots (order-sensitive 32-bit FNV-1a) so stale indexes can be detected', () => {
    expect(crossingSignature(['a', 'b'])).not.toBe(crossingSignature(['b', 'a']));
    expect(crossingSignature(['ab'])).not.toBe(crossingSignature(['a', 'b']));
    expect(crossingSignature([])).toBe(0x811c9dc5);
    const sig = crossingSignature(['c|E', 'c|N']);
    expect(Number.isInteger(sig) && sig >= 0 && sig < 2 ** 32).toBe(true);
    const sim = new Simulation(crossDoc(120), { demand: false, citizens: false });
    const before = sim.snapshot();
    expect(before.crossingSig).toBe(crossingSignature(sim.graph.crossings.map((c) => c.id)));
    sim.applyCommand(ctrl({ crosswalkLegs: ['N', 'S', 'W'] }));
    sim.step();
    const after = sim.snapshot();
    expect(after.crossingCount).toBe(3);
    expect(after.crossingSig).toBe(crossingSignature(['c|N', 'c|S', 'c|W']));
    expect(after.crossingSig).not.toBe(before.crossingSig);
  });
});
