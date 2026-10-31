// Road medians (ADR 0014 §4) through the web save paths: export → import, the offline save (v8 → v9) and
// the sim worker (init and a road-type command), so no path drops `median` on the way.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, DOC_VERSION, MEDIAN_ROAD_PRESETS, MODERN_BUILDING_PRESETS, type CityDoc, type Command, type RoadType, type ServerMessage } from '@smartcity/shared';
import { Simulation, type SimSnapshot } from '@smartcity/sim';
import { exportDoc, parseImport } from '../app/importExport';
import type { FromWorker, ToWorker } from '../sim/protocol';
import { LocalTransport, offlineStorageKey, readOfflineSave } from './localTransport';

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const MINE: RoadType = { id: 'mine', name: '내 대로', lanesForward: 2, lanesBackward: 2, laneWidth: 3.25, speedLimit: 16, sidewalk: true, busOnlyRightLane: true, median: { width: 2.5, planted: false } };

/** A median cross: a preset median road and a user median road meeting at the origin. */
function medianCity(): CityDoc {
  const doc = createEmptyDoc('m', 4);
  const cmds: Command[] = [
    { type: 'roadType.upsert', roadType: MINE },
    { type: 'node.add', node: { id: 'c', pos: { x: 0, z: 0 } } },
    { type: 'node.add', node: { id: 'w', pos: { x: -200, z: 0 } } },
    { type: 'node.add', node: { id: 'e', pos: { x: 200, z: 0 } } },
    { type: 'node.add', node: { id: 'n', pos: { x: 0, z: -200 } } },
    { type: 'node.add', node: { id: 's', pos: { x: 0, z: 200 } } },
    { type: 'segment.add', segment: { id: 'W', a: 'w', b: 'c', roadTypeId: 'road-6-median' } },
    { type: 'segment.add', segment: { id: 'E', a: 'c', b: 'e', roadTypeId: 'road-6-median' } },
    { type: 'segment.add', segment: { id: 'N', a: 'n', b: 'c', roadTypeId: 'mine' } },
    { type: 'segment.add', segment: { id: 'S', a: 'c', b: 's', roadTypeId: 'mine' } },
  ];
  expect(applyCommand(doc, { type: 'batch', commands: cmds })).toEqual({ ok: true });
  return doc;
}

/** The doc as the v8 app saved it (no median presets, no modern designs). */
function asV8(doc: CityDoc): Record<string, unknown> {
  const old = cloneJson(doc) as unknown as { version: number; roadTypes: Record<string, unknown>; buildingTypes: Record<string, unknown> };
  for (const t of MEDIAN_ROAD_PRESETS) delete old.roadTypes[t.id];
  for (const t of MODERN_BUILDING_PRESETS) delete old.buildingTypes[t.id];
  old.version = 8;
  return old as unknown as Record<string, unknown>;
}

