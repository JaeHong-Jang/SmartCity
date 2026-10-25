import { describe, expect, it } from 'vitest';
import type { ScenarioKpi } from '@smartcity/sim';
import { alignKpiSeries, inclusiveResponseTime, KPI_EVERY, KPI_METRICS, KpiCollector, rebaseSeries, sinceBase } from './kpiSeries';

const kpi = (tick: number, over: Partial<ScenarioKpi> = {}): ScenarioKpi => ({
  tick, since: 0, completed: tick / 10, avgTravelTime: 60, inProgress: 3, noRoute: 1, droppedTrips: 0, waitingToDepart: 2, removed: 0, congestionLength: 100, rerouted: 0, detoured: 0, recovered: 0, activeEvents: 0, avgResponseTime: 0, maxResponseTime: 0, responses: 0, extinguished: 0, damaged: 0, medicalCompleted: 0, dispatchFailed: 0, respondingNow: 0, respondingElapsedSum: 0, oldestPendingMinutes: 0, ...over,
});

describe('KpiCollector', () => {
  it('keeps exactly the multiples of 60 ticks', () => {
    expect(KPI_EVERY).toBe(60);
    const c = new KpiCollector();
    for (let t = 0; t <= 200; t += 2) c.offer(kpi(t));
    expect(c.points.map((p) => p.tick)).toEqual([0, 60, 120, 180]);
  });
  it('ignores off-grid ticks and repeats, and adopts a fast-forward run', () => {
    const c = new KpiCollector();
    c.seed([kpi(0), kpi(60), kpi(120)]);
    for (const t of [121, 150, 180, 180, 240]) c.offer(kpi(t));
    expect(c.points.map((p) => p.tick)).toEqual([0, 60, 120, 180, 240]);
  });
});

describe('alignKpiSeries', () => {
  it('puts both policies on the same grid of sim ticks', () => {
    const on = [0, 60, 120, 180].map((t) => kpi(t, { rerouted: t }));
    const off = [0, 60, 120, 180].map((t) => kpi(t, { rerouted: 0 }));
    const rows = alignKpiSeries(on, off, 180);
    expect(rows.map((r) => r.tick)).toEqual([0, 60, 120, 180]);
    expect(rows.map((r) => r.off?.tick)).toEqual([0, 60, 120, 180]);
    expect(rows.map((r) => r.on?.tick)).toEqual([0, 60, 120, 180]);
  });
  it('carries the latest point forward and leaves a side empty before its first point', () => {
    const rows = alignKpiSeries([kpi(120)], [kpi(0), kpi(60)], 180);
    expect(rows.map((r) => r.on?.tick)).toEqual([undefined, undefined, 120, 120]);
    expect(rows.map((r) => r.off?.tick)).toEqual([0, 60, 60, 60]);
  });
  it('metrics read the five compared quantities, stuck = no route + waiting to depart', () => {
    expect(KPI_METRICS.map((m) => m.id)).toEqual(['completed', 'avgTravelTime', 'congestionLength', 'stuck', 'rerouted', 'avgResponseTime']);
    const stuck = KPI_METRICS.find((m) => m.id === 'stuck')!;
    expect(stuck.get(kpi(0, { noRoute: 4, waitingToDepart: 5 }))).toBe(9);
    // 60 sim seconds = 10 game minutes
    expect(KPI_METRICS.find((m) => m.id === 'avgTravelTime')!.get(kpi(0, { avgTravelTime: 60 }))).toBe(10);
  });
});

