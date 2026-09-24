import type { State } from './store.js';

const SORTING_REVISION = 2;
// Run only after this version of the worker owns coordinator leadership. In particular, the web
// pre-deploy migration must not hand the archive back to a still-running worker with old rules.
export function queueCategoryResort(state: State): number {
  if ((state.sortingRevision ?? 0) >= SORTING_REVISION) return 0;
  for (const message of state.messages) {
    // Include old trash: harmless spam can now be published, but only after fresh screening.
    // IDs, receipt hashes, sender names, original text and timestamps remain intact.
    message.status = 'pending_review';
    message.decision = undefined;
    message.reason = undefined;
    message.attempts = 0;
    message.nextAttemptAt = 0;
    message.claimedAt = undefined;
  }
  state.active = null;
  state.jev = [];
  state.sortingRevision = SORTING_REVISION;
  state.version++;
  return state.messages.length;
}
