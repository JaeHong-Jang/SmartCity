import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, IdGen } from '@smartcity/shared';
import { road } from '../test/fixtures';
import { PickIndex } from './picking';
import { stopFromClick } from './busLineTool';

describe('stopFromClick', () => {
  // Road along +x from (-100,0) to (100,0). Right of travel (+x) is +z.
  const doc = createEmptyDoc();
  road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('t'));
  const idx = new PickIndex(doc);

  it('clicking the right side of a→b gives a forward stop', () => {
    const hit = idx.nearestSegment({ x: 20, z: 3 })!;
    const st = stopFromClick(doc, hit, { x: 20, z: 3 });
    const seg = doc.segments[st.segmentId]!;
    const forwardIsPlusX = doc.nodes[seg.b]!.pos.x > doc.nodes[seg.a]!.pos.x;
    expect(st.dir).toBe(forwardIsPlusX ? 'forward' : 'backward');
    expect(st.t).toBeGreaterThan(0);
    expect(st.t).toBeLessThan(1);
    expect(applyCommand(doc, { type: 'busStop.add', stop: { id: 'p1', segmentId: st.segmentId, t: st.t, dir: st.dir } }).ok).toBe(true);
  });

  it('the opposite side gives the opposite direction', () => {
    const a = stopFromClick(doc, idx.nearestSegment({ x: 20, z: 3 })!, { x: 20, z: 3 });
    const b = stopFromClick(doc, idx.nearestSegment({ x: 20, z: -3 })!, { x: 20, z: -3 });
    expect(a.dir).not.toBe(b.dir);
  });

  it('one-way roads always get forward stops', () => {
    const d = createEmptyDoc();
    road(d, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('o'), 'oneway-2');
    const i = new PickIndex(d);
    expect(stopFromClick(d, i.nearestSegment({ x: 0, z: -3 })!, { x: 0, z: -3 }).dir).toBe('forward');
    expect(stopFromClick(d, i.nearestSegment({ x: 0, z: 3 })!, { x: 0, z: 3 }).dir).toBe('forward');
  });
});
