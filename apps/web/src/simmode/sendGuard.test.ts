import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@smartcity/shared';
import { createDispatcher } from '../app/dispatch';
import { ClientStore } from '../app/store';
import type { Transport } from '../net/transport';
import { guardedSend, SIM_LOCK_TOAST } from './sendGuard';

const cmdMsg = { t: 'cmd', ref: 1, cmd: { type: 'meta.update', trafficDensity: 2 } } as ClientMessage;

describe('shared-edit lock at the send path', () => {
  it('guardedSend drops cmd and ai.* in simulator mode, with a warning and a notice; presence and ping pass', () => {
    const sent: string[] = [];
    const notes: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const go = (m: ClientMessage, locked: boolean) => guardedSend(m, () => locked, (x) => sent.push(x.t), (t) => notes.push(t));
    expect(go(cmdMsg, true)).toBe(false);
    expect(go({ t: 'ai.ask', reqId: 1, text: 'x', focus: null } as ClientMessage, true)).toBe(false);
    expect(go({ t: 'ai.cancel', reqId: 1 } as ClientMessage, true)).toBe(false);
    expect(go({ t: 'ping', at: 1 } as ClientMessage, true)).toBe(true);
    expect(sent).toEqual(['ping']);
    expect(notes).toEqual([SIM_LOCK_TOAST, SIM_LOCK_TOAST, SIM_LOCK_TOAST]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(go(cmdMsg, false)).toBe(true); // normal mode: untouched
    expect(sent).toEqual(['ping', 'cmd']);
    warn.mockRestore();
  });

  it('the dispatcher refuses to queue or send a command while locked (the density slider repro)', () => {
    const store = new ClientStore('r', 'n');
    store.set({ ready: true });
    const sent: ClientMessage[] = [];
    const transport = { send: (m: ClientMessage) => sent.push(m) } as unknown as Transport;
    let locked = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = createDispatcher(store, () => transport, undefined, () => locked);
    expect(d.dispatch({ type: 'meta.update', trafficDensity: 2 })).toBeNull();
    expect(sent).toEqual([]);
    expect(store.getState().pending).toEqual([]); // no stuck ghost either
    expect(store.getState().toasts.some((t) => t.text === SIM_LOCK_TOAST)).toBe(true);
    locked = false;
    expect(d.dispatch({ type: 'meta.update', trafficDensity: 2 })).not.toBeNull();
    expect(sent.map((m) => m.t)).toEqual(['cmd']);
    warn.mockRestore();
  });
});
