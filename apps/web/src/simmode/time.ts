// Game minutes ↔ sim ticks for simulator mode. 1 simulated second = CLOCK_SCALE game seconds (ADR 0008),
// the worker runs TICK_HZ ticks per simulated second, so one game minute = 60 / CLOCK_SCALE × TICK_HZ ticks.

import { CLOCK_SCALE, CLOCK_START } from '@smartcity/sim';
import { TICK_HZ } from '../sim/protocol';

/** Warm-up before events can be injected (ADR 0010 §1): 10 game minutes. */
export const WARMUP_GAME_MIN = 10;
/** Inputs are scheduled this many ticks after the latest snapshot so the worker has not passed them yet (2 s at 20 Hz). */
export const EVENT_LEAD_TICKS = 40;
/** Compare/graph speed: the worker's fastest setting. */
export const FAST_SPEED = 4 as const;

export function gameMinToTicks(minutes: number, tickRate = TICK_HZ): number {
  return Math.max(0, Math.round(((minutes * 60) / CLOCK_SCALE) * tickRate));
}

export function ticksToGameMin(ticks: number, tickRate = TICK_HZ): number {
  return (ticks / tickRate) * (CLOCK_SCALE / 60);
}

export const WARMUP_TICKS = gameMinToTicks(WARMUP_GAME_MIN);

/** Game time of day (seconds since midnight) `ticks` after a sim started at `CLOCK_START`. */
export function dayTimeAtTick(ticks: number, tickRate = TICK_HZ): number {
  return (CLOCK_START + (ticks / tickRate) * CLOCK_SCALE) % 86400;
}
