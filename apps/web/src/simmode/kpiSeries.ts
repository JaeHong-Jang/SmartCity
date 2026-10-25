// KPI time series on a shared sim-tick axis (ADR 0010 §5: compare at the same sim tick).

import { CLOCK_SCALE, kpiEveryTicks, type ScenarioKpi } from '@smartcity/sim';
import { TICK_HZ } from '../sim/protocol';

/** Period of one KPI point: 30 game seconds (60 ticks at 20 Hz), same as the sim's KpiSeries. */
export const KPI_EVERY = kpiEveryTicks(TICK_HZ);

/** Keeps the KPI of every exact multiple of `every` ticks. Fed with each snapshot's `scenario.kpi` (the sim publishes every such tick). */
export class KpiCollector {
  readonly points: ScenarioKpi[] = [];
  private bucket = -1;

  constructor(readonly every = KPI_EVERY) {}

  offer(kpi: ScenarioKpi): void {
    if (kpi.tick % this.every !== 0) return;
    const b = kpi.tick / this.every;
    if (b > this.bucket) {
      this.bucket = b;
      this.points.push(kpi);
    }
  }

  /** Adopt grid points from a fast-forward run (`runTo` reply). */
  seed(points: readonly ScenarioKpi[]): void {
    const have = new Set(this.points.map((p) => p.tick));
    for (const p of points) if (p.tick % this.every === 0 && !have.has(p.tick)) this.points.push(p);
    this.points.sort((a, b) => a.tick - b.tick);
    this.bucket = Math.max(this.bucket, (this.points[this.points.length - 1]?.tick ?? 0) / this.every);
  }

  reset(): void {
    this.points.length = 0;
    this.bucket = -1;
  }
}

export interface AlignedRow {
  /** Grid tick (multiple of `every`). */
  tick: number;
  on?: ScenarioKpi;
  off?: ScenarioKpi;
}

/** Last point at or before `tick` (points sorted by tick). */
function pointAt(points: readonly ScenarioKpi[], tick: number): ScenarioKpi | undefined {
  let best: ScenarioKpi | undefined;
  for (const p of points) {
    if (p.tick > tick) break;
    best = p;
  }
  return best;
}

/** Rows at every grid tick from 0 to `untilTick`, each side carrying forward its latest point (undefined before its first). */
export function alignKpiSeries(on: readonly ScenarioKpi[], off: readonly ScenarioKpi[], untilTick: number, every = KPI_EVERY): AlignedRow[] {
  const rows: AlignedRow[] = [];
  for (let t = 0; t <= untilTick; t += every) rows.push({ tick: t, on: pointAt(on, t), off: pointAt(off, t) });
  return rows;
}

/**
 * Mean response time counting vehicles that have not arrived yet by their elapsed time (a lower bound for
 * them): (Σ arrived + Σ elapsed) / (arrived + still responding). Arrived-only averages hide slow responses
 * (survivorship bias). `k` is rebased, so the arrived sum is avg × responses since the base. 0 when none.
 */
export function inclusiveResponseTime(k: ScenarioKpi): number {
  const n = k.responses + k.respondingNow;
  return n > 0 ? (k.avgResponseTime * k.responses + k.respondingElapsedSum) / n : 0;
}

/** Metrics drawn as charts, with a getter from a KPI point. */
export interface KpiMetric {
  id: 'completed' | 'avgTravelTime' | 'congestionLength' | 'stuck' | 'rerouted' | 'avgResponseTime';
  label: string;
  unit: string;
  get(k: ScenarioKpi): number;
}

export const KPI_METRICS: KpiMetric[] = [
  { id: 'completed', label: '완료 통행 수', unit: '대', get: (k) => k.completed },
  { id: 'avgTravelTime', label: '평균 통행시간', unit: '게임 분', get: (k) => (k.avgTravelTime * CLOCK_SCALE) / 60 },
  { id: 'congestionLength', label: '정체 길이', unit: 'm', get: (k) => k.congestionLength },
  { id: 'stuck', label: '경로 없음 + 출발 대기', unit: '대', get: (k) => k.noRoute + k.waitingToDepart },
  { id: 'rerouted', label: '재탐색 수', unit: '대', get: (k) => k.rerouted },
  // Game minutes, call → arrival; vehicles still on their way count with their elapsed time (a lower bound).
  // 0 while there is no response at all (flat zero line).
  { id: 'avgResponseTime', label: '평균 대응 시간 (미도착 포함)', unit: '게임 분', get: inclusiveResponseTime },
];

/**
 * KPI counters since `base` (the grid point at the end of warm-up), so warm-up trips do not dilute the ON/OFF
 * difference. Cumulative counts become `value − base`; the mean travel time becomes
 * (sum(t) − sum(base)) / (n(t) − n(base)) with sum = avg × completed (exact: the sim's avg is ttTicks / completed),
 * 0 when no trip completed since. Instantaneous values (inProgress, noRoute, waitingToDepart, congestionLength,
 * activeEvents) are untouched.
 */
export function sinceBase(k: ScenarioKpi, base: ScenarioKpi): ScenarioKpi {
  const n = k.completed - base.completed;
  const sum = k.avgTravelTime * k.completed - base.avgTravelTime * base.completed;
  const responses = k.responses - base.responses;
  return {
    ...k,
    completed: n,
    avgTravelTime: n > 0 ? sum / n : 0,
    droppedTrips: k.droppedTrips - base.droppedTrips,
    removed: k.removed - base.removed,
    rerouted: k.rerouted - base.rerouted,
    detoured: k.detoured - base.detoured,
    recovered: k.recovered - base.recovered,
    // Emergency counters; the mean response time is rebuilt from sums like the travel time (sum = avg × responses).
    responses: k.responses - base.responses,
    avgResponseTime: responses > 0 ? (k.avgResponseTime * k.responses - base.avgResponseTime * base.responses) / responses : 0,
    extinguished: k.extinguished - base.extinguished,
    damaged: k.damaged - base.damaged,
    medicalCompleted: k.medicalCompleted - base.medicalCompleted,
    dispatchFailed: k.dispatchFailed - base.dispatchFailed,
  };
}

/** Points from `baseTick` on, rebased with `sinceBase`; empty when the series has no point at `baseTick`. */
export function rebaseSeries(points: readonly ScenarioKpi[], baseTick: number): ScenarioKpi[] {
  const base = points.find((p) => p.tick === baseTick);
  return base ? points.filter((p) => p.tick >= baseTick).map((p) => sinceBase(p, base)) : [];
}
