import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, IdGen, planRoad, resolvePoint, type CityDoc, type Command } from '@smartcity/shared';
import { crossDoc } from '../test/fixtures';
import { createDispatcher } from './dispatch';
import { dryRunProposal, proposalItems } from './proposal';
import { applyProposal } from './proposalApply';
import { ClientStore } from './store';

const planned = (doc: CityDoc, from: [number, number], to: [number, number], tag: string): Command => {
  const plan = planRoad(doc, { start: resolvePoint(doc, { x: from[0], z: from[1] }), end: resolvePoint(doc, { x: to[0], z: to[1] }), roadTypeId: 'road-2' }, new IdGen(tag));
  if (!plan.command) throw new Error(plan.error);
  return plan.command;
};

/** A client store plus a fake server: commands are applied to the server doc and answered like the sequencer does. */
function rig() {
  const { doc } = crossDoc();
  const server = cloneJson(doc);
  const store = new ClientStore('main', '나', () => 5000);
  store.receive({ t: 'welcome', clientId: 'me', tag: 'T1', color: '#f00', room: 'main', seq: 0, doc: cloneJson(doc), peers: [] });
  let seq = 0;
  let ref = 1;
  const sent: Command[] = [];
  const others = (cmd: Command) => {
    expect(applyCommand(server, cmd).ok).toBe(true);
    store.receive({ t: 'applied', seq: ++seq, cmd, by: 'other' });
  };
  const dispatch = (cmd: Command): number => {
    const r = ref++;
    sent.push(cmd);
    const res = applyCommand(server, cmd);
    if (res.ok) store.receive({ t: 'applied', seq: ++seq, cmd, by: 'me', ref: r });
    else store.receive({ t: 'rejected', ref: r, error: res.error });
    return r;
  };
  return { doc, server, store, dispatch, sent, others };
}

describe('applyProposal: independent items do not fail together (Sol 4b #2)', () => {
  it('a road that lost a race is dropped; the other road and the building still apply, highlighted', async () => {
    const { doc, store, dispatch, sent, others } = rig();
    // A splits the east road at x = 48; B extends the east end; C is a house beside B's future place.
    const a = planned(doc, [48, -64], [48, 64], 'A');
    const b = planned(doc, [96, 0], [224, 0], 'B');
    const c: Command = { type: 'building.place', building: { id: 'ai-c', typeId: 'house', pos: { x: 300, z: 60 }, rotation: 0 } };
    const items = proposalItems([a, b, c]);
    expect(dryRunProposal(doc, items)).toEqual({});
    // Another user splits A's target before the apply reaches the server.
    const east = Object.values(doc.segments).find((s) => doc.nodes[s.a]!.pos.x === 96 || doc.nodes[s.b]!.pos.x === 96)!;
    others({ type: 'segment.split', id: east.id, t: 0.5, nodeId: 'zz', segmentIds: ['z1', 'z2'] });
    const r = await applyProposal(store, dispatch, items, {}, '도로와 건물', 1);
    // A (the first road item) is refused as a whole; B was planned on the old east end node, which still exists.
    expect(r.error).toMatch(/segment|unknown/i);
    expect(sent.filter((x) => x.type === 'batch' && x.commands.some((y) => y.type === 'segment.split'))).toHaveLength(1);
    const st = store.getState();
    expect(Object.keys(st.doc.segments).some((id) => id.includes('B'))).toBe(true);
    expect(Object.keys(st.doc.segments).some((id) => id.includes('A'))).toBe(false);
    expect(st.doc.buildings['ai-c']).toBeDefined();
    // One highlight covering what applied: the B road and the house.
    expect(st.highlights.items).toHaveLength(1);
    const h = st.highlights.items[0]!;
    expect(h.buildingIds).toEqual(['ai-c']);
    expect(h.roadSegmentIds.length).toBe(1);
    expect(h.roadSegmentIds[0]).toContain('B');
  });

  it('sends roads one by one, then the rest as a single batch that is re-checked on the new doc', async () => {
    const { doc, store, dispatch, sent } = rig();
    const b = planned(doc, [96, 0], [224, 0], 'B');
    const near: Command = { type: 'building.place', building: { id: 'ai-near', typeId: 'house', pos: { x: 160, z: 0 }, rotation: 0 } };
    const ok: Command = { type: 'building.place', building: { id: 'ai-ok', typeId: 'house', pos: { x: 160, z: 60 }, rotation: 0 } };
    const items = proposalItems([b, near, ok]);
    // `near` is clear on the old doc (no road there yet) but sits on the new road.
    expect(dryRunProposal(doc, items)[2]).toBeUndefined();
    const r = await applyProposal(store, dispatch, items, {}, 's', 1);
    expect(sent.map((x) => x.type)).toEqual(['batch', 'batch']);
    expect(sent[0]!.type === 'batch' && sent[0]!.commands.some((x) => x.type === 'segment.add')).toBe(true);
    expect(sent[1]!.type === 'batch' && sent[1]!.commands.map((x) => x.type === 'building.place' && x.building.id)).toEqual(['ai-ok']);
    expect(r.failed).toBe(1);
    expect(store.getState().doc.buildings['ai-near']).toBeUndefined();
    expect(store.getState().doc.buildings['ai-ok']).toBeDefined();
  });
});

