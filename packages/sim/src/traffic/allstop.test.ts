// All-way stop under load (ADR 0010 §3 prerequisite for blackouts: dark signals run as all-way stops):
// first-come-first-served order, deterministic ties, no deadlock with four simultaneous arrivals or in
// congestion, and pedestrian conflicts through the crosswalk zones.

import { describe, expect, it } from 'vitest';
import { cloneJson, type Command } from '@smartcity/shared';
import { Simulation } from '../simulation.js';
import { apply, checkInvariants, checkZoneInvariants, cityDoc, crossDoc, internals } from '../testkit.js';

declare const console: { log(...args: unknown[]): void };

const allStop = (nodeId: string): Command => ({ type: 'intersection.set', control: { nodeId, kind: 'allStop', yellow: 3, allRed: 2, offset: 0 } });

describe('all-way stop', () => {
  it('four vehicles arriving at once from four approaches: all pass, served in (stop tick, id) order, no overlap', () => {
    const sim = new Simulation(apply(crossDoc(120), [allStop('c')]), { citizens: false, demand: false });
    const w = internals(sim);
    const L = w.net.len[w.graph.laneById.get('W|f|0')!]!;
    const ids = [
      sim.spawnVehicle('sedan', 'N|f|0', 'S|b|0', L - 30)!,
      sim.spawnVehicle('sedan', 'S|f|0', 'N|b|0', L - 30)!,
      sim.spawnVehicle('sedan', 'E|f|0', 'W|b|0', L - 30)!,
      sim.spawnVehicle('sedan', 'W|f|0', 'E|b|0', L - 30)!,
    ];
    const stop = new Map<number, number>();
    const granted: { id: number; stop: number }[] = [];
    for (let t = 0; t < 20 * 60 && granted.length < 4; t++) {
      sim.step();
      expect(checkInvariants(sim)).toEqual([]);
      for (const v of w.vehicles) {
        if (v.stopTick >= 0) stop.set(v.id, v.stopTick);
        if (v.grant >= 0 && !granted.some((g) => g.id === v.id)) granted.push({ id: v.id, stop: stop.get(v.id)! });
      }
    }
    expect(granted.map((g) => g.id).sort()).toEqual([...ids].sort());
    // All four completed their stop together; ties go by vehicle id.
    const sorted = [...granted].sort((x, y) => x.stop - y.stop || x.id - y.id);
    expect(granted.map((g) => g.id)).toEqual(sorted.map((g) => g.id));
  });

  it('a congested small city with five all-way stops and pedestrians: no deadlock, FCFS between conflicting movements, deterministic (reported)', () => {
    const nodes = ['n_1_1', 'n_0_1', 'n_1_0', 'n_2_1', 'n_1_2'];
    const doc = apply(cityDoc(150), nodes.map(allStop));
    doc.meta.trafficDensity = 2.5;
    const run = () => {
      const sim = new Simulation(cloneJson(doc));
      const w = internals(sim);
      const nodeIdx = new Set(nodes.map((id) => w.net.nodeIds.indexOf(id)));
      const grants: string[] = [];
      let waits: number[] = [];
      let overtakes = 0;
      let unexplained = 0;
      let conflictingGrants = 0;
      let stallTicks = 0;
      let pedTicks = 0;
      const problems: string[] = [];
      const lastGrant = new Map<number, number>();
      const servedAt = new Map<number, number>();
      const stopOf = new Map<number, number>();
      for (let t = 0; t < 12000; t++) {
        sim.step();
        if (t % 5 === 0) problems.push(...checkInvariants(sim), ...checkZoneInvariants(sim));
        const nL = w.net.nLanes;
        // Vehicles at a stop line, stopped completely and not granted yet, by node.
        const waiting = new Map<number, { id: number; stop: number; c: number }[]>();
        const served: { id: number; stop: number; c: number; node: number }[] = [];
        for (const v of w.vehicles) {
          // Served this tick: granted, or already on the junction's connector (granted and entered in one tick).
          const c = v.grant >= 0 ? v.grant : v.edge >= nL ? v.edge - nL : -1;
          if (c >= 0 && nodeIdx.has(w.net.connNode[c]!) && !servedAt.has(v.id * 100000 + c)) {
            servedAt.set(v.id * 100000 + c, t);
            served.push({ id: v.id, stop: stopOf.get(v.id) ?? -1, c, node: w.net.connNode[c]! });
          }
          if (v.stopTick >= 0) stopOf.set(v.id, v.stopTick);
          const nxt = v.route[v.ri + 1];
          if (v.edge >= nL || nxt === undefined || nxt < nL || v.grant >= 0 || v.stopTick < 0) continue;
          const node = w.net.connNode[nxt - nL]!;
          if (!nodeIdx.has(node)) continue;
          const l = waiting.get(node) ?? [];
          l.push({ id: v.id, stop: v.stopTick, c: nxt - nL });
          waiting.set(node, l);
        }
        for (const g of served) {
          lastGrant.set(g.node, t);
          grants.push(`${t}:${g.id}`);
          if (g.stop >= 0) waits.push(t - g.stop);
          // An earlier-stopped vehicle with a conflicting movement still waiting = overtaken.
          const conflicts = w.graph.connectors[g.c]!.conflicts;
          for (const u of waiting.get(g.node) ?? []) {
            if (!conflicts.includes(u.c)) continue;
            conflictingGrants++;
            if (g.stop >= 0 && u.stop < g.stop) {
              overtakes++;
              // Allowed reasons (ADR 0004 / 0008): its exit lane has no room, or pedestrians hold / may enter its crosswalk.
              const uv = w.vehicles.find((x) => x.id === u.id)!;
              const to = w.graph.connectors[u.c]!.toLane;
              const list = w.onEdge[to]!;
              const free = list.length > 0 ? list[list.length - 1]!.s - list[list.length - 1]!.len : w.net.len[to]!;
              const exitBlocked = free - w.reserved[to]! < Math.min(uv.len + 2, w.net.len[to]!) - 1e-9;
              const pedBlocked = w.zones.conn[u.c]!.some((pz) => w.zs.ped[pz.z]! > 0 || w.zs.elig[pz.z]! > 0);
              if (!exitBlocked && !pedBlocked) unexplained++;
            }
          }
        }
        // Stall: vehicles waiting at a node whose connectors are all free, and nobody served there for 60 s.
        for (const [node, list] of waiting) {
          if (list.length === 0) continue;
          let held = 0;
          for (const c of w.graph.connectors) if (w.net.connNode[c.index] === node) held += w.holders[c.index]!;
          if (held === 0 && t - (lastGrant.get(node) ?? 0) > 1200) stallTicks++;
        }
        for (const cr of w.graph.crossings) if (cr.nodeId && nodes.includes(cr.nodeId) && w.zs.ped[cr.index]! > 0) pedTicks++;
      }
      waits = waits.sort((a, b) => a - b);
      return { grants, waits, overtakes, unexplained, conflictingGrants, stallTicks, pedTicks, problems, arrived: sim.stats().arrived, removed: sim.stats().removed };
    };
    const a = run();
    const b = run();
    expect(b.grants).toEqual(a.grants);
    expect(a.problems.slice(0, 5)).toEqual([]);
    expect(a.stallTicks).toBe(0);
    expect(a.unexplained).toBe(0);
    expect(a.grants.length).toBeGreaterThan(300);
    expect(a.pedTicks).toBeGreaterThan(100);
    const p = (q: number): number => a.waits[Math.floor(q * (a.waits.length - 1))]! / 20;
    console.log(
      `all-way stop (5 junctions, 10 min): ${a.grants.length} grants, ${a.arrived} trips done, ${a.removed} removed; stop→grant wait median ${p(0.5).toFixed(1)} s, p95 ${p(0.95).toFixed(1)} s, max ${p(1).toFixed(1)} s; ` +
        `conflicting earlier-stopped vehicles at a grant: ${a.conflictingGrants}, of which overtaken ${a.overtakes} (unexplained by exit space / crosswalk: ${a.unexplained}); stall ticks ${a.stallTicks}; crosswalk-occupied ticks ${a.pedTicks}; deterministic ✓`,
    );
  }, 300_000);
});
