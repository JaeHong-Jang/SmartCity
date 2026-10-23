// Hover highlight shapes shared by the select, bulldoze and closure tools.

import { buildingFootprints, roadHalfWidth, type CityDoc } from '@smartcity/shared';
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
      if (b && t) for (const poly of buildingFootprints(b, t)) out.lines.push({ pts: [...poly, poly[0]!], width: 1, color });
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
  }
  return out;
}
