import { describe, expect, it } from 'vitest';
import { cellKey, cloneJson, createEmptyDoc, polygonArea, type BuildingType, type CellKey } from '@smartcity/shared';
import { applyPaint, besideParts, CONFLICT_KO, designEstimates, maxRound, newPart, partCells, preflight, roofBudget, stackOn, toRectangle, translateDesignError, withRound } from './designDraft';

const rectCells = (i0: number, j0: number, i1: number, j1: number, into = new Set<CellKey>()): Set<CellKey> => {
  for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) into.add(cellKey(i, j));
  return into;
};

describe('applyPaint', () => {
  it('turns painted cells into an L-shaped footprint with a flat roof and bbox fields', () => {
    const cells = rectCells(0, 0, 10, 4);
    rectCells(0, 4, 4, 10, cells);
    const r = applyPaint(newPart({ roof: 'gable' }), cells, 2);
    expect(r.empty).toBe(false);
    expect(r.corners).toBe(6);
    expect(r.part.roof).toBe('flat');
    expect(r.part.width).toBe(20);
    expect(r.part.depth).toBe(20);
    expect(r.part.offset).toEqual({ x: 10, z: 10 });
    expect(polygonArea(r.part.footprint!)).toBe(cells.size * 4);
    // Reopening gives the same cells back.
    expect([...partCells(r.part, 2)].sort()).toEqual([...cells].sort());
  });

  it('reports disconnected cells, filled holes and empty paint', () => {
    const cells = rectCells(0, 0, 3, 3);
    cells.delete(cellKey(1, 1));
    cells.add(cellKey(8, 8));
    const r = applyPaint(newPart(), cells, 1);
    expect(r.excluded).toBe(1);
    expect(r.filled).toBe(1);
    expect(applyPaint(newPart(), new Set(), 1).empty).toBe(true);
  });

  it('a comb shape has too many corners for the contract', () => {
    const cells = rectCells(0, 0, 40, 1);
    for (let i = 0; i < 40; i += 2) cells.add(cellKey(i, 1));
    expect(applyPaint(newPart(), cells, 1).corners).toBeGreaterThan(32);
  });
});

describe('volumes', () => {
  it('stacks on top of the selected volume without overlapping it', () => {
    const base = newPart({ floors: 4, floorHeight: 3 });
    const top = stackOn(base);
    expect(top.baseHeight).toBe(12);
    const doc = createEmptyDoc();
    const bt: BuildingType = { id: 'x', name: 'x', zone: 'residential', parts: [base, top, besideParts([base, top])] };
    expect(preflight(doc, { type: 'buildingType.upsert', buildingType: bt, expectedRev: 0 }).ok).toBe(true);
  });

  it('toRectangle drops the footprint', () => {
    const r = applyPaint(newPart(), rectCells(0, 0, 3, 3), 2).part;
    expect(toRectangle(r).footprint).toBeUndefined();
  });
});

describe('preflight', () => {
  const doc = createEmptyDoc();
  const school = cloneJson(doc.buildingTypes.school!);

  it('returns the design as stored and never touches the doc', () => {
    const before = JSON.stringify(doc);
    const r = preflight(doc, { type: 'buildingType.upsert', buildingType: { ...school, name: '새 이름' }, expectedRev: school.rev ?? 0 });
    expect(r.ok && r.stored.rev).toBe((school.rev ?? 0) + 1);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('explains rule violations in Korean', () => {
    const overlap = { ...school, parts: [school.parts[0]!, school.parts[0]!] };
    const r1 = preflight(doc, { type: 'buildingType.upsert', buildingType: overlap });
    expect(!r1.ok && r1.error).toMatch(/볼륨끼리 겹칩니다/);
    const budget = { ...school, smart: { solarRoof: 0.7, greenRoof: 0.3, evChargers: 0, sensors: false, dronePort: true } };
    expect(roofBudget(budget.smart)).toBeCloseTo(1.1);
    const r2 = preflight(doc, { type: 'buildingType.upsert', buildingType: budget });
    expect(!r2.ok && r2.error).toMatch(/지붕 면적/);
    const r3 = preflight(doc, { type: 'buildingType.upsert', buildingType: school, expectedRev: (school.rev ?? 0) + 5 });
    expect(!r3.ok && r3.error).toBe(CONFLICT_KO);
  });
});

describe('designEstimates', () => {
  it('splits mixed use into residents and jobs and counts solar on the roof', () => {
    const doc = createEmptyDoc();
    const m = designEstimates(doc.buildingTypes['mixed-use']!);
    expect(m.residents).toBeGreaterThan(0);
    expect(m.jobs).toBeGreaterThan(0);
    expect(m.solar).toBeGreaterThan(0);
    expect(m.energy).toBeGreaterThan(m.solar);
  });
});

describe('corner rounding of a volume (ADR 0012 §4)', () => {
  it('clamps to half the shorter side, flattens the roof, drops the field at 0', () => {
    const p = newPart({ width: 20, depth: 12, roof: 'gable' });
    expect(maxRound(p)).toBe(6);
    expect(withRound(p, 4)).toMatchObject({ round: 4, roof: 'flat' });
    expect(withRound(p, 99).round).toBe(6);
    expect(withRound(withRound(p, 4), 0)).not.toHaveProperty('round');
    expect(withRound(p, -3)).not.toHaveProperty('round');
  });

  it('reopens a rounded volume in the painter as its full rectangle; painting drops the radius', () => {
    const p = withRound(newPart({ width: 8, depth: 8, offset: { x: 4, z: 4 } }), 4);
    expect(partCells(p, 2).size).toBe(16);
    const painted = applyPaint(p, rectCells(0, 0, 4, 3), 2).part;
    expect(painted.footprint).toBeDefined();
    expect(painted).not.toHaveProperty('round');
    expect(maxRound(painted)).toBe(0);
  });

  it('translates the server refusals', () => {
    expect(translateDesignError('part.round out of range [0, 6]')).toMatch(/모서리 둥글기/);
    expect(translateDesignError('rounded volumes need a flat roof')).toMatch(/둥근 볼륨은 평지붕/);
    expect(translateDesignError('rounded corners need a rectangular volume (no drawn footprint)')).toMatch(/둥글게 할 수 없습니다/);
  });
});
