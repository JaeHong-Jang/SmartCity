import { describe, expect, it } from 'vitest';
import { applyCommand } from '../apply.js';
import type { Command } from '../commands.js';
import { createEmptyDoc } from '../defaults.js';
import { docProblem } from '../docCheck.js';
import { LIMITS } from '../apply/limits.js';
import { MAX_MESSAGE_BYTES } from '../protocol.js';
import { designStats } from '../stats.js';
import { buildingOverlapsBuildings } from './buildings.js';
import { SAMPLE_CITY_SEED, sampleCityPlan } from './sampleCity.js';

/** UTF-8 size of the JSON text (what the WebSocket frame carries). */
function utf8(v: unknown): number {
  let n = 0;
  for (const ch of JSON.stringify(v)) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

function build(seed = SAMPLE_CITY_SEED) {
  const { batch } = sampleCityPlan(seed);
  const doc = createEmptyDoc();
  const result = applyCommand(doc, batch);
  return { batch, doc, result };
}

describe('sample new town (ADR 0014 §7)', () => {
  const { batch, doc, result } = build();

  it('is one batch within the command and message limits', () => {
    expect(batch.type).toBe('batch');
    expect(batch.commands.length).toBeLessThanOrEqual(LIMITS.batchSize);
    expect(batch.commands.some((c) => c.type === 'batch')).toBe(false);
    // The client frame and the server's broadcast of it both fit one WebSocket message (maxPayload, UTF-8).
    const frame = { t: 'cmd', ref: 1, cmd: batch };
    const applied = { t: 'applied', seq: 1, by: '00000000-0000-0000-0000-000000000000', cmd: batch, ref: 1 };
    expect(utf8(frame)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(utf8(applied)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    // Same headroom as file imports (chunks ≤ 80 % of the limit).
    expect(utf8(batch)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES * 0.8);
  });

  it('requires an empty room, then switches automatic growth off before anything is built', () => {
    expect(batch.commands[0]).toEqual({ type: 'doc.expect', empty: true });
    expect(batch.commands[1]).toEqual({ type: 'meta.update', name: '현대 신도시 샘플', growth: false });
    expect(doc.meta.growth).toBe(false);
  });

  it('is accepted by applyCommand as a whole (policy checks on) and leaves a valid doc', () => {
    expect(result).toEqual({ ok: true });
    expect(docProblem(doc)).toBeNull();
    // Every command also passes on its own, in order.
    const step = createEmptyDoc();
    for (const c of batch.commands) expect(applyCommand(step, c)).toEqual({ ok: true });
  });

  it('has one connected road network with the boulevard hierarchy', () => {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const id of Object.keys(doc.nodes)) parent.set(id, id);
    for (const s of Object.values(doc.segments)) parent.set(find(s.a), find(s.b));
    const roots = new Set(Object.keys(doc.nodes).map(find));
    expect(roots.size).toBe(1);
    const types = new Set(Object.values(doc.segments).map((s) => s.roadTypeId));
    expect([...types].sort()).toEqual(['road-2', 'road-4', 'road-6-median', 'road-8-median']);
  });

  it('has the planned uses: south-facing apartment rows, offices, shops, facilities, parks and two bus lines', () => {
    const count = (typeId: string): number => Object.values(doc.buildings).filter((b) => b.typeId === typeId).length;
    for (const id of ['apt-slab-25', 'apt-tower-35', 'glass-podium', 'mixed-tower', 'office-tower', 'smart-office', 'shop', 'school']) expect(count(id)).toBeGreaterThan(0);
    expect(count('svc-fire-station')).toBe(1);
    expect(count('svc-hospital')).toBe(1);
    // Apartments all face south (+z): rotation 0.
    for (const b of Object.values(doc.buildings)) if (b.typeId.startsWith('apt-')) expect(b.rotation).toBe(0);
    expect(Object.values(doc.parcels).filter((p) => p.zone === 'green').length).toBeGreaterThan(20);
    expect(Object.keys(doc.busLines)).toEqual(['L1', 'L2']);
  });

  it('has no overlapping buildings and no lot violations', () => {
    for (const b of Object.values(doc.buildings)) expect(buildingOverlapsBuildings(doc, b, doc.buildingTypes[b.typeId]!)).toBe(false);
    expect(designStats(doc).violations).toBe(0);
  });

  it('reports its population and jobs', () => {
    const s = designStats(doc);
    expect(s.population).toBeGreaterThan(50_000);
    expect(s.jobs).toBeGreaterThan(20_000);
  });

  it('is deterministic, and other seeds stay valid and within the limits', () => {
    expect(JSON.stringify(sampleCityPlan(SAMPLE_CITY_SEED).batch)).toBe(JSON.stringify(batch));
    for (const seed of [1, 7, 2026]) {
      const other = build(seed);
      expect(JSON.stringify(sampleCityPlan(seed).batch)).toBe(JSON.stringify(other.batch));
      expect(other.result).toEqual({ ok: true });
      expect(other.batch.commands.length).toBeLessThanOrEqual(LIMITS.batchSize);
      expect(utf8(other.batch)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES * 0.8);
    }
  });

  it('is refused as a whole on a city that already has the same roads', () => {
    const again = applyCommand(doc, batch as Command);
    expect(again).toEqual({ ok: false, error: 'the city is not empty' });
  });

  it('is refused as a whole when another user built something first (P7d review #1), leaving that untouched', () => {
    const raced = createEmptyDoc();
    expect(applyCommand(raced, { type: 'building.place', building: { id: 'other-user-shop', typeId: 'shop', pos: { x: 100, z: 0 }, rotation: 0 } })).toEqual({ ok: true });
    const before = JSON.stringify(raced);
    expect(applyCommand(raced, batch)).toEqual({ ok: false, error: 'the city is not empty' });
    expect(JSON.stringify(raced)).toBe(before);
  });
});

describe('doc.expect', () => {
  const content: [string, Command][] = [
    ['node', { type: 'node.add', node: { id: 'n', pos: { x: 0, z: 0 } } }],
    ['building', { type: 'building.place', building: { id: 'b', typeId: 'house', pos: { x: 0, z: 0 }, rotation: 0 } }],
    ['parcel', { type: 'parcel.upsert', parcel: { id: 'p', polygon: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], zone: 'green', regulation: { coverage: 0, far: 0, maxHeight: 0, setback: 0 } } }],
  ];
  const expectEmpty: Command = { type: 'doc.expect', empty: true };

  it('passes on an empty city whatever its designs and settings, and changes nothing', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, { type: 'meta.update', name: '이름', growth: false })).toEqual({ ok: true });
    expect(applyCommand(doc, { type: 'buildingType.remove', id: 'house' })).toEqual({ ok: true });
    const before = JSON.stringify(doc);
    expect(applyCommand(doc, expectEmpty)).toEqual({ ok: true });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it.each(content)('fails once the city has a %s', (_what, cmd) => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, cmd)).toEqual({ ok: true });
    expect(applyCommand(doc, expectEmpty)).toEqual({ ok: false, error: 'the city is not empty' });
  });

  it.each(['nodes', 'segments', 'buildings', 'parcels', 'busStops', 'busLines', 'sensors'] as const)('counts %s as content', (key) => {
    // The check itself, one collection at a time (a stop, line or sensor cannot be made without a road).
    const doc = createEmptyDoc();
    (doc[key] as Record<string, unknown>)['x'] = {};
    expect(applyCommand(doc, expectEmpty)).toEqual({ ok: false, error: 'the city is not empty' });
  });

  it('is a no-op in trusted replay (an accepted batch replays even onto a non-empty doc)', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, content[0]![1])).toEqual({ ok: true });
    expect(applyCommand(doc, expectEmpty, { trusted: true })).toEqual({ ok: true });
  });

  it('is malformed without empty: true, also in trusted replay', () => {
    const bad = { type: 'doc.expect' } as unknown as Command;
    expect(applyCommand(createEmptyDoc(), bad)).toEqual({ ok: false, error: 'invalid doc.expect' });
    expect(applyCommand(createEmptyDoc(), bad, { trusted: true })).toEqual({ ok: false, error: 'invalid doc.expect' });
  });
});
