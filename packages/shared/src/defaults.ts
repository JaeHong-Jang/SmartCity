// Built-in presets every new city starts with. Users can edit or add their own through commands.

import { FACILITY_PRESETS } from './facilityPresets.js';
import { GROWTH_PRESETS } from './growthPresets.js';
import { MEDIAN_ROAD_PRESETS, MODERN_BUILDING_PRESETS } from './modernPresets.js';
import { cloneJson, DOC_VERSION, type BuildingPart, type BuildingType, type CityDoc, type Facade, type RoadType, type SmartFeatures, type VehiclePart, type VehicleType } from './model.js';

const kmh = (v: number): number => Math.round((v / 3.6) * 100) / 100;

export const DEFAULT_ROAD_TYPES: RoadType[] = [
  { id: 'road-2', name: '2차선 도로', lanesForward: 1, lanesBackward: 1, laneWidth: 3.5, speedLimit: kmh(50), sidewalk: true, busOnlyRightLane: false },
  { id: 'road-4', name: '4차선 도로', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, speedLimit: kmh(60), sidewalk: true, busOnlyRightLane: false },
  { id: 'road-6', name: '6차선 대로', lanesForward: 3, lanesBackward: 3, laneWidth: 3.5, speedLimit: kmh(70), sidewalk: true, busOnlyRightLane: false },
  { id: 'oneway-2', name: '일방통행 2차선', lanesForward: 2, lanesBackward: 0, laneWidth: 3.5, speedLimit: kmh(50), sidewalk: true, busOnlyRightLane: false },
  { id: 'road-4-bus', name: '4차선 + 버스전용', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, speedLimit: kmh(60), sidewalk: true, busOnlyRightLane: true },
];

const part = (p: Partial<BuildingPart> & Pick<BuildingPart, 'width' | 'depth' | 'floors'>): BuildingPart => ({
  offset: { x: 0, z: 0 },
  floorHeight: 3.2,
  baseHeight: 0,
  roof: 'flat',
  color: '#d9d4c7',
  roofColor: '#6b6b6b',
  ...p,
});

export const DEFAULT_BUILDING_TYPES: BuildingType[] = [
  { id: 'house', name: '단독주택', zone: 'residential', parts: [part({ width: 10, depth: 9, floors: 2, roof: 'gable', color: '#efe3cf', roofColor: '#9c4a2f' })] },
  { id: 'apartment', name: '아파트', zone: 'residential', parts: [part({ width: 28, depth: 14, floors: 15, floorHeight: 2.9, color: '#e9e7e1', roofColor: '#8a8a8a' })] },
  { id: 'shop', name: '근린상가', zone: 'commercial', parts: [part({ width: 16, depth: 12, floors: 3, color: '#c9d8e6', roofColor: '#555b66' })] },
  {
    id: 'office-tower',
    name: '오피스 타워',
    zone: 'office',
    parts: [
      part({ width: 34, depth: 30, floors: 4, floorHeight: 4, color: '#9fb3c8', roofColor: '#5d6b7a' }),
      part({ width: 20, depth: 18, floors: 28, floorHeight: 3.6, baseHeight: 16, color: '#7d9bb8', roofColor: '#3f4c5a' }),
    ],
  },
  { id: 'factory', name: '공장', zone: 'industrial', parts: [part({ width: 40, depth: 26, floors: 1, floorHeight: 9, roof: 'gable', color: '#c2b8a3', roofColor: '#7a7f86' })] },
  {
    id: 'city-hall',
    name: '시청',
    zone: 'public',
    parts: [
      part({ width: 40, depth: 16, floors: 5, floorHeight: 3.8, color: '#f0ece2', roofColor: '#6f7d6a' }),
      part({ offset: { x: -12, z: 15 }, width: 16, depth: 14, floors: 5, floorHeight: 3.8, color: '#f0ece2', roofColor: '#6f7d6a' }),
      part({ offset: { x: 0, z: 0 }, width: 10, depth: 10, floors: 2, floorHeight: 3.8, baseHeight: 19, roof: 'pyramid', color: '#e5dfd0', roofColor: '#4d6b57' }),
    ],
  },
];

const GLASS = '#26313d';
const TIRE = '#1b1b1b';

const box = (x: number, y: number, z: number, length: number, width: number, height: number, color: string): VehiclePart => ({
  offset: { x, y, z },
  length,
  width,
  height,
  color,
});

function wheels(length: number, width: number, axles = 2): VehiclePart[] {
  const xs = axles === 2 ? [length * 0.32, -length * 0.32] : [length * 0.36, -length * 0.18, -length * 0.36];
  return xs.flatMap((x) => [box(x, 0, width / 2 - 0.15, 0.75, 0.3, 0.7, TIRE), box(x, 0, -(width / 2 - 0.15), 0.75, 0.3, 0.7, TIRE)]);
}

