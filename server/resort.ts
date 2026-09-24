import type { State } from './store.js';

// 2: new bins, and harmless spam is published. 3: Jev can pick trash as well as a bin, so mail
// filed under revision 2 that should have been thrown away gets a second look.
const SORTING_REVISION = 3;
// Run only after this version of the worker owns coordinator leadership. In particular, the web
// pre-deploy migration must not hand the archive back to a still-running worker with old rules.
export function queueCategoryResort(state: State): number {
  const revision = state.sortingRevision ?? 0;
  if (revision >= SORTING_REVISION) return 0;
  let queued = 0;
  for (const message of state.messages) {
    // Mail already thrown away under revision 2's screening stays in the trash. Older trash is
    // re-checked too: harmless spam can now be published, but only after fresh screening.
    if (revision >= 2 && message.status === 'discarded') continue;
    // IDs, receipt hashes, sender names, original text and timestamps remain intact.
    message.status = 'pending_review';
    message.decision = undefined;
    message.reason = undefined;
    message.attempts = 0;
    message.nextAttemptAt = 0;
    message.claimedAt = undefined;
    queued++;
  }
  state.active = null;
  state.jev = [];
  state.sortingRevision = SORTING_REVISION;
  state.version++;
  return queued;
}
