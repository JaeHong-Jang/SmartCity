import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VEHICLE_STRIDE, type ScenarioView, type SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import { EmergencyLayer, rigPose } from './emergency';
import { interpAlpha, lerpAngle } from './vehicles';

const snap = (vehicles: [number, number, number, number][], extra: Partial<SimSnapshot> = {}): SimSnapshot => {
  const a = new Float32Array(vehicles.length * VEHICLE_STRIDE);
  vehicles.forEach(([id, x, z, h], i) => a.set([x, z, h, 0, 0, id], i * VEHICLE_STRIDE));
  return { tick: 0, graphRevision: 1, vehicles: a, vehicleCount: vehicles.length, ...extra } as unknown as SimSnapshot;
};

describe('dispatch rig pose', () => {
  it('matches what VehicleLayer draws: same alpha, same previous/latest positions and heading', () => {
    // Sol's repro: x 0 → 10, received at 1000 / 1100 ms, drawn at now = 1100: the car is at x = 5, so is the rig.
    const prev = snap([[7, 0, 0, 0]]);
    const cur = snap([[7, 10, 0, 0]]);
    const p = rigPose(cur, prev, 7, 1100, 1000, 1100)!;
    const alpha = interpAlpha(1100, 1000, 1100);
    expect(alpha).toBeCloseTo(0.5, 6);
    expect(p.x).toBeCloseTo(5, 5);
    // the heading takes the short way round, like lerpAngle
    const turn = rigPose(snap([[7, 0, 0, -3.0]]), snap([[7, 0, 0, 3.0]]), 7, 1100, 1000, 1100)!;
    expect(turn.h).toBeCloseTo(lerpAngle(3.0, -3.0, alpha), 5);
  });

  it('uses the latest pose without a usable previous snapshot (other graph revision, or vehicle not there before)', () => {
    const cur = snap([[7, 10, 0, 1]]);
    expect(rigPose(cur, snap([[7, 0, 0, 0]], { graphRevision: 2 }), 7, 1100, 1000, 1100)!.x).toBe(10);
    expect(rigPose(cur, snap([[8, 0, 0, 0]]), 7, 1100, 1000, 1100)!.x).toBe(10);
    expect(rigPose(cur, null, 7, 1100, 1000, 1100)!.x).toBe(10);
    expect(rigPose(cur, null, 99, 1100, 1000, 1100)).toBeNull();
  });
});

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
