import { describe, expect, it } from 'vitest';
import type { BusStop } from '@smartcity/shared';
import { crossDoc } from '../test/fixtures';
import { BusRouter, stopPosition } from './busRoute';

describe('BusRouter', () => {
  it('routes between stops on different roads and reuses its state across pairs', () => {
    const { doc } = crossDoc();
    const [s1, s2] = Object.keys(doc.segments);
    const a: BusStop = { id: 'a', segmentId: s1!, t: 0.1, dir: 'forward' };
    const b: BusStop = { id: 'b', segmentId: s2!, t: 0.9, dir: 'backward' };
    const router = new BusRouter(doc);
    const first = router.routeBetween(a, b);
    expect(first.length).toBeGreaterThan(2);
    expect(router.routeBetween(a, b)).toEqual(first);
    expect(first[0]).toEqual(stopPosition(doc, a));
  });

  it('cuts the segment itself when the next stop is ahead on the same segment and direction', () => {
    const { doc } = crossDoc();
    const id = Object.keys(doc.segments)[0]!;
    const a: BusStop = { id: 'a', segmentId: id, t: 0.2, dir: 'forward' };
    const b: BusStop = { id: 'b', segmentId: id, t: 0.6, dir: 'forward' };
    const route = new BusRouter(doc).routeBetween(a, b);
    expect(route[0]).toEqual(stopPosition(doc, a));
    expect(route[route.length - 1]).toEqual(stopPosition(doc, b));
  });
});
