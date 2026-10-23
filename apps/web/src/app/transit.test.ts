import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '@smartcity/shared';
import { lineLoad, lineWaiting, sameTransit, summarizeTransit } from './transit';

function setup() {
  const doc = createEmptyDoc();
  const bus = doc.vehicleTypes['city-bus']!;
  doc.vehicleTypes['city-bus'] = { ...bus, capacity: 50 };
  doc.busLines['L1'] = { id: 'L1', name: '1', color: '#f00', stopIds: ['s1', 's2'], vehicleTypeId: 'city-bus', buses: 2 };
  const car = Object.keys(doc.vehicleTypes).find((k) => doc.vehicleTypes[k]!.kind === 'car')!;
  const vehicleTypeIds = [car, 'city-bus'];
  // stride 6: x, z, heading, typeIndex, speed, id
  const vehicles = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 0, 1, 0, 3]);
  const snap = { vehicles, vehicleCount: 3, vehicleTypeIds, busLoad: new Uint16Array([0, 12, 30]), stopWaiting: new Uint16Array([4, 0, 7]), busStopIds: ['s1', 's2', 's3'] };
  return { doc, snap };
}

describe('transit summary', () => {
  it('sums passengers and capacity over buses only, and waiting per stop', () => {
    const { doc, snap } = setup();
    const t = summarizeTransit(snap, doc);
    expect(t).toMatchObject({ buses: 2, aboard: 42, capacity: 100, waiting: { s1: 4, s3: 7 } });
    expect(t.waiting['s2']).toBeUndefined();
    expect(lineWaiting(t, doc.busLines['L1']!)).toBe(4);
    expect(lineLoad(t, doc, doc.busLines['L1']!)).toEqual({ buses: 2, aboard: 42, capacity: 100 });
  });

  it('cannot attribute load when two lines share a vehicle type', () => {
    const { doc, snap } = setup();
    doc.busLines['L2'] = { ...doc.busLines['L1']!, id: 'L2' };
    expect(lineLoad(summarizeTransit(snap, doc), doc, doc.busLines['L1']!)).toBeNull();
  });

  it('sameTransit detects changes', () => {
    const { doc, snap } = setup();
    const a = summarizeTransit(snap, doc);
    expect(sameTransit(a, summarizeTransit(snap, doc))).toBe(true);
    snap.stopWaiting[1] = 3;
    expect(sameTransit(a, summarizeTransit(snap, doc))).toBe(false);
  });
});
