// Curated studio palette (LEGO/MagicaVoxel pattern): a few colors that always go together, plus
// material presets (= wall color + roof color + facade) and uses. Client constants only.

import type { Facade, PropKind, Zone } from '@smartcity/shared';

export interface Swatch {
  color: string;
  name: string;
}

export const WALL_COLORS: Swatch[] = [
  { color: '#f2efe8', name: '화이트' },
  { color: '#e8dcc8', name: '베이지' },
  { color: '#d9c3a5', name: '샌드' },
  { color: '#c98f6b', name: '테라코타' },
  { color: '#a5553f', name: '벽돌' },
  { color: '#8c6d5a', name: '브라운' },
  { color: '#b8c4c9', name: '라이트 그레이' },
  { color: '#7d8790', name: '콘크리트' },
  { color: '#4b5563', name: '차콜' },
  { color: '#a9c7d8', name: '하늘 유리' },
  { color: '#5f7f99', name: '청색 유리' },
  { color: '#c7d9b7', name: '세이지' },
];

export const ROOF_COLORS: Swatch[] = [
  { color: '#5b5f66', name: '슬레이트' },
  { color: '#3f3f46', name: '먹색 기와' },
  { color: '#9a4a32', name: '적색 기와' },
  { color: '#5f8f4e', name: '옥상 녹화' },
  { color: '#d6d3cc', name: '밝은 콘크리트' },
  { color: '#2f4f6f', name: '청색 지붕' },
];

export const ACCENT_COLORS: Swatch[] = [
  { color: '#e4572e', name: '주황' },
  { color: '#f2c14e', name: '노랑' },
  { color: '#4caf7d', name: '초록' },
  { color: '#3a86ff', name: '파랑' },
  { color: '#ff6fa8', name: '분홍' },
  { color: '#8e5cd9', name: '보라' },
];

export interface MaterialPreset {
  id: string;
  name: string;
  color: string;
  roofColor: string;
  facade: Facade;
}

export const MATERIALS: MaterialPreset[] = [
  { id: 'brick-house', name: '벽돌 주택', color: '#a5553f', roofColor: '#3f3f46', facade: { style: 'grid', windowRatio: 0.3, ground: 'none' } },
  { id: 'modern-house', name: '현대 주택', color: '#f2efe8', roofColor: '#4b5563', facade: { style: 'ribbon', windowRatio: 0.45, ground: 'none' } },
  { id: 'shop-front', name: '상가 1층', color: '#e8dcc8', roofColor: '#5b5f66', facade: { style: 'grid', windowRatio: 0.5, ground: 'shop' } },
  { id: 'curtain-wall', name: '유리 커튼월', color: '#5f7f99', roofColor: '#2f4f6f', facade: { style: 'curtain', windowRatio: 0.85, ground: 'lobby' } },
  { id: 'office-grid', name: '콘크리트 오피스', color: '#b8c4c9', roofColor: '#5b5f66', facade: { style: 'grid', windowRatio: 0.55, ground: 'lobby' } },
  { id: 'eco-terrace', name: '친환경 테라스', color: '#e7efe4', roofColor: '#5f8f4e', facade: { style: 'ribbon', windowRatio: 0.45, ground: 'none' } },
  { id: 'hanok', name: '한옥풍', color: '#efe6d6', roofColor: '#3f3f46', facade: { style: 'grid', windowRatio: 0.3, ground: 'none' } },
  { id: 'pilotis', name: '필로티', color: '#d6d3cc', roofColor: '#5b5f66', facade: { style: 'grid', windowRatio: 0.4, ground: 'pilotis' } },
  { id: 'factory', name: '공장', color: '#7d8790', roofColor: '#d6d3cc', facade: { style: 'none', windowRatio: 0.2, ground: 'none' } },
];

export const USES: Zone[] = ['residential', 'commercial', 'office', 'industrial', 'public'];

export interface PropInfo {
  label: string;
  /** wall = on a side face (faces away from it); top = on a roof or the ground. */
  mount: 'wall' | 'top';
  /** Height of the prop base above the floor it hangs on, as a share of the floor height (wall props). */
  yFrac: number;
  color: string;
}

export const PROP_INFO: Record<PropKind, PropInfo> = {
  balcony: { label: '발코니', mount: 'wall', yFrac: 0, color: '#e5e7eb' },
  awning: { label: '차양', mount: 'wall', yFrac: 0.68, color: '#e4572e' },
  sign: { label: '간판', mount: 'wall', yFrac: 0.7, color: '#3a86ff' },
  ac: { label: '실외기', mount: 'wall', yFrac: 0.12, color: '#d1d5db' },
  canopy: { label: '출입 캐노피', mount: 'wall', yFrac: 0, color: '#4b5563' },
  antenna: { label: '안테나', mount: 'top', yFrac: 0, color: '#9ca3af' },
  waterTank: { label: '물탱크', mount: 'top', yFrac: 0, color: '#60a5fa' },
  chimney: { label: '굴뚝', mount: 'top', yFrac: 0, color: '#a5553f' },
  planter: { label: '화단', mount: 'top', yFrac: 0, color: '#8c6d5a' },
  tree: { label: '나무', mount: 'top', yFrac: 0, color: '#4caf7d' },
  flag: { label: '깃발', mount: 'top', yFrac: 0, color: '#e4572e' },
  solarPanel: { label: '태양광 패널', mount: 'top', yFrac: 0, color: '#1f3a6e' },
  helipad: { label: '헬리패드', mount: 'top', yFrac: 0, color: '#30353d' },
  bench: { label: '벤치', mount: 'top', yFrac: 0, color: '#8c6d5a' },
};
