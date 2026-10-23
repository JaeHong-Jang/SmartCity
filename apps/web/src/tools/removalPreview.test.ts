import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, DEFAULT_REGULATIONS, type CityDoc, type Command, type Parcel } from '@smartcity/shared';
import { removalLines, RemovalPreview, removedAutoByCommand } from './removalPreview';

const lot = (id: string, x: number, extra: Partial<Parcel> = {}): Parcel => ({
  id,
  polygon: [{ x, z: 20 }, { x: x + 16, z: 20 }, { x: x + 16, z: 36 }, { x, z: 36 }],
  zone: 'residential',
  regulation: { ...DEFAULT_REGULATIONS.residential },
  ...extra,
});

function city(): CityDoc {
  const doc = createEmptyDoc();
  doc.parcels['a1'] = lot('a1', 0, { auto: true });
  doc.parcels['a2'] = lot('a2', 40, { auto: true });
  doc.parcels['u1'] = lot('u1', 80);
  doc.buildings['ab'] = { id: 'ab', typeId: 'grow-res-1', pos: { x: 8, z: 28 }, rotation: 0, auto: true };
  doc.buildings['ub'] = { id: 'ub', typeId: 'grow-res-1', pos: { x: 88, z: 28 }, rotation: 0 };
  return doc;
}

describe('removedAutoByCommand (dry run on a clone)', () => {
  it('reports exactly the automatic parcels and buildings the command removes', () => {
    const doc = city();
    const cmd: Command = { type: 'batch', commands: [{ type: 'building.remove', id: 'ab' }, { type: 'building.remove', id: 'ub' }, { type: 'parcel.remove', id: 'a1' }, { type: 'parcel.remove', id: 'u1' }] };
    const r = removedAutoByCommand(doc, cmd);
    expect(r).toEqual({ parcels: ['a1'], buildings: ['ab'] });
  });

  it('does not touch the real doc', () => {
    const doc = city();
    removedAutoByCommand(doc, { type: 'parcel.remove', id: 'a1' });
    expect(Object.keys(doc.parcels).sort()).toEqual(['a1', 'a2', 'u1']);
    expect(doc.buildings['ab']).toBeDefined();
  });

  it('reports nothing for a rejected command or a city without automatic items', () => {
    expect(removedAutoByCommand(city(), { type: 'parcel.remove', id: 'nope' })).toEqual({ parcels: [], buildings: [] });
    const manual = createEmptyDoc();
    manual.parcels['u1'] = lot('u1', 80);
    expect(removedAutoByCommand(manual, { type: 'parcel.remove', id: 'u1' })).toEqual({ parcels: [], buildings: [] });
  });

  it('draws one red outline per removed parcel and building footprint', () => {
    const doc = city();
    const lines = removalLines(doc, { parcels: ['a1'], buildings: ['ab'] });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => l.color === '#ef4444')).toBe(true);
  });
});

describe('RemovalPreview throttle and cache', () => {
  const cmd = (id: string): Command => ({ type: 'parcel.remove', id });

  it('caches per command and version, and throttles changing commands', () => {
    vi.useFakeTimers();
    let t = 1000;
    const prev = new RemovalPreview(() => t);
    const doc = city();
    const stale = vi.fn();
    expect(prev.get(doc, 1, cmd('a1'), stale).parcels).toEqual(['a1']);
    // Same command: cached, no timer.
    expect(prev.get(doc, 1, cmd('a1'), stale).parcels).toEqual(['a1']);
    // A different command within the window keeps the old result and schedules a refresh.
    t += 10;
    expect(prev.get(doc, 1, cmd('a2'), stale).parcels).toEqual(['a1']);
    expect(stale).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(stale).toHaveBeenCalledTimes(1);
    t += 200;
    expect(prev.get(doc, 1, cmd('a2'), stale).parcels).toEqual(['a2']);
    // No pending edit clears it.
    expect(prev.get(doc, 1, null, stale)).toEqual({ parcels: [], buildings: [] });
    vi.useRealTimers();
  });
});
