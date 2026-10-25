import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, DEFAULT_REGULATIONS, type Command } from '@smartcity/shared';
import {
  activeHighlights,
  addHighlight,
  BEACON_MS,
  boxOf,
  confirmHighlight,
  fitDistance,
  hasBeacon,
  highlightFromBatch,
  initialHighlights,
  isPulsing,
  liveBox,
  liveTargets,
  MAX_HIGHLIGHTS,
  PULSE_MS,
  replayHighlight,
} from './highlights';

const doc0 = createEmptyDoc();
const house = doc0.buildingTypes['house']!;
const place = (id: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId: 'house', pos: { x, z }, rotation: 0 } });
const lot = (id: string): Command => ({
  type: 'parcel.upsert',
  parcel: { id, polygon: [{ x: 100, z: 100 }, { x: 116, z: 100 }, { x: 116, z: 116 }, { x: 100, z: 116 }], zone: 'commercial', regulation: { ...DEFAULT_REGULATIONS.commercial } },
});
const batch: Command = { type: 'batch', commands: [{ type: 'batch', commands: [place('b1', 0, 0)] }, place('b2', 40, 10), lot('p1')] };
const make = (now = 1000) => highlightFromBatch(batch, { house }, now, 1)!;

describe('highlights', () => {
  it('collects new buildings and lots (nested batches) with a bbox and a label', () => {
    const h = make();
    expect(h.buildingIds).toEqual(['b1', 'b2']);
    expect(h.parcelIds).toEqual(['p1']);
    expect(h.label).toBe('건물 2 · 필지 1');
    expect(h.bbox!.minX).toBeLessThan(0);
    expect(h.bbox!.maxX).toBeGreaterThanOrEqual(116);
    expect(h.bbox!.maxZ).toBeGreaterThanOrEqual(116);
  });

  it('returns null when nothing positional was created', () => {
    expect(highlightFromBatch({ type: 'batch', commands: [{ type: 'buildingType.upsert', buildingType: house }] }, {}, 0, 1)).toBeNull();
  });

  it('a building of an unknown design counts as a point', () => {
    const h = highlightFromBatch(place('x', 5, 7), {}, 0, 1)!;
    expect(h.bbox).toEqual({ minX: 5, minZ: 7, maxX: 5, maxZ: 7 });
    expect(boxOf([])).toBeNull();
  });

  it('adds, keeps the newest five and numbers them', () => {
    let s = initialHighlights();
    for (let i = 0; i < 7; i++) s = addHighlight(s, make(i));
    expect(s.items).toHaveLength(MAX_HIGHLIGHTS);
    expect(s.items.map((h) => h.id)).toEqual([3, 4, 5, 6, 7]);
  });

  it('pulse lasts 6 s, beacon 60 s, then it is inactive', () => {
    const h = make(1000);
    expect(isPulsing(h, 1000 + PULSE_MS - 1)).toBe(true);
    expect(isPulsing(h, 1000 + PULSE_MS)).toBe(false);
    expect(hasBeacon(h, 1000 + BEACON_MS - 1)).toBe(true);
    const s = addHighlight(initialHighlights(), h);
    expect(activeHighlights(s, 1000 + PULSE_MS + 1)).toHaveLength(1);
    expect(activeHighlights(s, 1000 + BEACON_MS)).toHaveLength(0);
  });

  it('confirm removes the beacon only; replay pulses again', () => {
    let s = addHighlight(initialHighlights(), make(0));
    const id = s.items[0]!.id;
    s = confirmHighlight(s, id);
    expect(hasBeacon(s.items[0]!, 10)).toBe(false);
    expect(isPulsing(s.items[0]!, 10)).toBe(true);
    expect(activeHighlights(s, PULSE_MS + 1)).toHaveLength(0);
    s = replayHighlight(s, id, 20_000);
    expect(activeHighlights(s, 21_000)).toHaveLength(1);
    expect(confirmHighlight(s, 999)).toBe(s);
  });

  it('skips ids that were deleted and boxes only what remains', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, { type: 'batch', commands: [place('b1', 0, 0), place('b2', 40, 10), lot('p1')] })).toEqual({ ok: true });
    const h = make();
    expect(liveTargets(h, doc)).toMatchObject({ buildingIds: ['b1', 'b2'], parcelIds: ['p1'] });
    expect(applyCommand(doc, { type: 'building.remove', id: 'b2' })).toEqual({ ok: true });
    expect(applyCommand(doc, { type: 'parcel.remove', id: 'p1' })).toEqual({ ok: true });
    expect(liveTargets(h, doc)).toMatchObject({ buildingIds: ['b1'], parcelIds: [] });
    expect(liveBox(h, doc)!.maxX).toBeLessThan(40);
    expect(applyCommand(doc, { type: 'building.remove', id: 'b1' })).toEqual({ ok: true });
    expect(liveBox(h, doc)).toBeNull();
  });

  it('frames small areas closely and large ones within limits', () => {
    expect(fitDistance({ minX: 0, minZ: 0, maxX: 10, maxZ: 10 })).toBe(70);
    expect(fitDistance({ minX: 0, minZ: 0, maxX: 100, maxZ: 20 })).toBe(180);
    expect(fitDistance({ minX: 0, minZ: 0, maxX: 5000, maxZ: 20 })).toBe(700);
  });
});

