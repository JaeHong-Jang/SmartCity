import { describe, expect, it } from 'vitest';
import { applyCommand, buildingMetrics, createEmptyDoc, LIMITS, partsToVoxels, voxelKey, voxelsToParts, type BuildingType, type VoxelModel, type VoxelStyle } from '../index.js';

const WALL: VoxelStyle = { color: '#c8b8a0', roofColor: '#555555', roof: 'gable' };
const GLASS: VoxelStyle = { color: '#88aacc', roofColor: '#333333', roof: 'flat', use: 'office', facade: { style: 'curtain', windowRatio: 0.85, ground: 'lobby' } };

function model(fill: (set: (i: number, j: number, k: number, s?: number) => void) => void): VoxelModel {
  const m: VoxelModel = { cell: 2, floorHeight: 3.2, cells: new Map(), styles: [WALL, GLASS] };
  fill((i, j, k, s = 0) => m.cells.set(voxelKey(i, j, k), s));
  return m;
}

function accepted(parts: BuildingType['parts']): void {
  const doc = createEmptyDoc();
  const res = applyCommand(doc, { type: 'buildingType.upsert', buildingType: { id: 'v', name: 'v', zone: 'residential', parts } });
  expect(res).toEqual({ ok: true });
}

const box = (set: (i: number, j: number, k: number, s?: number) => void, i0: number, j0: number, i1: number, j1: number, k0: number, k1: number, s = 0) => {
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) set(i, j, k, s);
};

describe('voxelsToParts', () => {
  it('merges a box over several floors into one rectangular volume', () => {
    const { parts } = voxelsToParts(model((set) => box(set, 0, 0, 2, 1, 0, 2)));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ offset: { x: 3, z: 2 }, width: 6, depth: 4, floors: 3, baseHeight: 0, roof: 'gable' });
    expect(parts[0]!.footprint).toBeUndefined();
    accepted(parts);
  });

  it('keeps an L shape as one polygon volume with a flat roof', () => {
    const { parts } = voxelsToParts(
      model((set) => {
        box(set, 0, 0, 3, 0, 0, 0);
        box(set, 0, 1, 0, 3, 0, 0);
      }),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]!.footprint).toHaveLength(6);
    expect(parts[0]!.roof).toBe('flat');
    accepted(parts);
  });

  it('splits a courtyard ring into hole-free volumes with the same floor area', () => {
    const m = model((set) => {
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (i === 0 || j === 0 || i === 4 || j === 4) set(i, j, 0);
    });
    const { parts } = voxelsToParts(m);
    expect(parts.length).toBeGreaterThan(1);
    expect(buildingMetrics({ id: 'x', name: 'x', zone: 'residential', parts }).grossFloorArea).toBeCloseTo(16 * 4);
    accepted(parts);
  });

  it('stacks a tower on a podium: covered podium stays flat, the tower keeps its pitched roof', () => {
    const { parts } = voxelsToParts(
      model((set) => {
        box(set, 0, 0, 5, 5, 0, 1);
        box(set, 2, 2, 3, 3, 2, 9);
      }),
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ floors: 2, baseHeight: 0, roof: 'flat' });
    expect(parts[1]).toMatchObject({ floors: 8, roof: 'gable', width: 4 });
    expect(parts[1]!.baseHeight).toBeCloseTo(6.4);
    accepted(parts);
  });

  it('separates styles painted side by side on the same floor', () => {
    const { parts } = voxelsToParts(
      model((set) => {
        box(set, 0, 0, 1, 1, 0, 0, 0);
        box(set, 2, 0, 3, 1, 0, 0, 1);
      }),
    );
    expect(parts.map((p) => p.color).sort()).toEqual(['#88aacc', '#c8b8a0']);
    expect(parts.find((p) => p.use === 'office')?.facade?.style).toBe('curtain');
    accepted(parts);
  });

  it('bisects outlines with more corners than allowed', () => {
    // A comb: 12 teeth → far more than 32 corners in one outline.
    const { parts } = voxelsToParts(
      model((set) => {
        box(set, 0, 0, 23, 0, 0, 0);
        for (let t = 0; t < 12; t++) set(t * 2, 1, 0);
      }),
    );
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect((p.footprint ?? [1, 2, 3, 4]).length).toBeLessThanOrEqual(LIMITS.footprintVertices);
    accepted(parts);
  });

  it('is deterministic regardless of insertion order', () => {
    const fill = (set: (i: number, j: number, k: number) => void) => {
      box(set, 0, 0, 4, 4, 0, 1);
      box(set, 1, 1, 2, 3, 2, 4);
    };
    const a = model(fill);
    const b: VoxelModel = { ...a, cells: new Map([...a.cells].reverse()) };
    expect(voxelsToParts(b)).toEqual(voxelsToParts(a));
  });
});