describe('applyProposal edge cases (Sol 4b recheck)', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const withProposal = (store: ClientStore, reqId: number) => {
    store.aiEvent({ kind: 'ask', text: 'x' });
    store.aiEvent({ kind: 'server', msg: { t: 'ai.proposal', reqId, commands: [], summary: 's' } });
  };

  it('a timeout is "unknown": the late answer still gets recorded and cleans up the proposal', async () => {
    const { doc, store, server } = rig();
    withProposal(store, 1);
    const road = planned(doc, [96, 0], [224, 0], 'B');
    const items = proposalItems([road]);
    let sentRef = 0;
    const silent = (cmd: Command): number => {
      sentRef = 7;
      expect(applyCommand(server, cmd).ok).toBe(true);
      return sentRef;
    };
    const r = await applyProposal(store, silent, items, {}, 's', 1, 20);
    expect(r).toMatchObject({ applied: 0, failed: 0, pending: 1 });
    expect(store.getState().highlights.items).toHaveLength(0);
    expect(store.getState().ai.proposal).not.toBeNull();
    expect(store.getState().toasts.some((t) => t.text.includes('결과 확인 중'))).toBe(true);
    // The answer arrives late.
    store.receive({ t: 'applied', seq: 1, cmd: road, by: 'me', ref: 7 });
    await delay(5);
    const st = store.getState();
    expect(st.highlights.items).toHaveLength(1);
    expect(st.highlights.items[0]!.roadSegmentIds).toHaveLength(1);
    expect(st.ai.proposal).toBeNull();
  });

  it('records the earlier successes when a later send cannot go out (not connected)', async () => {
    const { doc, store, dispatch } = rig();
    const a = planned(doc, [96, 0], [224, 0], 'A');
    const b = planned(doc, [0, 96], [0, 224], 'B');
    const items = proposalItems([a, b]);
    let n = 0;
    const flaky = (cmd: Command): number | null => (++n === 1 ? dispatch(cmd) : null);
    const r = await applyProposal(store, flaky, items, {}, 's', 1);
    expect(r).toMatchObject({ applied: 1, failed: 1 });
    const h = store.getState().highlights.items;
    expect(h).toHaveLength(1);
    expect(h[0]!.roadSegmentIds).toHaveLength(1);
  });

  it('a second apply of the same proposal joins the first (also after the panel is gone)', async () => {
    const { doc, store, server } = rig();
    const road = planned(doc, [96, 0], [224, 0], 'A');
    const items = proposalItems([road]);
    let sends = 0;
    const slow = (cmd: Command): number => {
      sends++;
      const ref = 3;
      setTimeout(() => {
        applyCommand(server, cmd);
        store.receive({ t: 'applied', seq: 1, cmd, by: 'me', ref });
      }, 20);
      return ref;
    };
    const first = applyProposal(store, slow, items, {}, 's', 4);
    expect(store.getState().aiApplying).toBe(4);
    const second = applyProposal(store, slow, items, {}, 's', 4);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(sends).toBe(1);
    expect(store.getState().aiApplying).toBeNull();
    expect(store.aiApplyJobs.size).toBe(0);
  });
});

