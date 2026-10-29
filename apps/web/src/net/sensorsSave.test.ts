// Roadside sensors (ADR 0013 §4) through the web save paths: export → import, and the offline save (v7 → v8).

import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, DOC_VERSION, type CityDoc, type Sensor, type ServerMessage } from '@smartcity/shared';
import { exportDoc, parseImport } from '../app/importExport';
import { crossDoc } from '../test/fixtures';
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

function withSensors(): CityDoc {
  const { doc } = crossDoc();
  const seg = Object.keys(doc.segments).sort()[0]!;
  const s: Sensor = { id: 'cam', kind: 'cctv', segmentId: seg, t: 0.5, side: 'left', heading: 0.3, fov: 1.2, range: 90 };
  expect(applyCommand(doc, { type: 'sensor.place', sensor: s })).toEqual({ ok: true });
  expect(applyCommand(doc, { type: 'sensor.place', sensor: { ...s, id: 'pole', kind: 'smartpole', side: 'right', fov: 2 * Math.PI, range: 40 } })).toEqual({ ok: true });
  return doc;
}

describe('sensors in web save paths', () => {
  it('export → import replays the sensors into an empty city', () => {
    const doc = withSensors();
    const parsed = parseImport(exportDoc(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    const fresh = createEmptyDoc();
    for (const c of parsed.commands) expect(applyCommand(fresh, c).ok).toBe(true);
    expect(fresh.sensors).toEqual(doc.sensors);
  });

  it('a v7 file (no sensors collection) imports to the same commands as today', () => {
    const v7 = JSON.parse(exportDoc(crossDoc().doc)) as Record<string, unknown>;
    v7.version = 7;
    delete v7.sensors;
    const old = parseImport(JSON.stringify(v7));
    const now = parseImport(exportDoc(crossDoc().doc));
    expect(old.ok && now.ok).toBe(true);
    if (old.ok && now.ok) expect(JSON.stringify(old.commands)).toBe(JSON.stringify(now.commands));
  });

  it('the offline save keeps sensors, and a v7 save opens as v8 with an empty collection', async () => {
    const storage = new MemStorage();
    const doc = withSensors();
    storage.setItem(offlineStorageKey('s'), JSON.stringify({ seq: 2, doc }));
    const v7 = JSON.parse(JSON.stringify(crossDoc().doc)) as Record<string, unknown>;
    v7.version = 7;
    delete v7.sensors;
    storage.setItem(offlineStorageKey('old'), JSON.stringify({ seq: 1, doc: v7 }));
    const open = async (room: string) => {
      const t = new LocalTransport(room, storage, () => '나');
      const msgs: ServerMessage[] = [];
      t.onMessage((m) => msgs.push(m));
      t.connect();
      await flush();
      return { t, msgs };
    };
    const a = await open('s');
    const w = a.msgs[0]!;
    if (w.t !== 'welcome') throw new Error('no welcome');
    expect(w.doc.sensors).toEqual(doc.sensors);
    a.t.send({ t: 'cmd', ref: 1, cmd: { type: 'sensor.update', id: 'cam', range: 150 } });
    a.t.send({ t: 'cmd', ref: 2, cmd: { type: 'sensor.remove', id: 'pole' } });
    await flush();
    a.t.close();
    expect(JSON.parse(storage.getItem(offlineStorageKey('s'))!).doc.sensors).toEqual({ cam: { ...doc.sensors.cam, range: 150 } });
    const b = await open('old');
    const wb = b.msgs[0]!;
    if (wb.t !== 'welcome') throw new Error('no welcome');
    expect(wb.doc.version).toBe(DOC_VERSION);
    expect(DOC_VERSION).toBe(8);
    expect(wb.doc.sensors).toEqual({});
    b.t.close();
  });

  // Sol P6b-1 #2: a stored sensor with a bad kind / side / range is refused like any malformed city.
  const BAD = [{ kind: 'bogus' }, { side: 'wrong' }, { t: 2 }, { fov: 0 }, { range: -1 }];
  it.each(BAD)('the offline save with a sensor %o is unreadable, not opened', (bad) => {
    const storage = new MemStorage();
    const doc = withSensors();
    Object.assign(doc.sensors.cam!, bad);
    storage.setItem(offlineStorageKey('s'), JSON.stringify({ seq: 2, doc }));
    const r = readOfflineSave(storage, 's');
    expect(r.status).toBe('unreadable');
    if (r.status === 'unreadable') expect(r.reason).toContain('doc.sensors["cam"] is malformed');
  });

  it.each(BAD)('an imported file with a sensor %o skips that sensor and keeps the rest', (bad) => {
    const doc = withSensors();
    Object.assign(doc.sensors.cam!, bad);
    const parsed = parseImport(exportDoc(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(1);
    const fresh = createEmptyDoc();
    for (const c of parsed.commands) expect(applyCommand(fresh, c).ok).toBe(true);
    expect(Object.keys(fresh.sensors)).toEqual(['pole']);
  });
});
