// GrowthDirector: the server's automatic city growth (ADR 0009 §4). Every few seconds, while someone
// is connected and growth is on, it asks shared `growthTick` (a pure function of the document) for a
// batch of building.place commands and commits it through the room's normal commit path as 'system'.
//
// The epoch lives in memory only. After a restart it starts at 0 again, so the lots chosen for the
// same document may differ from before; that is fine because every result is already in the command
// log and replay applies logged commands, never re-runs growth.

import { growthTick } from '@smartcity/shared';
import type { CityDoc, Command } from '@smartcity/shared';
import type { CommitResult } from './room.js';

export const GROWTH_INTERVAL_MS = 5_000;

/** What the director needs from a room. */
export interface GrowthHost {
  readonly doc: CityDoc;
  readonly clients: { readonly size: number };
  system(cmd: Command): CommitResult;
}

export interface GrowthOptions {
  intervalMs?: number;
  /** Injectable for tests; defaults to the global timers (which fake timers also replace). */
  timer?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

export class GrowthDirector {
  private handle: unknown = null;
  private epoch = 0;
  private readonly intervalMs: number;
  private readonly timer: NonNullable<GrowthOptions['timer']>;

  constructor(
    private readonly host: GrowthHost,
    opts: GrowthOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? GROWTH_INTERVAL_MS;
    this.timer = opts.timer ?? {
      set: (fn, ms) => {
        const h = setInterval(fn, ms);
        h.unref?.();
        return h;
      },
      clear: (h) => clearInterval(h as NodeJS.Timeout),
    };
  }

  start(): void {
    if (this.handle === null) this.handle = this.timer.set(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = null;
  }

  /** One growth step; skipped (epoch unchanged) with nobody connected or growth switched off. */
  tick(): void {
    if (this.host.clients.size === 0 || this.host.doc.meta.growth === false) return;
    const cmd = growthTick(this.host.doc, this.epoch++);
    if (!cmd) return;
    const res = this.host.system(cmd);
    if (!res.ok) console.error(`[growth] commit rejected: ${res.error}`);
  }
}
