// Fires and medical calls (ADR 0010 §3, §8): dispatch from the facility with the shortest route, work at the
// scene, return / transport, dispatch failures, validation, replay and ON/OFF fairness.

import { describe, expect, it } from 'vitest';
import { cloneJson, Rng, type CityDoc, type Command } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkIncidentInvariants, checkInvariants, cityDoc, crossDoc, gridDoc, internals } from '../testkit.js';
import { laneSAtT, originLane } from '../traffic/demand.js';
import { simulationFromRecord } from './record.js';
import { DEFAULT_POLICY, ENGINE_VERSION, type ScenarioInput, type ScenarioOutcome, type ScenarioRecord } from './types.js';

const rngState = (r: unknown): number => (r as { s: number }).s;
const place = (id: string, typeId: string, x: number, z: number): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });

function input(eventId: string, tick: number, kind: ScenarioInput['kind'], target: ScenarioInput['target'], params: Record<string, number> = {}, order = 0): ScenarioInput {
  return { eventId, tick, order, kind, target, params };
}

/** 4 × 4 grid (150 m): fire stations fsA (near the call) and fsZ (far), hospital h, call buildings. */
function town(extra: Command[] = []): CityDoc {
  return apply(gridDoc(4, 150, 'road-4', 4), [
    place('fsA', 'svc-fire-station', -150, -150),
    place('fsZ', 'svc-fire-station', 150, 150),
    place('h', 'svc-hospital', 150, -150),
    place('home', 'house', -150, 20),
    place('flat', 'house', 0, 170),
    ...extra,
  ]);
}

/** One step, then the no-orphan incident invariant (throws on a violation). */
function step(sim: Simulation): void {
  sim.step();
  const p = checkIncidentInvariants(sim);
  if (p.length > 0) throw new Error(`tick ${internals(sim).tick - 1}: ${p.join('; ')}`);
}

function run(sim: Simulation, ticks: number, each?: (t: number) => void): ScenarioOutcome[] {
  const out: ScenarioOutcome[] = [];
  for (let t = 0; t < ticks; t++) {
    step(sim);
    out.push(...sim.drainScenarioOutcomes());
    each?.(t);
  }
  return out;
}

const kinds = (out: ScenarioOutcome[], eventId: string): string[] => out.filter((o) => o.eventId === eventId).map((o) => o.kind);
const hash = (sim: Simulation): string => {
  const s = sim.snapshot();
  return Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.stats) + JSON.stringify(s.scenario);
};

