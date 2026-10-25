// AI proposals (ADR 0009 §5): flatten the proposed commands into items, dry-run each item on a
// cloned doc (types first, in order) and apply only the ones that still work.

import { cloneJson, describeRoadBatch, sampleSegmentCurve, tryApplyCommand, type BuildingType, type CityDoc, type Command, type Parcel, type RoadBatchInfo, type Vec2 } from '@smartcity/shared';

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

/** A road made by the AI (ADR 0010 §9): one atomic batch of node/split/segment commands. */
export const isRoadBatch = (c: Command): boolean => c.type === 'batch' && c.commands.some((x) => x.type === 'segment.add');

// Designs, then roads (buildings can stand beside them), then lots, then buildings.
const ORDER: Record<string, number> = { 'buildingType.upsert': 0, batch: 1, 'parcel.upsert': 2 };

/**
 * Items of the proposal: designs first, then roads, lots and buildings; otherwise the given order. Batches
 * are flattened except a road batch, which stays one item (it succeeds or fails as a whole).
 */
export function proposalItems(commands: readonly Command[]): ProposalItem[] {
  const flat: Command[] = [];
  for (const c of commands) {
    if (c.type === 'batch' && !isRoadBatch(c)) flat.push(...c.commands);
    else flat.push(c);
  }
  return flat
    .map((cmd, i) => ({ cmd, i }))
    .sort((a, b) => (ORDER[a.cmd.type] ?? 3) - (ORDER[b.cmd.type] ?? 3) || a.i - b.i)
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

/** One batch with the items that work (null when none do). Batches cannot nest: a road's commands are spliced in. */
export function applicableBatch(items: readonly ProposalItem[], invalid: Record<number, string>): Command | null {
  const commands = items.filter((it) => !(it.index in invalid)).flatMap((it) => (it.cmd.type === 'batch' ? it.cmd.commands : [it.cmd]));
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

let roadMemo: { items: readonly ProposalItem[]; version: number; infos: Map<number, RoadBatchInfo | null> } | null = null;

/**
 * What each road item builds, computed on the same sequential working doc as the dry run (a later road may
 * split an earlier proposed one). Cached per items array and doc version, so coordinates follow doc edits.
 */
export function proposalRoadInfos(doc: CityDoc, items: readonly ProposalItem[], version: number): Map<number, RoadBatchInfo | null> {
  if (roadMemo && roadMemo.items === items && roadMemo.version === version) return roadMemo.infos;
  const infos = new Map<number, RoadBatchInfo | null>();
  const work = cloneJson(doc);
  for (const it of items) {
    if (!isRoadBatch(it.cmd)) continue;
    infos.set(it.index, describeRoadBatch(work, it.cmd));
    tryApplyCommand(work, it.cmd);
  }
  roadMemo = { items, version, infos };
  return infos;
}

/** Short Korean label of an item, for the review list. */
export function itemLabel(doc: CityDoc, catalog: Record<string, BuildingType>, cmd: Command, roadInfo?: RoadBatchInfo | null): string {
  switch (cmd.type) {
    case 'buildingType.upsert':
      return `새 설계: ${cmd.buildingType.name}`;
    case 'building.place': {
      const t = catalog[cmd.building.typeId] ?? doc.buildingTypes[cmd.building.typeId];
      return `건물: ${t?.name ?? cmd.building.typeId} (${Math.round(cmd.building.pos.x)}, ${Math.round(cmd.building.pos.z)})`;
    }
    case 'parcel.upsert':
      return `필지: ${cmd.parcel.zone}`;
    case 'batch': {
      const info = isRoadBatch(cmd) ? (roadInfo !== undefined ? roadInfo : describeRoadBatch(doc, cmd)) : null;
      return info ? `도로 ${Math.round(info.lengthM)} m (연결 ${info.connected}, 분할 ${info.splits})` : '도로';
    }
    default:
      return cmd.type;
  }
}

/** Center of the proposed buildings, parcels and new road nodes, to frame the camera. */
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
    } else if (it.cmd.type === 'batch' && isRoadBatch(it.cmd)) {
      for (const c of it.cmd.commands) {
        if (c.type !== 'node.add') continue;
        x += c.node.pos.x;
        z += c.node.pos.z;
        n++;
      }
    }
  }
  return n ? { x: x / n, z: z / n } : null;
}

/** Center lines of the new roads, for the preview; roads that no longer apply are drawn from the nodes still known. */
export function proposalRoads(doc: CityDoc, items: readonly ProposalItem[], version: number): { index: number; pieces: { points: Vec2[]; roadTypeId: string }[] }[] {
  const out: { index: number; pieces: { points: Vec2[]; roadTypeId: string }[] }[] = [];
  for (const it of items) {
    if (it.cmd.type !== 'batch' || !isRoadBatch(it.cmd)) continue;
    const info = proposalRoadInfos(doc, items, version).get(it.index);
    if (info) {
      out.push({ index: it.index, pieces: info.pieces });
      continue;
    }
    const pos = new Map<string, Vec2>(Object.values(doc.nodes).map((n) => [n.id, n.pos]));
    for (const c of it.cmd.commands) if (c.type === 'node.add') pos.set(c.node.id, c.node.pos);
    const pieces: { points: Vec2[]; roadTypeId: string }[] = [];
    for (const c of it.cmd.commands) {
      if (c.type !== 'segment.add') continue;
      const a = pos.get(c.segment.a);
      const b = pos.get(c.segment.b);
      if (a && b) pieces.push({ points: sampleSegmentCurve(a, b, c.segment.control), roadTypeId: c.segment.roadTypeId });
    }
    out.push({ index: it.index, pieces });
  }
  return out;
}
