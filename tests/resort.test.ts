import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueCategoryResort } from '../server/resort.js';
import type { State, StoredMessage } from '../server/store.js';
import { snapshot } from '../server/room.js';

const statuses = ['pending_review', 'classifying', 'ready', 'ready_to_discard', 'delivering', 'discarding', 'delivered', 'discarded', 'failed'] as const;
test('one-time resort queues the whole archive, including trash, and preserves identity and budget', () => {
  const messages: StoredMessage[] = statuses.map((status, i) => ({
    id: String(i), submissionId: `submission-${i}`, tokenHash: `receipt-${i}`, name: 'ADA',
    text: `saved text ${i}`, createdAt: 10, deliveredAt: 20, status,
    decision: { destination: status === 'discarded' ? 'trash' : 'feedback', reaction: 'Old reaction', reason: 'Old screening' },
    reason: 'Old reason', attempts: 5, nextAttemptAt: 999, claimedAt: 10,
  }));
  const state: State = {
    version: 10, messages, budget: { date: '2026-09-23', calls: 42 },
    active: { id: '4', destination: 'feedback', reaction: 'Old reaction', endsAt: 99 },
    jev: [{ kind: 'drop', from: 10, to: 99, path: [[190, 56]], carrying: '4', destination: 'feedback' }],
  };
  const originals = structuredClone(messages);
  assert.equal(queueCategoryResort(state), statuses.length);
  assert.equal(state.active, null);
  assert.deepEqual(state.jev, []);
  assert.deepEqual(state.budget, { date: '2026-09-23', calls: 42 });
  assert.equal(state.version, 11);
  assert.equal(snapshot(state, 0, 'live').recent.length, 0, 'nothing is published before fresh screening');
  messages.forEach((message, i) => {
    for (const key of ['id', 'submissionId', 'tokenHash', 'name', 'text', 'createdAt', 'deliveredAt'] as const) {
      assert.equal(message[key], originals[i][key]);
    }
    assert.equal(message.status, 'pending_review');
    assert.equal(message.attempts, 0);
    assert.equal(message.nextAttemptAt, 0);
    assert.equal(message.decision, undefined);
    assert.equal(message.reason, undefined);
    assert.equal(message.claimedAt, undefined);
  });
  // Persisted progress must survive restarts without resetting finished or held work.
  messages[0].status = 'delivered';
  messages[1].status = 'failed'; messages[1].nextAttemptAt = 12345;
  const restarted = JSON.parse(JSON.stringify(state));
  assert.equal(queueCategoryResort(restarted), 0);
  assert.deepEqual(restarted, JSON.parse(JSON.stringify(state)));
});

test('the trash re-check revisits revision 2 mail in bins and in flight, but leaves thrown-away mail alone', () => {
  const messages: StoredMessage[] = statuses.map((status, i) => ({
    id: String(i), submissionId: `submission-${i}`, tokenHash: `receipt-${i}`, name: 'ADA',
    text: `saved text ${i}`, createdAt: 10, deliveredAt: 20, status,
    decision: { destination: status === 'discarded' ? 'trash' : 'feedback', reaction: 'Old reaction' },
    attempts: 1, nextAttemptAt: 0,
  }));
  const state: State = { version: 3, sortingRevision: 2, messages, active: null, jev: [], budget: { date: '', calls: 0 } };
  const discarded = structuredClone(messages.find(message => message.status === 'discarded'));
  assert.equal(queueCategoryResort(state), statuses.length - 1);
  assert.equal(state.sortingRevision, 3);
  for (const message of messages) {
    if (message.id === discarded?.id) assert.deepEqual(message, discarded);
    else { assert.equal(message.status, 'pending_review'); assert.equal(message.decision, undefined); }
  }
  assert.equal(snapshot(state, 0, 'live').recent.length, 0, 'binned mail is hidden until Jev checks it again');
  assert.equal(queueCategoryResort(state), 0);
});