describe('fire', () => {
  it('the closest station (route time) sends a truck; arrival starts suppression; extinguished, then the truck drives home', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false });
    const w = internals(sim);
    expect(sim.scenarioInput(input('f', 100, 'fire.start', { buildingId: 'home' }, { burnTicks: 20000, suppressTicks: 300 })).ok).toBe(true);
    let truck = -1;
    let parked = 0;
    const docBefore = JSON.stringify(sim.doc);
    const out = run(sim, 6000, () => {
      const m = w.sc!.missions[0];
      if (m && m.v) truck = m.v.id;
      if (m && m.stage === 'working' && m.v === null) parked++;
    });
    expect(kinds(out, 'f')).toEqual(['fire.start', 'dispatch.start', 'dispatch.arrive', 'fire.extinguished', 'dispatch.return']);
    expect(out.find((o) => o.kind === 'dispatch.start')!.reason).toMatch(/from fsA$/);
    // Arrival at the end of tick T; 300 ticks of suppression; extinguished at the start of tick T + 301.
    const at = (k: string): number => out.find((o) => o.eventId === 'f' && o.kind === k)!.tick;
    expect(at('fire.extinguished') - at('dispatch.arrive')).toBe(301);
    expect(parked).toBe(301);
    const kpi = sim.kpi();
    expect(kpi).toMatchObject({ responses: 1, extinguished: 1, damaged: 0, dispatchFailed: 0, activeEvents: 0 });
    expect(kpi.avgResponseTime).toBeGreaterThan(0);
    expect(kpi.maxResponseTime).toBe(kpi.avgResponseTime);
    // The truck is no trip: never in the trip KPIs, and it is gone again.
    expect(truck).toBeGreaterThan(0);
    expect(w.vehicles.some((v) => v.id === truck)).toBe(false);
    expect(JSON.stringify(sim.doc)).toBe(docBefore);
  });

  it('a fire that reaches 100 % first damages the building (scenario state only); the truck turns back; a new fire there is a no-op', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false });
    expect(sim.scenarioInput(input('f', 10, 'fire.start', { buildingId: 'flat' }, { burnTicks: 200 })).ok).toBe(true);
    expect(sim.scenarioInput(input('g', 400, 'fire.start', { buildingId: 'flat' })).ok).toBe(true);
    let progressSeen = 0;
    const out = run(sim, 3000, (t) => {
      if (t === 110) progressSeen = sim.snapshot().scenario!.incidents[0]!.progress;
    });
    // Snapshot after the step of tick 110 (now tick 111): 101 of 200 ticks burnt.
    expect(progressSeen).toBeCloseTo(50.5, 6);
    expect(kinds(out, 'f')).toEqual(['fire.start', 'dispatch.start', 'fire.damaged', 'dispatch.return']);
    expect(out.find((o) => o.eventId === 'g')).toMatchObject({ applied: false, reason: 'building damaged' });
    const s = sim.snapshot().scenario!;
    expect(s.damagedBuildings).toEqual(['flat']);
    expect(s.kpi).toMatchObject({ damaged: 1, extinguished: 0, responses: 0 });
    expect(sim.doc.buildings['flat']).toBeDefined();
  });

  it('fire.end by eventId or building ends the fire (truck recalled); ends that find nothing are logged no-ops', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false });
    expect(sim.scenarioInput(input('f', 10, 'fire.start', { buildingId: 'flat' })).ok).toBe(true);
    expect(sim.scenarioInput(input('f2', 10, 'fire.start', { buildingId: 'flat' }, {}, 1)).ok).toBe(true);
    expect(sim.scenarioInput(input('e0', 5, 'fire.end', { eventId: 'f' })).ok).toBe(true);
    expect(sim.scenarioInput(input('e1', 60, 'fire.end', { eventId: 'f' })).ok).toBe(true);
    expect(sim.scenarioInput(input('e2', 70, 'fire.end', { buildingId: 'flat' })).ok).toBe(true);
    expect(sim.scenarioInput(input('e3', 80, 'medical.end', { eventId: 'f' })).ok).toBe(true);
    const out = run(sim, 2500);
    const log = out.filter((o) => o.eventId.startsWith('e') || o.eventId.startsWith('f')).map((o) => `${o.eventId}:${o.kind}:${o.applied}`);
    // f2: one fire per building at a time. e1 ends f (logged as the fire's end, then the input); the truck turns back.
    expect(log).toEqual([
      'e0:fire.end:false',
      'f:fire.start:true',
      'f2:fire.start:false',
      'f:dispatch.start:true',
      'f:fire.end:true',
      'e1:fire.end:true',
      'e2:fire.end:false',
      'e3:medical.end:false',
      'f:dispatch.return:true',
    ]);
    expect(sim.kpi()).toMatchObject({ extinguished: 0, damaged: 0, responses: 0, activeEvents: 0 });
  });
});

describe('medical', () => {
  it('ambulance arrives, treats, carries the patient to its hospital: medical.complete; not a trip in the KPIs', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false, demand: false });
    const w = internals(sim);
    expect(sim.scenarioInput(input('m', 20, 'medical.start', { buildingId: 'home' }, { treatTicks: 200 })).ok).toBe(true);
    const stages: string[] = [];
    const out = run(sim, 6000, () => {
      const d = sim.snapshot().scenario!.dispatches[0];
      const st = d ? `${d.stage}${d.vehicleId === null ? '-' : '+'}` : 'none';
      if (stages[stages.length - 1] !== st) stages.push(st);
      if (w.vehicles.length > 0) expect(sim.kpi().inProgress).toBe(0);
    });
    expect(kinds(out, 'm')).toEqual(['medical.start', 'dispatch.start', 'dispatch.arrive', 'medical.complete']);
    expect(out.find((o) => o.kind === 'dispatch.start')!.reason).toMatch(/from h$/);
    expect(stages).toEqual(['none', 'enroute+', 'working-', 'transport+', 'none']);
    expect(sim.kpi()).toMatchObject({ medicalCompleted: 1, responses: 1, completed: 0, inProgress: 0, activeEvents: 0 });
  });
});

