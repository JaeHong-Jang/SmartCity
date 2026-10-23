// Local guide grid in a road's frame, drawn while a building is aligned to that road.

import { add, scale, type Vec2 } from '@smartcity/shared';

export interface RoadFrame {
  /** Point on the building front line (road edge + setback) at the snapped arc length. */
  anchor: Vec2;
  /** Unit tangent along the road. */
  u: Vec2;
  /** Unit normal pointing away from the road. */
  v: Vec2;
}

/** Lines of a `cells` × `cells` grid with `step` spacing: centered along the road, extending away from it. */
export function guideGridLines(f: RoadFrame, step: number, cells = 10): Vec2[][] {
  if (step <= 0) return [];
  const half = Math.floor(cells / 2);
  const at = (i: number, j: number): Vec2 => add(f.anchor, add(scale(f.u, i * step), scale(f.v, j * step)));
  const out: Vec2[][] = [];
  for (let i = -half; i <= cells - half; i++) out.push([at(i, 0), at(i, cells)]);
  for (let j = 0; j <= cells; j++) out.push([at(-half, j), at(cells - half, j)]);
  return out;
}
