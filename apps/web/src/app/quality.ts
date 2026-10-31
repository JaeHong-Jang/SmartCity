// Render quality (ADR 0014 §8): '보통' (normal, the default) or '낮음' (low: one mountain ring, shorter tree
// and lamp distances, no tree shadows). Personal UI state remembered per browser; never in the doc and never
// seen by the simulation.

import type { ClientStore } from './store';

export type RenderQuality = 'normal' | 'low';

export const QUALITY_KEY = 'smartcity.render.quality';
export const QUALITY_LABEL: Record<RenderQuality, string> = { normal: '보통', low: '낮음' };

/** The remembered quality ('normal' when never set or storage is unavailable). */
export function storedQuality(): RenderQuality {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(QUALITY_KEY) === 'low' ? 'low' : 'normal';
  } catch {
    return 'normal';
  }
}

/** Switch the render quality and remember it in this browser (best effort). */
export function setQuality(store: ClientStore, quality: RenderQuality): void {
  store.set({ quality });
  try {
    window.localStorage.setItem(QUALITY_KEY, quality);
  } catch {
    // Private mode or blocked storage: the choice just lasts for this session.
  }
}