describe('edits remove the incident building or the facility (review #2)', () => {
  it("repro B: the burning building is deleted → the fire ends (target gone), the truck is cancelled and drives home; no arrival or damage counted", () => {
    const doc = apply(crossDoc(260), [place('fs', 'svc-fire-station', -40, -200), place('home', 'house', -20, 180)]);
    doc.meta.trafficDensity = 0;
    const sim = new Simulation(doc, { scenario: true, citizens: false, demand: false });
    sim.setPolicy({ reroute: true, informedShare: 0.7 });
    expect(sim.scenarioInput(input('f', 0, 'fire.start', { buildingId: 'home' }, { burnTicks: 1000 })).ok).toBe(true);
    const out = run(sim, 1);
    expect(sim.applyCommand({ type: 'building.remove', id: 'home' })).toEqual({ ok: true });
    out.push(...run(sim, 1100));
    // Sol's window (to tick 1101): cancelled, no arrival and no damage although the fire would have reached 100 % at 1000.
    expect(out.some((o) => o.kind === 'dispatch.arrive' || o.kind === 'fire.damaged')).toBe(false);
    out.push(...run(sim, 3000));
    expect(out.filter((o) => o.eventId === 'f').map((o) => [o.kind, o.reason])).toEqual([
      ['fire.start', undefined],
      ['dispatch.start', 'vehicle 1 from fs'],
      ['fire.end', 'target gone'],
      ['dispatch.cancel', 'target gone'],
      ['dispatch.return', undefined],
    ]);
    const s = sim.snapshot().scenario!;
    expect(s.kpi).toMatchObject({ responses: 0, damaged: 0, extinguished: 0, activeEvents: 0 });
    expect(s.damagedBuildings).toEqual([]);
    expect(s.incidents).toEqual([]);
    expect(s.dispatches).toEqual([]);
  });

  it('building deleted while the truck works there → it leaves for home; a patient already aboard is still delivered', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false, demand: false });
    const w = internals(sim);
    expect(sim.scenarioInput(input('f', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000, suppressTicks: 5000 })).ok).toBe(true);
    expect(sim.scenarioInput(input('m', 5, 'medical.start', { buildingId: 'flat' }, { treatTicks: 10 })).ok).toBe(true);
    const out: ScenarioOutcome[] = [];
    let removed = { home: false, flat: false };
    for (let t = 0; t < 8000; t++) {
      step(sim);
      out.push(...sim.drainScenarioOutcomes());
      const fm = w.sc!.missions.find((m) => m.incident.eventId === 'f');
      if (!removed.home && fm?.stage === 'working') {
        expect(sim.applyCommand({ type: 'building.remove', id: 'home' }).ok).toBe(true);
        removed = { ...removed, home: true };
      }
      const mm = w.sc!.missions.find((m) => m.incident.eventId === 'm');
      if (!removed.flat && mm?.stage === 'transport' && mm.v !== null) {
        expect(sim.applyCommand({ type: 'building.remove', id: 'flat' }).ok).toBe(true);
        removed = { ...removed, flat: true };
      }
    }
    expect(removed).toEqual({ home: true, flat: true });
    expect(kinds(out, 'f')).toEqual(['fire.start', 'dispatch.start', 'dispatch.arrive', 'fire.end', 'dispatch.cancel', 'dispatch.return']);
    expect(out.find((o) => o.eventId === 'f' && o.kind === 'fire.end')!.reason).toBe('target gone');
    expect(kinds(out, 'm')).toEqual(['medical.start', 'dispatch.start', 'dispatch.arrive', 'medical.complete']);
    expect(sim.kpi()).toMatchObject({ extinguished: 0, damaged: 0, medicalCompleted: 1, activeEvents: 0 });
  });

  it('a call before its vehicle could leave: the incident building deleted → dispatch.cancel; the facility deleted → cancelled and dispatched again from the next one', () => {
    const blocked = (): Simulation => {
      const sim = new Simulation(town(), { scenario: true, citizens: false, demand: false });
      const w = internals(sim);
      // An accident right at fsA's exit keeps the truck from entering the road (it waits for room).
      const acc = w.demand.access.get('fsA')!;
      const lane = originLane(w.net, acc.segId, acc.dir);
      const segLane = w.graph.segments.get(acc.segId)!.lanes.indexOf(lane);
      const s = laneSAtT(w.net, lane, acc.t);
      expect(sim.scenarioInput(input('blk', 0, 'accident.start', { segmentId: acc.segId, lane: segLane, s: Math.max(0, s - 6) }, { durationTicks: 100000 })).ok).toBe(true);
      expect(sim.scenarioInput(input('f', 2, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000 })).ok).toBe(true);
      run(sim, 10);
      expect(w.sc!.missions.map((m) => [m.incident.eventId, m.facilityId, m.v === null])).toEqual([['f', 'fsA', true]]);
      return sim;
    };
    const a = blocked();
    expect(a.applyCommand({ type: 'building.remove', id: 'home' }).ok).toBe(true);
    const outA = run(a, 100);
    expect(outA.filter((o) => o.eventId === 'f').map((o) => [o.kind, o.reason])).toEqual([
      ['fire.end', 'target gone'],
      ['dispatch.cancel', 'target gone'],
    ]);
    expect(internals(a).sc!.missions).toEqual([]);

    const b = blocked();
    expect(b.applyCommand({ type: 'building.remove', id: 'fsA' }).ok).toBe(true);
    const outB = run(b, 50);
    expect(outB.filter((o) => o.eventId === 'f').map((o) => `${o.kind}:${o.reason ?? ''}`)).toEqual(['dispatch.cancel:facility gone', 'dispatch.start:vehicle 1 from fsZ']);
    expect(internals(b).sc!.missions.map((m) => [m.facilityId, m.stage, m.v !== null])).toEqual([['fsZ', 'enroute', true]]);
  });

  it('facility deleted mid-mission: the truck goes back to the closest remaining station, the ambulance takes its patient to the other hospital; none left → dispatch.lost', () => {
    const doc = town([place('h2', 'svc-hospital', -150, 150)]);
    const sim = new Simulation(doc, { scenario: true, citizens: false, demand: false });
    const w = internals(sim);
    expect(sim.scenarioInput(input('f', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000, suppressTicks: 100 })).ok).toBe(true);
    expect(sim.scenarioInput(input('m', 5, 'medical.start', { buildingId: 'flat' }, { treatTicks: 10 })).ok).toBe(true);
    const out: ScenarioOutcome[] = [];
    const facilities: Record<string, string[]> = { f: [], m: [] };
    let cut = { fs: false, h: false };
    for (let t = 0; t < 8000; t++) {
      step(sim);
      out.push(...sim.drainScenarioOutcomes());
      for (const m of w.sc!.missions) {
        const l = facilities[m.incident.eventId]!;
        if (l[l.length - 1] !== m.facilityId) l.push(m.facilityId);
      }
      const fm = w.sc!.missions.find((m) => m.incident.eventId === 'f');
      if (!cut.fs && fm?.stage === 'working') {
        expect(sim.applyCommand({ type: 'building.remove', id: fm.facilityId }).ok).toBe(true);
        cut = { ...cut, fs: true };
      }
      const mm = w.sc!.missions.find((m) => m.incident.eventId === 'm');
      if (!cut.h && mm?.stage === 'transport' && mm.v !== null) {
        expect(sim.applyCommand({ type: 'building.remove', id: mm.facilityId }).ok).toBe(true);
        cut = { ...cut, h: true };
      }
    }
    expect(cut).toEqual({ fs: true, h: true });
    expect(facilities['f']).toEqual(['fsA', 'fsZ']);
    expect(facilities['m']!.length).toBe(2);
    expect(kinds(out, 'f')).toEqual(['fire.start', 'dispatch.start', 'dispatch.arrive', 'fire.extinguished', 'dispatch.return']);
    expect(kinds(out, 'm')).toEqual(['medical.start', 'dispatch.start', 'dispatch.arrive', 'medical.complete']);
    expect(sim.kpi()).toMatchObject({ extinguished: 1, medicalCompleted: 1 });

    // No station left: the truck working at the scene is lost when it should drive back.
    const lone = town();
    delete lone.buildings['fsZ'];
    const b = new Simulation(lone, { scenario: true, citizens: false, demand: false });
    const wb = internals(b);
    expect(b.scenarioInput(input('f', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000, suppressTicks: 100 })).ok).toBe(true);
    const outB: ScenarioOutcome[] = [];
    let gone = false;
    for (let t = 0; t < 4000; t++) {
      step(b);
      outB.push(...b.drainScenarioOutcomes());
      if (!gone && wb.sc!.missions[0]?.stage === 'working') {
        expect(b.applyCommand({ type: 'building.remove', id: 'fsA' }).ok).toBe(true);
        gone = true;
      }
    }
    expect(outB.filter((o) => o.eventId === 'f').map((o) => [o.kind, o.reason ?? ''])).toEqual([
      ['fire.start', ''],
      ['dispatch.start', 'vehicle 1 from fsA'],
      ['dispatch.arrive', outB.find((o) => o.kind === 'dispatch.arrive')!.reason],
      ['fire.extinguished', outB.find((o) => o.kind === 'fire.extinguished')!.reason],
      ['dispatch.lost', '귀소할 시설 없음'],
    ]);
    expect(wb.sc!.missions).toEqual([]);
  });
});

