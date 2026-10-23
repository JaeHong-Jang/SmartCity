import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, SMART_CITY_PRESETS, voxelKey, voxelsToParts, VOXEL_LIMITS, type BuildingType } from '@smartcity/shared';
import { checkDesign, fromBuildingType, toBuildingType } from './design';
import { DICE_SIZES, DICE_STYLES, rollDesign } from './dice';
import { pickVoxel, planeCell, type V3 } from './picking';
import { mirrorProps, propBox, snapProp } from './props';
import { StudioEditor } from './StudioEditor';
import { brushCells, connectedRegion, newStudioDoc, rectCells, withSymmetry, type StudioDoc } from './voxelEdit';

const ground = (i: number, j: number) => ({ kind: 'plane' as const, i, j, k: 0, normal: [0, 1, 0] as V3, t: 0, point: [0, 0, 0] as V3 });
const face = (i: number, j: number, k: number, n: V3) => ({ kind: 'cell' as const, i, j, k, normal: n, t: 0, point: [0, 0, 0] as V3 });

function accepted(t: BuildingType): void {
  const doc = createEmptyDoc();
  expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: t, expectedRev: 0 })).toEqual({ ok: true });
}

const meta = { id: 'studio-test', name: '테스트', zone: 'residential' as const };

describe('symmetry, brushes and rectangles', () => {
  it('mirrors cells across x = 0 and z = 0 (cell i ↔ −1 − i), without duplicates', () => {
    expect(withSymmetry([[2, 0, 1]], { x: true, z: false })).toEqual([
      [2, 0, 1],
      [-3, 0, 1],
    ]);
    expect(withSymmetry([[0, 0, 0]], { x: true, z: true })).toHaveLength(4);
    // A cell next to the mirror plane maps onto its neighbour, a symmetric pair stays a pair.
    expect(withSymmetry([[0, 0, 0], [-1, 0, 0]], { x: true, z: false })).toHaveLength(2);
  });

  it('snaps the 4 m brush to the 4 m grid', () => {
    expect(brushCells(3, -1, 2, 2).map((c) => c.join())).toEqual(['2,-2,2', '3,-2,2', '2,-1,2', '3,-1,2']);
    expect(rectCells({ i: 0, j: 0 }, { i: 2, j: 1 }, 0, 1)).toHaveLength(6);
    expect(rectCells({ i: 0, j: 0 }, { i: 2, j: 1 }, 0, 2)).toHaveLength(8);
  });
});

