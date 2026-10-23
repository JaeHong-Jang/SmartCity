// dispatch(cmd): send to the sequencer and keep a pending ghost until `applied`/`rejected` (ADR 0001).

import { IdGen, type Command, type Vec2 } from '@smartcity/shared';
import type { Transport } from '../net/transport';
import type { ClientStore } from './store';

export type Dispatch = (cmd: Command, ghost?: Vec2[][]) => number | null;

export interface Dispatcher {
  dispatch: Dispatch;
  /** Id generator bound to the current server-issued session tag. */
  ids(): IdGen;
}

export function createDispatcher(store: ClientStore, getTransport: () => Transport | null, now: () => number = () => Date.now()): Dispatcher {
  let ref = 1;
  let gen: IdGen | null = null;
  let genTag = '';

  const dispatch: Dispatch = (cmd, ghost = []) => {
    const s = store.getState();
    const t = getTransport();
    if (!t || !s.ready) {
      store.toast('아직 연결되지 않았습니다', 'error');
      return null;
    }
    const r = ref++;
    store.addPending({ ref: r, cmd, ghost, sentAt: now() });
    t.send({ t: 'cmd', ref: r, cmd });
    return r;
  };

  return {
    dispatch,
    ids() {
      const tag = store.getState().tag || 'x';
      if (!gen || genTag !== tag) {
        gen = new IdGen(tag);
        genTag = tag;
      }
      return gen;
    },
  };
}
