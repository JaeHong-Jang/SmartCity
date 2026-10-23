// Snap resolution shared by every placing tool and by moves: 8 / 4 / 2 / 1 m / off, G cycles.

import { snapToGrid, type Vec2 } from '@smartcity/shared';
import type { SnapStep } from '../app/store';

export const SNAP_STEPS: readonly SnapStep[] = [8, 4, 2, 1, 0];

/** Next step in the G cycle (8 → 4 → 2 → 1 → off → 8). */
export function nextSnapStep(step: SnapStep): SnapStep {
  const i = SNAP_STEPS.indexOf(step);
  return SNAP_STEPS[(i + 1) % SNAP_STEPS.length]!;
}

export const snapLabel = (step: SnapStep): string => (step === 0 ? '끔' : `${step}m`);

/** World point on the snap grid (unchanged when snapping is off). */
export const snapPoint = (p: Vec2, step: SnapStep): Vec2 => (step > 0 ? snapToGrid(p, step) : p);

/** Arc length along a road snapped to the step, kept strictly inside [0, length]. */
export function snapAlong(s: number, length: number, step: SnapStep): number {
  const v = step > 0 ? Math.round(s / step) * step : s;
  return Math.min(Math.max(v, 0.01), Math.max(0.01, length - 0.01));
}
