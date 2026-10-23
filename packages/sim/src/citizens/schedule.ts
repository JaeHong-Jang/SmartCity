// Citizen scheduling helpers: game clock conversions, the deterministic day hash, and the event queue
// ordered by (dueTick, personId, seq).

import { CLOCK_SCALE, CLOCK_START } from '../types.js';
import type { World } from '../traffic/world.js';

export interface Ev {
  due: number;
  pid: number;
  seq: number;
}

// ---------- time ----------

export const gameSec = (w: World, tick: number): number => CLOCK_START + (tick / w.tickRate) * CLOCK_SCALE;
export const tickAt = (w: World, game: number): number => Math.ceil(((game - CLOCK_START) / CLOCK_SCALE) * w.tickRate);
export const gameDuration = (w: World, sec: number): number => Math.round((sec / CLOCK_SCALE) * w.tickRate);

/** Deterministic hash of (person, day, salt) in [0, 1). */
export function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------- event queue: (dueTick, personId, seq) ----------

const evLess = (a: Ev, b: Ev): boolean => a.due < b.due || (a.due === b.due && (a.pid < b.pid || (a.pid === b.pid && a.seq < b.seq)));

export function heapPush(h: Ev[], e: Ev): void {
  h.push(e);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!evLess(h[i]!, h[p]!)) break;
    [h[i], h[p]] = [h[p]!, h[i]!];
    i = p;
  }
}

export function heapPop(h: Ev[]): Ev {
  const top = h[0]!;
  const last = h.pop()!;
  if (h.length > 0) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && evLess(h[l]!, h[m]!)) m = l;
      if (r < h.length && evLess(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
  return top;
}

export function schedule(w: World, c: { id: number; seq: number }, due: number): void {
  c.seq++;
  heapPush(w.cz.heap, { due: Math.max(due, w.tick + 1), pid: c.id, seq: c.seq });
}
