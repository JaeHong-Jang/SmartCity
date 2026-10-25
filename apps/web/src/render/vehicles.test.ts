import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { DEFAULT_VEHICLE_TYPES, createEmptyDoc } from '@smartcity/shared';
import { VEHICLE_STRIDE, type SimSnapshot } from '@smartcity/sim';
import { VehicleLayer, bakeVehicleGeometry, interpAlpha, lerpAngle } from './vehicles';
import type { SimulationStream } from '../sim/simStream';
import { TICK_MS } from '../sim/protocol';

describe('vehicle rendering helpers', () => {
  it('interpolates one tick behind the latest snapshot', () => {
    expect(interpAlpha(1000 + TICK_MS, 1000, 1050)).toBe(0);
    expect(interpAlpha(1050 + TICK_MS, 1000, 1050)).toBe(1);
    expect(interpAlpha(1025 + TICK_MS, 1000, 1050)).toBeCloseTo(0.5);
    expect(interpAlpha(5000, 1000, 1000)).toBe(1);
  });

  it('lerps angles the short way round', () => {
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI, 6);
  });

  it('bakes all parts into one vertex-colored geometry', () => {
    const vt = DEFAULT_VEHICLE_TYPES[0]!;
    const g = bakeVehicleGeometry(vt.parts);
    expect(g.getAttribute('position').count).toBe(vt.parts.length * 36);
    expect(g.getAttribute('color').count).toBe(vt.parts.length * 36);
  });

  it('tints only the car body: glass and wheels have no instance color', () => {
    const doc = createEmptyDoc();
    const v = new Float32Array(VEHICLE_STRIDE);
    v.set([10, 5, 0, 0, 0, 4]); // x, z, heading, type 0, speed, id 4
    const snap = { vehicles: v, vehicleCount: 1, vehicleTypeIds: ['sedan'], graphRevision: 1 } as unknown as SimSnapshot;
    const stream = { latest: () => snap, previous: () => null, previousAt: () => 0, latestAt: () => 0 } as unknown as SimulationStream;
    const layer = new VehicleLayer(stream);
    layer.syncTypes(doc);
    layer.update(0, doc);
    const meshes = layer.group.children as THREE.InstancedMesh[];
    const used = meshes.filter((m) => m.count === 1);
    const body = used.find((m) => !m.name.endsWith('-fixed'))!;
    const fixed = used.find((m) => m.name.endsWith('-fixed'))!;
    expect(used).toHaveLength(2);
    expect(body.instanceColor).not.toBeNull();
    expect(fixed.instanceColor).toBeNull();
    expect(fixed.name).toBe(`${body.name}-fixed`);
    layer.dispose();
  });
});
