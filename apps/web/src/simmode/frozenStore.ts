// A ClientStore view for the renderer: while frozen it reports the simulator copy's doc (and no pending
// edits, selection or highlights that refer to the live city), ignores live commands and resets, and on
// freeze/thaw tells the renderer to rebuild everything from the doc it now sees. The real store keeps
// receiving server commands untouched.

import type { CityDoc } from '@smartcity/shared';
import { initialHighlights } from '../app/highlights';
import type { ClientState, ClientStore } from '../app/store';

type ResetCb = Parameters<ClientStore['onReset']>[0];

export interface FrozenView {
  view: ClientStore;
  freeze(doc: CityDoc): void;
  thaw(): void;
  readonly frozen: boolean;
}

export function createFrozenView(real: ClientStore): FrozenView {
  let frozenDoc: CityDoc | null = null;
  let version = 0;
  const resets = new Set<ResetCb>();
  let cacheKey: { live: ClientState; version: number } | null = null;
  let cached: ClientState = real.getState();

  const derived = (): ClientState => {
    const live = real.getState();
    if (!frozenDoc) return live;
    if (!cacheKey || cacheKey.live !== live || cacheKey.version !== version) {
      cacheKey = { live, version };
      cached = {
        ...live,
        doc: frozenDoc,
        docVersion: -version - 1,
        pending: [],
        flashes: [],
        selection: null,
        phaseHighlight: null,
        highlights: initialHighlights(),
      };
    }
    return cached;
  };

  const rebuild = (doc: CityDoc): void => {
    version++;
    for (const cb of resets) cb(doc);
  };

  const view = new Proxy(real, {
    get(target, prop) {
      if (prop === 'getState') return derived;
      if (prop === 'onApplied') {
        return (l: Parameters<ClientStore['onApplied']>[0]) => target.onApplied((cmd, seq) => (frozenDoc ? undefined : l(cmd, seq)));
      }
      if (prop === 'onReset') {
        return (l: ResetCb) => {
          resets.add(l);
          const off = target.onReset((doc) => (frozenDoc ? undefined : l(doc)));
          return () => {
            resets.delete(l);
            off();
          };
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });

  return {
    view,
    freeze(doc) {
      frozenDoc = doc;
      rebuild(doc);
    },
    thaw() {
      frozenDoc = null;
      rebuild(real.getState().doc);
    },
    get frozen() {
      return frozenDoc !== null;
    },
  };
}