describe('counters since the end of warm-up', () => {
  const base = kpi(1200, { completed: 10, avgTravelTime: 40, droppedTrips: 1, removed: 2, rerouted: 3, detoured: 1, recovered: 1 });

  it('counts become differences and the mean uses (sum − base sum) / (n − base n)', () => {
    // 10 trips averaging 40 s (sum 400), then 4 more taking 100 s each: 14 trips, sum 800, avg 800/14
    const k = kpi(1800, { completed: 14, avgTravelTime: 800 / 14, droppedTrips: 4, removed: 2, rerouted: 8, detoured: 5, recovered: 1, inProgress: 7, noRoute: 2, waitingToDepart: 3, congestionLength: 55 });
    const d = sinceBase(k, base);
    expect(d.completed).toBe(4);
    expect(d.avgTravelTime).toBeCloseTo(100, 9);
    expect([d.droppedTrips, d.removed, d.rerouted, d.detoured, d.recovered]).toEqual([3, 0, 5, 4, 0]);
    // instantaneous values untouched
    expect([d.inProgress, d.noRoute, d.waitingToDepart, d.congestionLength]).toEqual([7, 2, 3, 55]);
  });

  it('no completed trip since the base gives mean 0 (n = 0), never NaN', () => {
    const d = sinceBase(kpi(1260, { completed: 10, avgTravelTime: 40 }), base);
    expect(d.completed).toBe(0);
    expect(d.avgTravelTime).toBe(0);
  });

  it('rebaseSeries starts at the base tick with zeros and is empty without it', () => {
    const pts = [kpi(1140, { completed: 9 }), base, kpi(1260, { completed: 12, avgTravelTime: 50 })];
    const r = rebaseSeries(pts, 1200);
    expect(r.map((p) => p.tick)).toEqual([1200, 1260]);
    expect(r[0]!.completed).toBe(0);
    expect(r[1]!.completed).toBe(2);
    expect(r[1]!.avgTravelTime).toBeCloseTo((50 * 12 - 40 * 10) / 2, 9);
    expect(rebaseSeries([kpi(60)], 1200)).toEqual([]);
  });
});

describe('emergency KPI deltas', () => {
  const base = kpi(1200, { responses: 2, avgResponseTime: 5, extinguished: 1, damaged: 0, medicalCompleted: 1, dispatchFailed: 1, maxResponseTime: 6 });

  it('counts are differences; the mean response time is rebuilt from sums (avg × responses)', () => {
    // 2 responses averaging 5 min (sum 10), then 2 more taking 15 min each: 4 responses, sum 40, avg 10
    const d = sinceBase(kpi(1800, { responses: 4, avgResponseTime: 10, extinguished: 3, damaged: 1, medicalCompleted: 2, dispatchFailed: 4, maxResponseTime: 15 }), base);
    expect(d.responses).toBe(2);
    expect(d.avgResponseTime).toBeCloseTo(15, 9);
    expect([d.extinguished, d.damaged, d.medicalCompleted, d.dispatchFailed]).toEqual([2, 1, 1, 3]);
    expect(d.maxResponseTime).toBe(15); // a maximum cannot be rebased; warm-up has no emergencies
  });

  it('no response since the base gives 0, never NaN', () => {
    const d = sinceBase(kpi(1260, { responses: 2, avgResponseTime: 5 }), base);
    expect(d.responses).toBe(0);
    expect(d.avgResponseTime).toBe(0);
    expect(KPI_METRICS.find((m) => m.id === 'avgResponseTime')!.get(d)).toBe(0);
  });
});

describe('response time without survivorship bias', () => {
  // Fake pending-response fields (the sim adds them): ON answered both calls, OFF's fire truck is still out.
  const on = kpi(2880, { responses: 2, avgResponseTime: 7.7 });
  const off = kpi(2880, { responses: 1, avgResponseTime: 2.2, respondingNow: 1, respondingElapsedSum: 15 });

  it('counts a pending response by its elapsed time: OFF 8.6 min is worse than ON 7.7 min', () => {
    expect(inclusiveResponseTime(on)).toBeCloseTo(7.7, 9);
    expect(inclusiveResponseTime(off)).toBeCloseTo((2.2 * 1 + 15) / 2, 9); // 8.6
    expect(inclusiveResponseTime(off)).toBeGreaterThan(inclusiveResponseTime(on));
    // the arrived-only average alone would have said OFF is better
    expect(off.avgResponseTime).toBeLessThan(on.avgResponseTime);
  });

  it('rebased arrivals plus pending ones; nothing at all is 0, never NaN', () => {
    const base = kpi(1200, { responses: 0, avgResponseTime: 0 });
    const d = sinceBase(off, base);
    expect(inclusiveResponseTime(d)).toBeCloseTo(8.6, 9);
    expect(inclusiveResponseTime(kpi(60))).toBe(0);
    expect(inclusiveResponseTime(kpi(60, { respondingNow: 0, respondingElapsedSum: 0 }))).toBe(0);
    expect(KPI_METRICS.find((m) => m.id === 'avgResponseTime')!.label).toContain('미도착 포함');
  });
});
