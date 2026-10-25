// Applies an AI proposal (ADR 0010 §9): every road is its own command, sent in order and awaited, so one
// road that lost a race (its split target changed) cannot take independent roads or buildings down with
// it. After the roads, what remains (designs, lots, buildings) is dry-run again on the updated doc and
// sent as one batch. Lives outside React so it finishes even if the panel is closed meanwhile; one apply
// per proposal at a time (the in-flight promise is kept in the store).

import type { Command } from '@smartcity/shared';
import type { Dispatch } from './dispatch';
import { applicableBatch, dryRunProposal, isRoadBatch, type ProposalItem } from './proposal';
import type { ClientStore } from './store';

const RESULT_TIMEOUT_MS = 20_000;
export const NO_ANSWER = '서버 응답이 없습니다';
export const LOST = '연결이 바뀌었습니다';

/**
 * Server answer for `ref`: 'ok', the error text, NO_ANSWER when it did not come in time, or LOST when the
 * connection session ended first (both unknown outcomes). The listener is always removed by then.
 */
export function waitForResult(store: ClientStore, ref: number, timeoutMs: number | null = RESULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    const known = store.getState().results[ref];
    if (known !== undefined) return resolve(known);
    const session = store.getState().session;
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            unsub();
            resolve(NO_ANSWER);
          }, timeoutMs);
    const unsub = store.subscribe(() => {
      const st = store.getState();
      const r = st.results[ref] ?? (st.session !== session ? LOST : undefined);
      if (r === undefined) return;
      if (timer) clearTimeout(timer);
      unsub();
      resolve(r);
    });
  });
}

export interface ProposalApplyResult {
  /** Items that were applied / that failed (roads count one each; the rest counts per leaf item). */
  applied: number;
  failed: number;
  /** Commands sent whose answer has not come yet: they are still tracked and recorded when they arrive. */
  pending: number;
  /** Sent, but the connection changed before the answer: unknown (checked after the next sync). */
  lost: number;
  /** First error, for the panel (null when nothing failed). */
  error: string | null;
}

interface Acc {
  done: Command[];
  applied: number;
  failed: number;
  pending: number;
  lost: number;
  error: string | null;
}

export function applyProposal(
  store: ClientStore,
  dispatch: Dispatch,
  items: readonly ProposalItem[],
  invalid: Record<number, string>,
  summary: string,
  reqId: number,
  timeoutMs: number | null = RESULT_TIMEOUT_MS,
): Promise<ProposalApplyResult> {
  const running = store.aiApplyJobs.get(reqId);
  if (running) return running as Promise<ProposalApplyResult>;
  // Commands of this proposal are still unanswered: sending them again could apply a road twice.
  const waiting = store.getState().aiPending[reqId] ?? 0;
  if (waiting > 0) return Promise.resolve({ applied: 0, failed: 0, pending: waiting, lost: 0, error: null });
  store.set({ aiApplying: reqId });
  const job = run(store, dispatch, items, invalid, summary, reqId, timeoutMs).finally(() => {
    store.aiApplyJobs.delete(reqId);
    if (store.getState().aiApplying === reqId) store.set({ aiApplying: null });
  });
  store.aiApplyJobs.set(reqId, job);
  return job;
}

async function run(store: ClientStore, dispatch: Dispatch, items: readonly ProposalItem[], invalid: Record<number, string>, summary: string, reqId: number, timeoutMs: number | null): Promise<ProposalApplyResult> {
  const acc: Acc = { done: [], applied: 0, failed: 0, pending: 0, lost: 0, error: null };
  await steps(store, dispatch, items, invalid, summary, reqId, timeoutMs, acc);
  // The single exit: whatever succeeded is recorded, whichever way the steps ended.
  if (acc.done.length > 0) {
    const extra = acc.failed > 0 ? ` (${acc.failed}개 항목은 적용하지 못했습니다)` : '';
    store.recordAiApplied({ type: 'batch', commands: acc.done }, summary, reqId, `AI 제안을 적용했습니다${extra} (되돌리려면 철거 도구로 지우세요)`);
  }
  if (acc.pending > 0) store.toast(`서버 응답을 기다리는 항목 ${acc.pending}개: 결과 확인 중입니다`, 'info');
  return { applied: acc.applied, failed: acc.failed, pending: acc.pending, lost: acc.lost, error: acc.error };
}

async function steps(store: ClientStore, dispatch: Dispatch, items: readonly ProposalItem[], invalid: Record<number, string>, summary: string, reqId: number, timeoutMs: number | null, acc: Acc): Promise<void> {
  const session = store.getState().session;
  const same = (): boolean => store.getState().session === session;
  const fail = (e: string, n = 1): void => {
    acc.failed += n;
    acc.error ??= e;
  };
  /** Send one command and fold its answer into `acc`. false = could not send (stop). */
  const send = async (cmd: Command, count: number): Promise<boolean> => {
    // The connection changed since this apply began: send nothing more (the user can apply again later).
    if (!same()) return false;
    const ref = dispatch(cmd);
    if (ref === null) {
      fail('아직 연결되지 않았습니다', count);
      return false;
    }
    store.trackAiPending(ref, cmd, reqId, summary);
    const outcome = await waitForResult(store, ref, timeoutMs);
    if (outcome === NO_ANSWER) {
      // Unknown, not failed: stays tracked (apply is blocked) and is recorded if it did apply.
      acc.pending += count;
      store.markAiLate(ref);
    } else if (outcome === LOST) {
      // The session ended: the store released it as unknown. Nothing more is sent.
      acc.lost += count;
      return false;
    } else {
      if (outcome === 'ok') {
        acc.applied += count;
        acc.done.push(cmd);
      } else {
        fail(outcome, count);
      }
    }
    return true;
  };

  for (const it of items) {
    if (!isRoadBatch(it.cmd)) continue;
    if (it.index in invalid) {
      fail(invalid[it.index]!);
      continue;
    }
    if (!(await send(it.cmd, 1))) return;
  }

  // The rest, judged against the doc as it is now (roads applied, other users' edits included).
  const rest = items.filter((it) => !isRoadBatch(it.cmd));
  const stillInvalid = dryRunProposal(store.getState().doc, rest);
  for (const e of Object.values(stillInvalid)) fail(e);
  const batch = applicableBatch(rest, stillInvalid);
  if (batch && batch.type === 'batch') await send(batch, batch.commands.length);
}
