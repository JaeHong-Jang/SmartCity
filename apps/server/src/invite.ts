// Invite password for a public server (SC_INVITE_CODE): a `hello` must carry it before the client may
// join a room. Constant-time comparison; wrong guesses are limited per IP (a guess while limited is not
// even compared, so a brute force gains nothing by continuing).

import { createHash, timingSafeEqual } from 'node:crypto';

export const AUTH_NEEDED = '초대 비밀번호가 필요합니다';
export const AUTH_WRONG = '초대 비밀번호가 틀렸습니다';
export const AUTH_LIMITED = '비밀번호를 너무 많이 틀렸습니다. 잠시 후 다시 시도하세요';

export interface InviteLimits {
  /** Wrong passwords an IP may send within the window before it is refused without checking. */
  maxFailures: number;
  windowMs: number;
}

export const DEFAULT_INVITE_LIMITS: InviteLimits = { maxFailures: 10, windowMs: 10 * 60_000 };

/** Above this many tracked IPs, expired entries are swept on the next failure. */
const SWEEP_AT = 10_000;

/** Exit status of a server refused at startup for its configuration (EX_CONFIG; systemd does not restart it). */
export const EXIT_CONFIG = 78;

/**
 * SC_REQUIRE_INVITE=1 (set by the deployment) makes a missing or blank SC_INVITE_CODE fatal at startup,
 * so a public server never comes up without its password (Sol deploy review #1). Unset = optional, as in dev.
 */
export function inviteConfigError(env: NodeJS.ProcessEnv): string | null {
  if (env.SC_REQUIRE_INVITE !== '1' || env.SC_INVITE_CODE?.trim()) return null;
  return 'SC_REQUIRE_INVITE=1 but SC_INVITE_CODE is empty: refusing to start without an invite password';
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export class InviteGate {
  private readonly code: Buffer;
  private readonly failures = new Map<string, number[]>();

  constructor(
    code: string,
    readonly limits: InviteLimits = DEFAULT_INVITE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.code = digest(code);
  }

  /** null = admitted; otherwise the refusal text (sent with code 'auth'). */
  check(ip: string, invite: string | undefined): string | null {
    const t = this.now();
    const recent = (this.failures.get(ip) ?? []).filter((x) => t - x < this.limits.windowMs);
    if (recent.length >= this.limits.maxFailures) return AUTH_LIMITED;
    // Equal-length digests: the comparison time depends on neither the password nor its length.
    if (invite !== undefined && timingSafeEqual(digest(invite), this.code)) return null;
    if (invite === undefined) return AUTH_NEEDED; // a first visit without a password is not a guess
    recent.push(t);
    this.failures.set(ip, recent);
    if (this.failures.size > SWEEP_AT) {
      for (const [k, v] of this.failures) if (!v.some((x) => t - x < this.limits.windowMs)) this.failures.delete(k);
    }
    return AUTH_WRONG;
  }
}