describe('partsToVoxels', () => {
  it('round-trips grid designs without loss', () => {
    const m = model((set) => {
      box(set, -3, -2, 2, 2, 0, 1);
      box(set, -1, -1, 1, 1, 2, 6, 1);
    });
    const { parts } = voxelsToParts(m);
    const back = partsToVoxels(parts, 2);
    expect(back.lossy).toBe(false);
    expect(new Set(back.model.cells.keys())).toEqual(new Set(m.cells.keys()));
  });

  it('flags a shifted shape whose area still matches the grid', () => {
    const back = partsToVoxels([{ offset: { x: 2.25, z: 2 }, width: 4, depth: 4, floors: 1, floorHeight: 3.2, baseHeight: 0, roof: 'flat', color: '#ffffff', roofColor: '#000000' }]);
    expect(back.lossy).toBe(true);
  });

  it('flags mixed floor heights', () => {
    const p = { offset: { x: 0, z: 0 }, width: 4, depth: 4, floors: 1, floorHeight: 3.2, baseHeight: 0, roof: 'flat' as const, color: '#ffffff', roofColor: '#000000' };
    expect(partsToVoxels([p, { ...p, offset: { x: 8, z: 0 }, floorHeight: 4 }]).lossy).toBe(true);
  });

  it('flags pitched roofs that would merge on the way back (Sol 2b #1)', () => {
    const p = { offset: { x: 1, z: 1 }, width: 2, depth: 2, floors: 1, floorHeight: 3.2, baseHeight: 0, roof: 'gable' as const, color: '#ffffff', roofColor: '#000000' };
    const parts = [p, { ...p, offset: { x: 3, z: 1 } }];
    accepted(parts);
    expect(partsToVoxels(parts).lossy).toBe(true);
    // A single pitched volume reopens unchanged.
    expect(partsToVoxels([p]).lossy).toBe(false);
  });

  it('refuses designs larger than the studio instead of exploding into cells (Sol 2b #4)', () => {
    const big = { offset: { x: 0, z: 0 }, width: 100, depth: 100, floors: 30, floorHeight: 3.2, baseHeight: 0, roof: 'flat' as const, color: '#ffffff', roofColor: '#000000' };
    const r = partsToVoxels([big]);
    expect(r.tooLarge).toBe(true);
    expect(r.model.cells.size).toBe(0);
    expect(partsToVoxels([{ ...big, width: 20, depth: 20, floors: 40 }]).tooLarge).toBe(true);
    expect(partsToVoxels([{ ...big, width: 20, depth: 20, floors: 5 }]).tooLarge).toBe(false);
    // Area says 3969 cells but the grid needs 4096 (Sol 2b-sim #6).
    expect(partsToVoxels([{ ...big, width: 63, depth: 63, floors: 4 }]).tooLarge).toBe(true);
  });

  it('flags designs that are off the grid', () => {
    const back = partsToVoxels([{ offset: { x: 0, z: 0 }, width: 11, depth: 9, floors: 2, floorHeight: 3.2, baseHeight: 0, roof: 'flat', color: '#ffffff', roofColor: '#000000' }]);
    expect(back.lossy).toBe(true);
    expect(back.model.cells.size).toBeGreaterThan(0);
  });
});
