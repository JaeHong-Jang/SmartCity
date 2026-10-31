import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_VEHICLE_TYPES, createEmptyDoc, type CityDoc } from '@smartcity/shared';
import { VEHICLE_STRIDE, type ScenarioView, type SimSnapshot } from '@smartcity/sim';
import { LOD_DIST, LOD_HYSTERESIS, VehicleLayer, bakeVehicleGeometry, interpAlpha, lerpAngle, lodFor } from './vehicles';
import { CAR_CLASSES, carClassOf, carClassSize, carColorOf, type CarGroup } from './vehicleModels';
import type { SimulationStream } from '../sim/simStream';
import { TICK_MS } from '../sim/protocol';

/** Snapshot of vehicles [id, x, z, heading, type index] over `typeIds`. */
function snapshot(vehicles: [number, number, number, number, number][], typeIds: string[], scenario?: Partial<ScenarioView>): SimSnapshot {
  const v = new Float32Array(vehicles.length * VEHICLE_STRIDE);
  vehicles.forEach(([id, x, z, h, t], i) => v.set([x, z, h, t, 0, id], i * VEHICLE_STRIDE));
  return { vehicles: v, vehicleCount: vehicles.length, vehicleTypeIds: typeIds, graphRevision: 1, scenario } as unknown as SimSnapshot;
}

function setup(doc: CityDoc = createEmptyDoc()) {
  let cur: SimSnapshot | null = null;
  const stream = { latest: () => cur, previous: () => null, previousAt: () => 0, latestAt: () => 0 } as unknown as SimulationStream;
  const layer = new VehicleLayer(stream);
  layer.syncTypes(doc);
  const draw = (snap: SimSnapshot, eye?: THREE.Vector3): THREE.InstancedMesh[] => {
    cur = snap;
    layer.update(0, doc, eye);
    return (layer.group.children as THREE.InstancedMesh[]).filter((m) => m.count > 0);
  };
  return { layer, doc, draw };
}

/** First id of the given appearance class within a default car type's mix. */
const idOfClass = (cls: number, group: CarGroup = 'sedan'): number => {
  for (let id = 1; id < 100000; id++) if (carClassOf(id, group) === cls) return id;
  throw new Error(`class ${CAR_CLASSES[cls]} not in the ${group} mix`);
};

const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const pose = (mesh: THREE.InstancedMesh, i: number) => {
  mesh.getMatrixAt(i, _m);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  _m.decompose(p, q, s);
  mesh.getColorAt(i, _c);
  return { p, q, s, color: '#' + _c.getHexString() };
};

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

  it('bakes all parts into one vertex-colored geometry (edited and custom types)', () => {
    const vt = DEFAULT_VEHICLE_TYPES[0]!;
    const g = bakeVehicleGeometry(vt.parts);
    expect(g.getAttribute('position').count).toBe(vt.parts.length * 36);
    expect(g.getAttribute('color').count).toBe(vt.parts.length * 36);
  });

  it('picks the detail level by camera distance, keeping long vehicles detailed farther away', () => {
    expect(lodFor(10 ** 2, 4.5)).toBe(0);
    expect(lodFor((LOD_DIST[0] + 1) ** 2, 4.5)).toBe(1);
    expect(lodFor((LOD_DIST[1] + 1) ** 2, 4.5)).toBe(2);
    expect(lodFor((LOD_DIST[0] + 1) ** 2, 11.5)).toBe(0);
    expect(lodFor((LOD_DIST[1] * 2.5 + 1) ** 2, 30)).toBe(2);
  });

  it('keeps the previous level within the hysteresis band and leaves it beyond', () => {
    const b = LOD_DIST[0];
    expect(lodFor((b + 1) ** 2, 4.5, 0)).toBe(0);
    expect(lodFor((b + LOD_HYSTERESIS + 0.5) ** 2, 4.5, 0)).toBe(1);
    expect(lodFor((b - 1) ** 2, 4.5, 1)).toBe(1);
    expect(lodFor((b - LOD_HYSTERESIS - 0.5) ** 2, 4.5, 1)).toBe(0);
    expect(lodFor((LOD_DIST[1] + 1) ** 2, 4.5, 1)).toBe(1);
    expect(lodFor((LOD_DIST[1] - 1) ** 2, 4.5, 2)).toBe(2);
  });
});

