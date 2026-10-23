import { describe, expect, it } from 'vitest';
import { createEmptyDoc, DOC_VERSION, type ServerMessage } from '@smartcity/shared';
import { LocalTransport, localStorageKey } from './localTransport';

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
    const saved = JSON.parse(storage.getItem(localStorageKey('solo'))!);
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
    storage.setItem(localStorageKey('old'), JSON.stringify({ seq: 3, doc }));
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

    storage.setItem(localStorageKey('future'), JSON.stringify({ seq: 9, doc: { ...doc, version: DOC_VERSION + 1 } }));
    const f = new LocalTransport('future', storage, () => '나');
    const fm: ServerMessage[] = [];
    f.onMessage((m) => fm.push(m));
    f.connect();
    await flush();
    expect(fm[0]).toMatchObject({ t: 'welcome', seq: 0 });
  });
});
