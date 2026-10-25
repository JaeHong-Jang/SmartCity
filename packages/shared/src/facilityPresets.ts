// Default facility designs (ADR 0010 §8): the design's `service` makes every building of it that facility.
// Added to new cities and by the v5 → v6 migration (only ids the doc does not have; deleted or edited
// designs are left alone). Kept apart from defaults.ts so model.ts can migrate without an import cycle.

import type { BuildingPart, BuildingType, Facade } from './model.js';

const part = (p: Partial<BuildingPart> & Pick<BuildingPart, 'width' | 'depth' | 'floors'>): BuildingPart => ({
  offset: { x: 0, z: 0 },
  floorHeight: 3.2,
  baseHeight: 0,
  roof: 'flat',
  color: '#d9d4c7',
  roofColor: '#6b6b6b',
  ...p,
});

const facade = (style: Facade['style'], windowRatio: number, ground: Facade['ground'] = 'none'): Facade => ({ style, windowRatio, ground });

export const FACILITY_PRESETS: BuildingType[] = [
  {
    id: 'svc-fire-station',
    name: '소방서',
    zone: 'public',
    service: 'fireStation',
    parts: [
      // Red-brick office block, a wide engine garage in front and a hose tower on the roof.
      part({ offset: { x: 0, z: -4 }, width: 20, depth: 14, floors: 2, floorHeight: 3.6, color: '#a8432f', roofColor: '#5b2a22', facade: facade('grid', 0.3, 'lobby') }),
      part({ offset: { x: 0, z: 8 }, width: 20, depth: 10, floors: 1, floorHeight: 5.5, color: '#8e2b22', roofColor: '#4a1f1a', facade: facade('ribbon', 0.15, 'pilotis') }),
      part({ offset: { x: 7, z: -8 }, width: 4, depth: 4, floors: 3, floorHeight: 3.2, baseHeight: 7.2, color: '#b5533c', roofColor: '#5b2a22', facade: facade('none', 0.1) }),
    ],
  },
  {
    id: 'svc-hospital',
    name: '종합병원',
    zone: 'public',
    service: 'hospital',
    parts: [
      // White ward block with an entrance wing; a red cross on the roof.
      part({ width: 30, depth: 18, floors: 5, floorHeight: 3.6, color: '#f5f7fa', roofColor: '#cfd8dc', facade: facade('ribbon', 0.5) }),
      part({ offset: { x: 0, z: 12 }, width: 12, depth: 6, floors: 1, floorHeight: 4, color: '#e8eef3', roofColor: '#cfd8dc', facade: facade('curtain', 0.7, 'lobby') }),
      part({ width: 10, depth: 3, floors: 1, floorHeight: 2, baseHeight: 18, color: '#e53935', roofColor: '#e53935', facade: facade('none', 0.1) }),
      part({ offset: { x: 0, z: 3.25 }, width: 3, depth: 3.5, floors: 1, floorHeight: 2, baseHeight: 18, color: '#e53935', roofColor: '#e53935', facade: facade('none', 0.1) }),
      part({ offset: { x: 0, z: -3.25 }, width: 3, depth: 3.5, floors: 1, floorHeight: 2, baseHeight: 18, color: '#e53935', roofColor: '#e53935', facade: facade('none', 0.1) }),
    ],
  },
  {
    id: 'svc-substation',
    name: '변전소',
    zone: 'industrial',
    service: 'substation',
    parts: [
      // Low grey switch house with a row of transformers.
      part({ width: 22, depth: 16, floors: 1, floorHeight: 4, color: '#9aa0a6', roofColor: '#6b7075', facade: facade('none', 0.1) }),
      part({ offset: { x: -8, z: 11 }, width: 4, depth: 4, floors: 1, floorHeight: 3, color: '#7d848b', roofColor: '#5f656b', facade: facade('none', 0.1) }),
      part({ offset: { x: 0, z: 11 }, width: 4, depth: 4, floors: 1, floorHeight: 3, color: '#7d848b', roofColor: '#5f656b', facade: facade('none', 0.1) }),
      part({ offset: { x: 8, z: 11 }, width: 4, depth: 4, floors: 1, floorHeight: 3, color: '#7d848b', roofColor: '#5f656b', facade: facade('none', 0.1) }),
    ],
  },
  {
    id: 'svc-power-plant',
    name: '발전소',
    zone: 'industrial',
    service: 'powerPlant',
    parts: [
      // Turbine hall with two tall stacks behind it.
      part({ width: 36, depth: 24, floors: 2, floorHeight: 7, roof: 'gable', color: '#b8b2a7', roofColor: '#6f6a62', facade: facade('ribbon', 0.2) }),
      part({ offset: { x: -10, z: 16 }, width: 4, depth: 4, floors: 20, floorHeight: 3, color: '#c9c4bb', roofColor: '#8b3a2e', facade: facade('none', 0.1) }),
      part({ offset: { x: -3, z: 16 }, width: 4, depth: 4, floors: 20, floorHeight: 3, color: '#c9c4bb', roofColor: '#8b3a2e', facade: facade('none', 0.1) }),
    ],
  },
];
