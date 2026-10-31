// Phase 7 presets (ADR 0014 §4·§5): median boulevards and modern high-rise designs. Added to new cities
// and by the v8 → v9 migration (only ids the doc does not have; deleted or edited ones are left alone).
// The designs have no `growth`, so automatic growth keeps choosing among the same candidates as before.
// Kept apart from defaults.ts so model.ts can migrate without an import cycle.

import type { BuildingPart, BuildingType, Facade, RoadType, SmartFeatures } from './model.js';

const kmh = (v: number): number => Math.round((v / 3.6) * 100) / 100;

export const MEDIAN_ROAD_PRESETS: RoadType[] = [
  { id: 'road-6-median', name: '6차선 대로(중앙녹지)', lanesForward: 3, lanesBackward: 3, laneWidth: 3.5, speedLimit: kmh(70), sidewalk: true, busOnlyRightLane: false, median: { width: 4, planted: true } },
  { id: 'road-8-median', name: '8차선 대로(중앙녹지)', lanesForward: 4, lanesBackward: 4, laneWidth: 3.5, speedLimit: kmh(70), sidewalk: true, busOnlyRightLane: false, median: { width: 6, planted: true } },
];

const part = (p: Partial<BuildingPart> & Pick<BuildingPart, 'width' | 'depth' | 'floors'>): BuildingPart => ({
  offset: { x: 0, z: 0 },
  floorHeight: 2.9,
  baseHeight: 0,
  roof: 'flat',
  color: '#f3f1ec',
  roofColor: '#8a8f96',
  ...p,
});

const facade = (style: Facade['style'], windowRatio: number, ground: Facade['ground'] = 'none'): Facade => ({ style, windowRatio, ground });
const smart = (s: Partial<SmartFeatures>): SmartFeatures => ({ solarRoof: 0, greenRoof: 0, evChargers: 0, sensors: false, dronePort: false, ...s });

/** Tower plan of a Korean 타워형 apartment: a cross of 12 m arms, 30 m across. */
const CROSS: BuildingPart['footprint'] = [
  { x: -6, z: -15 },
  { x: 6, z: -15 },
  { x: 6, z: -6 },
  { x: 15, z: -6 },
  { x: 15, z: 6 },
  { x: 6, z: 6 },
  { x: 6, z: 15 },
  { x: -6, z: 15 },
  { x: -6, z: 6 },
  { x: -15, z: 6 },
  { x: -15, z: -6 },
  { x: -6, z: -6 },
];

export const MODERN_BUILDING_PRESETS: BuildingType[] = [
  {
    id: 'apt-slab-25',
    name: '고층 아파트 (판상 25층)',
    zone: 'residential',
    parts: [part({ width: 52, depth: 14, floors: 25, facade: facade('grid', 0.5, 'pilotis') })],
    smart: smart({ solarRoof: 0.3 }),
  },
  {
    id: 'apt-tower-35',
    name: '고층 아파트 (타워 35층)',
    zone: 'residential',
    parts: [part({ width: 30, depth: 30, floors: 35, footprint: CROSS, facade: facade('grid', 0.5, 'pilotis') })],
  },
  {
    id: 'mixed-tower',
    name: '주상복합 타워',
    zone: 'residential',
    parts: [
      part({ width: 48, depth: 40, floors: 4, floorHeight: 4.5, color: '#cfd6dd', roofColor: '#5f6b63', use: 'commercial', facade: facade('curtain', 0.8, 'shop') }),
      part({ width: 30, depth: 26, floors: 40, floorHeight: 3, baseHeight: 18, round: 6, color: '#a9bccd', roofColor: '#4b5563', use: 'residential', facade: facade('curtain', 0.75) }),
    ],
    smart: smart({ greenRoof: 0.4, evChargers: 60, sensors: true }),
  },
  {
    id: 'glass-podium',
    name: '유리 업무 포디움',
    zone: 'office',
    parts: [
      part({ width: 64, depth: 44, floors: 4, floorHeight: 4.5, color: '#8fa7bd', roofColor: '#4f6a5a', facade: facade('curtain', 0.85, 'lobby') }),
      part({ width: 56, depth: 34, floors: 8, floorHeight: 4, baseHeight: 18, color: '#7f9ab3', roofColor: '#3f4c5a', facade: facade('curtain', 0.9) }),
    ],
    smart: smart({ solarRoof: 0.5, greenRoof: 0.3, evChargers: 40, sensors: true }),
  },
];
