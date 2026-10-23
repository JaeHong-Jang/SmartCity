import { describe, expect, it } from 'vitest';
import { cloneJson, createEmptyDoc, DEFAULT_REGULATIONS, type BuildingType, type Command, type Parcel } from '@smartcity/shared';
import { IdGen } from '@smartcity/shared';
import { road } from '../test/fixtures';
import { applicableBatch, dryRunProposal, proposalCatalog, proposalCenter, proposalItems } from './proposal';

const design = (id: string): BuildingType => ({ ...cloneJson(createEmptyDoc().buildingTypes['house']!), id, name: `카페 ${id}`, rev: 0 });
const place = (id: string, typeId: string, x: number, z = 60): Command => ({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation: 0 } });
const lot = (id: string, x: number): Parcel => ({
  id,
  polygon: [{ x, z: 100 }, { x: x + 16, z: 100 }, { x: x + 16, z: 116 }, { x, z: 116 }],
  zone: 'commercial',
  regulation: { ...DEFAULT_REGULATIONS.commercial },
  auto: true,
});

function proposal(): Command[] {
  return [
    { type: 'batch', commands: [place('b1', 'ai-cafe', 0), place('b2', 'ai-cafe', 30)] },
    { type: 'parcel.upsert', parcel: lot('p1', 200) },
    { type: 'buildingType.upsert', buildingType: design('ai-cafe'), expectedRev: 0 },
  ];
}

describe('proposal items', () => {
  it('flattens batches and puts designs first, parcels next', () => {
    const items = proposalItems(proposal());
    expect(items.map((i) => i.cmd.type)).toEqual(['buildingType.upsert', 'parcel.upsert', 'building.place', 'building.place']);
    expect(items.map((i) => i.index)).toEqual([0, 1, 2, 3]);
  });

  it('bakes a temporary catalog from the proposed designs without touching the doc', () => {
    const doc = createEmptyDoc();
    const cat = proposalCatalog(proposalItems(proposal()));
    expect(Object.keys(cat)).toEqual(['ai-cafe']);
    expect(doc.buildingTypes['ai-cafe']).toBeUndefined();
  });

  it('centers on the proposed buildings and parcels', () => {
    const c = proposalCenter(proposalItems([place('b1', 'x', 0), place('b2', 'x', 40)]))!;
    expect(c).toEqual({ x: 20, z: 60 });
    expect(proposalCenter([])).toBeNull();
  });
});

describe('dry run partitioning', () => {
  it('accepts everything on an untouched doc', () => {
    const doc = createEmptyDoc();
    const items = proposalItems(proposal());
    expect(dryRunProposal(doc, items)).toEqual({});
    expect(doc.buildingTypes['ai-cafe']).toBeUndefined();
    expect(applicableBatch(items, {})!.type).toBe('batch');
  });

  it('marks only the items a conflicting edit breaks, and later items still apply', () => {
    const doc = createEmptyDoc();
    // A collaborator laid a road over the spot of b1 meanwhile (b2 at x = 30 is clear of it).
    road(doc, { x: -20, z: 60 }, { x: 10, z: 60 }, new IdGen('c'));
    const items = proposalItems(proposal());
    const invalid = dryRunProposal(doc, items);
    const failing = Object.keys(invalid).map(Number);
    expect(failing).toHaveLength(1);
    const it = items[failing[0]!]!;
    expect(it.cmd.type === 'building.place' && it.cmd.building.id).toBe('b1');
    const batch = applicableBatch(items, invalid)!;
    expect(batch.type === 'batch' && batch.commands).toHaveLength(items.length - 1);
  });

  it('fails the buildings that need a design that cannot be added', () => {
    const doc = createEmptyDoc();
    doc.buildingTypes['ai-cafe'] = design('ai-cafe'); // the id is taken (expectedRev 0 now stale)
    doc.buildingTypes['ai-cafe']!.rev = 3;
    const invalid = dryRunProposal(doc, proposalItems(proposal()));
    expect(Object.keys(invalid).length).toBeGreaterThanOrEqual(1);
    expect(applicableBatch(proposalItems([]), {})).toBeNull();
  });
});
