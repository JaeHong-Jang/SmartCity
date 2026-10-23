import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '@smartcity/shared';
import { apply, crossDoc, gridDoc } from '../testkit.js';
import { compileNetwork, newCompileCache } from './compile.js';
import type { RoadGraph } from '../types.js';

const conn = (g: RoadGraph, from: string, to: string) => g.connectors.find((c) => c.id === `${from}>${to}`);
const outOf = (g: RoadGraph, laneId: string) => g.lanes[g.laneById.get(laneId)!]!.out.map((i) => g.connectors[i]!);

describe('compileNetwork', () => {
  it('builds lanes per direction with stable ids, forward lanes first', () => {
    const g = compileNetwork(crossDoc(120, 'road-4'));
    const seg = g.segments.get('W')!;
    expect(seg.lanes.map((i) => g.lanes[i]!.id)).toEqual(['W|f|0', 'W|f|1', 'W|b|0', 'W|b|1']);
    const f0 = g.lanes[g.laneById.get('W|f|0')!]!;
    expect(f0.fromNode).toBe('w');
    expect(f0.toNode).toBe('c');
    // Trimmed by the junction setback at c (max half width 9.5 + 1) plus the 4 m crosswalk zone, nothing at the dead end.
    expect(seg.setbackB).toBeCloseTo(10.5);
    expect(seg.setbackA).toBe(0);
    expect(seg.laneStartB).toBeCloseTo(14.5);
    expect(f0.length).toBeCloseTo(120 - 14.5, 1);
  });

  it('one-way roads only get forward lanes', () => {
    const doc = createEmptyDoc();
    apply(doc, [
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
      { type: 'segment.add', segment: { id: 's', a: 'a', b: 'b', roadTypeId: 'oneway-2' } },
    ]);
    const g = compileNetwork(doc);
    expect(g.lanes.map((l) => l.id)).toEqual(['s|f|0', 's|f|1']);
    // No way out of the end (no outgoing lane at b) and no U-turn on a one-way.
    expect(g.connectors).toHaveLength(0);
  });

  it('classifies turns and applies the lane rules at a 4-way junction', () => {
    const g = compileNetwork(crossDoc(120, 'road-4'));
    // Eastbound from W: S (+z) is a right turn, N is a left turn.
    const left = outOf(g, 'W|f|0');
    const right = outOf(g, 'W|f|1');
    expect(new Set(left.map((c) => c.turn))).toEqual(new Set(['left', 'straight']));
    expect(new Set(right.map((c) => c.turn))).toEqual(new Set(['right', 'straight']));
    expect(left.find((c) => c.turn === 'left')!.id).toBe('W|f|0>N|b|0');
    expect(right.find((c) => c.turn === 'right')!.id).toBe('W|f|1>S|b|1');
    // Straight keeps the lane plus a lane-shift connector into the neighbour.
    expect(left.filter((c) => c.turn === 'straight').map((c) => c.id).sort()).toEqual(['W|f|0>E|b|0', 'W|f|0>E|b|1']);
    expect(g.connectors.some((c) => c.turn === 'uturn' && c.nodeId === 'c')).toBe(false);
    for (const l of g.lanes) if (l.toNode === 'c') expect(l.out.length).toBeGreaterThan(0);
  });

  it('adds U-turns only at dead ends', () => {
    const g = compileNetwork(crossDoc(120, 'road-2'));
    const u = g.connectors.filter((c) => c.turn === 'uturn');
    expect(u.map((c) => c.nodeId).sort()).toEqual(['e', 'n', 's', 'w']);
    expect(conn(g, 'W|b|0', 'W|f|0')?.turn).toBe('uturn');
  });

  it('marks crossing and merging connectors as conflicts, not parallel ones', () => {
    const g = compileNetwork(crossDoc(120, 'road-2'));
    const conflicts = (a: string, b: string): boolean => {
      const ca = g.connectors.find((c) => c.id === a)!;
      const cb = g.connectors.find((c) => c.id === b)!;
      expect(ca.conflicts.includes(cb.index)).toBe(cb.conflicts.includes(ca.index));
      return ca.conflicts.includes(cb.index);
    };
    expect(conflicts('W|f|0>N|b|0', 'E|f|0>W|b|0')).toBe(true); // left vs opposing straight
    expect(conflicts('W|f|0>E|b|0', 'E|f|0>W|b|0')).toBe(false); // opposing straights
    expect(conflicts('W|f|0>S|b|0', 'E|f|0>N|b|0')).toBe(false); // opposite right turns
    expect(conflicts('W|f|0>S|b|0', 'N|f|0>S|b|0')).toBe(true); // merge into the same lane
    expect(conflicts('W|f|0>E|b|0', 'N|f|0>S|b|0')).toBe(true); // crossing straights
  });

  it('uses a 1 m setback through a straight degree-2 node and builds junction polygons', () => {
    const doc = createEmptyDoc();
    apply(doc, [
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
      { type: 'node.add', node: { id: 'c', pos: { x: 200, z: 5 } } },
      { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      { type: 'segment.add', segment: { id: 'bc', a: 'b', b: 'c', roadTypeId: 'road-2' } },
    ]);
    const g = compileNetwork(doc);
    expect(g.segments.get('ab')!.setbackB).toBe(1);
    expect(g.segments.get('bc')!.setbackA).toBe(1);
    expect(g.nodes.get('b')!.signalized).toBe(false);
    expect(g.nodes.get('a')!.polygon).toEqual([]);
    const cross = compileNetwork(crossDoc(120));
    expect(cross.nodes.get('c')!.signalized).toBe(true);
    expect(cross.nodes.get('c')!.polygon.length).toBe(8);
  });

  it('is deterministic', () => {
    const doc = crossDoc(120, 'road-4');
    expect(JSON.stringify(compileNetwork(doc).connectors)).toBe(JSON.stringify(compileNetwork(doc).connectors));
  });

  it('reuses per-node conflict tables without changing the result (incremental compile)', () => {
    const doc = gridDoc(5, 80, 'road-4');
    const cache = newCompileCache();
    const same = (): void => {
      const a = compileNetwork(doc, cache);
      const b = compileNetwork(doc);
      expect(a.connectors.map((c) => [c.id, c.conflicts])).toEqual(b.connectors.map((c) => [c.id, c.conflicts]));
      expect(a).toEqual(b);
    };
    same();
    same();
    const edits = [
      { type: 'node.move', id: 'n_2_2', pos: { x: 6, z: -3 } },
      { type: 'segment.setType', id: 'h_1_1', roadTypeId: 'road-2' },
      { type: 'feature.upsert', feature: { id: 'f', segmentId: 'v_3_1', kind: 'crosswalk', t: 0.5 } },
      { type: 'segment.split', id: 'h_0_3', t: 0.4, nodeId: 'm', segmentIds: ['h_0_3a', 'h_0_3b'] },
      { type: 'segment.remove', id: 'v_2_2' },
      { type: 'intersection.set', control: { nodeId: 'n_1_3', kind: 'uncontrolled', crosswalkLegs: [], yellow: 3, allRed: 1, offset: 0 } },
    ] as const;
    for (const e of edits) {
      apply(doc, [e as never]);
      same();
    }
  });
});
