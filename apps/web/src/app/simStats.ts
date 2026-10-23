import type { SimStats } from '@smartcity/sim';

/**
 * Whether `next` would look the same as `prev` to the UI. `tick` and `time` are not shown, the clock
 * is shown to the minute, everything else is compared exactly. The store keeps `prev` when true, so
 * components subscribed to it do not re-render for nothing.
 */
export function sameDisplayedStats(prev: SimStats | null, next: SimStats): boolean {
  if (!prev) return false;
  for (const k of Object.keys(next) as (keyof SimStats)[]) {
    if (k === 'tick' || k === 'time' || k === 'clock' || k === 'citizens') continue;
    if (prev[k] !== next[k]) return false;
  }
  if (prev.clock?.day !== next.clock?.day || Math.floor(prev.clock?.dayTime / 60) !== Math.floor(next.clock?.dayTime / 60)) return false;
  const a = prev.citizens as unknown as Record<string, number> | undefined;
  const b = next.citizens as unknown as Record<string, number> | undefined;
  if (!a || !b) return a === b;
  for (const k of Object.keys(b)) if (a[k] !== b[k]) return false;
  return true;
}
