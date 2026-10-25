import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEmptyDoc, FACILITY_PRESETS } from '@smartcity/shared';
import type { ScenarioView, SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import type { SimModeController } from '../simmode/controller';
import { setSimModeController } from '../simmode/instance';
import { simModeStore } from '../simmode/store';
import { BlackoutLayer, LABEL_DISTANCE, veilOpacity } from './blackout';

const doc = createEmptyDoc('t', 1);
for (const t of FACILITY_PRESETS) doc.buildingTypes[t.id] = t;
doc.buildingTypes['house'] = { id: 'house', name: '집', zone: 'residential', parts: [{ offset: { x: 0, z: 0 }, width: 10, depth: 9, floors: 2, floorHeight: 3, baseHeight: 0, roof: 'flat', color: '#fff', roofColor: '#888' }] };
doc.buildings['h1'] = { id: 'h1', typeId: 'house', pos: { x: 20, z: 20 }, rotation: 0 };
doc.nodes['n1'] = { id: 'n1', pos: { x: 0, z: 0 } } as never;
setSimModeController({ copyCityDoc: () => doc, roadGraph: () => null } as unknown as SimModeController);

const view = (over: Partial<ScenarioView> = {}): SimSnapshot =>
  ({ scenario: { blackouts: [], unpoweredBuildings: [], battery: [], darkJunctions: [], darkCrossings: [], ...over } as unknown as ScenarioView }) as unknown as SimSnapshot;
function setup(initial: SimSnapshot | null = null) {
  let cur = initial;
  const stream = { latest: () => cur, previous: () => null, latestAt: () => 0, previousAt: () => 0, subscribe: () => () => {} } as SimulationStream;
  const layer = new BlackoutLayer(stream);
  return { layer, set: (s: SimSnapshot | null) => (cur = s) };
}

describe('blackout layer', () => {
  it('draws nothing without blackouts, unpowered buildings, batteries or an armed tool (zero cost)', () => {
    const { layer, set } = setup(view());
    layer.update(0, 0, 100);
    expect(layer.stats().drawn).toBe(false);
    set(null);
    layer.update(0, 0, 100);
    expect(layer.stats().drawn).toBe(false);
  });

  it('a disc per blackout, a veil per unpowered building (slight by day, strong at night), cleared when over', () => {
    const { layer, set } = setup(view({ blackouts: [{ eventId: 'b', substationId: null, x: 0, z: 0, radius: 100, startTick: 0, endTick: 10 }], unpoweredBuildings: ['h1', 'gone'] }));
    layer.update(0, 0, 100);
    expect(layer.stats()).toMatchObject({ drawn: true, discs: 1, unpoweredBuildings: 1 }); // unknown building skipped
    expect(veilOpacity(1)).toBeGreaterThan(veilOpacity(0) * 3);
    expect(veilOpacity(0)).toBeGreaterThan(0);
    set(view());
    layer.update(0, 0, 100);
    expect(layer.stats().drawn).toBe(false);
    expect(layer.stats()).toMatchObject({ discs: 0, unpoweredBuildings: 0 });
  });

  it('battery labels only show when the camera is near, and follow the remaining minutes', () => {
    const { layer } = setup(view({ battery: [{ signalId: 'n:n1', remainingMinutes: 12.2 }], blackouts: [{ eventId: 'b', substationId: null, x: 0, z: 0, radius: 50, startTick: 0, endTick: 10 }] }));
    layer.update(0, 0, LABEL_DISTANCE + 50);
    expect(layer.stats().batteryLabels).toBe(0);
    layer.update(0, 0, LABEL_DISTANCE - 50);
    expect(layer.stats().batteryLabels).toBe(1);
  });

  it('shows the substation coverage circles while the 정전 tool is armed', () => {
    const { layer } = setup(null);
    simModeStore.set({ coverage: [{ substationId: 's', x: 0, z: 0, radius: 80 }], armed: null });
    layer.update(0, 0, 100);
    expect(layer.stats().coverageRings).toBe(0);
    simModeStore.set({ armed: { kind: 'blackout', blackoutMode: 'substation', radius: 150, durationMin: 30, people: 1, inflowMin: 0, stayMin: 0, outflowMin: 0 } });
    layer.update(0, 0, 100);
    expect(layer.stats()).toMatchObject({ drawn: true, coverageRings: 1 });
    simModeStore.reset();
  });

  it('2000 unpowered buildings: one instanced veil (a constant, tiny number of meshes), nothing allocated per frame', () => {
    const big = createEmptyDoc('big', 1);
    big.buildingTypes['house'] = doc.buildingTypes['house']!;
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const id = `b${i}`;
      big.buildings[id] = { id, typeId: 'house', pos: { x: (i % 50) * 14, z: Math.floor(i / 50) * 14 }, rotation: 0 };
      ids.push(id);
    }
    setSimModeController({ copyCityDoc: () => big, roadGraph: () => null } as unknown as SimModeController);
    const snap = view({ blackouts: [{ eventId: 'b', substationId: null, x: 0, z: 0, radius: 900, startTick: 0, endTick: 10 }], unpoweredBuildings: ids });
    const { layer, set } = setup(snap);
    layer.update(0, 0, 100);
    const meshes = (): number => {
      let n = 0;
      layer.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) n++;
      });
      return n;
    };
    expect(layer.stats().unpoweredBuildings).toBe(2000);
    expect(meshes()).toBeLessThanOrEqual(3); // the veils + one disc + its edge
    const before = layer.group.children.length;
    const geometry = (layer.group.children.find((c) => c.name === 'blackout-veils') as THREE.InstancedMesh).instanceMatrix;
    // frames on the same snapshot rebuild nothing: same objects, only the opacity follows the day/night factor
    for (let f = 0; f < 50; f++) layer.update(f * 16, f / 50, 100);
    expect(layer.group.children.length).toBe(before);
    expect((layer.group.children.find((c) => c.name === 'blackout-veils') as THREE.InstancedMesh).instanceMatrix).toBe(geometry);
    expect(meshes()).toBeLessThanOrEqual(3);
    // fewer buildings later: the count follows, still one mesh
    set(view({ unpoweredBuildings: ids.slice(0, 10) }));
    layer.update(0, 0, 100);
    expect(layer.stats().unpoweredBuildings).toBe(10);
    expect(meshes()).toBeLessThanOrEqual(3);
    // dispose releases the shared geometry / material
    let disposed = 0;
    const veil = layer.group.children.find((c) => c.name === 'blackout-veils') as THREE.InstancedMesh;
    veil.addEventListener('dispose', () => disposed++);
    (veil.material as THREE.Material).addEventListener('dispose', () => disposed++);
    layer.dispose();
    expect(disposed).toBe(2);
    expect(layer.stats()).toMatchObject({ drawn: false, unpoweredBuildings: 0 });
    setSimModeController({ copyCityDoc: () => doc, roadGraph: () => null } as unknown as SimModeController);
  });
});