describe('StudioEditor edits and undo', () => {
  it('stacks on faces and the ground; a symmetric click is one undo step', () => {
    const ed = new StudioEditor(newStudioDoc());
    ed.sym = { x: true, z: true };
    expect(ed.click(ground(1, 1))).toBe(true);
    expect(ed.doc.model.cells.size).toBe(4);
    // Top face → the cell above; side face → the neighbour.
    ed.sym = { x: false, z: false };
    ed.click(face(1, 1, 0, [0, 1, 0]));
    expect(ed.has(1, 1, 1)).toBe(true);
    ed.click(face(1, 1, 0, [1, 0, 0]));
    expect(ed.has(2, 1, 0)).toBe(true);
    ed.undo();
    ed.undo();
    expect(ed.doc.model.cells.size).toBe(4);
    ed.undo();
    expect(ed.doc.model.cells.size).toBe(0);
    ed.redo();
    expect(ed.doc.model.cells.size).toBe(4);
    // A new edit drops the redo branch.
    ed.click(ground(5, 5));
    ed.redo();
    expect(ed.doc.model.cells.size).toBe(5);
  });

  it('rectangle fill, erase and paint are each one step and respect bounds', () => {
    const ed = new StudioEditor(newStudioDoc());
    const cells = ed.rectTargets('add', [-2, -2, 0], { i: 1, j: 0 });
    expect(cells).toHaveLength(4 * 3);
    ed.apply('add', cells);
    // Out of bounds cells are dropped.
    expect(ed.rectTargets('add', [VOXEL_LIMITS.halfExtent - 1, 0, 0], { i: VOXEL_LIMITS.halfExtent + 5, j: 0 })).toHaveLength(1);
    ed.apply('erase', ed.rectTargets('erase', [-2, -2, 0], { i: -1, j: 0 }));
    expect(ed.doc.model.cells.size).toBe(6);
    ed.undo();
    expect(ed.doc.model.cells.size).toBe(12);
    // Erase via right click / shift on the stack tool.
    ed.click(face(0, 0, 0, [0, 1, 0]), true);
    expect(ed.has(0, 0, 0)).toBe(false);
  });

  it('refuses edits beyond the cell limit with a hint', () => {
    const doc = newStudioDoc();
    doc.model.styles.push({ color: '#ffffff', roofColor: '#000000', roof: 'flat' });
    let n = 0;
    for (let k = 0; k < VOXEL_LIMITS.floors && n < VOXEL_LIMITS.cells; k++)
      for (let i = -16; i < 16 && n < VOXEL_LIMITS.cells; i++)
        for (let j = -16; j < 16 && n < VOXEL_LIMITS.cells; j++, n++) doc.model.cells.set(voxelKey(i, j, k), 0);
    const ed = new StudioEditor(doc);
    expect(ed.click(face(0, 0, 3, [0, 1, 0]))).toBe(false);
    expect(ed.hint).toMatch(/4,000/);
  });

  it('paints cells or connected chunks; painted halves become separate volumes the server accepts', () => {
    const ed = new StudioEditor(newStudioDoc());
    ed.apply('add', ed.rectTargets('add', [0, 0, 0], { i: 3, j: 1 }));
    ed.apply('add', ed.rectTargets('add', [0, 0, 1], { i: 3, j: 1 }));
    expect(voxelsToParts(ed.doc.model).parts).toHaveLength(1);
    ed.style = { ...ed.style, color: '#a5553f' };
    ed.channel = 'color';
    ed.tool = 'paint';
    ed.apply('paint', ed.rectTargets('paint', [0, 0, 0], { i: 1, j: 1 }));
    ed.apply('paint', ed.rectTargets('paint', [0, 0, 1], { i: 1, j: 1 }));
    const conv = voxelsToParts(ed.doc.model);
    expect(conv.parts).toHaveLength(2);
    expect(conv.parts.map((p) => p.color).sort()).toEqual(['#a5553f', '#e8dcc8']);
    accepted(toBuildingType(ed.doc, meta, conv));
    // Chunk mode repaints the whole same-style connected region from one click.
    ed.paintChunk = true;
    ed.style = { ...ed.style, color: '#5f7f99' };
    ed.click(face(3, 0, 1, [0, 1, 0]));
    expect(connectedRegion(ed.doc.model, [3, 0, 0])).toHaveLength(8);
    expect(voxelsToParts(ed.doc.model).parts.map((p) => p.color).sort()).toEqual(['#5f7f99', '#a5553f']);
    // Use paint keeps colors.
    ed.channel = 'use';
    ed.style = { ...ed.style, use: 'commercial' };
    ed.click(face(3, 0, 1, [0, 1, 0]));
    const blue = voxelsToParts(ed.doc.model).parts.find((p) => p.color === '#5f7f99')!;
    expect(blue.use).toBe('commercial');
  });

  it('eyedropper copies a cell style and switches to painting', () => {
    const ed = new StudioEditor(newStudioDoc());
    ed.style = { color: '#123456', roofColor: '#654321', roof: 'flat', use: 'office' };
    ed.click(ground(0, 0));
    ed.style = { color: '#ffffff', roofColor: '#000000', roof: 'flat' };
    ed.tool = 'eyedropper';
    ed.eyedrop(face(0, 0, 0, [0, 1, 0]));
    expect(ed.style).toMatchObject({ color: '#123456', use: 'office' });
    expect(ed.tool).toBe('paint');
  });

  it('raises and lowers the selected volume with a handle drag as one undo step', () => {
    const ed = new StudioEditor(newStudioDoc());
    ed.apply('add', ed.rectTargets('add', [0, 0, 0], { i: 2, j: 1 }));
    ed.select(face(1, 1, 0, [0, 1, 0]));
    expect(ed.beginRaise()).toBe(true);
    ed.previewRaise(1);
    ed.previewRaise(3);
    ed.endRaise();
    expect(ed.floorsUsed()).toBe(4);
    expect(ed.selection()!.top).toBe(3);
    ed.undo();
    expect(ed.floorsUsed()).toBe(1);
    ed.redo();
    // Lowering keeps the bottom floor; cancel restores.
    ed.beginRaise();
    ed.previewRaise(-10);
    expect(ed.floorsUsed()).toBe(1);
    ed.endRaise(true);
    expect(ed.floorsUsed()).toBe(4);
  });

  it('allows pitched roofs only on uncovered rectangular volumes', () => {
    const ed = new StudioEditor(newStudioDoc());
    ed.apply('add', ed.rectTargets('add', [0, 0, 0], { i: 2, j: 2 }));
    ed.select(face(0, 0, 0, [0, 1, 0]));
    expect(ed.roofOptions().ok).toBe(true);
    expect(ed.setRoof('gable')).toBe(true);
    expect(voxelsToParts(ed.doc.model).parts[0]!.roof).toBe('gable');
    // An L shape (same style) cannot take a pitched roof; a block on top flattens it.
    ed.undo();
    ed.click(face(2, 2, 0, [1, 0, 0]));
    ed.select(face(0, 0, 0, [0, 1, 0]));
    expect(ed.roofOptions()).toMatchObject({ ok: false, reason: expect.stringMatching(/사각형/) });
    ed.undo();
    ed.click(face(0, 0, 0, [0, 1, 0]));
    ed.select(face(1, 1, 0, [0, 1, 0]));
    expect(ed.roofOptions()).toMatchObject({ ok: false, reason: expect.stringMatching(/위에 블록/) });
  });

  it('places props with symmetry and removes the mirrored group together', () => {
    const ed = new StudioEditor(newStudioDoc());
    ed.apply('add', ed.rectTargets('add', [-2, -1, 0], { i: 1, j: 0 }));
    ed.sym = { x: true, z: false };
    ed.propKind = 'ac';
    expect(ed.placeProp(face(1, 0, 0, [1, 0, 0]))).toBe(true);
    expect(ed.doc.props).toHaveLength(2);
    expect(ed.doc.props.map((p) => [p.pos.x, p.rot])).toEqual([
      [4, 1],
      [-4, 3],
    ]);
    ed.removeProps(ed.propGroup(0));
    expect(ed.doc.props).toHaveLength(0);
    ed.undo();
    expect(ed.doc.props).toHaveLength(2);
  });
});

