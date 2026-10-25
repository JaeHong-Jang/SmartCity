import { describe, expect, it } from 'vitest';
import { compileNetwork } from '@smartcity/sim';
import { PickIndex } from '../tools/picking';
import { crossDoc } from '../test/fixtures';
import { accidentAt, segmentAt } from './pick';

describe('click targets', () => {
  const { doc } = crossDoc();
  const index = new PickIndex(doc);
  const graph = compileNetwork(doc);

  it('picks the segment under the click, nothing in open ground', () => {
    expect(segmentAt(index, { x: -60, z: 0 })).not.toBeNull();
    expect(segmentAt(index, { x: -60, z: 70 })).toBeNull();
  });

  it('accident: the nearest lane of that segment and a position along its travel direction', () => {
    const lanePos = (id: string) => graph.segments.get(id)!.lanes.map((i) => graph.lanes[i]!);
    const a = accidentAt(index, graph, { x: -60, z: 1.5 })!;
    const b = accidentAt(index, graph, { x: -60, z: -1.5 })!;
    expect(a.segmentId).toBe(b.segmentId);
    expect(a.lane).not.toBe(b.lane); // opposite directions of the 2-lane road
    const lane = lanePos(a.segmentId)[a.lane]!;
    // s runs along the lane's travel direction: the obstacle's rear end is before the clicked point, in range
    expect(a.s).toBeGreaterThanOrEqual(0);
    expect(a.s).toBeLessThanOrEqual(lane.length);
    const other = lanePos(b.segmentId)[b.lane]!;
    expect(lane.dir).not.toBe(other.dir);
    // clicks 1.5 m apart on x map to s values that grow in opposite senses for opposite lanes
    const a2 = accidentAt(index, graph, { x: -40, z: 1.5 })!;
    const b2 = accidentAt(index, graph, { x: -40, z: -1.5 })!;
    expect(Math.sign(a2.s - a.s)).toBe(-Math.sign(b2.s - b.s));
  });

  it('no accident spot off the road', () => {
    expect(accidentAt(index, graph, { x: 200, z: 200 })).toBeNull();
  });
});
