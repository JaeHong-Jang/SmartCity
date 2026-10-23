import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, lotsAlongSegment, type Parcel } from '@smartcity/shared';
import { crossDoc, road } from '../test/fixtures';
import { IdGen } from '@smartcity/shared';
import { dragRange, eraseBatches, lotBatches, lotSlots, nearestRoadSide } from './zoningTool';

function straight() {
  const doc = createEmptyDoc();
  road(doc, { x: -200, z: 0 }, { x: 200, z: 0 }, new IdGen('t'));
  return doc;
}

describe('nearestRoadSide', () => {
  it('finds the road and the side the pointer is on', () => {
    const doc = straight();
    const seg = Object.keys(doc.segments)[0]!;
    const a = doc.nodes[doc.segments[seg]!.a]!.pos;
    const b = doc.nodes[doc.segments[seg]!.b]!.pos;
    // The a → b direction decides what "right" means; test relative to it.
    const forward = b.x > a.x ? 1 : -1;
    const south = nearestRoadSide(doc, { x: 0, z: 12 })!;
    const north = nearestRoadSide(doc, { x: 0, z: -12 })!;
    expect(south.segmentId).toBe(seg);
    expect(south.side).not.toBe(north.side);
    // Looking along +x with z down, the right-hand side is +z.
    expect(south.side).toBe(forward === 1 ? 'right' : 'left');
    expect(south.t).toBeCloseTo(0.5, 1);
  });

  it('ignores points far from any road', () => {
    expect(nearestRoadSide(straight(), { x: 0, z: 200 })).toBeNull();
  });
});

describe('dragRange', () => {
  it('keeps the segment and side of the press and projects the pointer on the road', () => {
    const doc = straight();
    const start = nearestRoadSide(doc, { x: -100, z: 12 })!;
    const r = dragRange(doc, start, { x: 100, z: -30 });
    expect(r.segmentId).toBe(start.segmentId);
    expect(r.side).toBe(start.side);
    expect(r.t0).toBeCloseTo(0.25, 1);
    expect(Math.abs(r.t1 - r.t0)).toBeCloseTo(0.5, 1);
  });

  it('yields lots from the shared planner for the dragged range', () => {
    const doc = straight();
    const start = nearestRoadSide(doc, { x: -100, z: 12 })!;
    const r = dragRange(doc, start, { x: 100, z: 12 });
    const lots = lotsAlongSegment(doc, r.segmentId, r.side, r.t0, r.t1, 2, 'residential', 'z');
    expect(lots.length).toBeGreaterThan(5);
    expect(lots.every((l) => l.auto && l.frontage?.segmentId === r.segmentId)).toBe(true);
  });
});

describe('batching', () => {
  const lot = (i: number): Parcel => ({ id: `z-${i}`, polygon: [], zone: 'residential', regulation: {} as Parcel['regulation'], auto: true });
  it('splits lots into batches of at most the limit', () => {
    const cmds = lotBatches(Array.from({ length: 2500 }, (_, i) => lot(i)), 1000);
    expect(cmds).toHaveLength(3);
    expect(cmds.map((c) => (c.type === 'batch' ? c.commands.length : 0))).toEqual([1000, 1000, 500]);
    expect(lotBatches([])).toEqual([]);
  });

  it('counts lot slots including omitted positions', () => {
    expect(lotSlots([lot(0), lot(2), lot(5)])).toBe(6);
    expect(lotSlots([])).toBe(0);
  });
});

describe('eraseBatches', () => {
  it('removes empty automatic lots only and skips lots with buildings', () => {
    const { doc } = crossDoc();
    const start = nearestRoadSide(doc, { x: -60, z: 12 })!;
    const lots = lotsAlongSegment(doc, start.segmentId, start.side, 0, 1, 2, 'residential', 'z');
    expect(lots.length).toBeGreaterThan(2);
    for (const l of lots) expect(applyCommand(doc, { type: 'parcel.upsert', parcel: l }).ok).toBe(true);
    const manual: Parcel = { ...lots[0]!, id: 'manual', auto: undefined, polygon: lots[0]!.polygon.map((p) => ({ x: p.x, z: p.z + 100 })) };
    doc.parcels['manual'] = manual;
    // A building inside the first lot.
    const c = lots[0]!.polygon.reduce((a, v) => ({ x: a.x + v.x / 4, z: a.z + v.z / 4 }), { x: 0, z: 0 });
    doc.buildings['b'] = { id: 'b', typeId: 'grow-res-1', pos: c, rotation: 0, auto: true };
    const r = eraseBatches(doc, [...lots.map((l) => l.id), 'manual']);
    expect(r.skipped).toBe(1);
    expect(r.removed).toBe(lots.length - 1);
    expect(r.commands).toHaveLength(1);
  });
});
