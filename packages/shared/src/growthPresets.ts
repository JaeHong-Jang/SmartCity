// Designs that automatic growth places on zoned lots (ADR 0009 §4). Sized for 16–24 m wide lots with
// the zone's default setback; added to new cities and by the migrations (v3 → v4: the first six, v4 → v5:
// the variants). Variants share their base's zone, lot size class and gross floor area (±15%), so only the look changes.

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

/** The presets of the v3 → v4 migration; the others were added by v4 → v5. */
export const BASE_GROWTH_PRESET_IDS: readonly string[] = ['grow-res-1', 'grow-res-2', 'grow-com-1', 'grow-com-2', 'grow-off-1', 'grow-off-2'];

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

  // ---- Variants (v5): same zone and lot class as the base preset, floor area within ±15% of it ----
  {
    id: 'grow-res-1b',
    name: '모임지붕 주택',
    zone: 'residential',
    growth: { level: 1 },
    parts: [part({ width: 8, depth: 8, floors: 2, roof: 'pyramid', color: '#e9dcc3', roofColor: '#7b4b3a', facade: { style: 'grid', windowRatio: 0.28, ground: 'none' } })],
  },
  {
    id: 'grow-res-1c',
    name: '단차 벽돌집',
    zone: 'residential',
    growth: { level: 1 },
    parts: [
      part({ offset: { x: 0, z: -1.5 }, width: 9, depth: 5, floors: 2, color: '#b5654a', roofColor: '#5b5b5b', facade: { style: 'grid', windowRatio: 0.28, ground: 'none' } }),
      part({ offset: { x: -2, z: 2.5 }, width: 5, depth: 3, floors: 3, roof: 'gable', color: '#c47a5c', roofColor: '#7a3f2e', facade: { style: 'grid', windowRatio: 0.3, ground: 'none' } }),
    ],
  },
  {
    id: 'grow-res-1d',
    name: '필로티 원룸',
    zone: 'residential',
    growth: { level: 1 },
    parts: [part({ width: 7, depth: 7.5, floors: 3, color: '#c9c5bb', roofColor: '#8a8a8a', facade: { style: 'ribbon', windowRatio: 0.4, ground: 'pilotis' } })],
  },
  {
    id: 'grow-res-2b',
    name: '박공 빌라',
    zone: 'residential',
    growth: { level: 1 },
    parts: [part({ width: 12, depth: 10.5, floors: 4, floorHeight: 2.9, roof: 'gable', color: '#c98f6b', roofColor: '#6a3b30', facade: { style: 'grid', windowRatio: 0.32, ground: 'none' } })],
  },
  {
    id: 'grow-res-2c',
    name: '단차 연립',
    zone: 'residential',
    growth: { level: 1 },
    parts: [
      part({ offset: { x: 0, z: -2.5 }, width: 12, depth: 6, floors: 4, floorHeight: 2.9, color: '#d8cfc0', roofColor: '#7c7c7c', facade: { style: 'grid', windowRatio: 0.35, ground: 'none' } }),
      part({ offset: { x: 0, z: 3 }, width: 12, depth: 5, floors: 3, floorHeight: 2.9, roof: 'gable', color: '#c4a98a', roofColor: '#6b4a3a', facade: { style: 'grid', windowRatio: 0.3, ground: 'none' } }),
    ],
  },
  {
    id: 'grow-res-2d',
    name: '필로티 아파트',
    zone: 'residential',
    growth: { level: 1 },
    parts: [part({ width: 11, depth: 11, floors: 4, floorHeight: 3, color: '#d9d9d4', roofColor: '#8a8f95', facade: { style: 'ribbon', windowRatio: 0.4, ground: 'pilotis' } })],
  },
  {
    id: 'grow-com-1b',
    name: '코너 상가',
    zone: 'commercial',
    growth: { level: 1 },
    parts: [
      part({ offset: { x: 0, z: -2 }, width: 11, depth: 5, floors: 3, floorHeight: 3.6, color: '#b8735a', roofColor: '#4a4a4a', facade: { style: 'grid', windowRatio: 0.4, ground: 'shop' } }),
      part({ offset: { x: -2.5, z: 2.5 }, width: 6, depth: 4, floors: 2, floorHeight: 3.6, color: '#d8c9a8', roofColor: '#5b5b5b', facade: { style: 'ribbon', windowRatio: 0.5, ground: 'shop' } }),
    ],
  },
  {
    id: 'grow-com-1c',
    name: '박공 점포',
    zone: 'commercial',
    growth: { level: 1 },
    parts: [part({ width: 10, depth: 9, floors: 2, floorHeight: 3.6, roof: 'gable', color: '#e8d9b8', roofColor: '#8a4b38', facade: { style: 'grid', windowRatio: 0.38, ground: 'shop' } })],
  },
  {
    id: 'grow-com-1d',
    name: '저층부 상가',
    zone: 'commercial',
    growth: { level: 1 },
    parts: [
      part({ width: 11, depth: 9, floors: 1, floorHeight: 3.6, color: '#8e8a84', roofColor: '#4d4d4d', facade: { style: 'ribbon', windowRatio: 0.5, ground: 'shop' } }),
      part({ width: 7, depth: 7, floors: 2, floorHeight: 3.6, baseHeight: 3.6, color: '#cfd8dc', roofColor: '#5b6470', facade: { style: 'curtain', windowRatio: 0.6, ground: 'none' } }),
    ],
  },
  {
    id: 'grow-com-2b',
    name: '코너 상가 빌딩',
    zone: 'commercial',
    growth: { level: 1 },
    parts: [
      part({ offset: { x: 0, z: -3 }, width: 15, depth: 7, floors: 5, floorHeight: 3.6, color: '#d8c9a8', roofColor: '#555b63', facade: { style: 'ribbon', windowRatio: 0.5, ground: 'shop' } }),
      part({ offset: { x: -3.5, z: 3.5 }, width: 8, depth: 6, floors: 4, floorHeight: 3.6, color: '#b99a82', roofColor: '#4f5865', facade: { style: 'grid', windowRatio: 0.4, ground: 'shop' } }),
    ],
  },
  {
    id: 'grow-com-2c',
    name: '탑형 상가',
    zone: 'commercial',
    growth: { level: 1 },
    parts: [
      part({ width: 15, depth: 13, floors: 2, floorHeight: 3.6, color: '#9a948b', roofColor: '#4d4d4d', facade: { style: 'ribbon', windowRatio: 0.5, ground: 'shop' } }),
      part({ width: 9, depth: 9, floors: 5, floorHeight: 3.6, baseHeight: 7.2, color: '#cfd6dc', roofColor: '#4f5865', facade: { style: 'curtain', windowRatio: 0.6, ground: 'none' } }),
    ],
  },
  {
    id: 'grow-com-2d',
    name: '박공 근린상가',
    zone: 'commercial',
    growth: { level: 1 },
    parts: [part({ width: 15, depth: 12.5, floors: 4, floorHeight: 3.6, roof: 'gable', color: '#e3d6c0', roofColor: '#6b4a3a', facade: { style: 'grid', windowRatio: 0.42, ground: 'shop' } })],
  },
  {
    id: 'grow-off-1b',
    name: '유리 사무동',
    zone: 'office',
    growth: { level: 1 },
    parts: [part({ width: 12, depth: 11, floors: 3, floorHeight: 3.6, color: '#7fa6bf', roofColor: '#3d4a56', facade: { style: 'curtain', windowRatio: 0.78, ground: 'lobby' } })],
  },
  {
    id: 'grow-off-1c',
    name: '단차 사무소',
    zone: 'office',
    growth: { level: 1 },
    parts: [
      part({ offset: { x: 0, z: -2.5 }, width: 12, depth: 7, floors: 4, floorHeight: 3.6, color: '#d3d3cf', roofColor: '#5a5f66', facade: { style: 'ribbon', windowRatio: 0.5, ground: 'none' } }),
      part({ offset: { x: 0, z: 3.5 }, width: 12, depth: 5, floors: 2, floorHeight: 3.6, color: '#9fb3c8', roofColor: '#4d5966', facade: { style: 'curtain', windowRatio: 0.6, ground: 'lobby' } }),
    ],
  },
  {
    id: 'grow-off-1d',
    name: '필로티 사무동',
    zone: 'office',
    growth: { level: 1 },
    parts: [part({ width: 11, depth: 12, floors: 3, floorHeight: 3.6, color: '#c8c4bb', roofColor: '#6b6b6b', facade: { style: 'grid', windowRatio: 0.5, ground: 'pilotis' } })],
  },
  {
    id: 'grow-off-2b',
    name: '유리 타워',
    zone: 'office',
    growth: { level: 1 },
    parts: [
      part({ width: 16, depth: 15, floors: 2, floorHeight: 3.6, color: '#8d9aa6', roofColor: '#3f4c5a', facade: { style: 'ribbon', windowRatio: 0.5, ground: 'lobby' } }),
      part({ width: 11, depth: 11, floors: 8, floorHeight: 3.6, baseHeight: 7.2, color: '#8fb4cc', roofColor: '#3f4c5a', facade: { style: 'curtain', windowRatio: 0.75, ground: 'none' } }),
    ],
  },
  {
    id: 'grow-off-2c',
    name: 'L자 오피스',
    zone: 'office',
    growth: { level: 1 },
    parts: [
      part({ offset: { x: 0, z: -3.5 }, width: 16, depth: 8, floors: 8, floorHeight: 3.6, color: '#c9ccd0', roofColor: '#4a4f55', facade: { style: 'ribbon', windowRatio: 0.55, ground: 'lobby' } }),
      part({ offset: { x: -3.5, z: 4 }, width: 9, depth: 7, floors: 7, floorHeight: 3.6, color: '#aab4be', roofColor: '#4a4f55', facade: { style: 'curtain', windowRatio: 0.65, ground: 'lobby' } }),
    ],
  },
  {
    id: 'grow-off-2d',
    name: '회색 오피스동',
    zone: 'office',
    growth: { level: 1 },
    parts: [part({ width: 15, depth: 15, floors: 6, floorHeight: 3.6, color: '#6e747b', roofColor: '#3a3f45', facade: { style: 'ribbon', windowRatio: 0.45, ground: 'lobby' } })],
  },
];
