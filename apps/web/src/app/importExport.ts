// JSON export, and import into a fresh room as command batches (≤ LIMITS.batchSize each).
// Items today's rules reject (e.g. a building on a road) are skipped instead of failing the import.

import {
  applyCommand,
  createEmptyDoc,
  docToCommands,
  DOC_VERSION,
  LIMITS,
  MAX_MESSAGE_BYTES,
  normalizeDoc,
  type CityDoc,
  type Command,
} from '@smartcity/shared';
import type { Dispatcher } from './dispatch';
import { translateError, type ClientStore } from './store';

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

export interface ParsedImport {
  ok: true;
  commands: Command[];
  /** Items left out because the current rules reject them. */
  skipped: number;
  /** Most common reasons for the skipped items (Korean). */
  reasons: string[];
}

/**
 * Parse an exported city (any doc version up to DOC_VERSION, migrated by normalizeDoc) and replay
 * it into an empty doc with the server's rules; commands that fail are skipped and counted.
 */
export function parseImport(text: string): ParsedImport | { ok: false; error: string } {
  let doc: CityDoc;
  try {
    doc = JSON.parse(text) as CityDoc;
  } catch {
    return { ok: false, error: 'JSON 형식이 아닙니다' };
  }
  if (!doc || typeof doc !== 'object' || typeof doc.version !== 'number' || doc.version < 1 || typeof doc.meta !== 'object' || doc.meta === null) {
    return { ok: false, error: '도시 파일이 아닙니다' };
  }
  if (doc.version > DOC_VERSION) return { ok: false, error: `더 새로운 버전(v${doc.version})의 도시 파일입니다. 앱을 업데이트하세요` };
  let cmds: Command[];
  try {
    cmds = docToCommands(normalizeDoc(doc));
  } catch {
    return { ok: false, error: '도시 파일 구조가 올바르지 않습니다' };
  }
  const check = createEmptyDoc();
  const kept: Command[] = [];
  const reasons = new Map<string, number>();
  let skipped = 0;
  for (const c of cmds) {
    const r = applyCommand(check, c);
    if (r.ok) {
      kept.push(c);
    } else {
      skipped++;
      const why = translateError(r.error);
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
    }
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return { ok: true, commands: chunkCommands(kept), skipped, reasons: top };
}

interface StoredImport {
  commands: Command[];
  skipped: number;
  reasons: string[];
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
    storage.setItem(IMPORT_KEY(room), JSON.stringify({ commands: parsed.commands, skipped: parsed.skipped, reasons: parsed.reasons } satisfies StoredImport));
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
  const stored = JSON.parse(raw) as StoredImport;
  const batches = stored.commands;
  let i = 0;
  let waiting: number | null = null;
  let seqAtSend = 0;
  const next = (): void => {
    if (i >= batches.length) {
      unsub();
      store.toast(`가져오기 완료 (${batches.length}개 묶음)`, 'success');
      if (stored.skipped > 0) {
        store.toast(`현재 규칙(도로 침범 등) 때문에 ${stored.skipped}개 항목을 가져오지 못했습니다: ${stored.reasons.join(' / ')}`, 'error');
      }
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
