// JSON export, and import into a fresh room as command batches (≤ LIMITS.batchSize each).

import { applyCommand, createEmptyDoc, docToCommands, LIMITS, MAX_MESSAGE_BYTES, type CityDoc, type Command } from '@smartcity/shared';
import type { Dispatcher } from './dispatch';
import type { ClientStore } from './store';

const IMPORT_KEY = (room: string): string => `smartcity:import:${room}`;
/** Leave headroom under the server's frame limit for the envelope. */
const MAX_BATCH_BYTES = Math.floor(MAX_MESSAGE_BYTES * 0.8);

export function exportDoc(doc: CityDoc): string {
  return JSON.stringify(doc, null, 2);
}

/** Split commands into batches limited by count and serialized size. */
export function chunkCommands(cmds: Command[], maxCount: number = LIMITS.batchSize, maxBytes = MAX_BATCH_BYTES): Command[] {
  const out: Command[] = [];
  let cur: Command[] = [];
  let bytes = 0;
  for (const c of cmds) {
    const size = JSON.stringify(c).length + 1;
    if (cur.length > 0 && (cur.length >= maxCount || bytes + size > maxBytes)) {
      out.push({ type: 'batch', commands: cur });
      cur = [];
      bytes = 0;
    }
    cur.push(c);
    bytes += size;
  }
  if (cur.length) out.push({ type: 'batch', commands: cur });
  return out;
}

/** Parse and validate an exported city by replaying it into an empty doc. */
export function parseImport(text: string): { ok: true; commands: Command[] } | { ok: false; error: string } {
  let doc: CityDoc;
  try {
    doc = JSON.parse(text) as CityDoc;
  } catch {
    return { ok: false, error: 'JSON 형식이 아닙니다' };
  }
  if (!doc || doc.version !== 1 || typeof doc.meta !== 'object') return { ok: false, error: '도시 파일(version 1)이 아닙니다' };
  let commands: Command[];
  try {
    commands = chunkCommands(docToCommands(doc));
  } catch {
    return { ok: false, error: '도시 파일 구조가 올바르지 않습니다' };
  }
  const check = createEmptyDoc();
  for (const c of commands) {
    const r = applyCommand(check, c);
    if (!r.ok) return { ok: false, error: `검증 실패: ${r.error}` };
  }
  return { ok: true, commands };
}

export function newRoomId(): string {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return 'import-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Store the file for the fresh room and navigate there; the import runs after its welcome. */
export function startImport(text: string, storage: Storage, navigate: (room: string) => void): string | null {
  const parsed = parseImport(text);
  if (!parsed.ok) return parsed.error;
  const room = newRoomId();
  try {
    storage.setItem(IMPORT_KEY(room), JSON.stringify(parsed.commands));
  } catch {
    return '파일이 너무 커서 가져올 수 없습니다';
  }
  navigate(room);
  return null;
}

/** Called after welcome: replays a pending import into this (empty) room, one batch at a time. */
export function resumeImport(store: ClientStore, dispatcher: Dispatcher, storage: Storage): void {
  const s = store.getState();
  const raw = storage.getItem(IMPORT_KEY(s.room));
  if (!raw) return;
  storage.removeItem(IMPORT_KEY(s.room));
  if (Object.keys(s.doc.nodes).length || Object.keys(s.doc.buildings).length) {
    store.toast('이 방은 비어 있지 않아 가져오기를 건너뜁니다', 'error');
    return;
  }
  const batches = JSON.parse(raw) as Command[];
  let i = 0;
  let waiting: number | null = null;
  let seqAtSend = 0;
  const next = (): void => {
    if (i >= batches.length) {
      unsub();
      store.toast(`가져오기 완료 (${batches.length}개 묶음)`, 'success');
      return;
    }
    seqAtSend = store.getState().seq;
    waiting = dispatcher.dispatch(batches[i++]!);
    if (waiting === null) unsub();
  };
  const unsub = store.subscribe(() => {
    if (waiting === null) return;
    if (!store.getState().pending.some((p) => p.ref === waiting)) {
      waiting = null;
      if (store.getState().seq === seqAtSend) {
        unsub();
        store.toast(`가져오기 중단: ${i}번째 묶음이 거부되었습니다`, 'error');
        return;
      }
      next();
    }
  });
  store.toast('도시 파일을 가져오는 중…', 'info');
  next();
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
