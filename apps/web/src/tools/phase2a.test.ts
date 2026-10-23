import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, dist, dot, IdGen, rotateY, type Vec2 } from '@smartcity/shared';
import { crossDoc, road } from '../test/fixtures';
import { alignToRoad, GHOST_ID, placementGuide, placementStatus } from './buildingTool';
import { CLICK_SLOP_PX, DragGesture } from './gesture';
import { guideGridLines } from './guideGrid';
import { makeParcel, parcelGhostError, rectPolygon } from './parcelTool';
import { PickIndex } from './picking';
import { ghostPolyline, wrapAngle } from './selectTool';
import { nextSnapStep, snapAlong, snapPoint, SNAP_STEPS } from './snap';
import { commandError } from './validate';

describe('snap step', () => {
  it('G cycles 8 → 4 → 2 → 1 → off → 8', () => {
    const seen = [8 as const];
    let s = nextSnapStep(8);
    while (s !== 8) {
      seen.push(s as never);
      s = nextSnapStep(s);
    }
    expect(seen).toEqual([8, 4, 2, 1, 0]);
    expect(SNAP_STEPS).toEqual([8, 4, 2, 1, 0]);
  });

  it('snaps points to the step and leaves them alone when off', () => {
    expect(snapPoint({ x: 5.2, z: -3.1 }, 4)).toEqual({ x: 4, z: -4 });
    expect(snapPoint({ x: 5.2, z: -3.1 }, 1)).toEqual({ x: 5, z: -3 });
    expect(snapPoint({ x: 5.2, z: -3.1 }, 0)).toEqual({ x: 5.2, z: -3.1 });
  });

  it('snaps arc length along a road but stays inside it', () => {
    expect(snapAlong(13, 100, 4)).toBe(12);
    expect(snapAlong(13, 100, 0)).toBe(13);
    expect(snapAlong(99.9, 100, 8)).toBeLessThan(100);
    expect(snapAlong(0.4, 100, 8)).toBeGreaterThan(0);
  });
});

describe('click vs drag', () => {
  it('stays a click below the threshold and becomes a drag once at it', () => {
    const g = new DragGesture();
    g.down(100, 100);
    expect(g.move(103, 102)).toBe(false);
    expect(g.phase).toBe('pressed');
    expect(g.up()).toBe('pressed');

    g.down(100, 100);
    expect(g.move(100 + CLICK_SLOP_PX, 100)).toBe(true);
    expect(g.move(140, 100)).toBe(false); // only once
    expect(g.phase).toBe('dragging');
    expect(g.up()).toBe('dragging');
    expect(g.phase).toBe('idle');
  });

  it('cancel (Esc / pointercancel) ignores the rest of the press', () => {
    const g = new DragGesture();
    g.down(0, 0);
    g.move(20, 0);
    g.cancel();
    expect(g.move(40, 0)).toBe(false);
    expect(g.up()).toBe('cancelled');
  });
});

describe('local guide grid', () => {
  const frame = { anchor: { x: 10, z: 5 }, u: { x: 1, z: 0 }, v: { x: 0, z: 1 } };

  it('draws a 10×10 cell grid in the road frame, extending away from the road', () => {
    const lines = guideGridLines(frame, 2);
    expect(lines).toHaveLength(22);
    const across = lines.slice(0, 11);
    const along = lines.slice(11);
    // Lines across the road: spaced by the step along u, each 10 cells long away from the road.
    across.forEach((l, i) => {
      expect(l[0]!.x).toBeCloseTo(10 + (i - 5) * 2);
      expect(l[0]!.z).toBeCloseTo(5);
      expect(l[1]!.z).toBeCloseTo(25);
    });
    // Lines parallel to the road, the first on the front line.
    along.forEach((l, j) => {
      expect(l[0]!.z).toBeCloseTo(5 + j * 2);
      expect(dist(l[0]!, l[1]!)).toBeCloseTo(20);
    });
  });

  it('follows a rotated road and is empty when snapping is off', () => {
    const a = Math.PI / 6;
    const u = { x: Math.cos(a), z: Math.sin(a) };
    const v = { x: -u.z, z: u.x };
    for (const l of guideGridLines({ anchor: { x: 0, z: 0 }, u, v }, 4)) {
      const d = { x: l[1]!.x - l[0]!.x, z: l[1]!.z - l[0]!.z };
      const along = Math.abs(dot(d, u)) > 1e-6;
      const away = Math.abs(dot(d, v)) > 1e-6;
      expect(along !== away).toBe(true); // every line is parallel to u or to v
    }
    expect(guideGridLines(frame, 0)).toEqual([]);
  });

  it('an aligned building placement carries the frame and its grid', () => {
    const doc = createEmptyDoc();
    road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('t'));
    const p = alignToRoad(doc, new PickIndex(doc), doc.buildingTypes.house!, { x: 13, z: 15 }, 4)!;
    expect(p.frame).toBeDefined();
    // Snapped to 4 m along the road (the road starts at x = -96).
    expect((p.pos.x + 96) % 4).toBeCloseTo(0);
    expect(placementGuide(p, 4)).toHaveLength(22);
    expect(placementGuide({ ...p, frame: undefined }, 4)).toEqual([]);
  });
});

