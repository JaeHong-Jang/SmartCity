// A SimulationStream that delegates to a swappable target: the renderer is built once with this proxy and
// simulator mode points it at the copy's worker stream (and back). Layers read latest()/previous() every
// frame and keep no per-stream state, so switching needs no invalidation.

import type { SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';

export class SwitchableStream implements SimulationStream {
  private listeners = new Set<(s: SimSnapshot) => void>();
  private unsub: (() => void) | null = null;

  constructor(private target: SimulationStream) {
    this.attach();
  }

  private attach(): void {
    this.unsub = this.target.subscribe((s) => {
      for (const l of this.listeners) l(s);
    });
  }

  /** Point the proxy at another stream. */
  use(target: SimulationStream): void {
    if (target === this.target) return;
    this.unsub?.();
    this.target = target;
    this.attach();
  }

  get current(): SimulationStream {
    return this.target;
  }

  latest(): SimSnapshot | null {
    return this.target.latest();
  }
  previous(): SimSnapshot | null {
    return this.target.previous();
  }
  latestAt(): number {
    return this.target.latestAt();
  }
  previousAt(): number {
    return this.target.previousAt();
  }
  subscribe(cb: (s: SimSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