describe('pending responses (no survivorship bias)', () => {
  it('respondingNow / respondingElapsedSum / oldestPendingMinutes count dispatches not at the scene yet, instantaneously', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false, demand: false });
    expect(sim.kpi()).toMatchObject({ respondingNow: 0, respondingElapsedSum: 0, oldestPendingMinutes: 0 });
    expect(sim.scenarioInput(input('f', 10, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000 })).ok).toBe(true);
    expect(sim.scenarioInput(input('m', 70, 'medical.start', { buildingId: 'flat' })).ok).toBe(true);
    run(sim, 130);
    // Tick 130: the truck called at 10 and the ambulance called at 70 are both still on their way.
    const minutes = (ticks: number): number => (ticks / 20) * (10 / 60);
    const k = sim.kpi();
    expect(k.respondingNow).toBe(2);
    expect(k.respondingElapsedSum).toBeCloseTo(minutes(120) + minutes(60), 9);
    expect(k.oldestPendingMinutes).toBeCloseTo(minutes(120), 9);
    const out = run(sim, 4000);
    expect(out.filter((o) => o.kind === 'dispatch.arrive')).toHaveLength(2);
    // Arrived: cumulative response KPIs take over, the instantaneous ones drop to 0.
    expect(sim.kpi()).toMatchObject({ responses: 2, respondingNow: 0, respondingElapsedSum: 0, oldestPendingMinutes: 0 });
  });
});

