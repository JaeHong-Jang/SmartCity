// "현대 신도시 샘플 만들기" (ADR 0014 §7): a fresh room, then the generated city as ONE batch sent after its
// welcome, like a JSON import (the current city is never touched). Only the requester's camera moves.

import { designStats, SAMPLE_CITY_SEED, sampleCityPlan } from '@smartcity/shared';
import type { Dispatcher } from './dispatch';
import type { ClientStore } from './store';

const SAMPLE_KEY = (room: string): string => `smartcity:sample:${room}`;

export function newSampleRoomId(): string {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return 'newtown-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Remember the request for a new room and go there; the city is built after its welcome. */
export function startSampleCity(storage: Storage, navigate: (room: string) => void): void {
  const room = newSampleRoomId();
  storage.setItem(SAMPLE_KEY(room), String(SAMPLE_CITY_SEED));
  navigate(room);
}

/**
 * Called after welcome: builds the requested sample city in this room if it is still empty (never over
 * someone's city), then shows its center with `viewCity` once the batch is applied.
 */
export function resumeSampleCity(store: ClientStore, dispatcher: Dispatcher, storage: Storage, viewCity: () => void): void {
  const s = store.getState();
  const raw = storage.getItem(SAMPLE_KEY(s.room));
  if (raw === null) return;
  storage.removeItem(SAMPLE_KEY(s.room));
  if (Object.keys(s.doc.nodes).length || Object.keys(s.doc.buildings).length || Object.keys(s.doc.parcels).length) {
    store.toast('이 방은 비어 있지 않아 신도시 샘플을 만들지 않았습니다', 'error');
    return;
  }
  const seed = Number(raw);
  const { batch } = sampleCityPlan(Number.isFinite(seed) ? seed : SAMPLE_CITY_SEED);
  store.toast('현대 신도시 샘플을 만드는 중…', 'info');
  const ref = dispatcher.dispatch(batch);
  if (ref === null) return;
  let done = false;
  const settle = (): void => {
    const st = store.getState();
    const outcome = st.results[ref];
    // Still waiting; a dropped connection leaves neither (the store reports the unknown result).
    if (outcome === undefined && st.pending.some((p) => p.ref === ref)) return;
    done = true;
    unsub();
    if (outcome !== 'ok') return;
    const d = designStats(st.doc);
    store.toast(`현대 신도시 샘플 완료: 건물 ${d.buildings}동 · 도로 ${Object.keys(st.doc.segments).length}개 · 인구 약 ${d.population.toLocaleString('ko-KR')}명 · 일자리 약 ${d.jobs.toLocaleString('ko-KR')}개`, 'success');
    viewCity();
  };
  const unsub = store.subscribe(() => {
    if (!done) settle();
  });
  // A synchronous transport (offline) has already answered.
  settle();
}
