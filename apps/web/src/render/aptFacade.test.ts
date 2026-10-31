// Korean high-rise residential look (ADR 0014 §5): chosen per volume by shape and use, not by preset id.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEmptyDoc, MODERN_BUILDING_PRESETS, voxelsToParts, type BuildingPart, type BuildingType } from '@smartcity/shared';
import { fromBuildingType, studioBakeInput, toBuildingType } from '../studio/design';
import { APT_STYLE, bakeBuildingGeometry, FACADE_STYLE_ID, isResidentialHighRise } from './buildingGeometry';
import { buildingPreview, buildingPreviewKey } from './buildings';

const part = (p: Partial<BuildingPart>): BuildingPart => ({
  offset: { x: 0, z: 0 },
  width: 52,
  depth: 14,
  floors: 25,
  floorHeight: 2.9,
  baseHeight: 0,
  roof: 'flat',
  color: '#f3f1ec',
  roofColor: '#8a8f96',
  ...p,
});

/** Facade style id and aTop of every wall vertex, keyed by the wall length (aWall.z). */
function wallStyles(g: ReturnType<typeof bakeBuildingGeometry>): Map<number, Set<string>> {
  const wall = g.getAttribute('aWall');
  const fac = g.getAttribute('aFacade');
  const top = g.getAttribute('aTop');
  const out = new Map<number, Set<string>>();
  for (let i = 0; i < wall.count; i++) {
    const L = Math.round(wall.getZ(i) * 100) / 100;
    if (L <= 0) continue;
    let set = out.get(L);
    if (!set) out.set(L, (set = new Set()));
    set.add(`${fac.getY(i)}:${Math.round(top.getX(i) * 100) / 100}`);
  }
  return out;
}

describe('residential high-rise rule', () => {
  it('applies to residential volumes of 10+ floors with a punched or ribbon facade only', () => {
    expect(isResidentialHighRise(part({}), 'residential')).toBe(true);
    expect(isResidentialHighRise(part({ facade: { style: 'ribbon', windowRatio: 0.4, ground: 'none' } }), 'residential')).toBe(true);
    expect(isResidentialHighRise(part({ floors: 9 }), 'residential')).toBe(false);
    expect(isResidentialHighRise(part({ facade: { style: 'curtain', windowRatio: 0.8, ground: 'none' } }), 'residential')).toBe(false);
    expect(isResidentialHighRise(part({}), 'office')).toBe(false);
    expect(isResidentialHighRise(part({}))).toBe(false);
    // The volume's own use wins over the design's zone (mixed-use towers).
    expect(isResidentialHighRise(part({ use: 'residential' }), 'commercial')).toBe(true);
    expect(isResidentialHighRise(part({ use: 'commercial' }), 'residential')).toBe(false);
    const doc = createEmptyDoc();
    expect(isResidentialHighRise(doc.buildingTypes.apartment!.parts[0]!, 'residential')).toBe(true);
    const mixed = doc.buildingTypes['mixed-use']!;
    expect(mixed.parts.map((p) => isResidentialHighRise(p, mixed.zone))).toEqual([false, true]);
    expect(isResidentialHighRise(doc.buildingTypes.house!.parts[0]!, 'residential')).toBe(false);
  });

  it('bakes balcony faces on the long walls and gable ends on the short ones, with the wall height in aTop', () => {
    const g = bakeBuildingGeometry({ zone: 'residential', parts: [part({})] });
    const styles = wallStyles(g);
    expect(styles.get(52)).toEqual(new Set([`${APT_STYLE.face}:72.5`]));
    expect(styles.get(14)).toEqual(new Set([`${APT_STYLE.gable}:72.5`]));
    // Roof cap: the volume's own style again and no aTop.
    const wall = g.getAttribute('aWall');
    const fac = g.getAttribute('aFacade');
    const top = g.getAttribute('aTop');
    for (let i = 0; i < wall.count; i++) {
      if (wall.getZ(i) > 0) continue;
      expect(fac.getY(i)).toBe(FACADE_STYLE_ID.grid);
      expect(top.getX(i)).toBe(0);
    }
  });

  it('leaves every other design as it was baked before (style ids 0–3, aTop 0)', () => {
    const doc = createEmptyDoc();
    for (const t of Object.values(doc.buildingTypes)) {
      const g = bakeBuildingGeometry(t);
      const apt = t.parts.some((p) => isResidentialHighRise(p, t.zone));
      const fac = g.getAttribute('aFacade');
      const top = g.getAttribute('aTop');
      expect(top.count).toBe(g.getAttribute('position').count);
      if (apt) continue;
      for (let i = 0; i < fac.count; i++) {
        expect(fac.getY(i), t.id).toBeLessThan(4);
        expect(top.getX(i), t.id).toBe(0);
      }
    }
    // Without a zone (callers that pass parts only) nothing is an apartment.
    const bare = bakeBuildingGeometry({ parts: [part({})] });
    for (const s of wallStyles(bare).values()) for (const k of s) expect(k).toBe(`${FACADE_STYLE_ID.grid}:0`);
  });

  it('the cross-plan tower has balcony faces all round; glass towers keep the curtain wall', () => {
    const tower = MODERN_BUILDING_PRESETS.find((t) => t.id === 'apt-tower-35')!;
    for (const set of wallStyles(bakeBuildingGeometry(tower)).values()) for (const k of set) expect(k).toBe(`${APT_STYLE.face}:101.5`);
    const mixed = MODERN_BUILDING_PRESETS.find((t) => t.id === 'mixed-tower')!;
    expect(mixed.parts.map((p) => isResidentialHighRise(p, mixed.zone))).toEqual([false, false]);
  });
});

