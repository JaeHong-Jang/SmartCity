// Which design the full-screen studio is editing (UI state only, outside the city store).

import { useSyncExternalStore } from 'react';
import type { BuildingType } from '@smartcity/shared';

export interface StudioRequest {
  /** Design to open; null = a blank new design. */
  type: BuildingType | null;
  /** Revision the edit starts from (0 = a new design that must not exist yet). */
  baseRev: number;
  /** Back to the precise (numeric) editor for this design. */
  onPrecise?: (id: string) => void;
}

let current: (StudioRequest & { key: number }) | null = null;
let opened = 0;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const fn of listeners) fn();
};

export function openStudio(req: StudioRequest): void {
  current = { ...req, key: ++opened };
  emit();
}

export function closeStudio(): void {
  current = null;
  emit();
}

/** The open request; `key` changes with every open (remount the studio). */
export function useStudioRequest(): (StudioRequest & { key: number }) | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
