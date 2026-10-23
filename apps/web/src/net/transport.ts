import type { ClientMessage, ServerMessage } from '@smartcity/shared';

export type TransportStatus = 'connecting' | 'open' | 'closed';

export interface Transport {
  connect(): void;
  send(msg: ClientMessage): void;
  onMessage(cb: (msg: ServerMessage) => void): () => void;
  onStatus(cb: (status: TransportStatus) => void): () => void;
  /** Drop the connection and join again to receive a fresh snapshot (seq gap, divergence). */
  reconnect(): void;
  close(): void;
}

/** Small listener list shared by both transports. */
export class Emitter<T> {
  private ls = new Set<(v: T) => void>();
  on(cb: (v: T) => void): () => void {
    this.ls.add(cb);
    return () => this.ls.delete(cb);
  }
  emit(v: T): void {
    for (const l of this.ls) l(v);
  }
}