describe('highlight label', () => {
  it('uses the AI summary (clipped) and falls back to the counts', () => {
    const long = '가'.repeat(100);
    expect(highlightFromBatch(batch, { house }, 0, 1, '  카페를 지었어요 ')!.label).toBe('카페를 지었어요');
    expect(highlightFromBatch(batch, { house }, 0, 1, long)!.label).toHaveLength(60);
  });
});

describe('road highlights', () => {
  const nodeA: Command = { type: 'node.add', node: { id: 'na', pos: { x: 0, z: 0 } } };
  const nodeB: Command = { type: 'node.add', node: { id: 'nb', pos: { x: 0, z: 100 } } };
  const roadOnly: Command = {
    type: 'batch',
    commands: [
      nodeA,
      nodeB,
      { type: 'segment.add', segment: { id: 'sr', a: 'na', b: 'nb', roadTypeId: 'road-2' } },
      { type: 'segment.split', id: 'old', t: 0.5, nodeId: 'nsp', segmentIds: ['p1', 'p2'] },
    ],
  };

  it('a road-only batch gets a highlight with added and split segments, a bbox and a label', () => {
    const h = highlightFromBatch(roadOnly, {}, 0, 1)!;
    expect(h).not.toBeNull();
    expect(h.roadSegmentIds).toEqual(['sr']);
    expect(h.segmentIds).toEqual(['sr', 'p1', 'p2']);
    expect(h.label).toBe('도로 1');
    expect(h.bbox).toEqual({ minX: 0, minZ: 0, maxX: 0, maxZ: 100 });
  });

  it('uses doc node positions for roads joined to existing nodes, and counts roads in the label with buildings', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, { type: 'node.add', node: { id: 'ex', pos: { x: -50, z: 0 } } })).toEqual({ ok: true });
    const b: Command = { type: 'batch', commands: [nodeB, { type: 'segment.add', segment: { id: 'sr', a: 'ex', b: 'nb', roadTypeId: 'road-2' } }, place('b1', 10, 10)] };
    const h = highlightFromBatch(b, { house }, 0, 1, '', doc)!;
    expect(h.label).toBe('건물 1 · 도로 1');
    expect(h.bbox!.minX).toBeLessThanOrEqual(-50);
  });

  it('live targets and box skip segments that no longer exist', () => {
    const doc = createEmptyDoc();
    const cmds: Command[] = [nodeA, nodeB, { type: 'segment.add', segment: { id: 'sr', a: 'na', b: 'nb', roadTypeId: 'road-2' } }];
    expect(applyCommand(doc, { type: 'batch', commands: cmds })).toEqual({ ok: true });
    const h = highlightFromBatch({ type: 'batch', commands: cmds }, {}, 0, 1, '', doc)!;
    expect(liveTargets(h, doc).roadSegmentIds).toEqual(['sr']);
    expect(liveBox(h, doc)!.maxZ).toBeGreaterThanOrEqual(100);
    expect(applyCommand(doc, { type: 'segment.remove', id: 'sr' })).toEqual({ ok: true });
    expect(liveTargets(h, doc).segmentIds).toEqual([]);
    expect(liveBox(h, doc)).toBeNull();
  });

  it('a road highlight is active (pulse, beacon) like any other', () => {
    const h = highlightFromBatch(roadOnly, {}, 1000, 1)!;
    const s = addHighlight(initialHighlights(), h);
    expect(activeHighlights(s, 1000 + PULSE_MS - 1)).toHaveLength(1);
    expect(activeHighlights(s, 1000 + BEACON_MS)).toHaveLength(0);
  });
});
