// Frame-time percentiles for the render stats (ADR 0013 §7): a fixed ring of recent frame times,
// summarized into p50/p95/p99 without allocating (the sort runs on a preallocated scratch copy).

export interface FramePercentiles {
  p50: number;
  p95: number;
  p99: number;
}

/** Nearest-rank percentile of an ascending sorted array (q in 0..1). */
export function percentile(sorted: ArrayLike<number>, n: number, q: number): number {
  if (n <= 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sorted[i]!;
}

export class FrameTimes {
  private readonly ring: Float32Array;
  private readonly scratch: Float32Array;
  private next = 0;
  private filled = 0;

  constructor(capacity = 600) {
    this.ring = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity);
  }

  push(ms: number): void {
    this.ring[this.next] = ms;
    this.next = (this.next + 1) % this.ring.length;
    if (this.filled < this.ring.length) this.filled++;
  }

  get count(): number {
    return this.filled;
  }

  /** Percentiles of the frames currently held, written into `out` (no allocation). */
  summarize(out: FramePercentiles): FramePercentiles {
    const n = this.filled;
    const s = this.scratch;
    s.set(this.ring);
    // Slots never written sort to the end, past the n frames that count.
    s.fill(Infinity, n);
    s.sort();
    out.p50 = percentile(s, n, 0.5);
    out.p95 = percentile(s, n, 0.95);
    out.p99 = percentile(s, n, 0.99);
    return out;
  }

  clear(): void {
    this.next = 0;
    this.filled = 0;
  }
}
