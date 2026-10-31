// Studio draft ⇄ stored design. Saving converts cells to volumes (voxelsToParts) and runs the same
// applyCommand the server runs; failures are translated and traced back to cells / props.

import {
  applyCommand,
  cloneJson,
  createEmptyDoc,
  LIMITS,
  partsToVoxels,
  VOXEL_LIMITS,
  voxelsToParts,
  type BuildingPart,
  type BuildingProp,
  type BuildingType,
  type CityDoc,
  type Command,
  type VoxelPartsResult,
  type Zone,
} from '@smartcity/shared';
import { translateDesignError } from '../ui/building/designDraft';
import type { StudioDoc } from './voxelEdit';

export interface StudioMeta {
  id: string;
  name: string;
  zone: Zone;
  /** Kept from the opened design (AI designs stay marked after an edit); new designs have none. */
  origin?: 'ai';
}

/**
 * What the studio scene bakes: the draft's volumes and props with the design's zone, so the facade (the
 * residential high-rise rule of ADR 0014 §5 reads the zone when a volume has no own use) matches the saved design.
 */
export function studioBakeInput(parts: BuildingType['parts'], props: BuildingProp[], doc: StudioDoc, zone: Zone): Pick<BuildingType, 'parts' | 'props' | 'smart' | 'zone'> {
  return { parts, props, zone, ...(doc.smart ? { smart: doc.smart } : {}) };
}

/** The design as it would be stored (parts from cells, props as placed). */
export function toBuildingType(doc: StudioDoc, meta: StudioMeta, conv: VoxelPartsResult = voxelsToParts(doc.model)): BuildingType {
  const t: BuildingType = { id: meta.id, name: meta.name, zone: meta.zone, parts: conv.parts };
  if (meta.origin) t.origin = meta.origin;
  if (doc.smart) t.smart = { ...doc.smart };
  if (doc.props.length) t.props = doc.props.map((p) => ({ ...p, pos: { ...p.pos } }));
  return t;
}

export const TOO_LARGE_KO = '스튜디오 범위(64m × 64m, 30층, 블록 4,000개)보다 큰 설계입니다. 정밀 모드에서 편집하세요';

export interface OpenResult {
  doc: StudioDoc;
  /** The stored shape was not on the 2 m grid (or mixed floor heights) and was snapped. */
  lossy: boolean;
  /** Larger than the studio can edit (VOXEL_LIMITS); only the precise editor can open it. */
  tooLarge: boolean;
}

/** Reopen a stored design as cells. Props keep their metre positions. */
export function fromBuildingType(t: Pick<BuildingType, 'parts' | 'props' | 'smart'>): OpenResult {
  const { model, lossy, tooLarge } = partsToVoxels(t.parts, 2);
  const doc: StudioDoc = { model, props: tooLarge ? [] : (t.props ?? []).map((p) => ({ ...p, pos: { ...p.pos } })) };
  if (t.smart) doc.smart = { ...t.smart };
  return { doc, lossy, tooLarge };
}

export interface Budget {
  parts: number;
  cells: number;
  props: number;
  floors: number;
}

export function budget(doc: StudioDoc, conv: VoxelPartsResult): Budget {
  let floors = 0;
  for (const p of conv.parts) floors = Math.max(floors, Math.round((p.baseHeight + p.floors * p.floorHeight) / doc.model.floorHeight));
  return { parts: conv.parts.length, cells: doc.model.cells.size, props: doc.props.length, floors };
}

export const BUDGET_MAX = { parts: LIMITS.buildingParts, cells: VOXEL_LIMITS.cells, props: LIMITS.buildingProps } as const;

const STUDIO_ERRORS_KO: [RegExp, string][] = [
  [/invalid building parts/, `덩어리(파츠)가 ${LIMITS.buildingParts}개를 넘습니다 — 색·재질 종류를 줄이거나 모양을 단순하게 하세요`],
  [/invalid building props/, `장식은 ${LIMITS.buildingProps}개까지 붙일 수 있습니다`],
  [/prop\.pos\.[xz]/, '장식이 건물에서 2m 넘게 떨어져 있습니다 — 빨간 장식을 지우거나 옮기세요'],
  [/prop\.pos\.y/, '장식이 너무 높거나 낮습니다 — 빨간 장식을 지우거나 옮기세요'],
  [/prop/, '장식 값이 올바르지 않습니다'],
];

export function translateStudioError(error: string): string {
  for (const [re, ko] of STUDIO_ERRORS_KO) if (re.test(error)) return ko;
  return translateDesignError(error);
}

export type StudioCheck =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** Cells of the volumes that fail on their own (to highlight). */
      cells: string[];
      /** Indices of props that fail on their own. */
      props: number[];
    };

type Upsert = Extract<Command, { type: 'buildingType.upsert' }>;

/** Run the save exactly as the server will (on a copy of the doc). */
function studioPreflight(city: CityDoc, cmd: Upsert): { ok: true } | { ok: false; raw: string } {
  const copy: CityDoc = { ...city, buildingTypes: { ...city.buildingTypes } };
  const r = applyCommand(copy, cmd);
  return r.ok ? { ok: true } : { ok: false, raw: r.error };
}

/**
 * Validate the draft as a save would, and find the culprits: volumes and props that fail even on
 * their own (checked against an empty city so conflicts do not hide shape errors).
 */
export function checkDesign(city: CityDoc, t: BuildingType, expectedRev: number, sources: string[][]): StudioCheck {
  if (t.parts.length === 0) return { ok: false, error: '블록을 하나 이상 쌓아야 저장할 수 있습니다', cells: [], props: [] };
  if (!t.name.trim()) return { ok: false, error: '이름을 입력하세요', cells: [], props: [] };
  const r = studioPreflight(city, { type: 'buildingType.upsert', buildingType: t, expectedRev });
  if (r.ok) return { ok: true };
  const blank = createEmptyDoc();
  const solo = (bt: BuildingType): boolean => applyCommand({ ...blank, buildingTypes: {} }, { type: 'buildingType.upsert', buildingType: bt }).ok;
  const cells: string[] = [];
  const props: number[] = [];
  if (!/^conflict/.test(r.raw)) {
    const base = { id: t.id, name: 'x', zone: t.zone } as const;
    t.parts.forEach((p: BuildingPart, i) => {
      if (!solo({ ...base, parts: [cloneJson(p)] })) cells.push(...(sources[i] ?? []));
    });
    (t.props ?? []).forEach((p, i) => {
      if (!solo({ ...base, parts: cloneJson(t.parts.slice(0, LIMITS.buildingParts)), props: [p] })) props.push(i);
    });
  }
  return { ok: false, error: translateStudioError(r.raw), cells, props };
}
