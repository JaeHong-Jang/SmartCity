// Facilities of the simulated copy (BuildingType.service) and the hint shown before an emergency is created.

import type { CityDoc } from '@smartcity/shared';

export interface FacilityCounts {
  fireStation: number;
  hospital: number;
  substation: number;
  powerPlant: number;
}

export function countFacilities(doc: CityDoc): FacilityCounts {
  const out: FacilityCounts = { fireStation: 0, hospital: 0, substation: 0, powerPlant: 0 };
  for (const b of Object.values(doc.buildings)) {
    const service = doc.buildingTypes[b.typeId]?.service;
    if (service) out[service]++;
  }
  return out;
}

/** Supply model note shown with the facility counts (ADR 0010 §8). */
export const SUPPLY_MODEL_NOTE = '커버리지 기반 공급 모델';

export const FACILITY_SUMMARY = (c: FacilityCounts): string => `소방서 ${c.fireStation} · 병원 ${c.hospital} · 변전소 ${c.substation} · 발전소 ${c.powerPlant}`;

/** Warning for a fire / medical call that no facility can answer (the event can still be created). Null = fine. */
export function facilityHint(kind: 'fire' | 'medical' | 'blackout', c: FacilityCounts): string | null {
  if (kind === 'blackout') return c.substation > 0 ? null : '변전소가 없어 변전소 정전은 쓸 수 없습니다 — 구역 정전을 쓰거나 도시에 변전소를 지어 두세요';
  if (kind === 'fire') return c.fireStation > 0 ? null : '소방서가 없어 출동할 수 없습니다 — 도시에 소방서를 지어 두세요';
  return c.hospital > 0 ? null : '병원이 없어 출동할 수 없습니다 — 도시에 병원을 지어 두세요';
}
