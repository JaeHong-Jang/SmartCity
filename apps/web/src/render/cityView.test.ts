import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyCommand, buildingMetrics, createEmptyDoc, Rng, partFootprint, pointInPolygon, type Building, type BuildingType, type CityDoc, type Command, type Vec2 } from '@smartcity/shared';
import { createBenchCity } from '../dev/benchCity';
import {
  CITY_VIEW_ELEVATION,
  CITY_VIEW_MAX,
  CITY_VIEW_NDC_MARGIN,
  cityFitDistance,
  cityFrame,
  cityViewPose,
  DEFAULT_AZIMUTH,
  DISTRICT_SIZE,
  districtFrame,
  EYE_HEIGHT,
  eyeLevelPose,
  type CameraPose,
  type CityFrame,
} from './cityView';
import { roofHeight, wallHeight } from './buildingGeometry';
import { MIN_DISTANCE } from './camera';

function town(): CityDoc {
  const doc = createEmptyDoc();
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) doc.nodes[`n${i}_${j}`] = { id: `n${i}_${j}`, pos: { x: 300 + i * 100, z: -200 + j * 100 } };
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (i < 4) doc.segments[`x${i}_${j}`] = { id: `x${i}_${j}`, a: `n${i}_${j}`, b: `n${i + 1}_${j}`, roadTypeId: 'road-2' };
      if (j < 4) doc.segments[`z${i}_${j}`] = { id: `z${i}_${j}`, a: `n${i}_${j}`, b: `n${i}_${j + 1}`, roadTypeId: 'road-2' };
    }
  }
  return doc;
}

/** A camera placed like camera-controls would place it for a pose. */
function cameraFor(pose: CameraPose, aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, aspect, 1, 20_000);
  cam.position.set(pose.position.x, pose.position.y, pose.position.z);
  cam.lookAt(pose.target.x, 0, pose.target.z);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

/** NDC of a world point and whether it is in front of the camera. */
function ndc(cam: THREE.PerspectiveCamera, x: number, y: number, z: number): { x: number; y: number; front: boolean } {
  const v = new THREE.Vector3(x, y, z);
  const front = v.clone().applyMatrix4(cam.matrixWorldInverse).z < 0;
  v.project(cam);
  return { x: v.x, y: v.y, front };
}

function corners(f: CityFrame): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, f.height]) out.push([f.center.x + sx * f.halfX, y, f.center.z + sz * f.halfZ]);
  return out;
}

