// Why an automatic lot stays empty (ADR 0009 §4), computed from the doc for the parcel inspector.

import { buildingsInParcel, parcelCompliance, type CityDoc, type Parcel, type Zone } from '@smartcity/shared';
import { GROWTH_DEMAND_MIN, type DemandBars } from './growthDemand';

const USE_KO: Record<string, string> = { residential: '주거', commercial: '상업', office: '업무' };

function centroidOf(poly: readonly { x: number; z: number }[]): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p.x;
    z += p.z;
  }
  return { x: x / poly.length, z: z / poly.length };
}

/** Whether some growth design of the lot's zone fits it without regulation violations (4 orientations tried). */
export function someDesignFits(doc: CityDoc, parcel: Parcel): boolean {
  const at = centroidOf(parcel.polygon);
  for (const type of Object.values(doc.buildingTypes)) {
    if (!type.growth || type.zone !== (parcel.zone as Zone)) continue;
    for (let k = 0; k < 4; k++) {
      const trial = { ...doc, buildings: { ...doc.buildings, __trial__: { id: '__trial__', typeId: type.id, pos: at, rotation: (k * Math.PI) / 2 } } };
      if (parcelCompliance(trial, parcel).violations.length === 0) return true;
    }
  }
  return false;
}

/** Reasons an empty auto lot does not grow (empty list = nothing blocks it; it grows over time). */
export function growthBlockers(doc: CityDoc, parcel: Parcel, demand: DemandBars | null): string[] {
  if (!parcel.auto || buildingsInParcel(doc, parcel).length > 0) return [];
  const out: string[] = [];
  if (doc.meta.growth === false) out.push('자동 성장이 꺼져 있습니다 (상단 "자동 성장" 켜기)');
  if (parcel.zone === 'industrial') out.push('산업 성장은 아직 지원하지 않습니다');
  else if (parcel.zone !== 'residential' && parcel.zone !== 'commercial' && parcel.zone !== 'office') out.push('이 용도지역은 자동 성장 대상이 아닙니다');
  else if (demand && demand[parcel.zone] <= GROWTH_DEMAND_MIN) out.push(`${USE_KO[parcel.zone]} 수요가 낮습니다 (${Math.round(demand[parcel.zone] * 100)}%, ${Math.round(GROWTH_DEMAND_MIN * 100)}% 초과 필요)`);
  const f = parcel.frontage;
  if (!f || !doc.segments[f.segmentId]) out.push('접한 도로가 없습니다 (도로가 철거·분할되었거나 지정되지 않음)');
  if ((parcel.zone === 'residential' || parcel.zone === 'commercial' || parcel.zone === 'office') && !someDesignFits(doc, parcel)) out.push('이 필지에 들어가는 성장 설계가 없습니다');
  return out;
}
