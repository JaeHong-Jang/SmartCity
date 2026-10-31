import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VEHICLE_STRIDE, type ScenarioView, type SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import { EmergencyLayer } from './emergency';

const snap = (vehicles: [number, number, number, number][], extra: Partial<SimSnapshot> = {}): SimSnapshot => {
  const a = new Float32Array(vehicles.length * VEHICLE_STRIDE);
  vehicles.forEach(([id, x, z, h], i) => a.set([x, z, h, 0, 0, id], i * VEHICLE_STRIDE));
  return { tick: 0, graphRevision: 1, vehicles: a, vehicleCount: vehicles.length, ...extra } as unknown as SimSnapshot;
};

describe('pre-emption ring', () => {
  const view = (p: ScenarioView['preempted']): SimSnapshot =>
    snap([], {
      scenario: { incidents: [], damagedBuildings: [], dispatches: [], preempted: p, obstacles: [], closedLanes: [] } as unknown as ScenarioView,
    });
  function setup() {
    let cur: SimSnapshot = view([]);
    const stream = { latest: () => cur, previous: () => null, latestAt: () => 0, previousAt: () => 0, subscribe: () => () => {} } as SimulationStream;
    const layer = new EmergencyLayer(stream);
    layer.setSource({ building: () => null, node: () => ({ x: 1, z: 2 }) });
    const ringColor = (): string | null => {
      let hex: string | null = null;
      layer.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry?.type === 'RingGeometry') hex = (m.material as THREE.MeshBasicMaterial).color.getHexString();
      });
      return hex;
    };
    return { layer, ringColor, set: (p: ScenarioView['preempted']) => ((cur = view(p)), layer.update(0)) };
  }

  it('follows the signal color: green → yellow → red', () => {
    const { ringColor, set } = setup();
    set([{ nodeId: 'n', vehicleId: 1, phase: 0, color: 'green' }]);
    expect(ringColor()).toBe('22c55e');
    set([{ nodeId: 'n', vehicleId: 1, phase: 0, color: 'yellow' }]);
    expect(ringColor()).toBe('facc15');
    set([{ nodeId: 'n', vehicleId: 1, phase: 0, color: 'red' }]);
    expect(ringColor()).toBe('ef4444');
  });

  it('a junction handing back to its plan (phase −1) is amber', () => {
    const { ringColor, set, layer } = setup();
    set([{ nodeId: 'n', vehicleId: 1, phase: 0, color: 'green' }]);
    set([{ nodeId: 'n', vehicleId: -1, phase: -1, color: 'green' }]);
    expect(ringColor()).toBe('f59e0b');
    expect(layer.stats().preempted).toBe(1);
  });

  it('draws nothing without incidents, dispatches or pre-emption', () => {
    const { layer, set } = setup();
    set([]);
    expect(layer.stats().drawn).toBe(false);
  });
});

describe('dispatched vehicles', () => {
  it('counts fire trucks and ambulances on the road and draws no body of its own (VehicleLayer draws them)', () => {
    const dispatches = [
      { eventId: 'e1', kind: 'fire', vehicleId: 7, stage: 'enroute', facilityId: 'f', buildingId: 'b' },
      { eventId: 'e2', kind: 'medical', vehicleId: 8, stage: 'enroute', facilityId: 'f', buildingId: 'b' },
      { eventId: 'e3', kind: 'medical', vehicleId: null, stage: 'working', facilityId: 'f', buildingId: 'b' },
    ] as ScenarioView['dispatches'];
    const cur = snap([[7, 0, 0, 0], [8, 5, 0, 0]], {
      scenario: { incidents: [], damagedBuildings: [], dispatches, preempted: [], obstacles: [], closedLanes: [] } as unknown as ScenarioView,
    });
    const stream = { latest: () => cur, previous: () => null, latestAt: () => 0, previousAt: () => 0 } as unknown as SimulationStream;
    const layer = new EmergencyLayer(stream);
    layer.update(0);
    expect(layer.stats()).toMatchObject({ drawn: true, fireTrucks: 1, ambulances: 1 });
    let meshes = 0;
    layer.group.traverse((o) => void ((o as THREE.Mesh).isMesh && meshes++));
    expect(meshes).toBe(0);
    layer.dispose();
  });
});
