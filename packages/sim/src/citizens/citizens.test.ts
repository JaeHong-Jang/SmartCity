import { describe, expect, it } from 'vitest';
import { Simulation } from '../simulation.js';
import { apply, checkCitizenInvariants, checkInvariants, checkZoneInvariants, cityDoc, gridDoc, internals } from '../testkit.js';
import { CLOCK_SCALE } from '../types.js';
import { CitState } from './citizens.js';

/** Ticks until the game clock shows `hours` on day 1 (the clock starts at 06:30). */
const ticksUntil = (hours: number, tickRate = 20): number => Math.round((((hours - 6.5) * 3600) / CLOCK_SCALE) * tickRate);

describe('citizens', () => {
  it('derives residents from residential floor area (30 m² each) and caps agents with a scale', () => {
    const sim = new Simulation(cityDoc(), { demand: false });
    const st = sim.stats().citizens;
    // 2 apartments × 5880 m² / 30 + 2 houses × 180 m² / 30.
    expect(st.total).toBe(404);
    expect(st.scale).toBe(1);
    expect(st.home).toBe(404);
    const snap = sim.snapshot();
    expect(snap.buildingIds).toEqual(['apt1', 'apt2', 'house1', 'house2', 'office1', 'shop1', 'shop2']);
    expect(Array.from(snap.occupancy.subarray(0, 7))).toEqual([196, 196, 6, 6, 0, 0, 0]);
    const w = internals(sim);
    const workers = w.cz.slots.filter((c) => c && c.worker).length;
    expect(workers / 404).toBeGreaterThan(0.45);
    expect(workers / 404).toBeLessThan(0.65);
    expect(w.cz.slots.every((c) => !c || !c.worker || c.work !== null)).toBe(true);

    const capped = new Simulation(cityDoc(), { demand: false, maxCitizens: 100 });
    const cs = capped.stats().citizens;
    // scale = ⌈404 / 100⌉ = 5 → round(80.8) = 81 agents by largest remainder (tie → first id).
    expect(cs.scale).toBe(5);
    expect(cs.total).toBe(81);
    expect(Array.from(capped.snapshot().occupancy.subarray(0, 4))).toEqual([40, 39, 1, 1]);
  });

  it('keeps every citizen in exactly one state through a whole working day (home → work → home)', () => {
    const sim = new Simulation(cityDoc());
    const w = internals(sim);
    const workers = w.cz.slots.filter((c) => c && c.worker && c.work).length;
    let peakWork = 0;
    let peakWalking = 0;
    let homeAtNine = -1;
    for (let t = 0; t < ticksUntil(21); t++) {
      sim.step();
      if (t % 5 === 0) {
        const p = checkCitizenInvariants(sim);
        if (p.length) throw new Error(`tick ${t}: ${p.slice(0, 3).join('; ')}`);
      }
      const st = sim.stats().citizens;
      peakWork = Math.max(peakWork, st.atWork);
      peakWalking = Math.max(peakWalking, st.walking);
      if (t === ticksUntil(9.5)) homeAtNine = st.home;
      if (t === ticksUntil(6.9)) expect(st.home).toBe(404);
      if (t === ticksUntil(12)) expect(st.atWork).toBeGreaterThan(0.85 * workers);
    }
    const st = sim.stats();
    expect(st.clock.day).toBe(1);
    expect(st.clock.dayTime / 3600).toBeCloseTo(21, 1);
    expect(peakWalking).toBeGreaterThan(50);
    expect(peakWork).toBeGreaterThan(0.9 * workers);
    expect(homeAtNine).toBeLessThan(404 - 0.8 * workers);
    // Evening: (almost) everyone is back home and the pedestrians are gone.
    expect(st.citizens.home).toBeGreaterThan(404 - 0.05 * 404);
    expect(st.citizens.atWork).toBeLessThan(0.05 * workers);
    expect(w.cz.failedTrips).toBe(0);
    expect(w.cz.trips).toBeGreaterThan(2 * workers);
  }, 60_000);

  it('puts citizens to work when workplaces are built after their homes (verifier bug 1)', () => {
    const full = cityDoc();
    const later = ['office1', 'shop1', 'shop2'].map((id) => full.buildings[id]!);
    const doc = apply(cityDoc(), later.map((b) => ({ type: 'building.remove' as const, id: b.id })));
    const sim = new Simulation(doc);
    for (let i = 0; i < 20; i++) sim.step();
    for (const b of later) {
      expect(sim.applyCommand({ type: 'building.place', building: b })).toEqual({ ok: true });
      for (let i = 0; i < 20; i++) sim.step();
    }
    const w = internals(sim);
    expect(w.cz.slots.some((c) => c && c.worker && c.work !== null)).toBe(true);
    let peakWork = 0;
    const end = ticksUntil(11);
    while (sim.stats().tick < end) {
      sim.step();
      peakWork = Math.max(peakWork, sim.stats().citizens.atWork);
    }
    expect(peakWork).toBeGreaterThan(0);
  });

  it('links long trips to a car: walk to the curb, drive (personId), walk from the car into work', () => {
    const doc = apply(gridDoc(3, 600, 'road-2'), [
      { type: 'building.place', building: { id: 'apt', typeId: 'apartment', pos: { x: -450, z: -580 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'office', typeId: 'office-tower', pos: { x: 450, z: 575 }, rotation: 0 } },
    ]);
    const sim = new Simulation(doc, { demand: false });
    const w = internals(sim);
    const drove = new Map<number, number>();
    const walkedAfter = new Set<number>();
    for (let t = 0; t < ticksUntil(10.5); t++) {
      sim.step();
      if (t % 10 === 0) expect(checkCitizenInvariants(sim)).toEqual([]);
      for (const v of sim.vehicles()) if (v.personId !== undefined) drove.set(v.personId, t);
      const snap = sim.snapshot();
      for (let k = 0; k < snap.pedestrianCount; k++) {
        const id = snap.pedestrianIds[k]!;
        if (drove.has(id) && !sim.vehicles().some((v) => v.personId === id)) walkedAfter.add(id);
      }
    }
    expect(drove.size).toBeGreaterThan(30);
    // Drivers got out and walked on; they are now at work.
    expect(walkedAfter.size).toBe(drove.size);
    for (const id of drove.keys()) expect(w.cz.byId.get(id)!.state).toBe(CitState.atWork);
    expect(sim.stats().arrived).toBe(drove.size);
    expect(w.cz.failedTrips).toBe(0);
  }, 60_000);

  it('survives demolitions and road removal mid-trip without exceptions or leaks', () => {
    const sim = new Simulation(cityDoc());
    const w = internals(sim);
    for (let t = 0; t < ticksUntil(8.2); t++) sim.step();
    expect(sim.stats().pedestrians).toBeGreaterThan(30);
    const before = w.cz.count;
    expect(sim.applyCommand({ type: 'building.remove', id: 'office1' }).ok).toBe(true);
    for (let t = 0; t < 200; t++) {
      sim.step();
      expect(checkCitizenInvariants(sim)).toEqual([]);
      expect(checkZoneInvariants(sim)).toEqual([]);
    }
    // Nobody works in office1 anymore and nobody is inside it.
    expect(w.cz.slots.some((c) => c && (c.work === 'office1' || c.at === 'office1'))).toBe(false);
    expect(sim.applyCommand({ type: 'building.remove', id: 'apt1' }).ok).toBe(true);
    expect(sim.applyCommand({ type: 'segment.remove', id: 'h_0_1' }).ok).toBe(true);
    expect(sim.applyCommand({ type: 'segment.remove', id: 'v_1_0' }).ok).toBe(true);
    for (let t = 0; t < 2000; t++) {
      sim.step();
      if (t % 4 === 0) {
        expect(checkCitizenInvariants(sim)).toEqual([]);
        expect(checkZoneInvariants(sim)).toEqual([]);
        expect(checkInvariants(sim)).toEqual([]);
      }
    }
    expect(w.cz.count).toBe(before - 196);
    expect(w.cz.removedCitizens).toBe(196);
    expect(w.cz.slots.some((c) => c && c.home === 'apt1')).toBe(false);
    for (let i = 0; i < w.peds.hi; i++) if (w.peds.alive[i]) expect(w.cz.slots[w.peds.owner[i]!]?.ped).toBe(i);
    const snap = sim.snapshot();
    expect(snap.buildingIds).not.toContain('apt1');
    for (let k = 0; k < snap.pedestrianCount * 8; k++) expect(Number.isFinite(snap.pedestrians[k]!)).toBe(true);
  }, 60_000);

  it('turns home ↔ work demand into background traffic at 0.3 × when citizens exist', () => {
    const on = new Simulation(cityDoc());
    // Same roads without buildings: random lane-to-lane trips at the full rate.
    const off = new Simulation(gridDoc(3, 150, 'road-2'));
    for (let t = 0; t < 20 * 60; t++) {
      on.step();
      off.step();
    }
    const a = on.stats().spawned;
    const b = off.stats().spawned;
    expect(a).toBeGreaterThan(0.2 * b);
    expect(a).toBeLessThan(0.4 * b);
    expect(off.stats().citizens.total).toBe(0);
  });
});
