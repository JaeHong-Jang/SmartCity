// Keeps `store.proposalStatus` in step with the shown AI proposal and the live doc: re-runs the
// dry run whenever either changes (collaborators editing under the proposal turn items orange).

import type { ClientStore } from './store';
import { dryRunProposal, proposalItems, type ProposalStatus } from './proposal';

export function watchProposal(store: ClientStore): () => void {
  let lastProposal = store.getState().ai.proposal;
  let lastVersion = store.getState().docVersion;
  return store.subscribe(() => {
    const s = store.getState();
    const p = s.ai.proposal;
    if (p === lastProposal && s.docVersion === lastVersion) return;
    lastProposal = p;
    lastVersion = s.docVersion;
    if (!p) {
      if (s.proposalStatus) store.set({ proposalStatus: null });
      return;
    }
    const items = proposalItems(p.commands);
    const invalid = dryRunProposal(s.doc, items);
    const prev = s.proposalStatus;
    const same = prev && prev.reqId === p.reqId && Object.keys(invalid).length === Object.keys(prev.invalid).length && Object.keys(invalid).every((k) => prev.invalid[Number(k)] !== undefined);
    if (!same) store.set({ proposalStatus: { reqId: p.reqId, invalid, total: items.length } satisfies ProposalStatus });
  });
}