describe('pending refs: guard and session lifecycle (Sol 4b recheck 2)', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const listeners = (s: ClientStore) => (s as unknown as { listeners: Set<unknown> }).listeners.size;
  const welcomeWith = (store: ClientStore, doc: CityDoc) => store.receive({ t: 'welcome', clientId: 'me', tag: 'T1', color: '#f00', room: 'main', seq: 10, doc: cloneJson(doc), peers: [] });

  it('keeps blocking a re-apply while a timed-out command is unresolved, then releases when it answers', async () => {
    const { doc, store, server } = rig();
    const items = proposalItems([planned(doc, [96, 0], [224, 0], 'B')]);
    let sends = 0;
    const silent = (cmd: Command): number => {
      sends++;
      expect(applyCommand(server, cmd).ok).toBe(true);
      return 100 + sends;
    };
    const first = await applyProposal(store, silent, items, {}, 's', 1, 15);
    expect(first.pending).toBe(1);
    expect(store.getState().aiPending[1]).toBe(1);
    const again = await applyProposal(store, silent, items, {}, 's', 1, 15);
    expect(sends).toBe(1);
    expect(again).toMatchObject({ applied: 0, pending: 1 });
    store.receive({ t: 'applied', seq: 1, cmd: items[0]!.cmd, by: 'me', ref: 101 });
    await delay(5);
    expect(store.getState().aiPending).toEqual({});
    expect(store.getState().highlights.items).toHaveLength(1);
  });

  it('a lost connection releases every waiter and guard; nothing is inferred from the doc after resync', async () => {
    const { doc, store, server } = rig();
    const base = listeners(store);
    const roads = [planned(doc, [96, 0], [224, 0], 'A'), planned(doc, [0, 96], [0, 224], 'B'), planned(doc, [-96, 0], [-224, 0], 'C')];
    let ref = 0;
    const silent = (cmd: Command): number => {
      ++ref;
      if (ref === 1) expect(applyCommand(server, cmd).ok).toBe(true); // A really applied on the server
      return ref;
    };
    for (const [i, r] of roads.entries()) await applyProposal(store, silent, proposalItems([r]), {}, 's', i + 1, 10);
    expect(Object.keys(store.getState().aiPending)).toHaveLength(3);
    store.connectionLost('reconnecting');
    expect(store.getState().aiPending).toEqual({});
    expect(store.getState().toasts.some((t) => t.text.includes('결과를 확인할 수 없습니다'))).toBe(true);
    await delay(5);
    expect(listeners(store)).toBe(base);
    // Reconnect: the server doc even has road A, but only an explicit applied(ok) of ours may record anything.
    welcomeWith(store, server);
    expect(store.getState().highlights.items).toHaveLength(0);
    expect(listeners(store)).toBe(base);
    // Not blocked any more: the guard is released for every reqId.
    expect(store.getState().aiPending).toEqual({});
  });
});