describe('parcel ghost validation (same rules as the server)', () => {
  const doc = createEmptyDoc();
  expect(applyCommand(doc, { type: 'parcel.upsert', parcel: makeParcel('q1', rectPolygon({ x: 0, z: 0 }, { x: 40, z: 40 }), 'residential') }).ok).toBe(true);

  it('accepts a free rectangle and one that only touches an edge', () => {
    expect(parcelGhostError(doc, makeParcel('g', rectPolygon({ x: 60, z: 0 }, { x: 80, z: 20 }), 'commercial'))).toBeNull();
    expect(parcelGhostError(doc, makeParcel('g', rectPolygon({ x: 40, z: 0 }, { x: 60, z: 20 }), 'commercial'))).toBeNull();
  });

  it('flags overlap, too small and self-intersecting outlines in Korean', () => {
    expect(parcelGhostError(doc, makeParcel('g', rectPolygon({ x: 30, z: 30 }, { x: 60, z: 60 }), 'office'))).toContain('다른 필지와 겹칩니다');
    expect(parcelGhostError(doc, makeParcel('g', rectPolygon({ x: 100, z: 100 }, { x: 103, z: 103 }), 'office'))).toContain('너무 작습니다');
    const bowtie: Vec2[] = [{ x: 100, z: 100 }, { x: 120, z: 120 }, { x: 120, z: 100 }, { x: 100, z: 120 }];
    expect(parcelGhostError(doc, makeParcel('g', bowtie, 'office'))).toContain('스스로 교차');
  });

  it('uses the zone default regulation', () => {
    expect(makeParcel('g', rectPolygon({ x: 0, z: 0 }, { x: 1, z: 1 }), 'green').regulation).toEqual({ coverage: 0.2, far: 1, maxHeight: 12, setback: 5 });
  });
});

describe('commandError (drag pre-validation)', () => {
  it('matches applyCommand and never mutates the doc', () => {
    const { doc, ids } = crossDoc();
    road(doc, { x: 40, z: 30 }, { x: 80, z: 30 }, ids);
    const before = JSON.stringify(doc);
    const center = Object.values(doc.nodes).find((n) => n.pos.x === 0 && n.pos.z === 0)!;
    expect(commandError(doc, { type: 'node.move', id: center.id, pos: { x: 4, z: 6 } })).toBeNull();
    const end = Object.values(doc.nodes).find((n) => n.pos.x === 96)!;
    // Dragging the east end to (100, 60) makes its road cross the free-standing one at z = 30.
    const err = commandError(doc, { type: 'node.move', id: end.id, pos: { x: 100, z: 60 } });
    expect(err).toBe('the moved road would cross another road');
    expect(JSON.stringify(doc)).toBe(before);
    const copy = cloneJson(doc);
    expect(applyCommand(copy, { type: 'node.move', id: end.id, pos: { x: 100, z: 60 } }).ok).toBe(false);
  });
});

describe('building placement status', () => {
  it('red on a road, orange when breaking the parcel rules, otherwise ok', () => {
    const doc = createEmptyDoc();
    road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, new IdGen('t'));
    const tower = Object.values(doc.buildingTypes).find((t) => t.id === 'office-tower')!;
    const house = doc.buildingTypes.house!;
    expect(placementStatus(doc, house, { pos: { x: 0, z: 0 }, rotation: 0 })).toBe('block');
    expect(placementStatus(doc, house, { pos: { x: 0, z: 9000 }, rotation: 0 })).toBe('block');
    // Anchor inside, corner outside: the server rejects it, so the ghost is red too.
    const edge = { pos: { x: 0, z: doc.meta.halfSize - 1 }, rotation: 0 };
    expect(placementStatus(doc, house, edge)).toBe('block');
    expect(commandError(doc, { type: 'building.place', building: { id: 'e', typeId: 'house', ...edge } })).toBe('building extends beyond the map');
    expect(placementStatus(doc, house, { pos: { x: 0, z: 40 }, rotation: 0 })).toBe('ok');
    expect(applyCommand(doc, { type: 'parcel.upsert', parcel: makeParcel('q', rectPolygon({ x: -40, z: 20 }, { x: 40, z: 80 }), 'green') }).ok).toBe(true);
    // A green zone allows only public uses: an office tower there is a warning, not a block.
    expect(placementStatus(doc, tower, { pos: { x: 0, z: 50 }, rotation: 0 })).toBe('warn');
  });
});

describe('select tool helpers', () => {
  it('wraps angles and caps presence ghosts at 64 points', () => {
    expect(wrapAngle(Math.PI * 2 + 0.5)).toBeCloseTo(0.5);
    expect(Math.abs(wrapAngle(Math.PI + 0.1))).toBeCloseTo(Math.PI - 0.1);
    const square = rectPolygon({ x: 0, z: 0 }, { x: 1, z: 1 });
    expect(ghostPolyline(Array.from({ length: 30 }, () => square))).toHaveLength(64);
    expect(rotateY({ x: 0, z: 1 }, 0)).toEqual({ x: 0, z: 1 });
  });
});

describe('ghost ids', () => {
  it('a valid rectangle ghost is not rejected for its preview id', () => {
    const doc = createEmptyDoc();
    expect(parcelGhostError(doc, makeParcel(GHOST_ID, rectPolygon({ x: 0, z: 0 }, { x: 40, z: 40 }), 'office'))).toBeNull();
  });
});