describe('city view framing', () => {
  it('frames the built area, not the origin, with the tallest building', () => {
    const doc = town();
    doc.buildings.t = { id: 't', typeId: 'office-tower', pos: { x: 450, z: 50 }, rotation: 0 };
    const f = cityFrame(doc)!;
    expect(f.center.x).toBeCloseTo(500, 6);
    expect(f.center.z).toBeCloseTo(0, 6);
    expect(f.height).toBeCloseTo(buildingMetrics(doc.buildingTypes['office-tower']!).height, 6);
    expect(cityFrame(createEmptyDoc())).toBeNull();
  });

  it('ignores a lone far outlier', () => {
    const doc = town();
    doc.nodes.far = { id: 'far', pos: { x: -1900, z: 1900 } };
    const f = cityFrame(doc)!;
    expect(f.center.x).toBeGreaterThan(400);
    expect(f.halfX).toBeLessThan(400);
  });

  // Sol's repro: a ±200 m city (margin included: 230) at 16:9 cut its corners far off screen.
  const cases: { name: string; frame: CityFrame; aspect: number }[] = [
    { name: '±200 m square, 16:9', frame: { center: { x: 0, z: 0 }, halfX: 230, halfZ: 230, height: 0 }, aspect: 16 / 9 },
    { name: '±200 m square with 120 m towers, 16:9', frame: { center: { x: 50, z: -80 }, halfX: 230, halfZ: 230, height: 120 }, aspect: 16 / 9 },
    { name: 'long thin city, portrait 9:16', frame: { center: { x: 0, z: 0 }, halfX: 260, halfZ: 90, height: 40 }, aspect: 9 / 16 },
    { name: '1.1 km city with towers, 16:9', frame: { center: { x: 0, z: 0 }, halfX: 550, halfZ: 550, height: 120 }, aspect: 16 / 9 },
    { name: 'small block, square window', frame: { center: { x: 300, z: 300 }, halfX: 60, halfZ: 60, height: 20 }, aspect: 1 },
  ];
  for (const { name, frame, aspect } of cases) {
    for (const az of [0, 0.7, -2.3, Math.PI / 2]) {
      it(`keeps every frame corner on screen: ${name}, azimuth ${az.toFixed(2)}`, () => {
        const pose = cityViewPose(frame, 50, aspect, az);
        expect(pose.fits).toBe(true);
        expect(pose.elevation).toBeCloseTo(CITY_VIEW_ELEVATION, 9);
        const cam = cameraFor(pose, aspect);
        let touches = 0;
        for (const [x, y, z] of corners(frame)) {
          const p = ndc(cam, x, y, z);
          expect(p.front).toBe(true);
          expect(Math.abs(p.x)).toBeLessThanOrEqual(CITY_VIEW_NDC_MARGIN + 1e-6);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(CITY_VIEW_NDC_MARGIN + 1e-6);
          if (Math.max(Math.abs(p.x), Math.abs(p.y)) > CITY_VIEW_NDC_MARGIN - 1e-3) touches++;
        }
        // Tight: some corner touches the margin unless the minimum distance applies.
        const d = Math.hypot(pose.position.x - pose.target.x, pose.position.y, pose.position.z - pose.target.z);
        if (d > 120 + 1e-6) expect(touches).toBeGreaterThan(0);
      });
    }
  }

  it('portrait windows use the narrow horizontal field of view (needs more distance than landscape)', () => {
    const frame = { center: { x: 0, z: 0 }, halfX: 260, halfZ: 90, height: 40 };
    expect(cityFitDistance(frame, 50, 9 / 16, 0, CITY_VIEW_ELEVATION)).toBeGreaterThan(cityFitDistance(frame, 50, 16 / 9, 0, CITY_VIEW_ELEVATION) * 1.5);
  });

  it('a steeper view would not fit more: the low angle is also the closest fit', () => {
    const frame = { center: { x: 0, z: 0 }, halfX: 550, halfZ: 550, height: 60 };
    const low = cityFitDistance(frame, 50, 16 / 9, -0.6, CITY_VIEW_ELEVATION);
    for (const deg of [25, 31, 40, 60]) expect(cityFitDistance(frame, 50, 16 / 9, -0.6, (deg * Math.PI) / 180)).toBeGreaterThan(low);
  }, 60_000);

  it('policy for a city too large for the cap: 19°, capped distance, center framed, nothing behind the camera', () => {
    const doc = createBenchCity();
    const frame = cityFrame(doc)!;
    const pose = cityViewPose(frame, 50, 16 / 9);
    expect(pose.fits).toBe(false);
    expect(pose.elevation).toBeCloseTo(CITY_VIEW_ELEVATION, 9);
    expect(Math.hypot(pose.position.x - pose.target.x, pose.position.y, pose.position.z - pose.target.z)).toBeCloseTo(CITY_VIEW_MAX, 6);
    const cam = cameraFor(pose, 16 / 9);
    const c = ndc(cam, frame.center.x, 0, frame.center.z);
    expect(Math.abs(c.x) + Math.abs(c.y)).toBeLessThan(1e-6);
    let behind = 0;
    for (const b of Object.values(doc.buildings)) if (!ndc(cam, b.pos.x, 0, b.pos.z).front) behind++;
    expect(behind).toBe(0);
  }, 60_000);
});

/** Every outline vertex of every building part, at its base and at its top (world space). */
function outlineVertices(doc: CityDoc, filter: (b: Building) => boolean = () => true): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const b of Object.values(doc.buildings)) {
    if (!filter(b)) continue;
    for (const part of doc.buildingTypes[b.typeId]!.parts) {
      for (const v of partFootprint(b, part)) {
        out.push([v.x, part.baseHeight, v.z], [v.x, part.baseHeight + wallHeight(part) + roofHeight(part), v.z]);
      }
    }
  }
  return out;
}