describe('prop snapping', () => {
  const m = newStudioDoc().model;
  m.styles.push({ color: '#ffffff', roofColor: '#000000', roof: 'flat' });
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) m.cells.set(voxelKey(i, j, k), 0);

  it('puts wall props on the face, facing out, at the floor height', () => {
    const r = snapProp(m, face(2, 0, 1, [1, 0, 0]), 'balcony', 0, 1, '#ffffff');
    expect(r).toMatchObject({ ok: true, prop: { pos: { x: 6, y: 3.2, z: 1 }, rot: 1 } });
    const front = snapProp(m, face(1, 1, 0, [0, 0, 1]), 'awning', 0, 2, '#ffffff');
    expect(front.ok && front.prop.rot).toBe(0);
    expect(front.ok && front.prop.pos.z).toBe(4);
    expect(snapProp(m, face(1, 1, 1, [0, 1, 0]), 'balcony', 0, 1, '#ffffff').ok).toBe(false);
  });

  it('puts top props on roofs and on nearby ground only', () => {
    expect(snapProp(m, face(1, 0, 1, [0, 1, 0]), 'antenna', 5, 1, '#ffffff')).toMatchObject({ ok: true, prop: { pos: { x: 3, y: 6.4, z: 1 }, rot: 1 } });
    expect(snapProp(m, ground(3, 0), 'tree', 0, 1, '#ffffff').ok).toBe(true);
    const far = snapProp(m, ground(8, 0), 'tree', 0, 1, '#ffffff');
    expect(far).toMatchObject({ ok: false, reason: expect.stringMatching(/2m/) });
    expect(snapProp(m, face(0, 0, 0, [-1, 0, 0]), 'tree', 0, 1, '#ffffff').ok).toBe(false);
  });

  it('mirrors props and gives rotated pick boxes', () => {
    const p = { kind: 'sign' as const, pos: { x: 3, y: 1, z: 4 }, rot: 0, size: 1, color: '#ffffff' };
    expect(mirrorProps(p, { x: true, z: true }).map((q) => [q.pos.x, q.pos.z, q.rot])).toEqual([
      [3, 4, 0],
      [-3, 4, 0],
      [3, -4, 2],
      [-3, -4, 2],
    ]);
    const b = propBox({ ...p, rot: 1 });
    // Facing +x: depth goes along +x, width along z.
    expect(b.min[0]).toBeCloseTo(3);
    expect(b.max[0]).toBeCloseTo(3.2);
    expect(b.max[2] - b.min[2]).toBeCloseTo(2.4);
  });
});

