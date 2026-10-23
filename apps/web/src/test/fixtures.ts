import { applyCommand, createEmptyDoc, IdGen, planRoad, resolvePoint, type CityDoc, type Vec2 } from '@smartcity/shared';

/** Apply a straight road from a to b through the real planner (auto-intersections). */
export function road(doc: CityDoc, a: Vec2, b: Vec2, ids: IdGen, roadTypeId = 'road-2'): void {
  const plan = planRoad(doc, { start: resolvePoint(doc, a), end: resolvePoint(doc, b), roadTypeId }, ids);
  if (!plan.command) throw new Error(plan.error);
  const r = applyCommand(doc, plan.command);
  if (!r.ok) throw new Error(r.error);
}

/** Two crossing roads: x axis from -100..100 and z axis from -100..100 → a 4-way junction at 0,0. */
export function crossDoc(): { doc: CityDoc; ids: IdGen } {
  const doc = createEmptyDoc();
  const ids = new IdGen('t');
  road(doc, { x: -96, z: 0 }, { x: 96, z: 0 }, ids);
  road(doc, { x: 0, z: -96 }, { x: 0, z: 96 }, ids);
  return { doc, ids };
}
