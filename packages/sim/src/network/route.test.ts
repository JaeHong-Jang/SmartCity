import { describe, expect, it } from 'vitest';
import type { CityDoc } from '@smartcity/shared';
import { apply, gridDoc } from '../testkit.js';
import { compileNetwork } from './compile.js';
import { buildNet } from './net.js';
import { Router } from './route.js';

function route(doc: CityDoc, from: string, to: string): string[] | null {
  const net = buildNet(compileNetwork(doc));
  const g = net.graph;
  const goal = g.laneById.get(to)!;
  const res = new Router(net).find(g.laneById.get(from)!, 0, [{ lane: goal, destS: net.len[goal]! }], false, new Int32Array(net.nLanes));
  return res ? res.path.filter((e) => e < net.nLanes).map((e) => g.lanes[e]!.id) : null;
}

const segs = (path: string[]): string[] => path.map((id) => id.split('|')[0]!);

describe('Router (lane-graph A*)', () => {
  it('takes the direct path through the grid', () => {
    const path = route(gridDoc(3, 150, 'road-2'), 'h_1_1|b|0', 'v_0_1|f|0')!;
    expect(segs(path)).toEqual(['h_1_1', 'h_0_1', 'v_0_1']);
  });

  it('respects one-way roads', () => {
    const doc = apply(gridDoc(3, 150, 'road-2'), [{ type: 'segment.setType', id: 'h_0_1', roadTypeId: 'oneway-2' }]);
    const path = route(doc, 'h_1_1|b|0', 'v_0_1|f|0')!;
    expect(path).not.toBeNull();
    expect(segs(path)).not.toContain('h_0_1');
    expect(segs(path)).toContain('v_0_0');
  });

  it('detours around closed segments', () => {
    const doc = apply(gridDoc(3, 150, 'road-2'), [{ type: 'closure.set', closure: { segmentId: 'h_0_1', reason: 'test' } }]);
    const path = route(doc, 'h_1_1|b|0', 'v_0_1|f|0')!;
    expect(path).not.toBeNull();
    expect(segs(path)).not.toContain('h_0_1');
  });

  it('returns null when the destination is unreachable', () => {
    const doc = apply(gridDoc(2, 150, 'road-2'), [
      { type: 'closure.set', closure: { segmentId: 'h_0_0', reason: 'x' } },
      { type: 'closure.set', closure: { segmentId: 'v_1_0', reason: 'x' } },
    ]);
    expect(route(doc, 'v_0_0|f|0', 'h_0_1|f|0')).not.toBeNull();
    expect(route(doc, 'v_0_0|b|0', 'h_0_0|f|0')).toBeNull();
  });

  it('is deterministic for equal-cost alternatives', () => {
    const doc = gridDoc(4, 100, 'road-2');
    const a = route(doc, 'h_0_0|f|0', 'h_2_3|f|0');
    expect(a).not.toBeNull();
    for (let i = 0; i < 3; i++) expect(route(doc, 'h_0_0|f|0', 'h_2_3|f|0')).toEqual(a);
  });
});
