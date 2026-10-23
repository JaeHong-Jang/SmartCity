// Offline solo mode: an in-browser sequencer that behaves like the server (applyCommand, seq,
// applied/rejected) and keeps the city in localStorage.

import {
  applyCommand,
  cloneJson,
  createEmptyDoc,
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
}

const SAVE_DELAY_MS = 500;

export const localStorageKey = (room: string): string => `smartcity:local:${room}`;

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

  constructor(
    private readonly room: string,
    private readonly storage: KeyValueStorage | null,
    private readonly name: () => string,
  ) {
    this.doc = createEmptyDoc();
    const raw = storage?.getItem(localStorageKey(room));
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Saved;
        if (saved?.doc?.version === 1) {
          this.doc = saved.doc;
          this.seq = saved.seq | 0;
        }
      } catch {
        // Corrupt save: start fresh.
      }
    }
  }

  private emit(msg: ServerMessage): void {
    // Deliver asynchronously, like a network round trip.
    queueMicrotask(() => this.messages.emit(msg));
  }

  connect(): void {
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

  private scheduleSave(): void {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  save(): void {
    try {
      this.storage?.setItem(localStorageKey(this.room), JSON.stringify({ seq: this.seq, doc: this.doc } satisfies Saved));
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
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }
}
