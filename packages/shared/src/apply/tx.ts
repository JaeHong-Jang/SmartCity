// Failure signal, undo log and the policy flag shared by the apply modules.

import type { TxIndex } from './spatial.js';

export class ApplyError extends Error {}

export function fail(msg: string): never {
  throw new ApplyError(msg);
}

/**
 * Road check work budget for ONE top-level applyCommand, a whole batch included: contact piece-pair
 * evaluations and the spatial-grid cells and candidates visited to find them. Every road the transaction
 * adds or rounds draws from the same allowance, so no single command can hold the doc for long. Running out refuses the command (atomically) with its own reason, never a
 * silent allow. Sized so that spending all of it takes about 100–200 ms (see apply/contact.test.ts).
 */
export const CONTACT_BUDGET = 500_000;

/** Undo log so a failed batch can be rolled back without cloning the whole doc. */
export class Tx {
  private undo: (() => void)[] = [];
  /** What is left of CONTACT_BUDGET in this transaction (shared by all its commands). */
  readonly contact = { left: CONTACT_BUDGET };
  /** Spatial indexes of this transaction, built by the first check that needs them (see TxIndex.of). */
  index: TxIndex | undefined;
  /** Record sizes counted once per transaction and kept by `set` (capacity checks of large batches). */
  private counts = new Map<object, number>();

  /** Number of entries of `rec` now (counted once, then updated by every `set`). */
  count(rec: Record<string, unknown>): number {
    let n = this.counts.get(rec);
    if (n === undefined) this.counts.set(rec, (n = Object.keys(rec).length));
    return n;
  }
  private listeners: ((rec: object, id: string) => void)[] = [];

  /** Called after every `set` of this transaction (keeps derived indexes such as the road grid current). */
  listen(f: (rec: object, id: string) => void): void {
    this.listeners.push(f);
  }

  set<T>(rec: Record<string, T>, id: string, value: T | undefined): void {
    const had = Object.prototype.hasOwnProperty.call(rec, id);
    const prev = rec[id];
    this.undo.push(() => {
      if (had) rec[id] = prev as T;
      else delete rec[id];
    });
    if (value === undefined) delete rec[id];
    else rec[id] = value;
    const n = this.counts.get(rec);
    if (n !== undefined) this.counts.set(rec, n + (!had && value !== undefined ? 1 : 0) - (had && value === undefined ? 1 : 0));
    for (const f of this.listeners) f(rec, id);
  }

  field<O extends object, K extends keyof O>(obj: O, key: K, value: O[K]): void {
    const prev = obj[key];
    this.undo.push(() => {
      obj[key] = prev;
    });
    obj[key] = value;
  }

  rollback(): void {
    for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i]!();
    this.undo = [];
    this.counts.clear();
  }
}

// Policy checks consult this flag; applyCommand is synchronous, so a module-level flag is safe.
export const policy = { enforce: true };