function carParts(l: number, w: number, h: number, color: string): VehiclePart[] {
  const bodyH = h * 0.42;
  return [
    box(0, 0.3, 0, l, w, bodyH, color),
    box(-l * 0.06, 0.3 + bodyH, 0, l * 0.52, w * 0.9, h - 0.3 - bodyH, GLASS),
    ...wheels(l, w),
  ];
}

function busParts(l: number, w: number, h: number, color: string): VehiclePart[] {
  return [
    box(0, 0.35, 0, l, w, h - 0.35, color),
    box(0.1, h - 1.45, 0, l - 0.6, w + 0.02, 0.9, GLASS),
    box(l / 2 - 0.05, 0.9, 0, 0.12, w * 0.9, h - 1.3, GLASS),
    ...wheels(l, w),
  ];
}

function truckParts(l: number, w: number, h: number, color: string): VehiclePart[] {
  const cab = 2.2;
  return [
    box(l / 2 - cab / 2, 0.4, 0, cab, w, h * 0.72, color),
    box(l / 2 - 0.3, 0.4 + h * 0.36, 0, 0.5, w * 0.92, h * 0.28, GLASS),
    box(-cab / 2 + 0.1, 0.5, 0, l - cab - 0.2, w, h - 0.5, '#e4e4e0'),
    ...wheels(l, w, 3),
  ];
}

function ambulanceParts(l: number, w: number, h: number, color: string): VehiclePart[] {
  return [
    box(0, 0.35, 0, l, w, h - 0.55, color),
    box(l / 2 - 0.7, 1.2, 0, 1.0, w + 0.02, 0.6, GLASS),
    box(0, 1.0, 0, l * 0.98, w + 0.04, 0.25, '#d32f2f'),
    box(l / 2 - 1.2, h - 0.2, 0, 0.4, w * 0.7, 0.2, '#ff3b30'),
    ...wheels(l, w),
  ];
}

const facade = (style: Facade['style'], windowRatio: number, ground: Facade['ground'] = 'none'): Facade => ({ style, windowRatio, ground });
const smart = (s: Partial<SmartFeatures>): SmartFeatures => ({ solarRoof: 0, greenRoof: 0, evChargers: 0, sensors: false, dronePort: false, ...s });

/** Future smart-city designs: starting points for the building editor. */
export const SMART_CITY_PRESETS: BuildingType[] = [
  {
    id: 'eco-tower',
    name: '친환경 테라스 타워',
    zone: 'residential',
    parts: [
      part({ width: 32, depth: 28, floors: 8, floorHeight: 3.1, color: '#e7efe4', roofColor: '#5f8f4e', facade: facade('ribbon', 0.45, 'lobby') }),
      part({ width: 26, depth: 22, floors: 8, floorHeight: 3.1, baseHeight: 24.8, color: '#e7efe4', roofColor: '#5f8f4e', facade: facade('ribbon', 0.45) }),
      part({ width: 20, depth: 16, floors: 8, floorHeight: 3.1, baseHeight: 49.6, color: '#e7efe4', roofColor: '#5f8f4e', facade: facade('ribbon', 0.45) }),
    ],
    smart: smart({ solarRoof: 0.5, greenRoof: 0.4, evChargers: 24, sensors: true }),
  },
  {
    id: 'mixed-use',
    name: '주상복합 (상가+주거)',
    zone: 'residential',
    parts: [
      part({ width: 36, depth: 30, floors: 3, floorHeight: 4.5, color: '#d6cfc2', roofColor: '#4b5563', use: 'commercial', facade: facade('curtain', 0.8, 'shop') }),
      part({ width: 24, depth: 18, floors: 22, floorHeight: 2.9, baseHeight: 13.5, color: '#eeeae2', roofColor: '#6b7280', use: 'residential', facade: facade('grid', 0.4) }),
    ],
    smart: smart({ solarRoof: 0.3, greenRoof: 0.3, evChargers: 30, sensors: true }),
  },
  {
    id: 'smart-office',
    name: '스마트 오피스',
    zone: 'office',
    parts: [part({ width: 30, depth: 30, floors: 24, floorHeight: 3.8, color: '#8fb3d1', roofColor: '#334155', facade: facade('curtain', 0.85, 'lobby') })],
    smart: smart({ solarRoof: 0.6, evChargers: 40, sensors: true }),
  },
  {
    id: 'data-center',
    name: '데이터센터',
    zone: 'industrial',
    parts: [part({ width: 48, depth: 32, floors: 3, floorHeight: 6, color: '#cbd5e1', roofColor: '#64748b', facade: facade('none', 0.1) })],
    smart: smart({ solarRoof: 0.8, sensors: true }),
  },
  {
    id: 'vertical-farm',
    name: '수직농장',
    zone: 'industrial',
    parts: [part({ width: 24, depth: 24, floors: 12, floorHeight: 4, color: '#bbf7d0', roofColor: '#15803d', facade: facade('curtain', 0.9) })],
    smart: smart({ solarRoof: 0.4, greenRoof: 0.5, sensors: true }),
  },
  {
    id: 'mobility-hub',
    name: '모빌리티 허브',
    zone: 'public',
    parts: [part({ width: 40, depth: 28, floors: 5, floorHeight: 3.6, color: '#e2e8f0', roofColor: '#1e293b', use: 'public', facade: facade('ribbon', 0.35, 'pilotis') })],
    smart: smart({ solarRoof: 0.6, evChargers: 120, sensors: true, dronePort: true }),
  },
  {
    id: 'school',
    name: '스마트 학교',
    zone: 'public',
    parts: [
      part({
        width: 44,
        depth: 36,
        offset: { x: 0, z: 0 },
        floors: 4,
        floorHeight: 3.6,
        color: '#fde68a',
        roofColor: '#78716c',
        footprint: [
          { x: -22, z: -18 },
          { x: 22, z: -18 },
          { x: 22, z: -6 },
          { x: -10, z: -6 },
          { x: -10, z: 18 },
          { x: -22, z: 18 },
        ],
        facade: facade('grid', 0.5, 'lobby'),
      }),
    ],
    smart: smart({ solarRoof: 0.5, greenRoof: 0.3, evChargers: 6, sensors: true }),
  },
  {
    id: 'hospital',
    name: '스마트 병원',
    zone: 'public',
    parts: [
      part({ width: 50, depth: 36, floors: 4, floorHeight: 4.2, color: '#f8fafc', roofColor: '#94a3b8', facade: facade('ribbon', 0.5, 'lobby') }),
      part({ width: 30, depth: 20, floors: 10, floorHeight: 3.8, baseHeight: 16.8, color: '#f1f5f9', roofColor: '#94a3b8', facade: facade('ribbon', 0.5) }),
    ],
    smart: smart({ solarRoof: 0.4, evChargers: 20, sensors: true, dronePort: true }),
  },
];

