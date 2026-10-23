// Designs that automatic growth places on zoned lots (ADR 0009 §4). Sized for 16–24 m wide lots with
// the zone's default setback; added to new cities and by the v3 → v4 migration only.

import type { BuildingPart, BuildingType } from './model.js';

const part = (p: Partial<BuildingPart> & Pick<BuildingPart, 'width' | 'depth' | 'floors'>): BuildingPart => ({
  offset: { x: 0, z: 0 },
  floorHeight: 3.2,
  baseHeight: 0,
  roof: 'flat',
  color: '#d9d4c7',
  roofColor: '#6b6b6b',
  ...p,
});

export const GROWTH_PRESETS: BuildingType[] = [
  {
    id: 'grow-res-1',
    name: '골목 단독주택',
    zone: 'residential',
    growth: { level: 1 },
    parts: [part({ width: 9, depth: 8, floors: 2, roof: 'gable', color: '#f1e4d0', roofColor: '#a0522d', facade: { style: 'grid', windowRatio: 0.3, ground: 'none' } })],
  },
  {
    id: 'grow-res-2',
    name: '다세대 주택',
    zone: 'residential',
    growth: { level: 1 },
    parts: [part({ width: 12, depth: 11, floors: 4, floorHeight: 2.9, color: '#e8e2d6', roofColor: '#7c7c7c', facade: { style: 'grid', windowRatio: 0.35, ground: 'none' } })],
  },
  {
    id: 'grow-com-1',
    name: '동네 가게',
    zone: 'commercial',
    growth: { level: 1 },
    parts: [part({ width: 11, depth: 9, floors: 2, floorHeight: 3.6, color: '#d7e3ec', roofColor: '#5b6470', facade: { style: 'ribbon', windowRatio: 0.5, ground: 'shop' } })],
  },
  {
    id: 'grow-com-2',
    name: '근린 상가',
    zone: 'commercial',
    growth: { level: 1 },
    parts: [part({ width: 15, depth: 13, floors: 4, floorHeight: 3.6, color: '#cfdbe6', roofColor: '#4f5865', facade: { style: 'ribbon', windowRatio: 0.55, ground: 'shop' } })],
  },
  {
    id: 'grow-off-1',
    name: '소형 사무소',
    zone: 'office',
    growth: { level: 1 },
    parts: [part({ width: 12, depth: 12, floors: 3, floorHeight: 3.6, color: '#b9c7d6', roofColor: '#4d5966', facade: { style: 'curtain', windowRatio: 0.6, ground: 'lobby' } })],
  },
  {
    id: 'grow-off-2',
    name: '오피스 빌딩',
    zone: 'office',
    growth: { level: 1 },
    parts: [part({ width: 16, depth: 15, floors: 6, floorHeight: 3.6, color: '#9fb3c8', roofColor: '#3f4c5a', facade: { style: 'curtain', windowRatio: 0.65, ground: 'lobby' } })],
  },
];
