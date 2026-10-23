import { randomBytes, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { tryApplyCommand } from '@smartcity/shared';
import type { CityDoc, Command, Peer, Presence, ServerMessage } from '@smartcity/shared';
import { appendLog, LogCorruptedError, writeCheckpoint } from './persistence.js';
import { GrowthDirector, type GrowthOptions } from './growth.js';
import { TokenBucket } from './rateLimit.js';

export const MAX_CLIENTS_PER_ROOM = 50;
/** `by` of commands the server issues itself. */
export const SYSTEM_ID = 'system';

export type CommitResult = { ok: true; seq: number } | { ok: false; error: string };
const CHECKPOINT_EVERY = 200;
const PRESENCE_MIN_INTERVAL_MS = 50; // 20Hz
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324'];

// Tags prefix client-generated entity ids. The per-boot prefix keeps them unique across
// restarts, when persisted rooms already contain ids from earlier sessions.
const BOOT_ID = randomBytes(3).toString('hex');
let tagCounter = 0;
let colorCounter = 0;

export class Client {
  readonly id = randomUUID();
  readonly tag = `${BOOT_ID}${(++tagCounter).toString(36)}`;
  readonly color = COLORS[colorCounter++ % COLORS.length]!;
  readonly bucket = new TokenBucket(20, 40);
  lastPresenceAt = 0;
  pendingPresence: Presence | null = null;
  presenceTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly ws: WebSocket,
    readonly name: string,
  ) {}

  get peer(): Peer {
    return { clientId: this.id, name: this.name, color: this.color };
  }
}

export class Room {
  readonly clients = new Set<Client>();
  private sinceCheckpoint = 0;
  /** False after the log could not be restored; a successful checkpoint (which resets the log) re-enables writes. */
  private writable = true;
  private timer: NodeJS.Timeout;
  unloadTimer: NodeJS.Timeout | null = null;
  private readonly growth: GrowthDirector;

  constructor(
    readonly id: string,
    readonly dataDir: string,
    public doc: CityDoc,
    public seq: number,
    growth: GrowthOptions = {},
  ) {
    this.timer = setInterval(() => this.checkpointIfDirty(), 30_000);
    this.timer.unref();
    this.growth = new GrowthDirector(this, growth);
    this.growth.start();
  }

  private send(c: Client, msg: ServerMessage): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, except?: Client): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c !== except && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  private peers(): Peer[] {
    return [...this.clients].map((c) => c.peer);
  }

  /** Join and send welcome in the same tick, so later `applied` always carries a higher seq. */
  join(c: Client): void {
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = null;
    }
    this.clients.add(c);
    this.send(c, {
      t: 'welcome',
      clientId: c.id,
      tag: c.tag,
      color: c.color,
      room: this.id,
      seq: this.seq,
      doc: this.doc,
      peers: this.peers(),
    });
    this.broadcast({ t: 'peers', peers: this.peers() });
  }

  leave(c: Client): void {
    if (c.presenceTimer) clearTimeout(c.presenceTimer);
    if (this.clients.delete(c)) this.broadcast({ t: 'peers', peers: this.peers() });
  }

  command(c: Client, ref: number, cmd: Command): void {
    if (!c.bucket.take()) {
      this.send(c, { t: 'rejected', ref, error: 'rate limited' });
      return;
    }
    const res = this.commit(cmd, c.id, c, ref);
    if (!res.ok) this.send(c, { t: 'rejected', ref, error: res.error });
  }

  /**
   * Commit a command made by the server itself (automatic growth). It takes the same path as a user
   * command: validation, log append with rollback, seq, broadcast; `by` is 'system'.
   */
  system(cmd: Command): CommitResult {
    return this.commit(cmd, SYSTEM_ID, null, 0);
  }

  /**
   * The single commit path: serialize, apply (validates), append to the log (rolling back on
   * failure), assign seq, broadcast. `origin` additionally receives its `ref` echoed in `applied`.
   */
  private commit(cmd: Command, by: string, origin: Client | null, ref: number): CommitResult {
    if (!this.writable) return { ok: false, error: 'storage error' };
    // Serialize first: a command that cannot be logged or broadcast must never touch the doc.
    let cmdJson: string;
    try {
      cmdJson = JSON.stringify(cmd);
    } catch {
      return { ok: false, error: 'command not serializable' };
    }
    const res = tryApplyCommand(this.doc, cmd);
    if (!res.ok) return res;
    try {
      appendLog(this.dataDir, this.id, this.seq + 1, cmdJson); // synchronous, before broadcast
    } catch (e) {
      // Only acknowledged edits may change the doc (ADR 0002): undo and refuse.
      res.rollback();
      console.error(`[room ${this.id}] log append failed: ${(e as Error).message}`);
      if (e instanceof LogCorruptedError) {
        // The rejected record may still sit in the log as seq+1. Burn that number so the next
        // checkpoint covers it and replay never resurrects it; clients see the gap and resync.
        this.seq++;
        this.writable = false;
        this.checkpoint();
      }
      return { ok: false, error: 'storage error' };
    }
    this.seq++;
    const head = `{"t":"applied","seq":${this.seq},"by":${JSON.stringify(by)},"cmd":${cmdJson}`;
    const data = `${head}}`;
    const withRef = `${head},"ref":${ref}}`;
    for (const o of this.clients) {
      if (o.ws.readyState === o.ws.OPEN) o.ws.send(o === origin ? withRef : data);
    }
    if (++this.sinceCheckpoint >= CHECKPOINT_EVERY) this.checkpoint();
    return { ok: true, seq: this.seq };
  }

  presence(c: Client, presence: Presence): void {
    const now = Date.now();
    const wait = c.lastPresenceAt + PRESENCE_MIN_INTERVAL_MS - now;
    if (wait <= 0) {
      c.lastPresenceAt = now;
      this.broadcast({ t: 'presence', clientId: c.id, presence }, c);
      return;
    }
    // Throttled: keep only the latest and flush it when the window ends.
    c.pendingPresence = presence;
    if (c.presenceTimer) return;
    c.presenceTimer = setTimeout(() => {
      c.presenceTimer = null;
      const p = c.pendingPresence;
      c.pendingPresence = null;
      if (p && this.clients.has(c)) {
        c.lastPresenceAt = Date.now();
        this.broadcast({ t: 'presence', clientId: c.id, presence: p }, c);
      }
    }, wait);
  }

  checkpoint(): void {
    try {
      writeCheckpoint(this.dataDir, this.id, this.seq, this.doc);
      this.sinceCheckpoint = 0;
      this.writable = true;
    } catch (e) {
      console.error(`[room ${this.id}] checkpoint failed: ${(e as Error).message}`);
    }
  }

  private checkpointIfDirty(): void {
    // A write-blocked room retries too: a successful checkpoint resets the log and re-enables writes.
    if (this.sinceCheckpoint > 0 || !this.writable) this.checkpoint();
  }

  dispose(): void {
    this.growth.stop();
    clearInterval(this.timer);
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.checkpointIfDirty();
  }
}
