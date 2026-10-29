// Hover highlight shapes shared by the select, bulldoze, closure and sensor tools.

import { add, buildingFootprints, dist, rotateY, roadHalfWidth, scale, type Building, type BuildingType, type CityDoc, type Vec2 } from '@smartcity/shared';
import { closedRing } from '../app/ring';
import type { PickIndex, PickResult } from './picking';
import type { ToolPreview } from './types';

export function highlightPreview(doc: CityDoc, idx: PickIndex, hit: PickResult, color: string): ToolPreview {
  const out: ToolPreview = { lines: [], points: [] };
  switch (hit.kind) {
    case 'segment': {
      const c = idx.curveOf(hit.id);
      const s = doc.segments[hit.id];
      const rt = s ? doc.roadTypes[s.roadTypeId] : undefined;
      if (c && rt) out.lines.push({ pts: c, width: roadHalfWidth(rt) * 2, color });
      break;
    }
    case 'building': {
      const b = doc.buildings[hit.id];
      const t = b ? doc.buildingTypes[b.typeId] : undefined;
      if (b && t) for (const poly of buildingFootprints(b, t)) out.lines.push({ pts: closedRing(poly), width: 1, color });
      break;
    }
    case 'node': {
      const n = doc.nodes[hit.id];
      if (n) out.points.push({ pos: n.pos, radius: 5, color });
      break;
    }
    case 'busStop': {
      const p = idx.stopPosition(hit.id);
      if (p) out.points.push({ pos: p, radius: 3, color });
      break;
    }
    case 'parcel': {
      const pc = doc.parcels[hit.id];
      if (pc) out.lines.push({ pts: closedRing(pc.polygon), width: 0.8, color });
      break;
    }
    case 'sensor': {
      const p = idx.sensorPosition(hit.id);
      if (p) out.points.push({ pos: p, radius: 2.2, color });
      break;
    }
  }
  return out;
}

/** Front-direction arrow (center → beyond the front, local +z) and rotation ring around a building. */
export function buildingGizmo(b: Pick<Building, 'pos' | 'rotation'>, type: BuildingType): { arrow: Vec2[]; ring: Vec2[]; radius: number } {
  const corners = buildingFootprints(b, type).flat();
  const radius = Math.max(4, ...corners.map((c) => dist(c, b.pos))) + 2.5;
  const front = rotateY({ x: 0, z: 1 }, b.rotation);
  const arrow = [b.pos, add(b.pos, scale(front, radius + 3))];
  const ring: Vec2[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push({ x: b.pos.x + Math.cos(a) * radius, z: b.pos.z + Math.sin(a) * radius });
  }
  return { arrow, ring, radius };
}
