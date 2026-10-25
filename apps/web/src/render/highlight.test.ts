import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, type Command } from '@smartcity/shared';
import { addHighlight, BEACON_MS, highlightFromBatch, initialHighlights, nextTransition } from '../app/highlights';
import { HighlightLayer } from './highlight';

const doc = createEmptyDoc();
const place: Command = { type: 'building.place', building: { id: 'b1', typeId: 'house', pos: { x: 0, z: 0 }, rotation: 0 } };
const one = (now: number) => addHighlight(initialHighlights(), highlightFromBatch(place, doc.buildingTypes, now, 0)!);

/** Counts how often the layer scans the highlight list. */
function spied(s: ReturnType<typeof one>) {
  const items = [...s.items];
  const filter = vi.fn(items.filter.bind(items));
  items.filter = filter as unknown as typeof items.filter;
  return { state: { ...s, items }, filter };
}

describe('HighlightLayer idle cost', () => {
  it('does not scan or allocate over 1000 updates with no highlights', () => {
    const layer = new HighlightLayer();
    const { state, filter } = spied({ items: [], nextId: 1 });
    for (let i = 0; i < 1000; i++) layer.update(1000 + i, doc, state, 1);
    expect(filter.mock.calls.length).toBeLessThanOrEqual(1);
    expect(layer.group.children).toHaveLength(0);
  });

  it('after everything expired, further frames do not scan again and nothing stays drawn', () => {
    const layer = new HighlightLayer();
    const { state, filter } = spied(one(0));
    layer.update(100, { ...doc, buildings: { b1: { id: 'b1', typeId: 'house', pos: { x: 0, z: 0 }, rotation: 0 } } }, state, 1);
    expect(layer.stats().beacons).toBe(1);
    const scans = () => filter.mock.calls.length;
    for (let i = 0; i < 1000; i++) layer.update(BEACON_MS + 1 + i, doc, state, 1);
    expect(scans()).toBeLessThanOrEqual(3);
    expect(layer.stats()).toEqual({ beacons: 0, pulsingBuildings: 0, lots: 0, roads: 0 });
    expect(layer.group.children).toHaveLength(0);
  });

  it('while active it rescans only when the phase changes, not every frame', () => {
    const layer = new HighlightLayer();
    const { state, filter } = spied(one(0));
    for (let i = 0; i < 500; i++) layer.update(100 + i, doc, state, 1);
    expect(filter.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('nextTransition reports the pulse end, then the beacon end, then never', () => {
    const s = one(0);
    expect(nextTransition(s, 10)).toBe(6000);
    expect(nextTransition(s, 7000)).toBe(BEACON_MS);
    expect(nextTransition(s, BEACON_MS)).toBe(Infinity);
    expect(nextTransition(initialHighlights(), 0)).toBe(Infinity);
  });
});