/** Asserts every point is in front of the camera and inside ±margin NDC; returns the largest |NDC|. */
function expectOnScreen(cam: THREE.PerspectiveCamera, pts: [number, number, number][]): number {
  let worst = 0;
  for (const [x, y, z] of pts) {
    const p = ndc(cam, x, y, z);
    expect(p.front).toBe(true);
    worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
  }
  expect(worst).toBeLessThanOrEqual(CITY_VIEW_NDC_MARGIN + 1e-6);
  return worst;
}

const flatType = (id: string, w: number, d: number, floors: number, fh: number, parts?: BuildingType['parts']): BuildingType => ({
  id,
  name: id,
  zone: 'office',
  rev: 1,
  parts: parts ?? [{ offset: { x: 0, z: 0 }, width: w, depth: d, floors, floorHeight: fh, baseHeight: 0, roof: 'flat', color: '#999999', roofColor: '#666666' }],
});

/** Applies commands like the server would (each must be accepted). */
function build(cmds: Command[]): CityDoc {
  const doc = createEmptyDoc();
  for (const c of cmds) expect(applyCommand(doc, c)).toEqual({ ok: true });
  return doc;
}

describe("frames real building outlines (Sol's recheck)", () => {
  it('repro B: one 300 × 300 m building is framed by its outline, not its origin', () => {
    const doc = build([
      { type: 'buildingType.upsert', buildingType: flatType('huge', 300, 300, 1, 3) },
      { type: 'building.place', building: { id: 'h', typeId: 'huge', pos: { x: 0, z: 0 }, rotation: 0 } },
    ]);
    const f = cityFrame(doc)!;
    expect(f.halfX).toBeGreaterThanOrEqual(150);
    expect(f.halfZ).toBeGreaterThanOrEqual(150);
    for (const frame of [f, districtFrame(doc)!]) {
      for (const az of [DEFAULT_AZIMUTH, 0, Math.PI / 2]) {
        const pose = cityViewPose(frame, 50, 16 / 9, az);
        expect(pose.fits).toBe(true);
        expectOnScreen(cameraFor(pose, 16 / 9), outlineVertices(doc));
      }
    }
  });

  it('a rotated multi-part building with offset volumes stays on screen (landscape and portrait)', () => {
    const parts: BuildingType['parts'] = [
      { offset: { x: 0, z: 0 }, width: 60, depth: 30, floors: 4, floorHeight: 4, baseHeight: 0, roof: 'flat', color: '#999999', roofColor: '#666666' },
      { offset: { x: 70, z: 25 }, width: 20, depth: 20, floors: 40, floorHeight: 3.5, baseHeight: 0, roof: 'flat', color: '#999999', roofColor: '#666666' },
      { offset: { x: -40, z: -30 }, width: 30, depth: 20, floors: 3, floorHeight: 4, baseHeight: 16, roof: 'flat', color: '#999999', roofColor: '#666666' },
    ];
    const doc = build([
      { type: 'buildingType.upsert', buildingType: flatType('complex', 0, 0, 0, 0, parts) },
      { type: 'building.place', building: { id: 'c', typeId: 'complex', pos: { x: 200, z: -100 }, rotation: 0.9 } },
    ]);
    const f = cityFrame(doc)!;
    expect(f.height).toBeCloseTo(140, 6);
    for (const aspect of [16 / 9, 9 / 16]) {
      for (const az of [DEFAULT_AZIMUTH, 1.3, -2.5]) expectOnScreen(cameraFor(cityViewPose(f, 50, aspect, az), aspect), outlineVertices(doc));
    }
  });

  it('repro A: a tower inside the re-centered district square sets its height', () => {
    const doc = build([
      { type: 'buildingType.upsert', buildingType: flatType('left', 20, 100, 1, 2) },
      { type: 'buildingType.upsert', buildingType: flatType('heavy', 100, 40, 10, 2) },
      { type: 'buildingType.upsert', buildingType: flatType('tower', 3, 3, 100, 3) },
      { type: 'building.place', building: { id: 'l', typeId: 'left', pos: { x: 0, z: 0 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'h', typeId: 'heavy', pos: { x: 500, z: 0 }, rotation: 0 } },
      { type: 'building.place', building: { id: 't', typeId: 'tower', pos: { x: 700, z: 0 }, rotation: 0 } },
    ]);
    const f = districtFrame(doc)!;
    expect(whollyInside(doc, f)(doc.buildings.t!)).toBe(true);
    expect(f.height).toBeCloseTo(300, 6);
    for (const az of [0, Math.PI / 2, DEFAULT_AZIMUTH]) expectDistrictGuarantees(doc, f, 16 / 9, az);
  });
});

/** Every part outline vertex of `b` lies within the frame's ground box. */
const whollyInside = (doc: CityDoc, f: CityFrame) => (b: Building): boolean =>
  doc.buildingTypes[b.typeId]!.parts.every((p) => partFootprint(b, p).every((v) => Math.abs(v.x - f.center.x) <= f.halfX + 1e-6 && Math.abs(v.z - f.center.z) <= f.halfZ + 1e-6));

/** Some part outline of `b` reaches into the frame's ground box (box-overlap test, as the frame uses). */
const touchesBox = (doc: CityDoc, f: CityFrame) => (b: Building): boolean => {
  const vs = doc.buildingTypes[b.typeId]!.parts.flatMap((p) => partFootprint(b, p));
  const xs = vs.map((v) => v.x);
  const zs = vs.map((v) => v.z);
  return Math.max(...xs) >= f.center.x - f.halfX && Math.min(...xs) <= f.center.x + f.halfX && Math.max(...zs) >= f.center.z - f.halfZ && Math.min(...zs) <= f.center.z + f.halfZ;
};

/**
 * District guarantees: the pose fits; every building wholly inside the square is fully on screen and
 * in front of the camera; buildings straddling the square's edge are never behind the camera (they
 * may run past the screen edges); the box height is at least every touching building's top.
 */
function expectDistrictGuarantees(doc: CityDoc, f: CityFrame, aspect: number, az: number): number {
  const pose = cityViewPose(f, 50, aspect, az);
  expect(pose.fits).toBe(true);
  const cam = cameraFor(pose, aspect);
  const inside = whollyInside(doc, f);
  const touching = touchesBox(doc, f);
  for (const [x, y, z] of corners(f)) {
    const p = ndc(cam, x, y, z);
    expect(p.front && Math.max(Math.abs(p.x), Math.abs(p.y)) <= CITY_VIEW_NDC_MARGIN + 1e-6).toBe(true);
  }
  let n = 0;
  const pts = outlineVertices(doc, inside);
  if (pts.length) expectOnScreen(cam, pts);
  for (const b of Object.values(doc.buildings)) {
    if (!touching(b)) continue;
    n++;
    for (const [x, y, z] of outlineVertices(doc, (o) => o.id === b.id)) {
      expect(ndc(cam, x, y, z).front).toBe(true);
      expect(f.height).toBeGreaterThanOrEqual(y - 1e-6);
    }
  }
  return n;
}

const dist = (q: CameraPose) => Math.hypot(q.position.x - q.target.x, q.position.y, q.position.z - q.target.z);

describe('frames without growth: district = square, full = single-pass union', () => {
  const part = (ox: number, w: number, d: number, floors: number, fh: number): BuildingType['parts'][number] => ({
    offset: { x: ox, z: 0 }, width: w, depth: d, floors, floorHeight: fh, baseHeight: 0, roof: 'flat', color: '#999999', roofColor: '#666666',
  });

  it('repro C: a tower touching the district square sets the height', () => {
    const doc = build([
      { type: 'buildingType.upsert', buildingType: flatType('left', 0, 0, 0, 0, [part(0, 20, 100, 1, 2)]) },
      { type: 'buildingType.upsert', buildingType: flatType('heavy', 0, 0, 0, 0, [part(200, 300, 40, 10, 2)]) },
      { type: 'buildingType.upsert', buildingType: flatType('tower', 0, 0, 0, 0, [part(0, 3, 3, 100, 3)]) },
      { type: 'building.place', building: { id: 'l', typeId: 'left', pos: { x: -500, z: 0 }, rotation: 0 } },
      { type: 'building.place', building: { id: 'h', typeId: 'heavy', pos: { x: 0, z: 0 }, rotation: 0 } },
      { type: 'building.place', building: { id: 't', typeId: 'tower', pos: { x: 330, z: 100 }, rotation: 0 } },
    ]);
    const f = districtFrame(doc)!;
    expect(f.halfX).toBe(DISTRICT_SIZE / 2);
    if (touchesBox(doc, f)(doc.buildings.t!)) expect(f.height).toBeCloseTo(300, 6);
    for (const aspect of [16 / 9, 9 / 16]) for (const az of [0, Math.PI / 2, DEFAULT_AZIMUTH]) expectDistrictGuarantees(doc, f, aspect, az);
  });

  /** Repro D: a row of 20 touching 100 × 20 m buildings, x from −1000 to 1000. */
  const rowCmds = (reverse: boolean): Command[] => {
    const ids = Array.from({ length: 20 }, (_, i) => i);
    if (reverse) ids.reverse();
    return [
      { type: 'buildingType.upsert', buildingType: flatType('bar', 100, 20, 1, 3) },
      ...ids.map((i): Command => ({ type: 'building.place', building: { id: `r${String(i).padStart(2, '0')}`, typeId: 'bar', pos: { x: -950 + 100 * i, z: 0 }, rotation: 0 } })),
    ];
  };

  it('repro D: touching buildings do not chain the district wider; it stays ~600 m and closer than the full view', () => {
    const doc = build(rowCmds(false));
    const f = districtFrame(doc)!;
    expect(f.halfX).toBe(DISTRICT_SIZE / 2);
    expect(f.halfZ).toBe(DISTRICT_SIZE / 2);
    const full = cityFrame(doc)!;
    for (const aspect of [16 / 9, 9 / 16]) {
      for (const az of [DEFAULT_AZIMUTH, 0, Math.PI / 2]) {
        expect(dist(cityViewPose(f, 50, aspect, az))).toBeLessThan(dist(cityViewPose(full, 50, aspect, az)));
        expect(expectDistrictGuarantees(doc, f, aspect, az)).toBeGreaterThan(4);
      }
    }
  });

  it('is independent of insertion order (district and full view)', () => {
    const tower: Command[] = [
      { type: 'buildingType.upsert', buildingType: flatType('tall', 20, 20, 100, 3) },
      { type: 'building.place', building: { id: 'tall', typeId: 'tall', pos: { x: 0, z: 60 }, rotation: 0 } },
    ];
    const row = (reverse: boolean): Command[] => {
      const ids = Array.from({ length: 40 }, (_, i) => i);
      if (reverse) ids.reverse();
      return [
        { type: 'buildingType.upsert', buildingType: flatType('bar', 100, 20, 1, 3) },
        ...ids.map((i): Command => ({ type: 'building.place', building: { id: `r${String(i).padStart(2, '0')}`, typeId: 'bar', pos: { x: -1950 + 100 * i, z: 0 }, rotation: 0 } })),
      ];
    };
    for (const extra of [[], tower]) {
      const a = build([...row(false), ...extra]);
      const b = build([...extra, ...row(true)]);
      expect(districtFrame(b)).toEqual(districtFrame(a));
      expect(cityFrame(b)).toEqual(cityFrame(a));
    }
    const a = build(rowCmds(false));
    const b = build(rowCmds(true));
    expect(districtFrame(b)).toEqual(districtFrame(a));
    expect(cityFrame(b)).toEqual(cityFrame(a));
  });

  it('property: random accepted layouts keep the guarantees (district: square; full: union)', () => {
    let checked = 0;
    let portrait = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rng = new Rng(seed * 7919);
      const r = (a: number, b: number) => a + (b - a) * rng.next();
      const doc = createEmptyDoc();
      const n = 3 + Math.floor(r(0, 10));
      for (let i = 0; i < n; i++) {
        const parts: BuildingType['parts'] = [];
        const np = 1 + Math.floor(r(0, 3));
        for (let k = 0; k < np; k++) {
          const roof = (['flat', 'gable', 'pyramid'] as const)[Math.floor(r(0, 3))]!;
          parts.push({ offset: { x: r(-200, 200), z: r(-200, 200) }, width: r(3, 300), depth: r(3, 300), floors: 1 + Math.floor(r(0, 80)), floorHeight: r(2, 4), baseHeight: rng.next() < 0.2 ? r(0, 60) : 0, roof, color: '#999999', roofColor: '#666666' });
        }
        const t: BuildingType = { id: `t${i}`, name: `t${i}`, zone: 'office', parts };
        if (!applyCommand(doc, { type: 'buildingType.upsert', buildingType: t }).ok) continue;
        applyCommand(doc, { type: 'building.place', building: { id: `b${i}`, typeId: t.id, pos: { x: r(-700, 700), z: r(-700, 700) }, rotation: r(-Math.PI, Math.PI) } });
      }
      if (Object.keys(doc.buildings).length === 0) continue;
      const full = cityFrame(doc)!;
      const district = districtFrame(doc)!;
      for (const aspect of [16 / 9, 9 / 16]) {
        for (const az of [0, 2.1, DEFAULT_AZIMUTH]) {
          // Within the distance cap only (beyond it the documented policy cuts the edges).
          if (cityViewPose(district, 50, aspect, az).fits) {
            expectDistrictGuarantees(doc, district, aspect, az);
            checked++;
            if (aspect < 1) portrait++;
          }
          const pose = cityViewPose(full, 50, aspect, az);
          if (!pose.fits) continue;
          const pts = outlineVertices(doc, whollyInside(doc, full));
          if (pts.length === 0) continue;
          expectOnScreen(cameraFor(pose, aspect), pts);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(portrait).toBeGreaterThan(30);
  }, 120_000);
});

describe('district view (first entry, first "도시 보기")', () => {
  const bench = createBenchCity();

  it('frames the densest 600 m district of a big city: downtown, not the factories', () => {
    const f = districtFrame(bench)!;
    expect(f.halfX).toBe(DISTRICT_SIZE / 2);
    expect(f.halfZ).toBe(DISTRICT_SIZE / 2);
    // Downtown towers stand within ~330 m of the origin; the industrial quarter is at x, z > 590.
    expect(Math.hypot(f.center.x, f.center.z)).toBeLessThan(330);
    expect(f.height).toBeGreaterThan(60);
  }, 60_000);

  for (const aspect of [16 / 9, 9 / 16]) {
    for (const az of [-0.6, 2.2]) {
      it(`keeps the district guarantees on the bench city (aspect ${aspect.toFixed(2)}, azimuth ${az})`, () => {
        const f = districtFrame(bench)!;
        expect(Object.values(bench.buildings).filter(whollyInside(bench, f)).length).toBeGreaterThan(50);
        expect(expectDistrictGuarantees(bench, f, aspect, az)).toBeGreaterThan(50);
        // Closer than the full-city view: the city fills the screen.
        expect(dist(cityViewPose(f, 50, aspect, az))).toBeLessThan(dist(cityViewPose(cityFrame(bench)!, 50, aspect, az)));
      }, 60_000);
    }
  }

  it('is the whole city when the city is already district-sized', () => {
    const doc = town();
    expect(districtFrame(doc)).toEqual(cityFrame(doc));
    expect(districtFrame(createEmptyDoc())).toBeNull();
  });
});

describe('street-level view', () => {
  const blocked = (doc: CityDoc, p: { x: number; y: number; z: number }): boolean =>
    Object.values(doc.buildings).some((b) => {
      const t = doc.buildingTypes[b.typeId]!;
      return t.parts.some((part) => p.y >= part.baseHeight && p.y <= part.baseHeight + part.floors * part.floorHeight && pointInPolygon({ x: p.x, z: p.z }, partFootprint(b, part)));
    });
  const onRoad = (doc: CityDoc, p: Vec2): boolean =>
    Object.values(doc.segments).some((s) => {
      const a = doc.nodes[s.a]!.pos;
      const b = doc.nodes[s.b]!.pos;
      if (s.control) return true;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / ((b.x - a.x) ** 2 + (b.z - a.z) ** 2)));
      return Math.hypot(a.x + (b.x - a.x) * t - p.x, a.z + (b.z - a.z) * t - p.z) < 1e-6;
    });
  const pitchOk = (p: CameraPose) => {
    const flat = Math.hypot(p.target.x - p.position.x, p.target.z - p.position.z);
    expect(Math.hypot(flat, p.position.y)).toBeGreaterThan(MIN_DISTANCE);
    // Within the camera's polar limit (π/2 − 0.08): not clamped.
    expect(Math.atan2(flat, p.position.y)).toBeLessThan(Math.PI / 2 - 0.08);
  };

  it("never starts inside a building behind the junction (Sol's repro)", () => {
    const doc = createEmptyDoc();
    doc.nodes.a = { id: 'a', pos: { x: 0, z: 0 } };
    doc.nodes.b = { id: 'b', pos: { x: 100, z: 0 } };
    doc.segments.s = { id: 's', a: 'a', b: 'b', roadTypeId: 'road-2' };
    doc.buildings.t = { id: 't', typeId: 'office-tower', pos: { x: -30, z: 0 }, rotation: 0 };
    const p = eyeLevelPose(doc, { x: 0, z: 0 }, { x: 0, z: 0 })!;
    expect(p.position.y).toBe(EYE_HEIGHT);
    expect(blocked(doc, p.position)).toBe(false);
    expect(onRoad(doc, { x: p.position.x, z: p.position.z })).toBe(true);
    expect(p.position.x).toBeGreaterThan(0);
    pitchOk(p);
  });

  it('stands on the road looking along it toward the center', () => {
    const doc = town();
    const p = eyeLevelPose(doc, { x: 300, z: 0 }, { x: 500, z: 0 })!;
    expect(onRoad(doc, { x: p.position.x, z: p.position.z })).toBe(true);
    expect(p.target.x).toBeGreaterThan(p.position.x);
    expect(Math.abs(p.target.z - p.position.z)).toBeLessThan(1e-6);
    pitchOk(p);
    expect(eyeLevelPose(createEmptyDoc(), { x: 0, z: 0 }, { x: 0, z: 0 })).toBeNull();
  });

  it('handles a dead end and a very short road (stays within the road)', () => {
    const doc = createEmptyDoc();
    doc.nodes.a = { id: 'a', pos: { x: 0, z: 0 } };
    doc.nodes.b = { id: 'b', pos: { x: 8, z: 0 } };
    doc.segments.s = { id: 's', a: 'a', b: 'b', roadTypeId: 'road-2' };
    const p = eyeLevelPose(doc, { x: 8, z: 0 }, { x: 8, z: 0 })!;
    expect(p.position.x).toBeGreaterThanOrEqual(0);
    expect(p.position.x).toBeLessThanOrEqual(8);
    expect(onRoad(doc, { x: p.position.x, z: p.position.z })).toBe(true);
    pitchOk(p);
  });

  it('follows a curve: on the arc, looking along its tangent', () => {
    const doc = createEmptyDoc();
    doc.nodes.a = { id: 'a', pos: { x: 0, z: 0 } };
    doc.nodes.b = { id: 'b', pos: { x: 100, z: 100 } };
    doc.segments.s = { id: 's', a: 'a', b: 'b', roadTypeId: 'road-2', control: { x: 100, z: 0 } };
    const p = eyeLevelPose(doc, { x: 0, z: 0 }, { x: 100, z: 100 })!;
    // Quadratic Bezier near its start runs along +x: the camera is close to z = 0, slightly bent.
    expect(p.position.x).toBeGreaterThan(5);
    expect(p.position.z).toBeGreaterThan(0);
    expect(p.position.z).toBeLessThan(5);
    expect(p.target.x - p.position.x).toBeGreaterThan(Math.abs(p.target.z - p.position.z));
    pitchOk(p);
  });

  it('skips a spot under an overhanging building and tries the next road', () => {
    const doc = town();
    // A volume bridging the road 14 m east of junction (300, 0) at 5–20 m height (not via applyCommand).
    doc.buildingTypes.bridge = { id: 'bridge', name: '브리지', zone: 'office', rev: 1, parts: [{ offset: { x: 0, z: 0 }, width: 30, depth: 30, floors: 5, floorHeight: 3, baseHeight: 5, roof: 'flat', color: '#999999', roofColor: '#666666' }] };
    doc.buildings.br = { id: 'br', typeId: 'bridge', pos: { x: 314, z: 0 }, rotation: 0 };
    const p = eyeLevelPose(doc, { x: 300, z: 0 }, { x: 500, z: 0 })!;
    expect(blocked(doc, p.position)).toBe(false);
    expect(Math.hypot(p.position.x - 314, p.position.z)).toBeGreaterThan(15);
  });
});
