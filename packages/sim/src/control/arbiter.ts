// A0 arbitration (ADR 0015 §2): a pure function of one stage queue. Order independent: proposals are put
// in one total order — priority class (life > spread > efficiency), conflict key, rank, agent, id — so the
// same set in any input order gives the same result. In that order: expired → rejected; reacting to an event
// the city does not know of → rejected (observation boundary); past the stage cap → rejected; the first
// proposal of each key is accepted and every later one of that key is rejected (conflict).

import { PRIORITY, type Proposal } from './types.js';

/**
 * Proposals one stage may consider per tick, summed over every submit of that stage in the tick (control.ts
 * keeps the budget). Past it a proposal is rejected `처리 상한 초과`; what follows is the stage's rule
 * (scenario/controlAdapter.ts): observe → deferred to the next tick, dispatch → retried next tick, signal →
 * proposed again next tick, route → dropped (the vehicles keep their routes).
 */
export const STAGE_CAP = 4096;

export interface Arbitration {
  /** In the total order (priority, key, rank, agent, id). */
  accepted: Proposal[];
  rejected: { proposal: Proposal; reason: string }[];
  /** Proposals that used the budget (past the expiry and boundary checks, within the cap). */
  considered: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function rankCmp(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** The arbitration order: smaller first. */
export const proposalOrder = (a: Proposal, b: Proposal): number => PRIORITY[a.priority] - PRIORITY[b.priority] || cmp(a.key, b.key) || rankCmp(a.rank, b.rank) || cmp(a.agent, b.agent) || cmp(a.id, b.id);

export const REJECT_EXPIRED = '유효기간 지남';
export const REJECT_UNOBSERVED = '관측되지 않은 사건 (관측 경계)';
export const REJECT_CAP = '처리 상한 초과';
export const REJECT_CONFLICT = '같은 대상에 우선 제안 채택';

/**
 * Arbitrate one queue at `tick`. `known(eventId)` = the city knows of the event (ObservationView). `cap` =
 * how many proposals (after the expiry and boundary checks) are considered, in order.
 */
export function arbitrate(queue: readonly Proposal[], tick: number, known: (eventId: string) => boolean, cap = STAGE_CAP): Arbitration {
  const sorted = [...queue].sort(proposalOrder);
  const out: Arbitration = { accepted: [], rejected: [], considered: 0 };
  const taken = new Set<string>();
  let considered = 0;
  for (const p of sorted) {
    if (p.expiresTick < tick) out.rejected.push({ proposal: p, reason: REJECT_EXPIRED });
    else if (p.eventId !== null && !known(p.eventId)) out.rejected.push({ proposal: p, reason: REJECT_UNOBSERVED });
    else if (considered >= cap) out.rejected.push({ proposal: p, reason: REJECT_CAP });
    else {
      considered++;
      if (taken.has(p.key)) out.rejected.push({ proposal: p, reason: REJECT_CONFLICT });
      else {
        taken.add(p.key);
        out.accepted.push(p);
      }
    }
  }
  out.considered = considered;
  return out;
}
