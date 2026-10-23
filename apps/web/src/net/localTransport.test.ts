import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@smartcity/shared';
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
});
