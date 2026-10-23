// Parcels and land-use regulation: the urban-design layer. Values are game simplifications of the
// Korean National Land Planning Act zones (국토계획법 시행령 용도지역별 건폐율·용적률 상한), not legal advice.

import { pointInPolygon, polygonArea, polygonBoundaryDistance, polygonInside } from './geometry.js';
import { buildingFootprints, buildingMetrics } from './editing/buildings.js';
import type { CityDoc, Parcel, ParcelZone, Regulation, Zone } from './model.js';

export const ZONE_LABELS: Record<ParcelZone, string> = {
  residential: '주거지역',
  commercial: '상업지역',
  office: '업무지역',
  industrial: '공업지역',
  public: '공공시설',
  green: '녹지지역',
};

/** Defaults per zone: 2종 일반주거, 일반상업, 업무(상업 준용), 일반공업, 공공, 자연녹지 수준. */
export const DEFAULT_REGULATIONS: Record<ParcelZone, Regulation> = {
  residential: { coverage: 0.6, far: 2.5, maxHeight: 60, setback: 3 },
  commercial: { coverage: 0.8, far: 10, maxHeight: 200, setback: 2 },
  office: { coverage: 0.7, far: 8, maxHeight: 150, setback: 3 },
  industrial: { coverage: 0.7, far: 3.5, maxHeight: 30, setback: 5 },
  public: { coverage: 0.6, far: 4, maxHeight: 40, setback: 3 },
  green: { coverage: 0.2, far: 1, maxHeight: 12, setback: 5 },
};

/** Building uses each parcel zone permits (simplified). */
export const ALLOWED_USES: Record<ParcelZone, Zone[]> = {
  residential: ['residential', 'public', 'commercial'],
  commercial: ['commercial', 'office', 'residential', 'public'],
  office: ['office', 'commercial', 'public', 'residential'],
  industrial: ['industrial', 'office', 'public'],
  public: ['public'],
  green: ['public'],
};

export type ViolationKind = 'coverage' | 'far' | 'height' | 'setback' | 'outside' | 'use';

export interface Violation {
  kind: ViolationKind;
  buildingId?: string;
  /** Observed value and the limit it breaks (ratio, meters, or a use name). */
  value: number | string;
  limit: number | string;
}

export interface ParcelCompliance {
  parcelId: string;
  area: number;
  buildingIds: string[];
  /** 건폐율 and 용적률 actually used. */
  coverage: number;
  far: number;
  maxHeight: number;
  violations: Violation[];
}

/** Buildings belong to the parcel that contains their anchor point. */
export function buildingsInParcel(doc: CityDoc, parcel: Parcel): string[] {
  return Object.keys(doc.buildings)
    .sort()
    .filter((id) => pointInPolygon(doc.buildings[id]!.pos, parcel.polygon));
}

export function parcelCompliance(doc: CityDoc, parcel: Parcel): ParcelCompliance {
  const area = polygonArea(parcel.polygon);
  const reg = parcel.regulation;
  const allowed = ALLOWED_USES[parcel.zone];
  const buildingIds = buildingsInParcel(doc, parcel);
  const violations: Violation[] = [];
  let footprint = 0;
  let gfa = 0;
  let maxHeight = 0;
  for (const id of buildingIds) {
    const b = doc.buildings[id]!;
    const type = doc.buildingTypes[b.typeId];
    if (!type) continue;
    const m = buildingMetrics(type);
    footprint += m.footprintArea;
    gfa += m.grossFloorArea;
    maxHeight = Math.max(maxHeight, m.height);
    if (m.height > reg.maxHeight + 1e-6) violations.push({ kind: 'height', buildingId: id, value: m.height, limit: reg.maxHeight });
    for (const [use, a] of Object.entries(m.areaByUse) as [Zone, number][]) {
      if (a > 0 && !allowed.includes(use)) violations.push({ kind: 'use', buildingId: id, value: use, limit: parcel.zone });
    }
    const polys = buildingFootprints(b, type);
    if (polys.some((poly) => !polygonInside(poly, parcel.polygon))) {
      violations.push({ kind: 'outside', buildingId: id, value: 0, limit: 0 });
    } else {
      const closest = Math.min(...polys.map((poly) => polygonBoundaryDistance(poly, parcel.polygon)));
      if (closest < reg.setback - 1e-6) violations.push({ kind: 'setback', buildingId: id, value: closest, limit: reg.setback });
    }
  }
  const coverage = area > 0 ? footprint / area : 0;
  const far = area > 0 ? gfa / area : 0;
  if (coverage > reg.coverage + 1e-9) violations.push({ kind: 'coverage', value: coverage, limit: reg.coverage });
  if (far > reg.far + 1e-9) violations.push({ kind: 'far', value: far, limit: reg.far });
  return { parcelId: parcel.id, area, buildingIds, coverage, far, maxHeight, violations };
}
