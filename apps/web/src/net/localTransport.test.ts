import { describe, expect, it } from 'vitest';
import { createEmptyDoc, DOC_VERSION, type ServerMessage } from '@smartcity/shared';
import { parseImport, exportDoc } from '../app/importExport';
import { LocalTransport, legacyStorageKey, offlineStorageKey, readOfflineSave } from './localTransport';

const readOk = (s: MemStorage, room: string) => {
  const r = readOfflineSave(s, room);
  if (r.status !== 'ok') throw new Error(`expected a readable save, got ${r.status}`);
  return r;
};

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

describe('LocalTransport', () => {
  it('sequences commands like the server and persists the doc', async () => {
    const storage = new MemStorage();
    const t = new LocalTransport('solo', storage, () => '나');
    const got: ServerMessage[] = [];
    t.onMessage((m) => got.push(m));
    t.connect();
    t.send({ t: 'cmd', ref: 1, cmd: { type: 'node.add', node: { id: 'n1', pos: { x: 0, z: 0 } } } });
    t.send({ t: 'cmd', ref: 2, cmd: { type: 'node.add', node: { id: 'n1', pos: { x: 0, z: 0 } } } });
    await flush();
    expect(got[0]!.t).toBe('welcome');
    expect(got[1]).toMatchObject({ t: 'applied', seq: 1, ref: 1 });
    expect(got[2]).toMatchObject({ t: 'rejected', ref: 2 });
    t.close();
    const saved = JSON.parse(storage.getItem(offlineStorageKey('solo'))!);
    expect(saved.seq).toBe(1);
    expect(saved.doc.nodes.n1).toBeDefined();

    const again = new LocalTransport('solo', storage, () => '나');
    const msgs: ServerMessage[] = [];
    again.onMessage((m) => msgs.push(m));
    again.connect();
    await flush();
    expect(msgs[0]).toMatchObject({ t: 'welcome', seq: 1 });
  });

  it('loads a saved doc of any supported version and migrates it', async () => {
    const storage = new MemStorage();
    const doc = createEmptyDoc() as unknown as Record<string, unknown>;
    doc.version = 1;
    delete doc.parcels;
    (doc.nodes as Record<string, unknown>).n1 = { id: 'n1', pos: { x: 0, z: 0 } };
    storage.setItem(offlineStorageKey('old'), JSON.stringify({ seq: 3, doc }));
    const t = new LocalTransport('old', storage, () => '나');
    const msgs: ServerMessage[] = [];
    t.onMessage((m) => msgs.push(m));
    t.connect();
    await flush();
    const w = msgs[0];
    expect(w?.t).toBe('welcome');
    if (w?.t !== 'welcome') return;
    expect(w.seq).toBe(3);
    expect(w.doc.version).toBe(DOC_VERSION);
    expect(w.doc.parcels).toEqual({});
    expect(w.doc.nodes.n1).toBeDefined();

    // A save from a newer version is not opened as an empty city (Sol review #3, see below).
  });

  it('keeps its city apart from the server room and copies a legacy save without deleting it', async () => {
    const storage = new MemStorage();
    const doc = createEmptyDoc();
    doc.nodes.n1 = { id: 'n1', pos: { x: 0, z: 0 } };
    const legacy = JSON.stringify({ seq: 4, doc });
    storage.setItem(legacyStorageKey('main'), legacy);
    expect(offlineStorageKey('main')).toBe('smartcity:offline:main');
    expect(readOfflineSave(storage, 'main')).toMatchObject({ status: 'ok', seq: 4, savedAt: null });

    const t = new LocalTransport('main', storage, () => '나');
    expect(storage.getItem(offlineStorageKey('main'))).toBe(legacy);
    const msgs: ServerMessage[] = [];
    t.onMessage((m) => msgs.push(m));
    t.connect();
    t.send({ t: 'cmd', ref: 1, cmd: { type: 'node.add', node: { id: 'n2', pos: { x: 40, z: 0 } } } });
    await flush();
    expect(msgs[0]).toMatchObject({ t: 'welcome', seq: 4 });
    t.close();
    // Edits go to the new key only; the legacy save is untouched.
    expect(storage.getItem(legacyStorageKey('main'))).toBe(legacy);
    const now = readOk(storage, 'main');
    expect(now.seq).toBe(5);
    expect(Object.keys(now.doc.nodes).sort()).toEqual(['n1', 'n2']);
    expect(now.savedAt).toEqual(expect.any(Number));

    // A later legacy write (an old tab) never overrides the migrated city.
    storage.setItem(legacyStorageKey('main'), JSON.stringify({ seq: 1, doc: createEmptyDoc() }));
    expect(readOk(storage, 'main').seq).toBe(5);
  });

  it('exports the offline city as a file the import accepts', () => {
    const storage = new MemStorage();
    const doc = createEmptyDoc();
    doc.nodes.n1 = { id: 'n1', pos: { x: 0, z: 0 } };
    storage.setItem(legacyStorageKey('r'), JSON.stringify({ seq: 1, doc }));
    const city = readOk(storage, 'r');
    const parsed = parseImport(exportDoc(city.doc));
    expect(parsed).toMatchObject({ ok: true, skipped: 0 });
    expect(readOfflineSave(storage, 'none')).toEqual({ status: 'none' });
  });

  it('never opens or overwrites a save it cannot read (Sol review #3)', async () => {
    const kept = createEmptyDoc() as unknown as Record<string, unknown>;
    (kept.nodes as Record<string, unknown>).kept = { id: 'kept', pos: { x: 0, z: 0 } };
    const arrays = createEmptyDoc() as unknown as Record<string, unknown>;
    arrays.nodes = [];
    const saves: Record<string, string> = {
      // Sol: a v7 save with node `kept`, opened by this (v6) app, came back as `["new"]`.
      future: JSON.stringify({ seq: 9, doc: { ...kept, version: DOC_VERSION + 1 } }),
      corrupt: '{"seq":3,"doc":{"version":6,"nod',
      notASave: JSON.stringify({ hello: 1 }),
      malformed: JSON.stringify({ seq: 2, doc: arrays }),
    };
    for (const [what, raw] of Object.entries(saves)) {
      const storage = new MemStorage();
      storage.setItem(offlineStorageKey('r'), raw);
      expect(readOfflineSave(storage, 'r'), what).toMatchObject({ status: 'unreadable', key: offlineStorageKey('r'), raw });
      const t = new LocalTransport('r', storage, () => '나');
      expect(t.unreadable?.reason, what).toBeTruthy();
      const msgs: ServerMessage[] = [];
      t.onMessage((m) => msgs.push(m));
      t.connect();
      t.send({ t: 'cmd', ref: 1, cmd: { type: 'node.add', node: { id: 'new', pos: { x: 40, z: 0 } } } });
      await flush();
      expect(msgs.map((m) => m.t), what).toEqual(['error', 'rejected']);
      t.save();
      t.close();
      expect(storage.getItem(offlineStorageKey('r')), what).toBe(raw);
    }
  });

  it('treats an unreadable legacy save the same way and keeps both keys', async () => {
    const storage = new MemStorage();
    const raw = '{"seq":1,"doc":';
    storage.setItem(legacyStorageKey('r'), raw);
    const t = new LocalTransport('r', storage, () => '나');
    expect(t.unreadable).toMatchObject({ raw });
    t.connect();
    t.close();
    expect(storage.getItem(legacyStorageKey('r'))).toBe(raw);
    expect(storage.getItem(offlineStorageKey('r'))).toBe(raw);
  });
});