describe('session races (Sol 4b recheck 3)', () => {
  const listeners = (s: ClientStore) => (s as unknown as { listeners: Set<unknown> }).listeners.size;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('an answered command is never lost to a connection change in the same turn: exactly one highlight', async () => {
    const { doc, store, server } = rig();
    const road = planned(doc, [96, 0], [224, 0], 'A');
    const items = proposalItems([road]);
    const dispatch = (cmd: Command): number => {
      applyCommand(server, cmd);
      // The answer and a disconnect + welcome arrive in one synchronous turn.
      queueMicrotask(() => {
        store.receive({ t: 'applied', seq: 1, cmd, by: 'me', ref: 5 });
        store.connectionLost('reconnecting');
        store.receive({ t: 'welcome', clientId: 'me', tag: 'T1', color: '#f00', room: 'main', seq: 1, doc: cloneJson(server), peers: [] });
      });
      return 5;
    };
    const r = await applyProposal(store, dispatch, items, {}, 's', 1);
    expect(r).toMatchObject({ applied: 1, lost: 0 });
    expect(store.getState().highlights.items).toHaveLength(1);
    expect(store.getState().toasts.some((t) => t.text.includes('확인할 수 없습니다'))).toBe(false);
  });

  it('a late answer followed by a reconnect records exactly one highlight', async () => {
    const { doc, store, server } = rig();
    const road = planned(doc, [96, 0], [224, 0], 'A');
    const items = proposalItems([road]);
    const silent = (cmd: Command): number => (applyCommand(server, cmd), 9);
    await applyProposal(store, silent, items, {}, 's', 1, 10);
    store.receive({ t: 'applied', seq: 1, cmd: road, by: 'me', ref: 9 });
    store.connectionLost('reconnecting');
    store.receive({ t: 'welcome', clientId: 'me', tag: 'T1', color: '#f00', room: 'main', seq: 1, doc: cloneJson(server), peers: [] });
    expect(store.getState().highlights.items).toHaveLength(1);
  });

  it('stops sending when the connection drops mid-apply and cleans everything up', async () => {
    const { doc, store } = rig();
    const items = proposalItems([planned(doc, [96, 0], [224, 0], 'A'), planned(doc, [0, 96], [0, 224], 'B')]);
    const base = listeners(store);
    let sends = 0;
    const dispatch = (): number => ++sends; // never answered
    const job = applyProposal(store, dispatch, items, {}, 's', 1);
    await delay(5);
    store.connectionLost('reconnecting');
    const r = await job;
    expect(sends).toBe(1);
    expect(r).toMatchObject({ applied: 0, lost: 1 });
    expect(listeners(store)).toBe(base);
    expect(store.aiApplyJobs.size).toBe(0);
    expect(store.getState().aiPending).toEqual({});
    expect(store.getState().aiApplying).toBeNull();
    expect((store as unknown as { aiPendingRefs: Map<number, unknown> }).aiPendingRefs.size).toBe(0);
  });

  it('the dispatcher refuses to send while not online', () => {
    const { store } = rig();
    const sent: unknown[] = [];
    const d = createDispatcher(store, () => ({ send: (m: unknown) => sent.push(m) }) as never);
    const cmd: Command = { type: 'node.add', node: { id: 'q', pos: { x: 1, z: 1 } } };
    expect(d.dispatch(cmd)).not.toBeNull();
    store.connectionLost('reconnecting');
    expect(d.dispatch(cmd)).toBeNull();
    expect(sent).toHaveLength(1);
  });
});

describe('transport states and synchronous answers (Sol 4b recheck 4)', () => {
  it('solo offline mode (ready + offline, a usable transport) still sends; only a reconnecting socket refuses', () => {
    const { store } = rig();
    store.set({ connection: 'offline' });
    const sent: unknown[] = [];
    const d = createDispatcher(store, () => ({ send: (m: unknown) => sent.push(m) }) as never);
    const cmd: Command = { type: 'node.add', node: { id: 'q', pos: { x: 1, z: 1 } } };
    expect(d.dispatch(cmd)).not.toBeNull();
    store.set({ connection: 'reconnecting' });
    expect(d.dispatch(cmd)).toBeNull();
    expect(createDispatcher(store, () => null).dispatch(cmd)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('AI apply works in solo offline mode', async () => {
    const { doc, store, dispatch } = rig();
    store.set({ connection: 'offline' });
    const r = await applyProposal(store, dispatch, proposalItems([planned(doc, [96, 0], [224, 0], 'A')]), {}, 's', 1);
    expect(r).toMatchObject({ applied: 1, failed: 0 });
    expect(store.getState().highlights.items).toHaveLength(1);
  });

  it('a synchronous answer (before dispatch returns) leaves nothing tracked and records once', async () => {
    const { doc, store, dispatch } = rig(); // rig's dispatch answers synchronously
    const items = proposalItems([planned(doc, [96, 0], [224, 0], 'A')]);
    const r = await applyProposal(store, dispatch, items, {}, 's', 1);
    expect(r).toMatchObject({ applied: 1, pending: 0 });
    expect(store.getState().aiPending).toEqual({});
    expect(store.getState().highlights.items).toHaveLength(1);
    store.connectionLost('reconnecting');
    expect(store.getState().toasts.some((t) => t.text.includes('확인할 수 없습니다'))).toBe(false);
  });
});