describe('lost missions never leave an orphan incident (recheck R1)', () => {
  const medicalTown = (): Simulation => {
    const doc = apply(gridDoc(4, 150, 'road-4', 4), [place('h', 'svc-hospital', 150, -150), place('flat', 'house', 0, 170)]);
    const sim = new Simulation(doc, { scenario: true, citizens: false, demand: false });
    expect(sim.scenarioInput(input('m', 5, 'medical.start', { buildingId: 'flat' }, { treatTicks: 10 })).ok).toBe(true);
    return sim;
  };
  const tail = (out: ScenarioOutcome[]): string[][] => out.filter((o) => o.eventId === 'm').slice(-2).map((o) => [o.kind, o.reason ?? '']);

  it("Sol's repro: the last hospital deleted while the patient is driven there → dispatch.lost + medical.end (patient transport lost), nothing left active", () => {
    const sim = medicalTown();
    const w = internals(sim);
    let deleted = false;
    const out = run(sim, 7000, () => {
      const m = w.sc!.missions[0];
      if (!deleted && m?.stage === 'transport' && m.v !== null) {
        expect(sim.applyCommand({ type: 'building.remove', id: 'h' })).toEqual({ ok: true });
        deleted = true;
      }
    });
    expect(deleted).toBe(true);
    expect(tail(out)).toEqual([
      ['dispatch.lost', '이송할 병원 없음'],
      ['medical.end', 'patient transport lost'],
    ]);
    expect(sim.kpi()).toMatchObject({ activeEvents: 0, medicalCompleted: 0, removed: 1 });
    expect(w.sc!.incidents).toEqual([]);
    expect(w.sc!.missions).toEqual([]);
  });

  it('the last hospital deleted while the transport waits for room to depart → the same resolution', () => {
    const sim = medicalTown();
    const w = internals(sim);
    let blocked = false;
    let deleted = false;
    const out = run(sim, 4000, () => {
      const m = w.sc!.missions[0];
      if (!blocked && m?.stage === 'working') {
        // An accident on the spot the ambulance leaves from: the transport waits for room.
        const lane = originLane(w.net, m.scene.segId, m.scene.dir);
        const s = laneSAtT(w.net, lane, m.scene.t);
        const segLane = w.graph.segments.get(m.scene.segId)!.lanes.indexOf(lane);
        expect(sim.scenarioInput(input('blk', w.tick, 'accident.start', { segmentId: m.scene.segId, lane: segLane, s: Math.max(0, s - 6) }, { durationTicks: 100000 })).ok).toBe(true);
        blocked = true;
      }
      if (blocked && !deleted && m?.stage === 'transport' && m.v === null && w.tick > (m.incident.workEnd ?? 0) + 5) {
        expect(sim.applyCommand({ type: 'building.remove', id: 'h' })).toEqual({ ok: true });
        deleted = true;
      }
    });
    expect(deleted).toBe(true);
    expect(tail(out)).toEqual([
      ['dispatch.lost', '이송할 병원 없음'],
      ['medical.end', 'patient transport lost'],
    ]);
    expect(sim.kpi()).toMatchObject({ activeEvents: 1, medicalCompleted: 0 });
    // Still active: only the blocking accident.
    expect(w.sc!.incidents).toEqual([]);
  });

  it('the ambulance removed by a road edit during transport → dispatch.lost (차량 소멸) + medical.end', () => {
    const sim = medicalTown();
    const w = internals(sim);
    let cut = false;
    const out = run(sim, 4000, () => {
      const v = w.sc!.missions[0]?.v;
      if (!cut && w.sc!.missions[0]?.stage === 'transport' && v && v.edge < w.net.nLanes && v.s > 5) {
        expect(sim.applyCommand({ type: 'segment.remove', id: w.graph.lanes[v.edge]!.segmentId }).ok).toBe(true);
        cut = true;
      }
    });
    expect(cut).toBe(true);
    expect(tail(out)).toEqual([
      ['dispatch.lost', '차량 소멸'],
      ['medical.end', 'patient transport lost'],
    ]);
    expect(sim.kpi()).toMatchObject({ medicalCompleted: 0 });
    expect(w.sc!.incidents).toEqual([]);
  });

  it('fire: a truck lost on its way is replaced at once (the fire keeps burning meanwhile); no vehicle possible → retried every 5 game min', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false, demand: false });
    const w = internals(sim);
    expect(sim.scenarioInput(input('f', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000 })).ok).toBe(true);
    let cut = false;
    const out = run(sim, 4000, () => {
      const v = w.sc!.missions[0]?.v;
      if (!cut && v && v.edge < w.net.nLanes && v.s > 5) {
        expect(sim.applyCommand({ type: 'segment.remove', id: w.graph.lanes[v.edge]!.segmentId }).ok).toBe(true);
        cut = true;
      }
    });
    const f = kinds(out, 'f');
    expect(f.slice(0, 4)).toEqual(['fire.start', 'dispatch.start', 'dispatch.lost', 'dispatch.start']);
    expect(f).toContain('dispatch.arrive');

    // A station on a road island: the first attempt fails (logged, counted once); a road built later is
    // found by the next retry.
    const island = apply(gridDoc(3, 150, 'road-4', 2), [
      { type: 'node.add', node: { id: 'i1', pos: { x: 600, z: 0 } } },
      { type: 'node.add', node: { id: 'i2', pos: { x: 900, z: 0 } } },
      { type: 'segment.add', segment: { id: 'isl', a: 'i1', b: 'i2', roadTypeId: 'road-2' } },
      place('fsI', 'svc-fire-station', 750, 40),
      place('home', 'house', -75, 20),
    ]);
    const b = new Simulation(island, { scenario: true, citizens: false, demand: false });
    expect(b.scenarioInput(input('f', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 50000 })).ok).toBe(true);
    const outB = run(b, 1300);
    expect(outB.filter((o) => o.eventId === 'f').map((o) => o.kind)).toEqual(['fire.start', 'dispatch.failed']);
    expect(b.kpi().dispatchFailed).toBe(1);
    expect(b.applyCommand({ type: 'segment.add', segment: { id: 'link', a: 'n_2_1', b: 'i1', roadTypeId: 'road-2' } }).ok).toBe(true);
    const outC = run(b, 700);
    expect(outC.filter((o) => o.eventId === 'f').map((o) => o.kind)).toEqual(['dispatch.start']);
    expect(b.kpi().dispatchFailed).toBe(1);
  });
});

