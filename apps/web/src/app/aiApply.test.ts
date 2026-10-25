import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, type Command } from '@smartcity/shared';
import { ClientStore } from './store';

const welcome = () => ({ t: 'welcome' as const, clientId: 'me', tag: 'T1', color: '#ff0000', room: 'main', seq: 0, doc: createEmptyDoc(), peers: [] });
const batch: Command = {
  type: 'batch',
  commands: [{ type: 'building.place', building: { id: 'ai-1-b1', typeId: 'house', pos: { x: 30, z: 40 }, rotation: 0 } }],
};
/** Ask and receive a proposal, as the panel would show it. */
function proposeFor(s: ClientStore, reqId: number): void {
  s.aiEvent({ kind: 'ask', text: 'x' });
  s.aiEvent({ kind: 'server', msg: { t: 'ai.proposal', reqId, commands: [], summary: `p${reqId}` } });
}
const ready = () => {
  const s = new ClientStore('main', '나', () => 5000);
  s.receive(welcome());
  return s;
};

describe('AI apply tracked in the store (survives panel switches)', () => {
  it('creates the highlight, notifies the camera hook and drops the proposal when the batch is applied', () => {
    const s = ready();
    const hook = vi.fn();
    s.onAiHighlight = hook;
    proposeFor(s, 1);
    s.trackAiApply(9, batch, '카페를 지었어요', 1);
    expect(s.getState().aiApplies[9]).toBeDefined();
    s.receive({ t: 'applied', seq: 1, cmd: batch, by: 'me', ref: 9 });
    const st = s.getState();
    expect(st.aiApplies).toEqual({});
    expect(st.highlights.items).toHaveLength(1);
    expect(st.highlights.items[0]).toMatchObject({ label: '카페를 지었어요', buildingIds: ['ai-1-b1'], createdAt: 5000 });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]![0].bbox).not.toBeNull();
    expect(st.ai.proposal).toBeNull();
    expect(st.toasts.some((t) => t.kind === 'success')).toBe(true);
  });

  it('a refused batch creates no highlight and clears the record', () => {
    const s = ready();
    const hook = vi.fn();
    s.onAiHighlight = hook;
    s.trackAiApply(3, batch, 's', 1);
    s.receive({ t: 'rejected', ref: 3, error: 'overlaps another building' });
    expect(s.getState().aiApplies).toEqual({});
    expect(s.getState().highlights.items).toHaveLength(0);
    expect(hook).not.toHaveBeenCalled();
  });

  it('ignores applies of other clients and unrelated refs', () => {
    const s = ready();
    s.trackAiApply(4, batch, 's', 1);
    s.receive({ t: 'applied', seq: 1, cmd: batch, by: 'someone-else', ref: 4 });
    expect(s.getState().highlights.items).toHaveLength(0);
    expect(s.getState().aiApplies[4]).toBeDefined();
  });

  it('resolves at once when the answer arrived before tracking (synchronous transports)', () => {
    const s = ready();
    s.receive({ t: 'applied', seq: 1, cmd: batch, by: 'me', ref: 6 });
    s.trackAiApply(6, batch, 's', 1);
    expect(s.getState().highlights.items).toHaveLength(1);
    expect(s.getState().aiApplies).toEqual({});
  });

  it('an older apply answer keeps a newer proposal (highlight and toast still happen)', () => {
    const s = ready();
    proposeFor(s, 1);
    s.trackAiApply(9, batch, 'A', 1);
    // The user asks again and receives proposal B before A's answer arrives.
    proposeFor(s, 2);
    expect(s.getState().ai.proposal?.reqId).toBe(2);
    s.receive({ t: 'applied', seq: 1, cmd: batch, by: 'me', ref: 9 });
    expect(s.getState().ai.proposal?.reqId).toBe(2);
    expect(s.getState().highlights.items).toHaveLength(1);
    expect(s.getState().toasts.some((t) => t.kind === 'success')).toBe(true);
  });
});
