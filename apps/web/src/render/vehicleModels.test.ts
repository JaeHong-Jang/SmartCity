import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { DEFAULT_VEHICLE_TYPES } from '@smartcity/shared';
import {
  CAR_CLASSES,
  CLASS_MIX,
  FIT_SIZE,
  carClassGeometry,
  carClassLength,
  carClassOf,
  carClassSize,
  carColorOf,
  defaultModelOf,
  farBoxGeometry,
  fittedGeometry,
  type Envelope,
  type FitKind,
} from './vehicleModels';

const tris = (g: THREE.BufferGeometry): number => g.getAttribute('position').count / 3;
const typeEnv = (id: string): Envelope => {
  const t = DEFAULT_VEHICLE_TYPES.find((v) => v.id === id)!;
  return { length: t.length, width: t.width, height: t.height };
};
const FITTED = Object.keys(FIT_SIZE) as FitKind[];
const allModels = (): [string, THREE.BufferGeometry, Envelope, 0 | 1][] => {
  const out: [string, THREE.BufferGeometry, Envelope, 0 | 1][] = [];
  for (const lod of [0, 1] as const) {
    CAR_CLASSES.forEach((name, c) => out.push([`${name}/${lod}`, carClassGeometry(c, lod), carClassSize(c), lod]));
    for (const kind of FITTED) out.push([`${kind}/${lod}`, fittedGeometry(kind, lod, true), FIT_SIZE[kind], lod]);
  }
  return out;
};

describe('car appearance classes', () => {
  it('follows each default car type\'s class mix within 2 percentage points over 10000 ids', () => {
    for (const group of ['sedan', 'suv'] as const) {
      const n = 10000;
      const counts = new Array<number>(CAR_CLASSES.length).fill(0);
      for (let id = 1; id <= n; id++) counts[carClassOf(id, group)]!++;
      for (const [name, pct] of CLASS_MIX[group]) expect(Math.abs((counts[CAR_CLASSES.indexOf(name)]! / n) * 100 - pct)).toBeLessThanOrEqual(2);
      expect(CLASS_MIX[group].reduce((a, [, p]) => a + p, 0)).toBe(100);
    }
  });

  it('only mixes classes whose model fits the type: no scaling at the default sizes', () => {
    for (const group of ['sedan', 'suv'] as const) {
      const env = typeEnv(group);
      for (const [name] of CLASS_MIX[group]) {
        const size = carClassSize(CAR_CLASSES.indexOf(name));
        expect(size.length, name).toBeLessThanOrEqual(env.length);
        expect(size.width, name).toBeLessThanOrEqual(env.width);
        expect(size.height, name).toBeLessThanOrEqual(env.height + 1e-9);
      }
    }
    // Fitted models are built at the default type size, so a default vehicle is drawn unscaled.
    expect(FIT_SIZE.bus).toEqual(typeEnv('city-bus'));
    expect(FIT_SIZE.truck).toEqual(typeEnv('truck'));
    expect(FIT_SIZE.ambulance).toEqual(typeEnv('ambulance'));
  });

  it('is deterministic per id (class and color)', () => {
    for (const id of [1, 7, 4242, 99999]) {
      const c = carClassOf(id);
      expect(carClassOf(id)).toBe(c);
      expect(carColorOf(id, c)).toBe(carColorOf(id, c));
    }
  });

  it('paints taxis yellow, police cars white and uses several colors for sedans', () => {
    expect(carColorOf(5, CAR_CLASSES.indexOf('taxi'))).toBe('#f2c200');
    expect(carColorOf(5, CAR_CLASSES.indexOf('police'))).toBe('#f4f5f7');
    const colors = new Set<string>();
    for (let id = 1; id <= 500; id++) colors.add(carColorOf(id, 0));
    expect(colors.size).toBeGreaterThanOrEqual(6);
  });

  it('keeps every model no longer than the shortest car type, or scales to it', () => {
    const carLens = DEFAULT_VEHICLE_TYPES.filter((t) => t.kind === 'car').map((t) => t.length);
    for (let c = 0; c < CAR_CLASSES.length; c++) {
      const len = carClassLength(c);
      expect(len).toBeGreaterThan(3);
      expect(len).toBeLessThanOrEqual(5.1);
      for (const L of carLens) expect(len * Math.min(1, L / len)).toBeLessThanOrEqual(L + 1e-9);
    }
  });
});

