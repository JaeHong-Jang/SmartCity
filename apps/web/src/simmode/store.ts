// Small independent store for simulator-mode UI state (the shared ClientStore is not touched).

import { useSyncExternalStore } from 'react';
import { DEFAULT_POLICY, type ResponsePolicy, type ScenarioKpi } from '@smartcity/sim';
import type { FacilityCounts } from './facilities';
import type { SimPhase } from './machine';

export type EventKind = 'closure' | 'accident' | 'surge' | 'fire' | 'medical';

export interface ArmedEvent {
  kind: EventKind;
  /** Game minutes for closures and accidents. */
  durationMin: number;
  /** Surge: extra trips (people) and inflow / stay / outflow game minutes. */
  people: number;
  inflowMin: number;
  stayMin: number;
  outflowMin: number;
}

export interface EventRow {
  eventId: string;
  kind: EventKind;
  label: string;
  /** Map position of the event (camera target). */
  pos: { x: number; z: number };
  startTick: number;
  /** null = no automatic end. */
  endTick: number | null;
  status: 'pending' | 'ok' | 'rejected';
  /** Why the sim rejected creating this event (status 'rejected'). */
  error?: string;
  /** Fire / medical: the incident's state and progress (fire 0..100) from the latest snapshot. */
  incident?: { state: 'burning' | 'suppressing' | 'waiting' | 'treating' | 'transport'; progress: number };
  /** Fire / medical: the emergency vehicle out for it, from the latest snapshot. */
  dispatch?: { stage: 'enroute' | 'working' | 'transport' | 'returning'; vehicleId: number | null };
  /** Last dispatch outcome as text (출동 중, 복귀, 출동 불가: …). */
  dispatchNote?: string;
  /** Response time (game minutes, call → arrival) as the sim reported it. */
  response?: string;
  /** How a fire or medical call ended: 진화됨, 피해, 완료. */
  result?: string;
  /** Why a fire or medical call ended without such a result: 수동 종료, 대상 건물 삭제됨, 이송 실패. */
  endReason?: string;
  /** Something that happened to the event after it started (obstacle moved, removed by a road edit). */
  note?: string;
  /** Why the sim rejected the last request to end this event (the event is still active). */
  endError?: string;
  /** Listed in the latest snapshot's activeEvents. */
  active: boolean;
  /** Gone from activeEvents after its start (ended by duration, by an end input, or run out). */
  ended: boolean;
  segmentId?: string;
  lane?: number;
  buildingId?: string;
}

export interface CompareResult {
  /** Policy shown on screen during the run, and the series of each side. */
  screenReroute: boolean;
  untilTick: number;
  on: ScenarioKpi[];
  off: ScenarioKpi[];
}

export interface SimModeState {
  phase: SimPhase;
  baseSeq: number;
  /** Game time of day (seconds) of the main city when the copy was taken. */
  baseDayTime: number;
  /** 0..1 for warming and comparing. */
  progress: number;
  /** Latest tick of the copy on screen (throttled). */
  tick: number;
  policy: ResponsePolicy;
  armed: ArmedEvent | null;
  events: EventRow[];
  compare: CompareResult | null;
  error: string | null;
  /** The copy's worker failed: the run is over until "최신 도시로 다시 시작". */
  fatal: boolean;
  /** A short fast-forward to the next KPI grid tick is running (compare must wait). */
  aligning: boolean;
  /** Facilities in the simulated copy, for the guidance line and the missing-facility hint. */
  facilities: FacilityCounts;
  /** Live workers (copy + compare), for the leak test hook. */
  workers: number;
}

export const DEFAULT_ARMED: Record<EventKind, ArmedEvent> = {
  closure: { kind: 'closure', durationMin: 30, people: 100, inflowMin: 20, stayMin: 40, outflowMin: 20 },
  accident: { kind: 'accident', durationMin: 20, people: 100, inflowMin: 20, stayMin: 40, outflowMin: 20 },
  surge: { kind: 'surge', durationMin: 0, people: 100, inflowMin: 20, stayMin: 40, outflowMin: 20 },
  fire: { kind: 'fire', durationMin: 0, people: 100, inflowMin: 20, stayMin: 40, outflowMin: 20 },
  medical: { kind: 'medical', durationMin: 0, people: 100, inflowMin: 20, stayMin: 40, outflowMin: 20 },
};

export function initialSimModeState(): SimModeState {
  return {
    phase: 'off',
    baseSeq: 0,
    baseDayTime: 0,
    progress: 0,
    tick: 0,
    policy: { ...DEFAULT_POLICY },
    armed: null,
    events: [],
    compare: null,
    error: null,
    fatal: false,
    aligning: false,
    facilities: { fireStation: 0, hospital: 0, substation: 0, powerPlant: 0 },
    workers: 0,
  };
}

export class SimModeStore {
  private state = initialSimModeState();
  private listeners = new Set<() => void>();

  getState = (): SimModeState => this.state;

  set(patch: Partial<SimModeState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  reset(): void {
    this.state = initialSimModeState();
    for (const l of this.listeners) l();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
}

export const simModeStore = new SimModeStore();

export function useSimMode<T>(selector: (s: SimModeState) => T): T {
  return useSyncExternalStore(simModeStore.subscribe, () => selector(simModeStore.getState()));
}