/** Sorted distinct facade style ids of a baked geometry. */
const styleIds = (g: THREE.BufferGeometry): number[] => {
  const fac = g.getAttribute('aFacade');
  const out = new Set<number>();
  for (let i = 0; i < fac.count; i++) out.add(fac.getY(i));
  return [...out].sort((a, b) => a - b);
};

describe('editors show the same facade as the city (Sol P7c-1 #1, #2)', () => {
  const slab = MODERN_BUILDING_PRESETS.find((t) => t.id === 'apt-slab-25')!;

  it('the studio bakes the opened design with its zone: the same look as after saving, and a zone change switches it', () => {
    const open = fromBuildingType(slab);
    expect(open.tooLarge).toBe(false);
    const parts = voxelsToParts(open.doc.model).parts;
    // Parts come back without their own use: only the design's zone makes them residential.
    expect(parts.every((p) => p.use === undefined)).toBe(true);
    const meta = { id: slab.id, name: slab.name, zone: slab.zone };
    const saved = styleIds(bakeBuildingGeometry(toBuildingType(open.doc, meta)));
    const studio = styleIds(bakeBuildingGeometry(studioBakeInput(parts, open.doc.props, open.doc, slab.zone)));
    expect(studio).toEqual(saved);
    expect(studio).toEqual(expect.arrayContaining([APT_STYLE.face, APT_STYLE.gable]));
    // 용도 → 업무: both lose the apartment look together.
    const office = styleIds(bakeBuildingGeometry(studioBakeInput(parts, open.doc.props, open.doc, 'office')));
    expect(office).toEqual(styleIds(bakeBuildingGeometry(toBuildingType(open.doc, { ...meta, zone: 'office' }))));
    expect(office.some((s) => s >= APT_STYLE.face)).toBe(false);
  });

  it('a zone-only change rebuilds the precise editor preview, which then drops the apartment look', () => {
    const residential: BuildingType = { ...slab, rev: 1 };
    const office: BuildingType = { ...residential, zone: 'office' };
    expect(buildingPreviewKey(office, 40)).not.toBe(buildingPreviewKey(residential, 40));
    const look = (t: BuildingType): number[] => styleIds((buildingPreview(t, 40).children[0] as THREE.Mesh).geometry);
    expect(look(residential)).toEqual(expect.arrayContaining([APT_STYLE.face, APT_STYLE.gable]));
    expect(look(office).some((s) => s >= APT_STYLE.face)).toBe(false);
  });
});
