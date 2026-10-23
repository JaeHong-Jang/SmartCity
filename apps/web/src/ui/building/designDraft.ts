// Pure helpers for the building editor: painting cells into a volume, stacking, metrics, and the
// same validation the server runs (applyCommand), translated to Korean.

import {
  applyCommand,
  AREA_PER_JOB,
  AREA_PER_PERSON,
  buildingMetrics,
  cellsToOutline,
  cloneJson,
  ENERGY_INTENSITY,
  GREEN_ROOF_SAVING,
  LIMITS,
  outlineToCells,
  partOutline,
  SOLAR_YIELD,
  type BuildingMetrics,
  type BuildingPart,
  type BuildingType,
  type CellKey,
  type CityDoc,
  type Command,
  type SmartFeatures,
  type Zone,
} from '@smartcity/shared';

export const CONFLICT_KO = '다른 사용자가 먼저 수정했습니다 — 최신본을 불러오거나 복제해서 저장하세요';

const DESIGN_ERRORS_KO: [RegExp, string][] = [
  [/^conflict/, CONFLICT_KO],
  [/too many corners/, `평면 꼭짓점이 ${LIMITS.footprintVertices}개를 넘습니다 — 모양을 단순하게 하세요`],
  [/must be orthogonal/, '평면은 가로·세로 선으로만 이루어져야 합니다'],
  [/footprint must be a simple polygon/, '평면 외곽선이 스스로 교차합니다'],
  [/footprint too small/, '평면이 너무 작습니다 (1㎡ 이상)'],
  [/need a flat roof/, '직접 그린 평면은 평지붕만 가능합니다'],
  [/volumes overlap/, '볼륨끼리 겹칩니다 — 시작 높이나 평면을 조정하세요'],
  [/roof equipment exceeds/, '지붕 설비(태양광+녹화+드론 포트)가 지붕 면적을 넘습니다'],
  [/invalid building type name/, `이름은 ${LIMITS.nameLength}자 이하여야 합니다`],
  [/invalid building parts/, `볼륨은 1~${LIMITS.buildingParts}개여야 합니다`],
  [/^part\.(\w+)(?:\.\w)? out of range/, '볼륨 값이 허용 범위를 벗어났습니다'],
  [/out of range|must be an integer/, '허용 범위를 벗어난 값이 있습니다'],
  [/color/, '색 값이 올바르지 않습니다'],
];

export function translateDesignError(error: string): string {
  for (const [re, ko] of DESIGN_ERRORS_KO) if (re.test(error)) return ko;
  return `저장할 수 없습니다 (${error})`;
}

export type PreflightResult = { ok: true; stored: BuildingType } | { ok: false; error: string };

/**
 * Run the save command against a copy of the doc, exactly as the server will. Only the building-type
 * record is written by `buildingType.upsert`, so copying that record is enough to keep `doc` untouched.
 * `stored` is the design as it will be stored (normalized, with the next rev).
 */
export function preflight(doc: CityDoc, cmd: Extract<Command, { type: 'buildingType.upsert' }>): PreflightResult {
  const copy: CityDoc = { ...doc, buildingTypes: { ...doc.buildingTypes } };
  const r = applyCommand(copy, cmd);
  if (!r.ok) return { ok: false, error: translateDesignError(r.error) };
  return { ok: true, stored: copy.buildingTypes[cmd.buildingType.id]! };
}

export const newPart = (p: Partial<BuildingPart> = {}): BuildingPart => ({
  offset: { x: 0, z: 0 },
  width: 12,
  depth: 10,
  floors: 3,
  floorHeight: 3.2,
  baseHeight: 0,
  roof: 'flat',
  color: '#d9d4c7',
  roofColor: '#6b6b6b',
  facade: { style: 'grid', windowRatio: 0.45, ground: 'none' },
  ...p,
});

export const partTop = (p: BuildingPart): number => p.baseHeight + p.floors * p.floorHeight;

