import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Destination, JevLeg } from '../shared/protocol.js';
import { DESK, dropPoint, jevAt, samePoint, TRAY } from '../shared/walk.js';
import { planJev } from '../server/jev.js';
import type { State, StoredMessage } from '../server/store.js';

const PAUSE = 2500;
const room = (): State => ({ version: 1, messages: [], active: null, jev: [], budget: { date: '', calls: 0 } });
const note = (id: string, createdAt: number, destination?: Destination): StoredMessage => ({
  id, text: 'x', submissionId: id, tokenHash: '00', createdAt, attempts: 1, nextAttemptAt: 0,
  status: destination ? (destination === 'trash' ? 'ready_to_discard' : 'ready') : 'classifying',
  ...(destination ? { decision: { destination, reaction: 'Noted!' } } : {}),
});
const sort = (message: StoredMessage, destination: Destination) => {
  message.status = destination === 'trash' ? 'ready_to_discard' : 'ready';
  message.decision = { destination, reaction: 'Noted!' };
};
// Every leg starts where and when the one before it ended, so Jev never teleports.
function assertContinuous(legs: JevLeg[]) {
  for (let i = 1; i < legs.length; i++) {
    assert.equal(legs[i].from, legs[i - 1].to, `leg ${i} starts at a different time`);
    assert.ok(samePoint(legs[i].path[0], legs[i - 1].path.at(-1)!), `leg ${i} starts somewhere else`);
  }
}
const visits = (leg: JevLeg, point: readonly [number, number]) => leg.path.some(step => samePoint(step, point));

test('Jev runs for a new note the moment it arrives, before it is sorted', () => {
  const state = room();
  state.messages.push(note('a', 1000));
  assert.ok(planJev(state, 1000, PAUSE));
  const [run, wait] = state.jev!;
  assert.equal(run.kind, 'run');
  assert.deepEqual(run.path[0], DESK);
  assert.deepEqual(run.path.at(-1), TRAY);
  assert.ok(run.to! - run.from < 700, 'the dash to the tray should be quick');
  assert.deepEqual({ kind: wait.kind, from: wait.from, to: wait.to }, { kind: 'wait', from: run.to, to: null });
  assert.equal(planJev(state, 1100, PAUSE), false);
});

test('a sorted note is sprinted straight from the tray to its bin, filed, and followed by a short pause', () => {
  const state = room();
  const message = note('a', 1000);
  state.messages.push(message);
  planJev(state, 1000, PAUSE);
  sort(message, 'complaints');
  planJev(state, 1200, PAUSE); // Still running over: he sets off the moment he reaches the tray.
  const legs = state.jev!;
  assertContinuous(legs);
  const carry = legs.find(leg => leg.carrying === 'a' && leg.kind === 'run')!;
  assert.deepEqual(carry.path[0], TRAY);
  assert.deepEqual(carry.path.at(-1), dropPoint('complaints'));
  assert.ok(!visits(carry, DESK), 'no detour past the desk');
  assert.equal(carry.say, 'FILING THIS COMPLAINT!');
  assert.ok(carry.to! - carry.from < 1500, 'the sprint to the bin should be quick');
  const rest = legs.at(-1)!;
  assert.equal(rest.kind, 'rest');
  assert.equal(rest.to! - rest.from, PAUSE);
  assert.equal(rest.say, undefined, 'no bubble during the pause');
  assert.equal(message.status, 'delivering');
  assert.deepEqual({ endsAt: state.active!.endsAt, doneAt: state.active!.doneAt }, { endsAt: rest.from, doneAt: rest.to });

  planJev(state, state.active!.endsAt, PAUSE);
  assert.equal(message.status, 'delivered');
  assert.equal(message.deliveredAt, rest.from);
  assert.ok(state.active, 'still pausing at the bin');
  planJev(state, rest.to!, PAUSE);
  assert.equal(state.active, null);
  const home = state.jev!.at(-1)!;
  assert.equal(home.kind, 'walk');
  assert.deepEqual(home.path[0], dropPoint('complaints'));
  assert.deepEqual(home.path.at(-1), DESK);
  assertContinuous(state.jev!);
});

test('a note waiting after the pause gets a dash from the bin, not from the desk', () => {
  const state = room();
  state.messages.push(note('a', 0, 'ideas'), note('b', 0, 'trash'));
  planJev(state, 0, PAUSE);
  const done = state.active!.doneAt;
  planJev(state, done, PAUSE);
  assertContinuous(state.jev!);
  const dash = state.jev!.find(leg => leg.kind === 'run' && leg.from === done)!;
  assert.deepEqual(dash.path[0], dropPoint('ideas'));
  assert.deepEqual(dash.path.at(-1), TRAY);
  assert.equal(state.active!.id, 'b');
  assert.equal(state.jev!.find(leg => leg.carrying === 'b' && leg.kind === 'run')!.say, 'ANOTHER ONE FOR THE BIN!');
});

test('a new note interrupts the stroll home, and Jev runs from wherever he is', () => {
  const state = room();
  state.messages.push(note('a', 0, 'misc'));
  planJev(state, 0, PAUSE);
  const done = state.active!.doneAt;
  planJev(state, done, PAUSE);
  const stroll = state.jev!.at(-1)!;
  assert.equal(stroll.kind, 'walk');
  const now = (stroll.from + stroll.to!) / 2, midway = jevAt(state.jev!, now).point;
  state.messages.push(note('b', now));
  planJev(state, now, PAUSE);
  assertContinuous(state.jev!);
  const dash = state.jev!.find(leg => leg.kind === 'run' && leg.from === now)!;
  assert.deepEqual(dash.path[0], midway);
  assert.ok(!samePoint(midway, DESK) && !samePoint(midway, dropPoint('misc')));
  assert.equal(state.jev!.at(-1)!.kind, 'wait');
});

test('when a note fails to sort, Jev stops waiting and strolls home', () => {
  const state = room();
  const message = note('a', 0);
  state.messages.push(message);
  planJev(state, 0, PAUSE);
  message.status = 'failed';
  planJev(state, 2000, PAUSE);
  assertContinuous(state.jev!);
  const stroll = state.jev!.at(-1)!;
  assert.equal(stroll.kind, 'walk');
  assert.deepEqual(stroll.path.at(-1), DESK);
});