describe('VehicleLayer models', () => {
  it('draws a default car as one mesh: body and fixed parts together, body tinted by the instance color', () => {
    const { draw, layer } = setup();
    const id = idOfClass(0);
    const used = draw(snapshot([[id, 10, 5, 0, 0]], ['sedan']));
    expect(used).toHaveLength(1);
    expect(used[0]!.name).toBe('vehicles-car-sedan-lod0');
    expect(used[0]!.geometry.getAttribute('aMat')).toBeDefined();
    expect(pose(used[0]!, 0).color).toBe('#' + new THREE.Color(carColorOf(id, 0)).getHexString());
    expect(layer.visibleCount).toBe(1);
    layer.dispose();
  });

  it('spreads vehicles over LOD 0 / 1 / far box by distance, keeping id color, position and heading', () => {
    const { draw, layer } = setup();
    const cls = CAR_CLASSES.indexOf('suv');
    const id = idOfClass(cls, 'suv');
    const car = (x: number): [number, number, number, number, number] => [id, x, 3, 0.7, 1];
    const at = (x: number) => {
      const used = draw(snapshot([car(x)], ['sedan', 'suv']), new THREE.Vector3(0, 0, 0));
      expect(used).toHaveLength(1);
      return { name: used[0]!.name, ...pose(used[0]!, 0) };
    };
    const near = at(20);
    const mid = at(150);
    const far = at(600);
    expect([near.name, mid.name, far.name]).toEqual([`vehicles-car-suv-lod0`, `vehicles-car-suv-lod1`, 'vehicles-far']);
    for (const p of [near, mid, far]) {
      expect(p.color).toBe('#' + new THREE.Color(carColorOf(id, cls)).getHexString());
      expect(p.q.angleTo(near.q)).toBeCloseTo(0, 6);
      expect(p.p.z).toBeCloseTo(3, 5);
    }
    // The SUV class fits the SUV type unscaled; the far box is the class model's size.
    const size = carClassSize(cls);
    expect([near.s.x, near.s.y, near.s.z]).toEqual([1, 1, 1].map((x) => expect.closeTo(x, 6)));
    expect(far.s.x).toBeCloseTo(size.length, 5);
    expect(far.s.y).toBeCloseTo(size.height, 5);
    expect(far.s.z).toBeCloseTo(size.width, 5);
    expect(layer.lodCounts).toEqual([0, 0, 1]);
    layer.dispose();
  });

  it('keeps every vehicle drawn exactly once across LOD buffers, growing them as needed', () => {
    const { draw, layer } = setup();
    const cars: [number, number, number, number, number][] = [];
    for (let i = 0; i < 2000; i++) cars.push([i + 1, (i % 50) * 12 - 300, Math.floor(i / 50) * 12 - 240, i * 0.01, i % 5]);
    const ids = ['sedan', 'suv', 'truck', 'city-bus', 'ambulance'];
    const used = draw(snapshot(cars, ids), new THREE.Vector3(0, 40, 0));
    const total = used.reduce((a, m) => a + m.count, 0);
    expect(total).toBe(2000);
    expect(layer.visibleCount).toBe(2000);
    expect(layer.lodCounts.reduce((a, b) => a + b, 0)).toBe(2000);
    expect(layer.lodCounts.every((n) => n > 0)).toBe(true);
    // Few draws: models × LOD 0/1 + one far box (2 meshes per class before: body + fixed).
    expect(used.length).toBeLessThanOrEqual(CAR_CLASSES.length * 2 + 3 * 2 + 1);
    layer.dispose();
  });

  it('draws default truck, bus and ambulance with fitted models at the type size', () => {
    const { draw, layer, doc } = setup();
    const used = draw(snapshot([[1, 0, 0, 0, 0], [2, 20, 0, 0, 1], [3, 40, 0, 0, 2]], ['truck', 'city-bus', 'ambulance']));
    expect(used.map((m) => m.name).sort()).toEqual(['vehicles-ambulance-lod0', 'vehicles-bus-lod0', 'vehicles-truck-lod0']);
    for (const m of used) {
      const bb = m.geometry.boundingBox!;
      const vt = Object.values(doc.vehicleTypes).find((t) => m.name.includes(t.id === 'city-bus' ? 'bus' : t.id))!;
      expect(bb.max.x - bb.min.x).toBeCloseTo(vt.length, 1);
      const p = pose(m, 0);
      expect(p.s.x).toBeCloseTo(1, 6);
      expect(p.color).toBe('#' + new THREE.Color(vt.color).getHexString());
    }
    layer.dispose();
  });

  it('keeps the parts path for edited and custom types', () => {
    const doc = createEmptyDoc();
    doc.vehicleTypes.truck!.parts[0]!.height += 0.2;
    const { draw, layer } = setup(doc);
    const used = draw(snapshot([[1, 0, 0, 0, 0]], ['truck']));
    expect(used.map((m) => m.name)).toEqual(['vehicles-truck']);
    expect(used[0]!.geometry.getAttribute('aMat')).toBeUndefined();
    layer.dispose();
  });

  it('draws dispatched vehicles as fire engine / ambulance with flashing beacons, whatever their type', () => {
    const doc = createEmptyDoc();
    doc.vehicleTypes.ambulance!.parts[0]!.height += 0.2; // even an edited type
    const { draw, layer } = setup(doc);
    const dispatches = [
      { eventId: 'e1', kind: 'fire', vehicleId: 7, stage: 'enroute', facilityId: 'f', buildingId: 'b' },
      { eventId: 'e2', kind: 'medical', vehicleId: 8, stage: 'enroute', facilityId: 'f', buildingId: 'b' },
    ] as ScenarioView['dispatches'];
    const used = draw(snapshot([[7, 0, 0, 0, 0], [8, 30, 0, 0, 0], [9, 60, 0, 0, 0]], ['ambulance'], { dispatches }));
    const names = used.map((m) => m.name).sort();
    expect(names).toContain('vehicles-fire-dispatch-lod0');
    expect(names).toContain('vehicles-ambulance-dispatch-lod0');
    // Only the vehicle that is not dispatched uses the type's own parts: no double body.
    expect(used.find((m) => m.name === 'vehicles-ambulance')!.count).toBe(1);
    const fire = used.find((m) => m.name.startsWith('vehicles-fire'))!;
    expect(pose(fire, 0).color).toBe('#c81e1e');
    const flash = fire.geometry.getAttribute('aMat');
    let beacons = 0;
    for (let i = 0; i < flash.count; i++) if (flash.getY(i) >= 2) beacons++;
    expect(beacons).toBeGreaterThan(0);
    layer.dispose();
  });

  it('lights lamps at night and alternates the beacon phase', () => {
    const { layer } = setup();
    const mat = (layer as unknown as { modelMat: THREE.Material }).modelMat;
    layer.update(0, createEmptyDoc(), undefined, 0.8);
    expect((mat.userData.uNight as { value: number }).value).toBe(0.8);
    const a = (mat.userData.uFlash as { value: number }).value;
    layer.update(170, createEmptyDoc(), undefined, 0.8);
    expect((mat.userData.uFlash as { value: number }).value).toBe(1 - a);
    layer.dispose();
  });

  it('stays inside the type size at the smallest and largest allowed sizes, at every detail level (classes, fitted, dispatched)', () => {
    const dispatches = [
      { eventId: 'e1', kind: 'fire', vehicleId: 900, stage: 'enroute', facilityId: 'f', buildingId: 'b' },
      { eventId: 'e2', kind: 'medical', vehicleId: 901, stage: 'enroute', facilityId: 'f', buildingId: 'b' },
    ] as ScenarioView['dispatches'];
    const ids = ['sedan', 'suv', 'truck', 'city-bus', 'ambulance'];
    const sizes = [
      { length: 2, width: 1, height: 1 },
      { length: 30, width: 4, height: 6 },
      { length: 30, width: 1, height: 1 },
      { length: 2, width: 4, height: 6 },
    ];
    const box = new THREE.Box3();
    for (const size of sizes) {
      const doc = createEmptyDoc();
      for (const id of ids) Object.assign(doc.vehicleTypes[id]!, size);
      const { draw, layer } = setup(doc);
      const cars: [number, number, number, number, number][] = [];
      // Every class of both mixes, each fitted type, and two dispatched vehicles, all at the origin heading +x.
      for (const [group, t] of [['sedan', 0], ['suv', 1]] as const) for (let c = 0; c < CAR_CLASSES.length; c++) {
        try {
          cars.push([idOfClass(c, group), 0, 0, 0, t]);
        } catch {
          /* class not in this mix */
        }
      }
      cars.push([800, 0, 0, 0, 2], [801, 0, 0, 0, 3], [802, 0, 0, 0, 4], [900, 0, 0, 0, 0], [901, 0, 0, 0, 3]);
      for (const eye of [new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 150, 0), new THREE.Vector3(0, 2000, 0)]) {
        const used = draw(snapshot(cars, ids, { dispatches }), eye);
        expect(used.reduce((a, m) => a + m.count, 0)).toBe(cars.length);
        for (const m of used) {
          m.geometry.computeBoundingBox();
          for (let i = 0; i < m.count; i++) {
            m.getMatrixAt(i, _m);
            box.copy(m.geometry.boundingBox!).applyMatrix4(_m);
            const eps = 1e-5;
            const tag = `${m.name} #${i} @${JSON.stringify(size)}`;
            expect(box.min.x, tag).toBeGreaterThanOrEqual(-size.length / 2 - eps);
            expect(box.max.x, tag).toBeLessThanOrEqual(size.length / 2 + eps);
            expect(box.min.z, tag).toBeGreaterThanOrEqual(-size.width / 2 - eps);
            expect(box.max.z, tag).toBeLessThanOrEqual(size.width / 2 + eps);
            expect(box.min.y, tag).toBeGreaterThanOrEqual(0);
            expect(box.max.y, tag).toBeLessThanOrEqual(0.06 + size.height + 1e-6);
          }
        }
      }
      layer.dispose();
    }
  });

  it('keeps a bounded set of models over repeated size edits and frees them when the document no longer uses them', () => {
    const doc = createEmptyDoc();
    const { layer } = setup(doc);
    let cur: SimSnapshot = snapshot([[1, 0, 0, 0, 0], [2, 20, 0, 0, 0]], ['city-bus'], {
      dispatches: [{ eventId: 'e', kind: 'fire', vehicleId: 2, stage: 'enroute', facilityId: 'f', buildingId: 'b' }] as ScenarioView['dispatches'],
    });
    (layer as unknown as { stream: SimulationStream }).stream = { latest: () => cur, previous: () => null, previousAt: () => 0, latestAt: () => 0 } as unknown as SimulationStream;
    let disposed = 0;
    const watch = (): void => {
      for (const m of layer.group.children as THREE.InstancedMesh[]) {
        if (m.geometry.userData.watched) continue;
        m.geometry.userData.watched = true;
        m.geometry.addEventListener('dispose', () => void disposed++);
      }
    };
    const entries0 = layer.modelEntryCount;
    let meshesMax = 0;
    for (let k = 0; k < 100; k++) {
      // A new type object each time, as a vehicleType.upsert produces.
      doc.vehicleTypes['city-bus'] = { ...doc.vehicleTypes['city-bus']!, length: 6 + k * 0.2 };
      layer.syncTypes(doc);
      layer.update(k, doc, new THREE.Vector3(0, 10, 0));
      watch();
      meshesMax = Math.max(meshesMax, layer.group.children.length);
    }
    expect(layer.modelEntryCount).toBeLessThanOrEqual(entries0 + 2); // bus + fire engine (dispatched)
    expect(meshesMax).toBe(3); // far box, bus and dispatched fire engine (LOD 0 at this distance): no meshes left behind by edits
    // Dispatch over, then a document without the default types: every model mesh is freed.
    cur = snapshot([], ['city-bus']);
    layer.update(200, doc);
    const other = createEmptyDoc();
    other.vehicleTypes = { mine: { ...structuredClone(other.vehicleTypes.sedan!), id: 'mine' } };
    other.vehicleTypes.mine!.parts[0]!.height += 0.1;
    layer.syncTypes(other);
    const left = (layer.group.children as THREE.InstancedMesh[]).map((m) => m.name).sort();
    expect(left).toEqual(['vehicles-far', 'vehicles-mine']);
    expect(disposed).toBe(2); // bus and fire engine geometries (and their instance buffers with the meshes)
    layer.dispose();
  });

  it('does not flicker between detail levels when the camera jitters at a boundary', () => {
    const { draw, layer } = setup();
    const id = idOfClass(0);
    const snap = snapshot([[id, LOD_DIST[0] - 1, 2, 0, 0]], ['sedan']);
    const seen = new Set<string>();
    for (let k = 0; k < 40; k++) {
      const used = draw(snap, new THREE.Vector3(k % 2 === 0 ? 0.1 : -0.1, 0, 0));
      seen.add(used[0]!.name);
    }
    expect([...seen]).toHaveLength(1);
    layer.dispose();
  });

  it('keeps the level across new snapshots (vehicle order changed) while the camera jitters at a boundary', () => {
    const id = idOfClass(0);
    const at = LOD_DIST[0] - 1;
    let prev: SimSnapshot | null = null;
    let cur: SimSnapshot = snapshot([[id, at, 2, 0, 0]], ['sedan']);
    const stream = { latest: () => cur, previous: () => prev, previousAt: () => 0, latestAt: () => 0 } as unknown as SimulationStream;
    const doc = createEmptyDoc();
    const layer = new VehicleLayer(stream);
    layer.syncTypes(doc);
    const seen = new Set<string>();
    for (let k = 0; k < 40; k++) {
      if (k % 3 === 0) {
        // A new snapshot with other vehicles before this one: its slot index changes.
        prev = cur;
        const others: [number, number, number, number, number][] = Array.from({ length: k % 2 ? 3 : 1 }, (_, j) => [5000 + j, 500, 0, 0, 0]);
        cur = snapshot([...others, [id, at, 2, 0, 0]], ['sedan']);
      }
      layer.update(0, doc, new THREE.Vector3(k % 2 === 0 ? 0.1 : -0.1, 0, 0));
      for (const m of layer.group.children as THREE.InstancedMesh[]) if (m.count > 0 && m.name.startsWith('vehicles-car')) seen.add(m.name);
    }
    expect([...seen]).toHaveLength(1);
    layer.dispose();
  });
});