/** A new volume with the same plan standing on top of `p`. */
export function stackOn(p: BuildingPart): BuildingPart {
  const next = cloneJson(p);
  next.baseHeight = Math.round(partTop(p) * 100) / 100;
  next.floors = Math.min(p.floors, 5);
  if (next.facade) next.facade.ground = 'none';
  return next;
}

/** A new ground volume placed just right of the existing ones (so it does not overlap them). */
export function besideParts(parts: readonly BuildingPart[]): BuildingPart {
  let maxX = -Infinity;
  for (const p of parts) for (const v of partOutline(p)) maxX = Math.max(maxX, v.x);
  const n = newPart();
  return Number.isFinite(maxX) ? { ...n, offset: { x: Math.round(maxX + n.width / 2), z: 0 } } : n;
}

export interface PaintResult {
  part: BuildingPart;
  /** Nothing painted: the volume keeps its previous plan and cannot be saved. */
  empty: boolean;
  /** Painted cells left out because they are not connected to the main region. */
  excluded: number;
  /** Empty cells inside the region that were filled (no courtyards yet). */
  filled: number;
  corners: number;
}

/** Cells (of `size`) covered by a volume's current plan, to reopen it in the painter. */
export const partCells = (p: BuildingPart, size: number): Set<CellKey> => outlineToCells(partOutline(p), size);

/** Painted cells → orthogonal footprint; bounding box into offset/width/depth, roof forced flat. */
export function applyPaint(p: BuildingPart, cells: ReadonlySet<CellKey>, size: number): PaintResult {
  const outline = cellsToOutline(cells, size);
  if (!outline) return { part: p, empty: true, excluded: 0, filled: 0, corners: 0 };
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const v of outline) {
    minX = Math.min(minX, v.x);
    minZ = Math.min(minZ, v.z);
    maxX = Math.max(maxX, v.x);
    maxZ = Math.max(maxZ, v.z);
  }
  const kept = outlineToCells(outline, size);
  let excluded = 0;
  for (const k of cells) if (!kept.has(k)) excluded++;
  let filled = 0;
  for (const k of kept) if (!cells.has(k)) filled++;
  return {
    part: { ...p, footprint: outline, offset: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 }, width: maxX - minX, depth: maxZ - minZ, roof: 'flat' },
    empty: false,
    excluded,
    filled,
    corners: outline.length,
  };
}

/** Back to a plain rectangle (the footprint's bounding box). */
export function toRectangle(p: BuildingPart): BuildingPart {
  const next = cloneJson(p);
  delete next.footprint;
  return next;
}

export const NO_SMART: SmartFeatures = { solarRoof: 0, greenRoof: 0, evChargers: 0, sensors: false, dronePort: false };

/** Share of the roof used by roof equipment (the drone pad takes a fixed 10 %), same rule as applyCommand. */
export const roofBudget = (s: SmartFeatures | undefined): number => (s ? s.solarRoof + s.greenRoof + (s.dronePort ? 0.1 : 0) : 0);

export interface DesignEstimates extends BuildingMetrics {
  residents: number;
  jobs: number;
  /** kWh per day */
  energy: number;
  solar: number;
}

/** Per-building indicators with the coefficients of shared `designStats`. */
export function designEstimates(t: BuildingType): DesignEstimates {
  const m = buildingMetrics(t);
  let jobs = 0;
  let energy = 0;
  for (const use of Object.keys(m.areaByUse) as Zone[]) {
    energy += m.areaByUse[use] * ENERGY_INTENSITY[use];
    if (use !== 'residential') jobs += m.areaByUse[use] / AREA_PER_JOB[use];
  }
  const s = t.smart;
  if (s) energy *= 1 - GREEN_ROOF_SAVING * s.greenRoof;
  return {
    ...m,
    residents: Math.round(m.areaByUse.residential / AREA_PER_PERSON),
    jobs: Math.round(jobs),
    energy,
    solar: s ? m.roofArea * s.solarRoof * SOLAR_YIELD : 0,
  };
}
