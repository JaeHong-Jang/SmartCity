import { describe, expect, it, vi } from 'vitest';
import { applyCommand, createEmptyDoc, designStats, sampleCityPlan, type ClientMessage, type Command } from '@smartcity/shared';
import { compileNetwork } from '@smartcity/sim';
import { createBenchCity } from '../dev/benchCity';
import type { Transport } from '../net/transport';
import { createDispatcher } from './dispatch';
import { resumeSampleCity, startSampleCity } from './sampleCity';
import { ClientStore } from './store';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function setup(room: string, doc = createEmptyDoc()) {
  const store = new ClientStore(room, '나');
  const sent: ClientMessage[] = [];
  const transport = { send: (m: ClientMessage) => sent.push(m) } as unknown as Transport;
  const dispatcher = createDispatcher(store, () => transport);
  store.receive({ t: 'welcome', clientId: 'me', tag: 'T1', color: '#ff0000', room, seq: 0, doc, peers: [] });
  return { store, sent, dispatcher };
}

describe('sample city flow', () => {
  it('opens a fresh newtown room and builds the city there with one batch, then shows its center', () => {
    const storage = memoryStorage();
    let room = '';
    startSampleCity(storage, (r) => (room = r));
    expect(room).toMatch(/^newtown-[0-9a-f]{8}$/);

    const { store, sent, dispatcher } = setup(room);
    const view = vi.fn();
    resumeSampleCity(store, dispatcher, storage, view);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Extract<ClientMessage, { t: 'cmd' }>;
    expect(msg.cmd).toEqual(sampleCityPlan().batch);
    expect(view).not.toHaveBeenCalled();
    store.receive({ t: 'applied', seq: 1, by: 'me', ref: msg.ref, cmd: msg.cmd });
    expect(view).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.getState().doc.buildings).length).toBeGreaterThan(200);
    expect(store.getState().toasts.some((t) => t.kind === 'success' && t.text.includes('현대 신도시 샘플 완료'))).toBe(true);
    // Only once: the request is consumed.
    resumeSampleCity(store, dispatcher, storage, view);
    expect(sent).toHaveLength(1);
  });

  it('never builds over an existing city', () => {
    const storage = memoryStorage();
    let room = '';
    startSampleCity(storage, (r) => (room = r));
    const doc = createEmptyDoc();
    applyCommand(doc, { type: 'node.add', node: { id: 'x', pos: { x: 0, z: 0 } } });
    const { store, sent, dispatcher } = setup(room, doc);
    resumeSampleCity(store, dispatcher, storage, vi.fn());
    expect(sent).toHaveLength(0);
    expect(store.getState().toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('does nothing in a room that did not ask for it, and does not move the camera when the server refuses (room no longer empty)', () => {
    const storage = memoryStorage();
    const plain = setup('main');
    resumeSampleCity(plain.store, plain.dispatcher, storage, vi.fn());
    expect(plain.sent).toHaveLength(0);

    let room = '';
    startSampleCity(storage, (r) => (room = r));
    const { store, sent, dispatcher } = setup(room);
    const view = vi.fn();
    resumeSampleCity(store, dispatcher, storage, view);
    const msg = sent[0] as Extract<ClientMessage, { t: 'cmd' }>;
    // Someone else built in the room after our welcome: the server's doc.expect refuses the whole batch.
    store.receive({ t: 'rejected', ref: msg.ref, error: 'the city is not empty' });
    expect(view).not.toHaveBeenCalled();
    expect(store.getState().toasts.some((t) => t.kind === 'error' && t.text === '거부됨: 방이 이미 비어 있지 않아 적용하지 않았습니다')).toBe(true);
    expect(store.getState().toasts.some((t) => t.kind === 'success')).toBe(false);
  });

  it('stays within the benchmark city load (P6 baseline): population, jobs, buildings, roads, lanes', () => {
    const sample = createEmptyDoc();
    expect(applyCommand(sample, sampleCityPlan().batch as Command).ok).toBe(true);
    const bench = createBenchCity();
    const a = designStats(sample);
    const b = designStats(bench);
    const laneKm = (d: typeof sample): number => compileNetwork(d).lanes.reduce((s, l) => s + l.length, 0) / 1000;
    expect(a.population).toBeLessThanOrEqual(b.population);
    expect(a.jobs).toBeLessThanOrEqual(b.jobs);
    expect(a.buildings).toBeLessThanOrEqual(b.buildings);
    expect(Object.keys(sample.segments).length).toBeLessThanOrEqual(Object.keys(bench.segments).length);
    expect(laneKm(sample)).toBeLessThanOrEqual(laneKm(bench));
  }, 60_000);
});
