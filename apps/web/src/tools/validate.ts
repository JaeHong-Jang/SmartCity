// Local pre-validation of drags and ghosts with the exact rules the server runs (non-trusted applyCommand).

import { applyCommand, type CityDoc, type Command } from '@smartcity/shared';

/**
 * Error the server would give for `cmd` on `doc`, or null when it would be accepted.
 * applyCommand only replaces record entries (and meta fields), so a copy of the top-level records
 * is enough to keep the real doc untouched — no deep clone per pointer move.
 */
export function commandError(doc: CityDoc, cmd: Command): string | null {
  const scratch = { ...doc, meta: { ...doc.meta } } as CityDoc;
  const rec = scratch as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(doc)) {
    if (k !== 'meta' && v && typeof v === 'object' && !Array.isArray(v)) rec[k] = { ...(v as object) };
  }
  const r = applyCommand(scratch, cmd);
  return r.ok ? null : r.error;
}
