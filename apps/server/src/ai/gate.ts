// Abuse and cost limits for the AI assistant (ADR 0009 §5). The server key is shared by everyone, so the
// limits are server-wide first (concurrency, requests per hour), then per IP and per room.

export interface GateLimits {
  maxConcurrent: number;
  perHour: number;
  perIpWindowMs: number;
  perIpMax: number;
}

export const DEFAULT_GATE: GateLimits = { maxConcurrent: 2, perHour: 60, perIpWindowMs: 10 * 60_000, perIpMax: 10 };

export type Admission = { ok: true; release: () => void } | { ok: false; reason: string };

export class AiGate {
  private running = 0;
  private readonly rooms = new Set<string>();
  private hour: number[] = [];
  private readonly ips = new Map<string, number[]>();

  constructor(
    readonly limits: GateLimits = DEFAULT_GATE,
    private readonly now: () => number = Date.now,
  ) {}

  admit(ip: string, room: string): Admission {
    const t = this.now();
    this.hour = this.hour.filter((x) => t - x < 3_600_000);
    const mine = (this.ips.get(ip) ?? []).filter((x) => t - x < this.limits.perIpWindowMs);
    if (this.rooms.has(room)) return { ok: false, reason: '이 도시에서 이미 AI가 작업 중입니다' };
    if (this.running >= this.limits.maxConcurrent) return { ok: false, reason: 'AI가 바쁩니다. 잠시 후 다시 시도하세요' };
    if (this.hour.length >= this.limits.perHour) return { ok: false, reason: '서버의 시간당 AI 사용 한도에 도달했습니다' };
    if (mine.length >= this.limits.perIpMax) return { ok: false, reason: '요청이 너무 잦습니다. 잠시 후 다시 시도하세요' };
    this.hour.push(t);
    mine.push(t);
    this.ips.set(ip, mine);
    this.running++;
    this.rooms.add(room);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.running--;
        this.rooms.delete(room);
      },
    };
  }
}