describe('road medians in web save paths', () => {
  it('export → import replays the median road types and roads into an empty city', () => {
    const doc = medianCity();
    const parsed = parseImport(exportDoc(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    const fresh = createEmptyDoc();
    for (const c of parsed.commands) expect(applyCommand(fresh, c).ok).toBe(true);
    expect(fresh.roadTypes.mine).toEqual(MINE);
    expect(fresh.roadTypes['road-6-median']).toEqual(doc.roadTypes['road-6-median']);
    expect(fresh.segments).toEqual(doc.segments);
  });

  it('a v8 file imports to the same commands as today, minus nothing it had', () => {
    const plain = createEmptyDoc();
    const old = parseImport(JSON.stringify(asV8(plain)));
    const now = parseImport(exportDoc(plain));
    expect(old.ok && now.ok).toBe(true);
    if (old.ok && now.ok) expect(JSON.stringify(old.commands)).toBe(JSON.stringify(now.commands));
  });

  it('an imported file with a bad median skips that road type (and its roads) and keeps the rest', () => {
    const doc = medianCity();
    doc.roadTypes.mine!.lanesBackward = 1;
    const parsed = parseImport(exportDoc(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBeGreaterThan(0);
    const fresh = createEmptyDoc();
    for (const c of parsed.commands) expect(applyCommand(fresh, c).ok).toBe(true);
    expect(fresh.roadTypes.mine).toBeUndefined();
    expect(Object.keys(fresh.segments).sort()).toEqual(['E', 'W']);
  });

  it('the offline save keeps medians; a v8 save opens as v9 with the presets added and its roads unchanged', async () => {
    const storage = new MemStorage();
    storage.setItem(offlineStorageKey('m'), JSON.stringify({ seq: 2, doc: medianCity() }));
    const v8 = asV8(createEmptyDoc());
    storage.setItem(offlineStorageKey('old'), JSON.stringify({ seq: 1, doc: v8 }));
    const open = async (room: string) => {
      const t = new LocalTransport(room, storage, () => '나');
      const msgs: ServerMessage[] = [];
      t.onMessage((m) => msgs.push(m));
      t.connect();
      await flush();
      return { t, msgs };
    };
    const a = await open('m');
    const w = a.msgs[0]!;
    if (w.t !== 'welcome') throw new Error('no welcome');
    expect(w.doc.roadTypes.mine).toEqual(MINE);
    a.t.send({ t: 'cmd', ref: 1, cmd: { type: 'roadType.upsert', roadType: { ...MINE, median: { width: 5, planted: true } } } });
    await flush();
    a.t.close();
    expect(JSON.parse(storage.getItem(offlineStorageKey('m'))!).doc.roadTypes.mine.median).toEqual({ width: 5, planted: true });
    const b = await open('old');
    const wb = b.msgs[0]!;
    if (wb.t !== 'welcome') throw new Error('no welcome');
    expect(wb.doc.version).toBe(DOC_VERSION);
    expect(DOC_VERSION).toBe(9);
    for (const t of MEDIAN_ROAD_PRESETS) expect(wb.doc.roadTypes[t.id]).toEqual(t);
    for (const [id, rt] of Object.entries(v8.roadTypes as Record<string, unknown>)) expect(JSON.stringify(wb.doc.roadTypes[id])).toBe(JSON.stringify(rt));
    b.t.close();
  });

  it.each([{ median: { width: 0, planted: true } }, { median: null }, { lanesBackward: 1 }])('the offline save with a road type %o is unreadable, not opened', (bad) => {
    const storage = new MemStorage();
    const doc = medianCity();
    Object.assign(doc.roadTypes.mine!, bad);
    storage.setItem(offlineStorageKey('m'), JSON.stringify({ seq: 2, doc }));
    const r = readOfflineSave(storage, 'm');
    expect(r.status).toBe('unreadable');
    if (r.status === 'unreadable') expect(r.reason).toContain('doc.roadTypes["mine"] is malformed');
  });
});

describe('road medians through the sim worker', () => {
  let out: FromWorker[] = [];
  let send: (msg: ToWorker) => void = () => undefined;
  const hash = (s: SimSnapshot): string => Array.from(new Uint8Array(s.vehicles.buffer, 0, s.vehicleCount * 24)).join(',') + JSON.stringify(s.stats);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    vi.resetModules();
    out = [];
    const self = { postMessage: (m: FromWorker) => out.push(m), onmessage: null as null | ((ev: { data: ToWorker }) => void) };
    (globalThis as unknown as { self: unknown }).self = self;
    await import('../sim/sim.worker');
    // Messages are structured-cloned on the way in, as postMessage does.
    send = (msg) => self.onmessage!({ data: structuredClone(msg) });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (globalThis as unknown as { self?: unknown }).self;
  });

  it('init and a median road-type command give the same state as the simulation run directly', async () => {
    const doc = medianCity();
    const widen: Command = { type: 'roadType.upsert', roadType: { ...MINE, median: { width: 6, planted: true } } };
    const direct = new Simulation(cloneJson(doc));
    for (let t = 0; t < 400; t++) direct.step();
    expect(direct.applyCommand(widen).ok).toBe(true);
    for (let t = 0; t < 400; t++) direct.step();

    send({ t: 'init', doc });
    send({ t: 'setSpeed', speed: 0 });
    send({ t: 'runTo', tick: 400 });
    for (let k = 0; k < 100000 && !out.some((m) => m.t === 'runTo' && 'done' in m); k++) await vi.advanceTimersByTimeAsync(1);
    send({ t: 'command', cmd: widen });
    out = [];
    send({ t: 'runTo', tick: 800 });
    for (let k = 0; k < 100000 && !out.some((m) => m.t === 'runTo' && 'done' in m); k++) await vi.advanceTimersByTimeAsync(1);
    const snap = out.filter((m): m is Extract<FromWorker, { t: 'snapshot' }> => m.t === 'snapshot').pop()!.snapshot;
    expect(snap.stats.tick).toBe(800);
    expect(snap.vehicleCount).toBeGreaterThan(0);
    expect(hash(snap)).toBe(hash(direct.snapshot()));
  });
});
