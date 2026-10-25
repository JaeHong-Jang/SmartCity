import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  cloneJson,
  createEmptyDoc,
  DOC_VERSION,
  docToCommands,
  FACILITY_PRESETS,
  FACILITY_SERVICES,
  normalizeDoc,
  type BuildingType,
  type CityDoc,
  type Command,
} from './index.js';

function ok(doc: CityDoc, cmd: Command): void {
  expect(applyCommand(doc, cmd)).toEqual({ ok: true });
}

const preset = (id: string): BuildingType => cloneJson(FACILITY_PRESETS.find((t) => t.id === id)!);

describe('BuildingType.service (ADR 0010 §8)', () => {
  it('accepts only the four services; apply keeps the field, a design without it stays without', () => {
    const doc = createEmptyDoc();
    for (const service of FACILITY_SERVICES) ok(doc, { type: 'buildingType.upsert', buildingType: { ...preset('svc-hospital'), id: `x-${service}`, service } });
    for (const service of FACILITY_SERVICES) expect(doc.buildingTypes[`x-${service}`]!.service).toBe(service);
    for (const bad of ['school', '', 'Hospital', 1, null]) {
      const r = applyCommand(doc, { type: 'buildingType.upsert', buildingType: { ...preset('svc-hospital'), id: 'bad', service: bad as unknown as BuildingType['service'] } });
      expect(r.ok, String(bad)).toBe(false);
    }
    ok(doc, { type: 'buildingType.upsert', buildingType: { ...preset('svc-hospital'), id: 'plain', service: undefined } });
    expect('service' in doc.buildingTypes['plain']!).toBe(false);
  });

  it('the four default designs are valid, one per service, and survive the docToCommands round trip', () => {
    expect(FACILITY_PRESETS.map((t) => t.service).sort()).toEqual([...FACILITY_SERVICES].sort());
    const doc = createEmptyDoc();
    for (const t of FACILITY_PRESETS) expect(doc.buildingTypes[t.id]).toMatchObject({ service: t.service, rev: 1 });
    ok(doc, { type: 'building.place', building: { id: 'fs1', typeId: 'svc-fire-station', pos: { x: 100, z: 100 }, rotation: 0 } });
    const replay = createEmptyDoc();
    for (const cmd of docToCommands(doc)) ok(replay, cmd);
    for (const t of FACILITY_PRESETS) {
      expect(replay.buildingTypes[t.id]!.service).toBe(t.service);
      expect(replay.buildingTypes[t.id]!.parts).toEqual(doc.buildingTypes[t.id]!.parts);
    }
    expect(replay.buildings['fs1']!.typeId).toBe('svc-fire-station');
  });
});

describe('v5 → v6 migration', () => {
  function v5(): CityDoc {
    const doc = createEmptyDoc();
    for (const t of FACILITY_PRESETS) delete doc.buildingTypes[t.id];
    doc.version = 5;
    return doc;
  }

  it('adds the missing facility designs, keeps an edited one, and is idempotent', () => {
    const doc = v5();
    doc.buildingTypes['svc-hospital'] = { ...preset('svc-hospital'), name: '우리 병원', rev: 4 };
    normalizeDoc(doc);
    expect(doc.version).toBe(DOC_VERSION);
    expect(DOC_VERSION).toBe(6);
    for (const t of FACILITY_PRESETS) expect(doc.buildingTypes[t.id], t.id).toBeDefined();
    expect(doc.buildingTypes['svc-hospital']).toMatchObject({ name: '우리 병원', rev: 4 });
    expect(doc.buildingTypes['svc-power-plant']).toMatchObject({ service: 'powerPlant', rev: 1 });
    const once = JSON.stringify(doc);
    normalizeDoc(doc);
    expect(JSON.stringify(doc)).toBe(once);
  });

  it('an old (v3) doc loads with growth presets and facilities; a v6 doc does not get a deleted design back', () => {
    const v3 = createEmptyDoc();
    for (const id of Object.keys(v3.buildingTypes)) if (id.startsWith('grow-') || id.startsWith('svc-')) delete v3.buildingTypes[id];
    v3.version = 3;
    normalizeDoc(v3);
    expect(v3.version).toBe(DOC_VERSION);
    for (const t of FACILITY_PRESETS) expect(v3.buildingTypes[t.id]).toBeDefined();
    expect(v3.buildingTypes['grow-res-1']).toBeDefined();

    const doc = createEmptyDoc();
    ok(doc, { type: 'buildingType.remove', id: 'svc-substation' });
    normalizeDoc(doc);
    expect(doc.buildingTypes['svc-substation']).toBeUndefined();
  });
});
