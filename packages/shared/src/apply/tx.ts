// Failure signal, undo log and the policy flag shared by the apply modules.

export class ApplyError extends Error {}

export function fail(msg: string): never {
  throw new ApplyError(msg);
}

/** Undo log so a failed batch can be rolled back without cloning the whole doc. */
export class Tx {
  private undo: (() => void)[] = [];

  set<T>(rec: Record<string, T>, id: string, value: T | undefined): void {
    const had = Object.prototype.hasOwnProperty.call(rec, id);
    const prev = rec[id];
    this.undo.push(() => {
      if (had) rec[id] = prev as T;
      else delete rec[id];
    });
    if (value === undefined) delete rec[id];
    else rec[id] = value;
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
  }
}

// Policy checks consult this flag; applyCommand is synchronous, so a module-level flag is safe.
export const policy = { enforce: true };
