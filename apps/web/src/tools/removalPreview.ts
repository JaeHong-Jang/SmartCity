// Road edit preview: which automatic parcels and buildings the pending command would remove
// (ADR 0009 §4). The command is dry-run on a clone of the doc and the result is diffed; the
// result is cached per command and recomputed at most every THROTTLE_MS while the pointer moves.

import { buildingFootprints, cloneJson, tryApplyCommand, type CityDoc, type Command } from '@smartcity/shared';
import { closedRing } from '../app/ring';
import type { PreviewLine } from './types';

export interface Removal {
  parcels: string[];
  buildings: string[];
}

const NONE: Removal = { parcels: [], buildings: [] };
export const REMOVAL_COLOR = '#ef4444';
const THROTTLE_MS = 120;

/** Automatic parcels and buildings that exist now but not after `cmd`. Empty when `cmd` fails. */
export function removedAutoByCommand(doc: CityDoc, cmd: Command): Removal {
  const hasAuto = Object.values(doc.parcels).some((p) => p.auto) || Object.values(doc.buildings).some((b) => b.auto);
  if (!hasAuto) return NONE;
  const copy = cloneJson(doc);
  if (!tryApplyCommand(copy, cmd).ok) return NONE;
  const parcels = Object.keys(doc.parcels).filter((id) => doc.parcels[id]!.auto && !copy.parcels[id]);
  const buildings = Object.keys(doc.buildings).filter((id) => doc.buildings[id]!.auto && !copy.buildings[id]);
  return parcels.length || buildings.length ? { parcels, buildings } : NONE;
}

/** Red outlines for the removal, for ToolPreview.lines. */
export function removalLines(doc: CityDoc, r: Removal): PreviewLine[] {
  const out: PreviewLine[] = [];
  for (const id of r.parcels) {
    const pc = doc.parcels[id];
    if (pc) out.push({ pts: closedRing(pc.polygon), width: 0.9, color: REMOVAL_COLOR });
  }
  for (const id of r.buildings) {
    const b = doc.buildings[id];
    const type = b ? doc.buildingTypes[b.typeId] : undefined;
    if (b && type) for (const poly of buildingFootprints(b, type)) out.push({ pts: closedRing(poly), width: 0.9, color: REMOVAL_COLOR });
  }
  return out;
}

export class RemovalPreview {
  private key = '';
  private result: Removal = NONE;
  private at = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Removal for `cmd` (null = no pending edit). `version` = doc change counter; `onStale` runs when a throttled result is due. */
  get(doc: CityDoc, version: number, cmd: Command | null, onStale: () => void): Removal {
    if (!cmd) {
      this.reset();
      return NONE;
    }
    const key = `${version}:${JSON.stringify(cmd)}`;
    if (key === this.key) return this.result;
    const wait = this.at + THROTTLE_MS - this.now();
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          onStale();
        }, wait);
      }
      return this.result;
    }
    this.key = key;
    this.at = this.now();
    this.result = removedAutoByCommand(doc, cmd);
    return this.result;
  }

  reset(): void {
    this.key = '';
    this.result = NONE;
    this.at = -Infinity;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