describe('dispatch failures (출동 불가)', () => {
  it('no facility, no emergency vehicle type, or a station cut off from the scene: the incident still runs', () => {
    // No hospital at all.
    const noHosp = town();
    delete noHosp.buildings['h'];
    const a = new Simulation(noHosp, { scenario: true, citizens: false });
    expect(a.scenarioInput(input('m', 5, 'medical.start', { buildingId: 'home' })).ok).toBe(true);
    const outA = run(a, 20);
    expect(outA.filter((o) => o.eventId === 'm').map((o) => [o.kind, o.applied, o.reason])).toEqual([
      ['medical.start', true, undefined],
      ['dispatch.failed', true, '출동 불가: 시설 없음'],
    ]);
    expect(a.kpi()).toMatchObject({ dispatchFailed: 1, activeEvents: 1 });

    // Stations only on a separate road island: the fire burns to 100 %.
    const island = apply(gridDoc(3, 150, 'road-4', 2), [
      { type: 'node.add', node: { id: 'i1', pos: { x: 600, z: 0 } } },
      { type: 'node.add', node: { id: 'i2', pos: { x: 900, z: 0 } } },
      { type: 'segment.add', segment: { id: 'isl', a: 'i1', b: 'i2', roadTypeId: 'road-2' } },
      place('fsI', 'svc-fire-station', 750, 40),
      place('home', 'house', -75, 20),
    ]);
    const b = new Simulation(island, { scenario: true, citizens: false });
    expect(b.scenarioInput(input('f', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 100 })).ok).toBe(true);
    const outB = run(b, 200);
    expect(outB.filter((o) => o.eventId === 'f').map((o) => [o.kind, o.reason])).toEqual([
      ['fire.start', undefined],
      ['dispatch.failed', '출동 불가: 경로 없음'],
      ['fire.damaged', undefined],
    ]);
    expect(b.kpi()).toMatchObject({ dispatchFailed: 1, damaged: 1 });

    // No vehicle type of kind `emergency` in the document.
    const noType = town();
    delete noType.vehicleTypes['ambulance'];
    const c = new Simulation(noType, { scenario: true, citizens: false });
    expect(c.scenarioInput(input('f', 5, 'fire.start', { buildingId: 'home' })).ok).toBe(true);
    expect(run(c, 10).find((o) => o.kind === 'dispatch.failed')!.reason).toBe('출동 불가: 긴급 차종 없음');
  });

  it('a closure that cuts every route from the stations: 경로 없음 (static validation still accepts the call)', () => {
    const doc = apply(gridDoc(2, 200, 'road-2', 3), [place('fs', 'svc-fire-station', -100, -100 - 25), place('home', 'house', 100 + 25, 0)]);
    const sim = new Simulation(doc, { scenario: true, citizens: false, demand: false });
    // The station sits on h_0_0; close every other road so the house's road (v_1_0) is unreachable.
    for (const seg of ['v_0_0', 'h_0_1', 'v_1_0']) expect(sim.scenarioInput(input(`c-${seg}`, 0, 'closure.start', { segmentId: seg })).ok).toBe(true);
    expect(sim.scenarioInput(input('f', 2, 'fire.start', { buildingId: 'home' })).ok).toBe(true);
    const out = run(sim, 5);
    expect(out.find((o) => o.eventId === 'f' && o.kind === 'dispatch.failed')?.reason).toBe('출동 불가: 경로 없음');
  });
});

