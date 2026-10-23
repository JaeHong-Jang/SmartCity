// AI proposals (ADR 0009 §5): flatten the proposed commands into items, dry-run each item on a
// cloned doc (types first, in order) and apply only the ones that still work.

import { cloneJson, tryApplyCommand, type BuildingType, type CityDoc, type Command, type Parcel } from '@smartcity/shared';

export interface ProposalItem {
  /** Position in the flattened list. */
  index: number;
  cmd: Command;
}

export interface ProposalStatus {
  reqId: number;
  /** Item index → error, for items that fail against the current doc. */
  invalid: Record<number, string>;
  total: number;
}

const ORDER: Record<string, number> = { 'buildingType.upsert': 0, 'parcel.upsert': 1 };

/** Leaf commands of the proposal (batches flattened), design commands first; otherwise the given order. */
export function proposalItems(commands: readonly Command[]): ProposalItem[] {
  const flat: Command[] = [];
  for (const c of commands) {
    if (c.type === 'batch') flat.push(...c.commands);
    else flat.push(c);
  }
  return flat
    .map((cmd, i) => ({ cmd, i }))
    .sort((a, b) => (ORDER[a.cmd.type] ?? 2) - (ORDER[b.cmd.type] ?? 2) || a.i - b.i)
    .map(({ cmd }, index) => ({ index, cmd }));
}

/** Which items fail when applied in order to a copy of `doc` (later items see earlier successes). */
export function dryRunProposal(doc: CityDoc, items: readonly ProposalItem[]): Record<number, string> {
  const copy = cloneJson(doc);
  const invalid: Record<number, string> = {};
  for (const it of items) {
    const r = tryApplyCommand(copy, it.cmd);
    if (!r.ok) invalid[it.index] = r.error;
  }
  return invalid;
}

/** One batch with the items that work (null when none do). */
export function applicableBatch(items: readonly ProposalItem[], invalid: Record<number, string>): Command | null {
  const commands = items.filter((it) => !(it.index in invalid)).map((it) => it.cmd);
  return commands.length ? { type: 'batch', commands } : null;
}

/** Designs the proposal introduces, by id (they are not in the doc until applied). */
export function proposalCatalog(items: readonly ProposalItem[]): Record<string, BuildingType> {
  const out: Record<string, BuildingType> = {};
  for (const it of items) if (it.cmd.type === 'buildingType.upsert') out[it.cmd.buildingType.id] = it.cmd.buildingType;
  return out;
}

export function proposalParcels(items: readonly ProposalItem[]): { index: number; parcel: Parcel }[] {
  const out: { index: number; parcel: Parcel }[] = [];
  for (const it of items) if (it.cmd.type === 'parcel.upsert') out.push({ index: it.index, parcel: it.cmd.parcel });
  return out;
}

/** Short Korean label of an item, for the review list. */
export function itemLabel(doc: CityDoc, catalog: Record<string, BuildingType>, cmd: Command): string {
  switch (cmd.type) {
    case 'buildingType.upsert':
      return `새 설계: ${cmd.buildingType.name}`;
    case 'building.place': {
      const t = catalog[cmd.building.typeId] ?? doc.buildingTypes[cmd.building.typeId];
      return `건물: ${t?.name ?? cmd.building.typeId} (${Math.round(cmd.building.pos.x)}, ${Math.round(cmd.building.pos.z)})`;
    }
    case 'parcel.upsert':
      return `필지: ${cmd.parcel.zone}`;
    default:
      return cmd.type;
  }
}

/** Center of the proposed buildings and parcels, to frame the camera. */
export function proposalCenter(items: readonly ProposalItem[]): { x: number; z: number } | null {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const it of items) {
    if (it.cmd.type === 'building.place') {
      x += it.cmd.building.pos.x;
      z += it.cmd.building.pos.z;
      n++;
    } else if (it.cmd.type === 'parcel.upsert' && it.cmd.parcel.polygon.length) {
      for (const v of it.cmd.parcel.polygon) {
        x += v.x;
        z += v.z;
        n++;
      }
    }
  }
  return n ? { x: x / n, z: z / n } : null;
}
