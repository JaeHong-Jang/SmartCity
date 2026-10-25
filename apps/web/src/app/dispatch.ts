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

export function createDispatcher(
  store: ClientStore,
  getTransport: () => Transport | null,
  now: () => number = () => Date.now(),
  /** True while simulator mode is active: shared edits are refused before anything is queued or sent. */
  isLocked: () => boolean = () => false,
): Dispatcher {
  let ref = 1;
  let gen: IdGen | null = null;
  let genTag = '';

  const dispatch: Dispatch = (cmd, ghost = []) => {
    if (isLocked()) {
      console.warn('[simmode] 시뮬레이터 모드에서 공유 도시 명령을 차단했습니다:', cmd.type);
      store.toast('시뮬레이터 모드에서는 공유 도시를 편집할 수 없습니다', 'error', 'simlock');
      return null;
    }
    const s = store.getState();
    const t = getTransport();
    if (!t || !s.ready || s.connection === 'reconnecting') {
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