describe('validation', () => {
  it('static checks only: building exists, whitelisted params, positive integer ticks; eventId targets only on ends', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false });
    const bad: [ScenarioInput, RegExp][] = [
      [input('a', 5, 'fire.start', { buildingId: 'nope' }), /없는 건물/],
      [input('a', 5, 'fire.start', {}), /없는 건물/],
      [input('a', 5, 'fire.start', { buildingId: 'home' }, { treatTicks: 5 }), /params/],
      [input('a', 5, 'medical.start', { buildingId: 'home' }, { burnTicks: 5 }), /params/],
      [input('a', 5, 'fire.start', { buildingId: 'home' }, { burnTicks: 0 }), /burnTicks/],
      [input('a', 5, 'fire.start', { buildingId: 'home' }, { suppressTicks: 1.5 }), /suppressTicks/],
      [input('a', 5, 'medical.start', { buildingId: 'home' }, { treatTicks: NaN }), /treatTicks/],
      [input('a', 5, 'medical.start', { buildingId: 'home', eventId: 'x' }), /eventId/],
      [input('a', 5, 'fire.end', {}), /없는 건물/],
      [input('a', 5, 'medical.end', { eventId: '' }), /eventId/],
    ];
    for (const [i, re] of bad) {
      const r = sim.scenarioInput(i);
      expect(r.ok, JSON.stringify(i)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(re);
    }
    expect(sim.scenarioInput(input('ok', 5, 'fire.end', { eventId: 'later' })).ok).toBe(true);
    expect(sim.scenarioInput(input('ok2', 5, 'medical.end', { buildingId: 'home' })).ok).toBe(true);
    expect(() => sim.setPolicy({ reroute: true, informedShare: 0.5, preempt: 1 as unknown as boolean })).toThrow(/preempt/);
  });

  it('policy: preempt omitted follows reroute; setPolicy records preempt only when given', () => {
    const sim = new Simulation(town(), { scenario: true, citizens: false });
    expect(sim.setPolicy({ reroute: true, informedShare: 0.7 }).params).toEqual({ reroute: 1, informedShare: 0.7 });
    expect(sim.setPolicy({ reroute: true, informedShare: 0.7, preempt: false }).params).toEqual({ reroute: 1, informedShare: 0.7, preempt: 0 });
    sim.step();
    expect(internals(sim).sc!.policy).toEqual({ reroute: true, informedShare: 0.7, preempt: false });
  });
});

