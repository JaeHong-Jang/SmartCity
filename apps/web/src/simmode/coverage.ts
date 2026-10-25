// Substation coverage circles for the armed 정전 tool, from `Simulation.powerCoverage()` (read-only).

import type { CityDoc } from '@smartcity/shared';

export interface PowerCoverageLike {
  substations: string[];
  junctions: Record<string, string>;
  buildings: Record<string, string>;
}

export interface CoverageRing {
  substationId: string;
  x: number;
  z: number;
  /** Distance to the farthest junction / building it supplies (at least 30 m). */
  radius: number;
}

export function coverageRings(doc: CityDoc, c: PowerCoverageLike): CoverageRing[] {
  const rings: CoverageRing[] = [];
  for (const id of c.substations) {
    const sub = doc.buildings[id];
    if (!sub) continue;
    let radius = 30;
    const reach = (map: Record<string, string>, pos: (key: string) => { x: number; z: number } | undefined): void => {
      for (const [key, by] of Object.entries(map)) {
        if (by !== id) continue;
        const p = pos(key);
        if (p) radius = Math.max(radius, Math.hypot(p.x - sub.pos.x, p.z - sub.pos.z));
      }
    };
    reach(c.junctions, (k) => doc.nodes[k]?.pos);
    reach(c.buildings, (k) => doc.buildings[k]?.pos);
    rings.push({ substationId: id, x: sub.pos.x, z: sub.pos.z, radius });
  }
  return rings;
}
