import { describe, expect, it } from 'vitest';
import { snapshotTransferables } from './protocol';

describe('snapshotTransferables', () => {
  it('lists every distinct buffer, including pedestrians, crossings, occupancy and bus buffers', () => {
    const b = {
      vehicles: new Float32Array(6),
      signals: new Float32Array(4),
      laneFlow: new Float32Array(2),
      pedestrians: new Float32Array(16),
      pedestrianIds: new Uint32Array(2),
      crossings: new Float32Array(3),
      occupancy: new Float32Array(5),
      busLoad: new Uint16Array(3),
      stopWaiting: new Uint16Array(2),
    };
    const list = snapshotTransferables(b);
    expect(list).toHaveLength(9);
    expect(new Set(list).size).toBe(9);
  });

  it('ignores missing and empty arrays (older simulation builds)', () => {
    expect(snapshotTransferables({ vehicles: new Float32Array(6), pedestrians: new Float32Array(0) })).toHaveLength(1);
    expect(snapshotTransferables({})).toHaveLength(0);
  });
});
