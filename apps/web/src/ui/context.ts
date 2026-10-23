import { createContext, useContext, useSyncExternalStore } from 'react';
import type { CityDoc, Vec2 } from '@smartcity/shared';
import type { Dispatcher } from '../app/dispatch';
import type { ClientState, ClientStore } from '../app/store';

export interface AppServices {
  store: ClientStore;
  dispatcher: Dispatcher;
  focus(p: Vec2): void;
  setName(name: string): void;
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext missing');
  return s;
}

/** Subscribe to a slice of the store. The selector must return state references or primitives. */
export function useStore<T>(selector: (s: ClientState) => T): T {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

/**
 * The city doc plus its change counter. The doc is updated in place, so `docVersion` (bumped on
 * every applied command and on resync) is what re-renders the component and what memo/effect
 * dependencies must use; `doc` alone never changes between commands.
 */
export function useDoc(): { doc: CityDoc; version: number } {
  const doc = useStore((s) => s.doc);
  const version = useStore((s) => s.docVersion);
  return { doc, version };
}
