import { describe, expect, it } from 'vitest';
import { snapshotTransferables } from './protocol';

describe('snapshotTransferables', () => {
  it('lists every distinct buffer, including pedestrians, crossings and occupancy', () => {
    const b = {
      vehicles: new Float32Array(6),
      signals: new Float32Array(4),
      laneFlow: new Float32Array(2),
      pedestrians: new Float32Array(16),
      pedestrianIds: new Uint32Array(2),
      crossings: new Float32Array(3),
      occupancy: new Float32Array(5),
    };
    const list = snapshotTransferables(b);
    expect(list).toHaveLength(7);
    expect(new Set(list).size).toBe(7);
  });

  it('ignores missing and empty arrays (older simulation builds)', () => {
    expect(snapshotTransferables({ vehicles: new Float32Array(6), pedestrians: new Float32Array(0) })).toHaveLength(1);
    expect(snapshotTransferables({})).toHaveLength(0);
  });
});
