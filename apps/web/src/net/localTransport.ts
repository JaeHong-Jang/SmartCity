// Offline solo mode: an in-browser sequencer that behaves like the server (applyCommand, seq,
// applied/rejected) and keeps the city in localStorage, under a key of its own so it is never
// mistaken for the server room of the same name (ADR 0011).

import {
  applyCommand,
  cloneJson,
  createEmptyDoc,
  DOC_VERSION,
  docProblem,
  growthTick,
  normalizeDoc,
  type CityDoc,
  type ClientMessage,
  type ServerMessage,
} from '@smartcity/shared';
import { Emitter, type Transport, type TransportStatus } from './transport';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Saved {
  seq: number;
  doc: CityDoc;
  /** Epoch ms of the save (absent in saves made before the key split). */
  savedAt?: number;
}

/**
 * What this browser holds for a room's offline city. `unreadable` (corrupt, malformed, or saved by a
 * newer version) is not "no save": its key must never be written over, and the raw text stays exportable.
 */
export type OfflineSave =
  | { status: 'none' }
  | { status: 'ok'; key: string; seq: number; doc: CityDoc; savedAt: number | null }
  | { status: 'unreadable'; key: string; raw: string; reason: string };

const SAVE_DELAY_MS = 500;
/** Same cadence as the server's GrowthDirector. */
const GROWTH_INTERVAL_MS = 5000;

export const offlineStorageKey = (room: string): string => `smartcity:offline:${room}`;
/** Key used before the split; read (and copied to the new key) but never written or deleted. */
export const legacyStorageKey = (room: string): string => `smartcity:local:${room}`;

/** sessionStorage key: the offline city (`seq:savedAt`) whose notice was closed in this tab. */
export const offlineSeenKey = (room: string): string => `smartcity:offline-seen:${room}`;

/** The offline save this browser keeps for `room`: the new key first, then the legacy one. */
export function readOfflineSave(storage: KeyValueStorage | null, room: string): OfflineSave {
  let key = offlineStorageKey(room);
  let raw = storage?.getItem(key) ?? null;
  if (raw === null) {
    key = legacyStorageKey(room);
    raw = storage?.getItem(key) ?? null;
  }
  if (raw === null) return { status: 'none' };
  const unreadable = (reason: string): OfflineSave => ({ status: 'unreadable', key, raw, reason });
  let saved: Saved;
  try {
    saved = JSON.parse(raw) as Saved;
  } catch {
    return unreadable('저장본이 손상되었습니다 (JSON 아님)');
  }
  const v = saved?.doc?.version;
  if (typeof v !== 'number' || v < 1) return unreadable('도시 저장본 형식이 아닙니다');
  if (v > DOC_VERSION) return unreadable(`더 새로운 버전(v${v})의 앱이 저장했습니다`);
  let doc: CityDoc;
  let problem: string | null;
  try {
    doc = normalizeDoc(saved.doc);
    problem = docProblem(doc);
  } catch (e) {
    return unreadable(`도시 구조가 올바르지 않습니다 (${(e as Error).message})`);
  }
  if (problem) return unreadable(`도시 구조가 올바르지 않습니다 (${problem})`);
  return { status: 'ok', key, doc, seq: saved.seq | 0, savedAt: typeof saved.savedAt === 'number' ? saved.savedAt : null };
}

function randomTag(): string {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return 'L' + Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
}

export class LocalTransport implements Transport {
  private doc: CityDoc;
  private seq = 0;
  private messages = new Emitter<ServerMessage>();
  private statuses = new Emitter<TransportStatus>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private growthTimer: ReturnType<typeof setInterval> | null = null;
  /** In memory only, like the server's: growth choices after a reload may differ, results are in the doc. */
  private growthEpoch = 0;
  /** Set when the stored city could not be read: nothing is opened and that key is never written. */
  readonly unreadable: Extract<OfflineSave, { status: 'unreadable' }> | null = null;

  constructor(
    private readonly room: string,
    private readonly storage: KeyValueStorage | null,
    private readonly name: () => string,
  ) {
    // Migrate a legacy save by copying it; the old key stays as it was (safety first).
    const legacy = storage?.getItem(offlineStorageKey(room)) == null ? storage?.getItem(legacyStorageKey(room)) : null;
    if (legacy) {
      try {
        storage!.setItem(offlineStorageKey(room), legacy);
      } catch {
        // Quota exceeded: the city still loads from the legacy key below.
      }
    }
    const saved = readOfflineSave(storage, room);
    this.doc = saved.status === 'ok' ? saved.doc : createEmptyDoc();
    this.seq = saved.status === 'ok' ? saved.seq : 0;
    if (saved.status === 'unreadable') this.unreadable = saved;
  }

  private emit(msg: ServerMessage): void {
    // Deliver asynchronously, like a network round trip.
    queueMicrotask(() => this.messages.emit(msg));
  }

  connect(): void {
    if (this.unreadable) {
      // Opening an empty city here would replace the unread save on the first edit.
      this.emit({ t: 'error', error: `오프라인 도시 저장본을 읽을 수 없습니다: ${this.unreadable.reason}` });
      return;
    }
    this.growthTimer ??= setInterval(() => this.growthStep(), GROWTH_INTERVAL_MS);
    this.statuses.emit('open');
    this.emit({
      t: 'welcome',
      clientId: 'local',
      tag: randomTag(),
      color: '#38bdf8',
      room: this.room,
      seq: this.seq,
      doc: cloneJson(this.doc),
      peers: [{ clientId: 'local', name: this.name(), color: '#38bdf8' }],
    });
  }

  send(msg: ClientMessage): void {
    switch (msg.t) {
      case 'cmd': {
        if (this.unreadable) {
          this.emit({ t: 'rejected', ref: msg.ref, error: 'offline save unreadable' });
          return;
        }
        const res = applyCommand(this.doc, msg.cmd);
        if (!res.ok) {
          this.emit({ t: 'rejected', ref: msg.ref, error: res.error });
          return;
        }
        this.seq++;
        this.emit({ t: 'applied', seq: this.seq, cmd: msg.cmd, by: 'local', ref: msg.ref });
        this.scheduleSave();
        return;
      }
      case 'ping':
        this.emit({ t: 'pong', at: msg.at });
        return;
      default:
        return;
    }
  }

  /** Automatic growth: a system command applied and announced like any other (`by: 'system'`, no ref). */
  private growthStep(): void {
    if (this.doc.meta.growth === false) return;
    const cmd = growthTick(this.doc, this.growthEpoch++);
    if (!cmd || !applyCommand(this.doc, cmd).ok) return;
    this.seq++;
    this.emit({ t: 'applied', seq: this.seq, cmd, by: 'system' });
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  save(): void {
    if (this.unreadable) return;
    try {
      this.storage?.setItem(offlineStorageKey(this.room), JSON.stringify({ seq: this.seq, doc: this.doc, savedAt: Date.now() } satisfies Saved));
    } catch {
      // Quota exceeded: keep running in memory.
    }
  }

  onMessage(cb: (msg: ServerMessage) => void): () => void {
    return this.messages.on(cb);
  }

  onStatus(cb: (status: TransportStatus) => void): () => void {
    return this.statuses.on(cb);
  }

  reconnect(): void {
    this.connect();
  }

  close(): void {
    if (this.growthTimer) {
      clearInterval(this.growthTimer);
      this.growthTimer = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }
}