describe('procedural vehicle models', () => {
  it('stays inside its size: x ±length/2, z ±width/2, y 0…height (physical dimensions unchanged)', () => {
    for (const [name, g, env] of allModels()) {
      const bb = g.boundingBox!;
      const eps = 1e-5;
      expect(bb.min.x, name).toBeGreaterThanOrEqual(-env.length / 2 - eps);
      expect(bb.max.x, name).toBeLessThanOrEqual(env.length / 2 + eps);
      expect(bb.min.z, name).toBeGreaterThanOrEqual(-env.width / 2 - eps);
      expect(bb.max.z, name).toBeLessThanOrEqual(env.width / 2 + eps);
      expect(bb.min.y, name).toBeGreaterThanOrEqual(-1e-6);
      expect(bb.max.y, name).toBeLessThanOrEqual(env.height + 1e-6);
      // …and fills it: no model is a toy inside a big envelope.
      expect(bb.max.x - bb.min.x, name).toBeGreaterThan(env.length * 0.97);
      expect(bb.max.y, name).toBeGreaterThan(env.height * 0.9);
    }
  });

  it('meets the triangle budget: about 300 (LOD 0), 80 (LOD 1) and 12 (far box)', () => {
    for (const [name, g, , lod] of allModels()) {
      if (lod === 0) expect(tris(g), name).toBeGreaterThanOrEqual(200);
      if (lod === 0) expect(tris(g), name).toBeLessThanOrEqual(360);
      if (lod === 1) expect(tris(g), name).toBeGreaterThanOrEqual(40);
      if (lod === 1) expect(tris(g), name).toBeLessThanOrEqual(100);
    }
    expect(tris(farBoxGeometry())).toBe(12);
  });

  it('has unit normals and faces wound the way they point', () => {
    for (const [name, g] of allModels()) {
      const p = g.getAttribute('position');
      const n = g.getAttribute('normal');
      for (let i = 0; i < p.count; i += 3) {
        const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i);
        const ux = p.getX(i + 1) - ax, uy = p.getY(i + 1) - ay, uz = p.getZ(i + 1) - az;
        const vx = p.getX(i + 2) - ax, vy = p.getY(i + 2) - ay, vz = p.getZ(i + 2) - az;
        const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
        let dot = 0;
        for (let k = 0; k < 3; k++) {
          expect(Math.hypot(n.getX(i + k), n.getY(i + k), n.getZ(i + k)), name).toBeCloseTo(1, 5);
          dot += fx * n.getX(i + k) + fy * n.getY(i + k) + fz * n.getZ(i + k);
        }
        expect(dot, name).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('marks only body paint for the instance color: glass, lamps, tires keep their own colors', () => {
    for (const [name, g] of allModels()) {
      const mat = g.getAttribute('aMat');
      let paint = 0;
      let glass = 0;
      let lamp = 0;
      for (let i = 0; i < mat.count; i++) {
        const isPaint = mat.getX(i) > 0.5;
        if (isPaint) paint++;
        if (mat.getZ(i) > 0.5) glass++;
        if (mat.getY(i) > 0.5) lamp++;
        if (isPaint) expect(mat.getY(i) + mat.getZ(i), name).toBe(0);
      }
      expect(paint, name).toBeGreaterThan(mat.count * 0.2);
      expect(glass, name).toBeGreaterThan(0);
      expect(lamp, name).toBeGreaterThan(0);
    }
  });

  it('flashes beacons (red phase A, blue phase B) only on dispatched emergency models', () => {
    const codes = (g: THREE.BufferGeometry): Set<number> => {
      const mat = g.getAttribute('aMat');
      const s = new Set<number>();
      for (let i = 0; i < mat.count; i++) s.add(mat.getY(i));
      return s;
    };
    for (const kind of ['ambulance', 'fire'] as const) {
      expect([...codes(fittedGeometry(kind, 0, true))].sort()).toEqual([0, 1, 2, 3]);
      expect([...codes(fittedGeometry(kind, 0, false))].sort()).toEqual([0, 1]);
    }
    // Police and taxi: lights and signs, no flashing.
    expect(Math.max(...codes(carClassGeometry(CAR_CLASSES.indexOf('police'), 0)))).toBe(1);
  });
});

describe('model eligibility (default types only)', () => {
  const byId = (id: string) => structuredClone(DEFAULT_VEHICLE_TYPES.find((t) => t.id === id)!);
  it('maps the unchanged defaults: sedan/suv by appearance class, truck, bus, ambulance fitted', () => {
    expect(defaultModelOf(byId('sedan'))).toBe('sedan');
    expect(defaultModelOf(byId('suv'))).toBe('suv');
    expect(defaultModelOf(byId('truck'))).toBe('truck');
    expect(defaultModelOf(byId('city-bus'))).toBe('bus');
    expect(defaultModelOf(byId('ambulance'))).toBe('ambulance');
  });
  it('keeps own parts when a part, the color or the kind is modified', () => {
    for (const id of ['sedan', 'truck', 'city-bus', 'ambulance']) {
      const part = byId(id);
      part.parts[0]!.height += 0.1;
      expect(defaultModelOf(part)).toBeNull();
      expect(defaultModelOf({ ...byId(id), color: '#123456' })).toBeNull();
    }
    expect(defaultModelOf({ ...byId('truck'), kind: 'bus' })).toBeNull();
  });
  it('compares parts field by field: object key order does not matter, a reordered part list is an edit', () => {
    for (const id of ['sedan', 'truck', 'city-bus', 'ambulance']) {
      // Same values, keys in another order (e.g. after a JSON round trip through other code).
      const shuffled = byId(id);
      shuffled.parts = shuffled.parts.map((p) => JSON.parse(JSON.stringify({ color: p.color, height: p.height, width: p.width, length: p.length, offset: { z: p.offset.z, y: p.offset.y, x: p.offset.x } })));
      expect(JSON.stringify(shuffled.parts)).not.toBe(JSON.stringify(byId(id).parts));
      expect(defaultModelOf(shuffled)).not.toBeNull();
      const reordered = byId(id);
      reordered.parts = [...reordered.parts.slice(1), reordered.parts[0]!];
      expect(defaultModelOf(reordered)).toBeNull();
    }
  });
  it('keeps the model when only the size changes (it is scaled to the type)', () => {
    expect(defaultModelOf({ ...byId('city-bus'), length: 2, width: 1, height: 1 })).toBe('bus');
  });
  it('keeps own parts for a custom type id', () => {
    expect(defaultModelOf({ ...byId('sedan'), id: 'my-car' })).toBeNull();
    expect(defaultModelOf({ ...byId('city-bus'), id: 'my-bus' })).toBeNull();
  });
});