export const DEFAULT_VEHICLE_TYPES: VehicleType[] = [
  { id: 'sedan', name: '승용차', kind: 'car', length: 4.6, width: 1.85, height: 1.45, maxSpeed: kmh(110), maxAccel: 1.6, comfortDecel: 2.5, color: '#3d6fb6', spawnWeight: 60, parts: carParts(4.6, 1.85, 1.45, '#3d6fb6') },
  { id: 'suv', name: 'SUV', kind: 'car', length: 4.9, width: 1.95, height: 1.75, maxSpeed: kmh(110), maxAccel: 1.4, comfortDecel: 2.5, color: '#e8e8e8', spawnWeight: 25, parts: carParts(4.9, 1.95, 1.75, '#e8e8e8') },
  { id: 'truck', name: '화물트럭', kind: 'truck', length: 8.5, width: 2.5, height: 3.3, maxSpeed: kmh(90), maxAccel: 0.8, comfortDecel: 2.0, color: '#d98b2b', spawnWeight: 10, parts: truckParts(8.5, 2.5, 3.3, '#d98b2b') },
  { id: 'city-bus', name: '시내버스', kind: 'bus', length: 11.5, width: 2.5, height: 3.2, maxSpeed: kmh(80), maxAccel: 1.0, comfortDecel: 2.0, color: '#2f9e62', spawnWeight: 0, parts: busParts(11.5, 2.5, 3.2, '#2f9e62') },
  { id: 'ambulance', name: '구급차', kind: 'emergency', length: 6.0, width: 2.1, height: 2.6, maxSpeed: kmh(120), maxAccel: 2.0, comfortDecel: 3.0, color: '#f4f4f4', spawnWeight: 0, parts: ambulanceParts(6.0, 2.1, 2.6, '#f4f4f4') },
];

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((i) => [i.id, cloneJson(i)]));

const withRev = (types: BuildingType[]): BuildingType[] => types.map((t) => ({ ...t, rev: 1 }));

export function createEmptyDoc(name = '새 도시', seed = 1): CityDoc {
  return {
    version: DOC_VERSION,
    meta: { name, seed, halfSize: 2000, trafficDensity: 1 },
    nodes: {},
    segments: {},
    roadTypes: byId([...DEFAULT_ROAD_TYPES, ...MEDIAN_ROAD_PRESETS]),
    buildingTypes: byId(withRev([...DEFAULT_BUILDING_TYPES, ...SMART_CITY_PRESETS, ...GROWTH_PRESETS, ...FACILITY_PRESETS, ...MODERN_BUILDING_PRESETS])),
    buildings: {},
    vehicleTypes: byId(DEFAULT_VEHICLE_TYPES),
    intersections: {},
    busStops: {},
    busLines: {},
    closures: {},
    parcels: {},
    features: {},
    sensors: {},
  };
}