describe('grid picking (DDA)', () => {
  const opt = (cells: string[], level = 0) => ({ cell: 2, floorHeight: 3, has: (i: number, j: number, k: number) => cells.includes(voxelKey(i, j, k)), level });

  it('hits the ground plane in an empty grid', () => {
    const h = pickVoxel([1, 50, 1], [0, -1, 0], opt([]));
    expect(h).toMatchObject({ kind: 'plane', i: 0, j: 0, k: 0 });
    expect(h!.point[1]).toBeCloseTo(0);
  });

  it('hits the top face and side faces of cells with the right normals', () => {
    const cells = [voxelKey(0, 0, 0), voxelKey(0, 0, 1)];
    expect(pickVoxel([1, 50, 1], [0, -1, 0], opt(cells))).toMatchObject({ kind: 'cell', i: 0, j: 0, k: 1, normal: [0, 1, 0] });
    expect(pickVoxel([20, 1.5, 1], [-1, 0, 0], opt(cells))).toMatchObject({ kind: 'cell', i: 0, j: 0, k: 0, normal: [1, 0, 0] });
    const d: V3 = [-1, -0.2, -1];
    const l = Math.hypot(...d);
    const h = pickVoxel([30, 9, 30], [d[0] / l, d[1] / l, d[2] / l], opt(cells));
    expect(h?.kind).toBe('cell');
  });

  it('uses the working floor as the plane and ignores cells above it', () => {
    const cells = [voxelKey(0, 0, 0)];
    expect(pickVoxel([5, 50, 5], [0, -1, 0], opt(cells, 2))).toMatchObject({ kind: 'plane', i: 2, j: 2, k: 2 });
    expect(pickVoxel([1, 50, 1], [0, -1, 0], opt(cells, 2))).toMatchObject({ kind: 'plane', k: 2 });
    expect(pickVoxel([1, 50, 1], [0, 1, 0], opt(cells))).toBeNull();
  });

  it('projects onto a fixed plane for drags', () => {
    expect(planeCell([5, 10, 5], [0, -1, 0], 3, 2)).toMatchObject({ i: 2, j: 2 });
    expect(planeCell([5, 10, 5], [0, 1, 0], 3, 2)).toBeNull();
  });
});

describe('dice', () => {
  it('is deterministic per seed, style and size and differs across seeds', () => {
    const a = rollDesign(42, 'house', 'M');
    const b = rollDesign(42, 'house', 'M');
    expect(JSON.stringify([...a.doc.model.cells], null, 0)).toBe(JSON.stringify([...b.doc.model.cells]));
    expect(a.doc.props).toEqual(b.doc.props);
    const sigs = new Set([1, 2, 3, 4, 5, 6].map((s) => JSON.stringify([[...rollDesign(s, 'glassOffice', 'L').doc.model.cells.keys()].sort()])));
    expect(sigs.size).toBeGreaterThan(1);
  });

  it('every style and size passes the server checks after voxelsToParts', () => {
    for (const st of DICE_STYLES) {
      for (const sz of DICE_SIZES) {
        for (let seed = 1; seed <= 6; seed++) {
          const r = rollDesign(seed, st.id, sz.id);
          const conv = voxelsToParts(r.doc.model);
          expect(conv.parts.length).toBeGreaterThan(0);
          expect(conv.parts.length).toBeLessThanOrEqual(48);
          expect(r.doc.props.length).toBeGreaterThan(0);
          const t = toBuildingType(r.doc, { id: 'dice', name: r.name, zone: r.zone }, conv);
          const doc = createEmptyDoc();
          const res = applyCommand(doc, { type: 'buildingType.upsert', buildingType: t, expectedRev: 0 });
          expect(res, `${st.id}/${sz.id}/${seed}`).toEqual({ ok: true });
        }
      }
    }
  });

  it('gives hanok gable roofs and a glass office a taller tower than a house', () => {
    const h = voxelsToParts(rollDesign(3, 'hanok', 'L').doc.model);
    expect(h.parts.filter((p) => p.roof === 'gable').length).toBeGreaterThanOrEqual(2);
    const top = (s: StudioDoc) => Math.max(...voxelsToParts(s.model).parts.map((p) => p.baseHeight + p.floors * p.floorHeight));
    expect(top(rollDesign(3, 'glassOffice', 'L').doc)).toBeGreaterThan(top(rollDesign(3, 'house', 'L').doc));
  });

  it('replacing the draft with a roll is one undo step', () => {
    const ed = new StudioEditor(newStudioDoc());
    ed.click(ground(0, 0));
    ed.replace(rollDesign(7, 'shop', 'M').doc);
    expect(ed.doc.props.length).toBeGreaterThan(0);
    ed.undo();
    expect(ed.doc.model.cells.size).toBe(1);
    expect(ed.doc.props).toHaveLength(0);
    ed.redo();
    expect(voxelsToParts(ed.doc.model)).toEqual(voxelsToParts(rollDesign(7, 'shop', 'M').doc.model));
  });
});

