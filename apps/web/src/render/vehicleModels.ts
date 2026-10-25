// Render-only car variety (ADR 0010 §7): appearance class and color come from an integer hash of the
// snapshot's stable vehicle id, so the same car always looks the same. The sim never sees any of this.

import { DEFAULT_VEHICLE_TYPES, type VehiclePart, type VehicleType } from '@smartcity/shared';

export const CAR_CLASSES = ['sedan', 'suv', 'hatch', 'van', 'pickup', 'taxi'] as const;
export type CarClass = (typeof CAR_CLASSES)[number];

/** Share of each class in percent (same order as CAR_CLASSES). */
export const CLASS_PERCENT = [45, 25, 12, 8, 6, 4] as const;

/** Murmur3 finalizer: well-mixed unsigned 32-bit hash of an integer id. */
export function hashId(id: number): number {
  let h = id | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Class index into CAR_CLASSES for a vehicle id. */
export function carClassOf(id: number): number {
  const u = (hashId(id) / 4294967296) * 100;
  let acc = 0;
  for (let i = 0; i < CLASS_PERCENT.length; i++) {
    acc += CLASS_PERCENT[i]!;
    if (u < acc) return i;
  }
  return 0;
}

interface Swatch {
  color: string;
  weight: number;
}

const PASSENGER_PALETTE: Swatch[] = [
  { color: '#f2f2f0', weight: 24 }, // white
  { color: '#1c1d20', weight: 20 }, // black
  { color: '#b8bcc2', weight: 17 }, // silver
  { color: '#6b7078', weight: 14 }, // gray
  { color: '#1f3566', weight: 8 }, // navy
  { color: '#b3262d', weight: 8 }, // red
  { color: '#6fa8d6', weight: 4 }, // sky blue
  { color: '#2f6b4a', weight: 3 }, // green
  { color: '#c9b79a', weight: 2 }, // beige
];
const WORK_PALETTE: Swatch[] = [
  { color: '#f2f2f0', weight: 55 },
  { color: '#b8bcc2', weight: 15 },
  { color: '#6b7078', weight: 10 },
  { color: '#1f3566', weight: 10 },
  { color: '#b3262d', weight: 10 },
];
const TAXI_PALETTE: Swatch[] = [{ color: '#f2c200', weight: 1 }];

const PALETTES: Swatch[][] = [PASSENGER_PALETTE, PASSENGER_PALETTE, PASSENGER_PALETTE, WORK_PALETTE, WORK_PALETTE, TAXI_PALETTE];

/** Palette color (hex) for a vehicle id and class, independent of the class hash bits. */
export function carColorOf(id: number, cls: number): string {
  const pal = PALETTES[cls]!;
  let total = 0;
  for (const s of pal) total += s.weight;
  const u = (hashId(id ^ 0x9e3779b9) / 4294967296) * total;
  let acc = 0;
  for (const s of pal) {
    acc += s.weight;
    if (u < acc) return s.color;
  }
  return pal[0]!.color;
}

const BODY = '#ffffff'; // multiplied by the instance color
const GLASS = '#2b3a4a';
const TIRE = '#16171a';
const LIGHT = '#fff3b0';

interface Shape {
  length: number;
  width: number;
  bodyH: number;
  bodyY: number;
  cabinL: number;
  cabinH: number;
  cabinX: number;
  cabinW: number;
}

function part(length: number, height: number, width: number, x: number, y: number, z: number, color: string): VehiclePart {
  return { length, height, width, offset: { x, y, z }, color };
}

function carParts(s: Shape, extra: VehiclePart[] = []): VehiclePart[] {
  const topY = s.bodyY + s.bodyH;
  const wheelX = s.length / 2 - 0.95;
  const wheelZ = s.width / 2 - 0.12;
  const parts: VehiclePart[] = [
    part(s.length, s.bodyH, s.width, 0, s.bodyY, 0, BODY),
    part(s.cabinL, s.cabinH, s.cabinW, s.cabinX, topY, 0, BODY),
    part(s.cabinL - 0.4, s.cabinH * 0.62, s.cabinW + 0.06, s.cabinX, topY + s.cabinH * 0.06, 0, GLASS),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(part(0.66, 0.66, 0.24, sx * wheelX, 0, sz * wheelZ, TIRE));
  return parts.concat(extra);
}

const SEDAN: Shape = { length: 4.5, width: 1.8, bodyH: 0.7, bodyY: 0.25, cabinL: 2.2, cabinH: 0.55, cabinX: -0.2, cabinW: 1.56 };

/** Parts for one class (x forward, y up, z right; body white so the instance color tints it). */
export function carClassParts(cls: number): VehiclePart[] {
  switch (CAR_CLASSES[cls]) {
    case 'suv':
      return carParts({ length: 4.7, width: 1.9, bodyH: 0.85, bodyY: 0.3, cabinL: 3.0, cabinH: 0.7, cabinX: -0.35, cabinW: 1.7 });
    case 'hatch':
      return carParts({ length: 3.9, width: 1.7, bodyH: 0.7, bodyY: 0.25, cabinL: 2.4, cabinH: 0.6, cabinX: -0.3, cabinW: 1.5 });
    case 'van':
      return carParts({ length: 4.9, width: 1.95, bodyH: 0.9, bodyY: 0.3, cabinL: 3.9, cabinH: 0.9, cabinX: -0.5, cabinW: 1.85 });
    case 'pickup': {
      const bedRim = part(1.9, 0.3, 1.9, -1.4, 1.05, 0, BODY);
      return carParts({ length: 5.0, width: 1.9, bodyH: 0.8, bodyY: 0.3, cabinL: 1.7, cabinH: 0.6, cabinX: 0.75, cabinW: 1.7 }, [bedRim]);
    }
    case 'taxi':
      return carParts(SEDAN, [part(0.5, 0.2, 0.28, -0.1, 1.5, 0, LIGHT)]);
    default:
      return carParts(SEDAN);
  }
}

/** Body parts only (white, tinted by the instance color). */
export function carBodyParts(cls: number): VehiclePart[] {
  return carClassParts(cls).filter((p) => p.color === BODY);
}

/** Glass, wheels and lights: fixed colors, drawn without an instance color. */
export function carFixedParts(cls: number): VehiclePart[] {
  return carClassParts(cls).filter((p) => p.color !== BODY);
}

/** Longest side (m) of a class model along x, from its parts. */
export function carClassLength(cls: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of carClassParts(cls)) {
    lo = Math.min(lo, p.offset.x - p.length / 2);
    hi = Math.max(hi, p.offset.x + p.length / 2);
  }
  return hi - lo;
}

const VARIETY_DEFAULTS = new Map(DEFAULT_VEHICLE_TYPES.filter((t) => t.id === 'sedan' || t.id === 'suv').map((t) => [t.id, t]));
const varietyCache = new WeakMap<VehicleType, boolean>();

/** True only for the shared default sedan/suv whose parts and color are unchanged; edited or custom car types keep their own parts. */
export function usesVarietyPath(vt: VehicleType): boolean {
  let r = varietyCache.get(vt);
  if (r === undefined) {
    const d = VARIETY_DEFAULTS.get(vt.id);
    r = vt.kind === 'car' && !!d && vt.color === d.color && JSON.stringify(vt.parts) === JSON.stringify(d.parts);
    varietyCache.set(vt, r);
  }
  return r;
}
