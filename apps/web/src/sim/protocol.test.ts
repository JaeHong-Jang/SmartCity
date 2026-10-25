import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc } from '@smartcity/shared';
import { Simulation } from '@smartcity/sim';
import { handleScenarioMessage, inputShapeError, snapshotTransferables, toWorkerError } from './protocol';

describe('handleScenarioMessage (simulator mode)', () => {
  const lineSim = (): Simulation => {
    const doc = createEmptyDoc('line', 5);
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
        { type: 'node.add', node: { id: 'b', pos: { x: 300, z: 0 } } },
        { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      ],
    });
    expect(r.ok).toBe(true);
    return new Simulation(doc, { demand: false, citizens: false });
  };

  it('queues inputs (per-input results), sets the policy, returns KPIs; snapshots then carry the overlay', () => {
    const sim = lineSim();
    const reply = handleScenarioMessage(sim, {
      t: 'scenario',
      inputs: [
        { eventId: 'c', tick: 2, order: 0, kind: 'closure.start', target: { segmentId: 'ab', lane: 1 }, params: {} },
        { eventId: 'bad', tick: 2, order: 0, kind: 'closure.start', target: { segmentId: 'zz' }, params: {} },
      ],
    });
    expect(reply.t === 'scenario' && reply.results.map((r) => [r.eventId, r.ok])).toEqual([
      ['c', true],
      ['bad', false],
    ]);
    // The change comes back as the tick-aligned input it was recorded as (for ScenarioRecord.inputs).
    expect(handleScenarioMessage(sim, { t: 'policy', policy: { reroute: true, informedShare: 0.5 } })).toMatchObject({
      t: 'policy',
      result: { ok: true },
      input: { kind: 'policy.set', tick: 0, params: { reroute: 1, informedShare: 0.5 } },
    });
    expect(handleScenarioMessage(sim, { t: 'policy', policy: { reroute: true, informedShare: 2 } })).toMatchObject({ t: 'policy', result: { ok: false } });
    for (let t = 0; t < 3; t++) sim.step();
    const kpi = handleScenarioMessage(sim, { t: 'kpi' });
    expect(kpi.t === 'kpi' && kpi.kpi.activeEvents).toBe(1);
    const snap = sim.snapshot();
    expect(snap.scenario?.closedLanes).toEqual([sim.graph.segments.get('ab')!.lanes[1]]);
    // The overlay is plain data: it survives structured cloning (postMessage).
    expect(structuredClone(snap.scenario)).toEqual(snap.scenario);
  });
});

describe('inputShapeError / toWorkerError', () => {
  it('fire / medical inputs and the optional policy.set preempt flag', () => {
    expect(inputShapeError({ eventId: 'f', tick: 1, order: 0, kind: 'fire.start', target: { buildingId: 'b' }, params: { burnTicks: 100, suppressTicks: 10 } })).toBeNull();
    expect(inputShapeError({ eventId: 'm', tick: 1, order: 0, kind: 'medical.start', target: { buildingId: 'b' }, params: { treatTicks: 10 } })).toBeNull();
    expect(inputShapeError({ eventId: 'm', tick: 1, order: 0, kind: 'medical.start', target: { buildingId: 'b' }, params: { burnTicks: 10 } })).toMatch(/burnTicks/);
    expect(inputShapeError({ eventId: 'e', tick: 1, order: 0, kind: 'fire.end', target: { eventId: 'f' }, params: {} })).toBeNull();
    const policy = { eventId: 'p', tick: 0, order: 0, kind: 'policy.set', target: {}, params: { reroute: 1, informedShare: 0.5 } };
    expect(inputShapeError(policy)).toBeNull();
    expect(inputShapeError({ ...policy, params: { ...policy.params, preempt: 0 } })).toBeNull();
    expect(inputShapeError({ ...policy, params: { ...policy.params, preempt: 2 } })).toMatch(/preempt/);
  });

  it('checks target.eventId (ending one specific event) and top-level messages', () => {
    const base = { eventId: 'e', tick: 0, order: 0, kind: 'closure.end', params: {} };
    expect(inputShapeError({ ...base, target: { eventId: 'A' } })).toBeNull();
    expect(inputShapeError({ ...base, target: { eventId: 7 } })).toMatch(/eventId/);
    // Numbers that do not survive JSON (recheck 3): NaN / ±Infinity / null in every numeric field.
    const ok = { eventId: 'a', tick: 5, order: 0, kind: 'accident.start', target: { segmentId: 'ab', lane: 0, s: 10 }, params: { durationTicks: 50 } };
    expect(inputShapeError(ok)).toBeNull();
    for (const v of [NaN, Infinity, -Infinity, null]) {
      expect(inputShapeError({ ...ok, tick: v })).not.toBeNull();
      expect(inputShapeError({ ...ok, order: v })).not.toBeNull();
      expect(inputShapeError({ ...ok, target: { ...ok.target, lane: v } })).not.toBeNull();
      expect(inputShapeError({ ...ok, target: { ...ok.target, s: v } })).not.toBeNull();
      expect(inputShapeError({ ...ok, params: { durationTicks: v } })).not.toBeNull();
      expect(inputShapeError({ ...ok, kind: 'policy.set', target: {}, params: { reroute: 1, informedShare: v } })).not.toBeNull();
    }
    expect(inputShapeError({ ...ok, kind: 'policy.set', target: {}, params: { reroute: 1, informedShare: 0.3 } })).toBeNull();
    expect(inputShapeError({ ...ok, kind: 'policy.set', target: {}, params: { reroute: 2, informedShare: 0.3 } })).not.toBeNull();
    expect(inputShapeError({ ...ok, target: { ...ok.target, lane: 1.5 } })).not.toBeNull();
    expect(inputShapeError({ ...ok, order: 0.5 })).not.toBeNull();
    // Whitelisted keys only (recheck 4): BigInt, functions, nested objects and unknown keys never pass.
    expect(inputShapeError({ ...ok, extra: 1 })).toMatch(/입력 필드/);
    expect(inputShapeError({ ...ok, target: { ...ok.target, extra: BigInt(1) } })).toMatch(/target 필드/);
    expect(inputShapeError({ ...ok, target: { ...ok.target, segmentId: { a: 1 } } })).not.toBeNull();
    expect(inputShapeError({ ...ok, target: { ...ok.target, fn: () => 0 } })).not.toBeNull();
    expect(inputShapeError({ ...ok, params: { durationTicks: BigInt(5) } })).not.toBeNull();
    expect(inputShapeError({ ...ok, params: { durationTicks: 5, extraTrips: 3 } })).toMatch(/params 필드/);
    expect(toWorkerError(null)).not.toBeNull();
    expect(toWorkerError({ t: 'zzz' })).not.toBeNull();
    expect(toWorkerError({ t: 'setSpeed', speed: 4 })).toBeNull();
    expect(toWorkerError({ t: 'kpi' })).toBeNull();
  });
});

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