describe('mirrored props', () => {
  it('refuses a mirrored copy that would float away from the building (Sol 2b #5)', () => {
    const ed = new StudioEditor(newStudioDoc());
    ed.apply('add', ed.rectTargets('add', [10, 0, 0], { i: 10, j: 0 }));
    ed.sym = { x: true, z: false };
    ed.propKind = 'ac';
    expect(ed.placeProp(face(10, 0, 0, [1, 0, 0]))).toBe(false);
    expect(ed.doc.props).toHaveLength(0);
    expect(ed.hint).toMatch(/대칭/);
  });
});

describe('opening and checking designs', () => {
  it('flags off-grid presets as lossy and round-trips studio designs', () => {
    const office = SMART_CITY_PRESETS.find((p) => p.id === 'smart-office')!;
    expect(fromBuildingType(office).lossy).toBe(true);
    const roll = rollDesign(11, 'ecoTower', 'M');
    const t = toBuildingType(roll.doc, meta);
    const back = fromBuildingType(t);
    expect(back.lossy).toBe(false);
    expect(new Set(back.doc.model.cells.keys())).toEqual(new Set(roll.doc.model.cells.keys()));
    expect(back.doc.props).toEqual(roll.doc.props);
  });

  it('reports conflicts and traces failing props', () => {
    const roll = rollDesign(5, 'house', 'S');
    const conv = voxelsToParts(roll.doc.model);
    const t = toBuildingType(roll.doc, meta, conv);
    const city = createEmptyDoc();
    expect(checkDesign(city, t, 0, conv.sources)).toEqual({ ok: true });
    applyCommand(city, { type: 'buildingType.upsert', buildingType: cloneJson(t), expectedRev: 0 });
    const conflict = checkDesign(city, t, 0, conv.sources);
    expect(conflict.ok).toBe(false);
    expect(!conflict.ok && conflict.error).toMatch(/다른 사용자/);
    const far = { ...t, id: 'far', props: [...(t.props ?? []), { kind: 'tree' as const, pos: { x: 60, y: 0, z: 0 }, rot: 0, size: 1, color: '#22aa44' }] };
    const bad = checkDesign(city, far, 0, conv.sources);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toMatch(/2m/);
      expect(bad.props).toEqual([far.props.length - 1]);
    }
    expect(checkDesign(city, { ...t, id: 'empty', parts: [] }, 0, []).ok).toBe(false);
  });

  it('converts 4000 cells to volumes fast enough for live editing', () => {
    const ed = new StudioEditor(newStudioDoc());
    // A ragged tower: 4000 cells over 25 floors with varied outlines.
    for (let k = 0; k < 25; k++) ed.apply('add', ed.rectTargets('add', [-10 + (k % 3), -4 - (k % 4), k], { i: 9 + (k % 3), j: 3 - (k % 4) }));
    expect(ed.doc.model.cells.size).toBe(4000);
    const t0 = performance.now();
    const conv = voxelsToParts(ed.doc.model);
    const ms = performance.now() - t0;
    expect(conv.parts.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(250);
  });
});