describe('determinism, replay and fairness', () => {
  it('property: random fires, medical calls, ends and closures replay identically from the record (acceptance order, sorted, JSON)', () => {
    const doc = town();
    doc.meta.trafficDensity = 0.8;
    const ids = ['home', 'flat', 'fsA', 'h'];
    for (let seed = 1; seed <= 4; seed++) {
      const rng = new Rng(seed);
      const live = new Simulation(cloneJson(doc), { scenario: true, citizens: seed % 2 === 0 });
      live.setPolicy({ reroute: seed % 2 === 1, informedShare: 0.7 });
      const w = internals(live);
      const started: string[] = [];
      const hashes: string[] = [];
      let n = 0;
      for (let t = 0; t < 1500; t++) {
        if (rng.next() < 0.02) {
          const id = `e${seed}-${n++}`;
          const r = rng.next();
          const tick = w.tick + rng.int(5);
          const b = ids[rng.int(ids.length)]!;
          let inp: ScenarioInput;
          if (r < 0.35) inp = input(id, tick, 'fire.start', { buildingId: b }, { burnTicks: 300 + rng.int(900), suppressTicks: 50 + rng.int(200) });
          else if (r < 0.7) inp = input(id, tick, 'medical.start', { buildingId: b }, { treatTicks: 20 + rng.int(100) });
          else if (r < 0.85 && started.length > 0) inp = input(id, tick, rng.next() < 0.5 ? 'fire.end' : 'medical.end', { eventId: started[rng.int(started.length)]! });
          else inp = input(id, tick, 'closure.start', { segmentId: rng.next() < 0.5 ? 'h_1_1' : 'v_1_2' }, { durationTicks: 100 + rng.int(300) });
          expect(live.scenarioInput(inp).ok).toBe(true);
          if (inp.kind.endsWith('.start')) started.push(id);
        }
        if (t === 700) live.setPolicy({ reroute: seed % 2 === 0, informedShare: 0.5 });
        step(live);
        if (t % 50 === 49) hashes.push(hash(live));
      }
      const inputs = live.scenarioInputs();
      const record = (list: ScenarioInput[]): ScenarioRecord => ({ engineVersion: ENGINE_VERSION, scenarioVersion: 1, baseSeq: 0, doc, seed: doc.meta.seed, tickRate: 20, warmupTicks: 0, inputs: list, policy: { ...DEFAULT_POLICY } });
      const replay = (list: ScenarioInput[]): void => {
        const sim = simulationFromRecord(record(list), { citizens: seed % 2 === 0 });
        const got: string[] = [];
        for (let t = 0; t < 1500; t++) {
          step(sim);
          if (t % 50 === 49) got.push(hash(sim));
        }
        expect(got).toEqual(hashes);
        expect(internals(sim).sc!.log).toEqual(w.sc!.log);
      };
      replay(inputs);
      replay([...inputs].sort((a, b) => a.tick - b.tick || a.order - b.order || (a.eventId < b.eventId ? -1 : 1)));
      replay(JSON.parse(JSON.stringify(inputs)) as ScenarioInput[]);
      const kinds = new Set(w.sc!.log.map((e) => e.kind));
      expect(kinds.has('dispatch.start') && kinds.has('dispatch.arrive')).toBe(true);
    }
  }, 240_000);

  it('ON/OFF (pre-emption and re-routing) with fires and medical calls: the demand RNG and citizen trips match tick by tick', () => {
    const doc = apply(cityDoc(150, 7), [place('fs', 'svc-fire-station', 75, 75 + 20), place('hosp', 'svc-hospital', -75 - 10, 75)]);
    doc.meta.trafficDensity = 1.5;
    const runOnce = (on: boolean) => {
      const sim = new Simulation(cloneJson(doc), { scenario: true });
      sim.setPolicy({ reroute: on, informedShare: 0.7 });
      const w = internals(sim);
      for (const [k, b] of ['apt1', 'house2', 'office1', 'shop1'].entries()) {
        expect(sim.scenarioInput(input(`f${k}`, 300 + k * 500, 'fire.start', { buildingId: b }, { burnTicks: 3000 })).ok).toBe(true);
        expect(sim.scenarioInput(input(`m${k}`, 450 + k * 500, 'medical.start', { buildingId: b })).ok).toBe(true);
      }
      const rng: number[] = [];
      const problems: string[] = [];
      let ctlTicks = 0;
      for (let t = 0; t < 4000; t++) {
        sim.step();
        rng.push(rngState(w.rng));
        if (w.sc!.ctl.size > 0) ctlTicks++;
        if (t % 10 === 0) problems.push(...checkInvariants(sim));
      }
      return { rng, kpi: sim.kpi(), ctlTicks, problems, citizens: sim.stats().citizens };
    };
    const off = runOnce(false);
    const on = runOnce(true);
    expect(on.rng).toEqual(off.rng);
    expect(on.problems.slice(0, 5)).toEqual([]);
    expect(off.problems.slice(0, 5)).toEqual([]);
    expect(off.ctlTicks).toBe(0);
    expect(on.ctlTicks).toBeGreaterThan(0);
    expect(on.kpi.responses).toBeGreaterThan(0);
    expect(on.citizens.total).toBe(off.citizens.total);
  }, 240_000);

  it('the vehicle cap does not stop a dispatch', () => {
    const doc = town();
    doc.meta.trafficDensity = 3;
    const sim = new Simulation(doc, { scenario: true, citizens: false, maxVehicles: 40 });
    for (let t = 0; t < 600; t++) sim.step();
    const w = internals(sim);
    expect(w.vehicles.length).toBeGreaterThanOrEqual(39);
    expect(sim.scenarioInput(input('m', w.tick, 'medical.start', { buildingId: 'flat' })).ok).toBe(true);
    const out = run(sim, 600);
    expect(kinds(out, 'm')).toContain('dispatch.start');
  });
});
