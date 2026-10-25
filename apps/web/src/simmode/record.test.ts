import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '@smartcity/shared';
import { DEFAULT_POLICY, ENGINE_VERSION } from '@smartcity/sim';
import { accidentParams, closureParams, eventEndTick, ScenarioRecorder, surgeParams } from './record';

function recorder(runId?: string) {
  return new ScenarioRecorder({ baseSeq: 7, doc: createEmptyDoc('t', 5), seed: 5, warmupTicks: 1200, policy: { ...DEFAULT_POLICY } }, runId);
}

describe('ScenarioInput building', () => {
  it('gives unique eventIds and strictly increasing orders, even for the same tick', () => {
    const r = recorder();
    const inputs = [
      r.make('closure.start', 1300, { segmentId: 's1' }, closureParams(30)),
      r.make('accident.start', 1300, { segmentId: 's1', lane: 0, s: 10 }, accidentParams(20)),
      r.make('surge.start', 1300, { buildingId: 'b1' }, surgeParams({ people: 100, inflowMin: 20, stayMin: 40, outflowMin: 20 })),
    ];
    expect(new Set(inputs.map((i) => i.eventId)).size).toBe(3);
    expect(inputs.map((i) => i.order)).toEqual([1, 2, 3]);
    expect(inputs.every((i) => i.tick === 1300)).toBe(true);
  });
  it('ids differ between runs so restarts never collide', () => {
    expect(recorder('a').make('closure.start', 1, {}).eventId).not.toBe(recorder('b').make('closure.start', 1, {}).eventId);
  });
  it('converts game minutes to ticks in params', () => {
    expect(closureParams(30)).toEqual({ durationTicks: 3600 });
    expect(surgeParams({ people: 100, inflowMin: 20, stayMin: 40, outflowMin: 10 })).toEqual({ extraTrips: 100, inflowTicks: 2400, stayTicks: 4800, outflowTicks: 1200 });
  });
  it('computes when an event stops acting', () => {
    expect(eventEndTick('closure.start', 1000, closureParams(10))).toBe(2200);
    expect(eventEndTick('accident.start', 1000, {})).toBeNull();
    expect(eventEndTick('surge.start', 0, surgeParams({ people: 1, inflowMin: 1, stayMin: 2, outflowMin: 3 }))).toBe(120 + 240 + 360);
  });
});

describe('ScenarioRecord accumulation', () => {
  it('holds the base, sorted accepted inputs and the policy; rejected inputs vanish', () => {
    const r = recorder();
    const late = r.make('closure.start', 2000, { segmentId: 'a' }, closureParams(5));
    const early = r.make('accident.start', 1500, { segmentId: 'a', lane: 0 }, accidentParams(5));
    const bad = r.make('surge.start', 1600, { buildingId: 'x' }, surgeParams({ people: 1, inflowMin: 1, stayMin: 1, outflowMin: 1 }));
    r.add(late);
    r.add(early);
    r.add(bad);
    r.reject(bad.eventId);
    const rec = r.toRecord();
    expect(rec.engineVersion).toBe(ENGINE_VERSION);
    expect(rec.baseSeq).toBe(7);
    expect(rec.seed).toBe(5);
    expect(rec.tickRate).toBe(20);
    expect(rec.warmupTicks).toBe(1200);
    expect(rec.inputs.map((i) => i.eventId)).toEqual([early.eventId, late.eventId]);
    expect(rec.policy).toEqual(DEFAULT_POLICY); // the copy's initial policy; changes ride along as policy.set inputs
    expect(rec.activatedAtTick).toBe(0);
    expect(r.size).toBe(2);
  });
  it('rejects a duplicate eventId and snapshots the doc (later edits do not leak in)', () => {
    const r = recorder();
    const i = r.make('closure.start', 10, { segmentId: 'a' });
    r.add(i);
    expect(() => r.add(i)).toThrow();
    const rec = r.toRecord();
    rec.doc.meta.name = 'changed';
    expect(r.toRecord().doc.meta.name).toBe('t');
  });
});
