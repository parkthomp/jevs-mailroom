import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Destination, JevLeg } from '../shared/protocol.js';
import { DESK, dropPoint, jevAt, samePoint, TRAY } from '../shared/walk.js';
import { CHAT_LINES, CHAT_MS, chatWithJev, planJev } from '../server/jev.js';
import type { State, StoredMessage } from '../server/store.js';

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
  assert.ok(planJev(state, 1000));
  const [run, wait] = state.jev!;
  assert.equal(run.kind, 'run');
  assert.deepEqual(run.path[0], DESK);
  assert.deepEqual(run.path.at(-1), TRAY);
  assert.ok(run.to! - run.from < 700, 'the dash to the tray should be quick');
  assert.deepEqual({ kind: wait.kind, from: wait.from, to: wait.to }, { kind: 'wait', from: run.to, to: null });
  assert.equal(planJev(state, 1100), false);
});

test('a sorted note is sprinted straight from the tray to its bin and filed as it lands', () => {
  const state = room();
  const message = note('a', 1000);
  state.messages.push(message);
  planJev(state, 1000);
  sort(message, 'feedback');
  planJev(state, 1200); // Still running over: he sets off the moment he reaches the tray.
  const legs = state.jev!;
  assertContinuous(legs);
  const carry = legs.find(leg => leg.carrying === 'a' && leg.kind === 'run')!;
  assert.deepEqual(carry.path[0], TRAY);
  assert.deepEqual(carry.path.at(-1), dropPoint('feedback'));
  assert.ok(!visits(carry, DESK), 'no detour past the desk');
  assert.equal(carry.say, 'FILING THIS FEEDBACK!');
  assert.ok(carry.to! - carry.from < 1500, 'the sprint to the bin should be quick');
  const drop = legs.at(-1)!;
  assert.equal(drop.kind, 'drop', 'no pause after the drop');
  assert.equal(message.status, 'delivering');
  assert.equal(state.active!.endsAt, drop.to);

  planJev(state, drop.to!);
  assert.equal(message.status, 'delivered');
  assert.equal(message.deliveredAt, drop.to);
  assert.equal(state.active, null);
  const stroll = state.jev!.find(leg => leg.from === drop.to)!;
  assert.equal(stroll.kind, 'walk', 'straight off for a stroll');
  assert.deepEqual(stroll.path[0], dropPoint('feedback'));
  assertContinuous(state.jev!);
});

test('with nothing to sort, Jev mills about the room instead of standing still', () => {
  const state = room();
  let now = 0;
  const spots: string[] = [];
  for (let i = 0; i < 8; i++) {
    planJev(state, now);
    assertContinuous(state.jev!);
    const [stroll, linger] = state.jev!.slice(-2);
    assert.equal(stroll.kind, 'walk');
    assert.equal(linger.kind, 'rest');
    assert.ok(linger.to! - linger.from <= 4000, 'he never lingers long');
    assert.ok(!samePoint(stroll.path[0], stroll.path.at(-1)!));
    spots.push(JSON.stringify(linger.path[0]));
    planJev(state, (linger.from + linger.to!) / 2);
    assert.deepEqual(state.jev!.at(-1), linger, 'no replanning mid-linger');
    now = linger.to!;
  }
  assert.ok(new Set(spots).size >= 3, 'he visits different parts of the room');
});

test('a note already waiting gets a dash from the bin, not from the desk', () => {
  const state = room();
  state.messages.push(note('a', 0, 'big_ideas'), note('b', 0, 'trash'));
  planJev(state, 0);
  const done = state.active!.endsAt;
  planJev(state, done);
  assertContinuous(state.jev!);
  const dash = state.jev!.find(leg => leg.kind === 'run' && leg.from === done)!;
  assert.deepEqual(dash.path[0], dropPoint('big_ideas'));
  assert.deepEqual(dash.path.at(-1), TRAY);
  assert.equal(state.active!.id, 'b');
  assert.equal(state.jev!.find(leg => leg.carrying === 'b' && leg.kind === 'run')!.say, 'ANOTHER ONE FOR THE BIN!');
});

test('a new note interrupts a stroll, and Jev runs from wherever he is', () => {
  const state = room();
  state.messages.push(note('a', 0, 'feedback'));
  planJev(state, 0);
  const done = state.active!.endsAt;
  planJev(state, done);
  const stroll = state.jev!.find(leg => leg.kind === 'walk' && leg.from === done)!;
  assert.equal(stroll.kind, 'walk');
  const now = (stroll.from + stroll.to!) / 2, midway = jevAt(state.jev!, now).point;
  state.messages.push(note('b', now));
  planJev(state, now);
  assertContinuous(state.jev!);
  const dash = state.jev!.find(leg => leg.kind === 'run' && leg.from === now)!;
  assert.deepEqual(dash.path[0], midway);
  assert.ok(!samePoint(midway, DESK) && !samePoint(midway, dropPoint('feedback')));
  assert.equal(state.jev!.at(-1)!.kind, 'wait');
});

test('when a note fails to sort, Jev stops waiting and strolls off', () => {
  const state = room();
  const message = note('a', 0);
  state.messages.push(message);
  planJev(state, 0);
  message.status = 'failed';
  planJev(state, 2000);
  assertContinuous(state.jev!);
  const stroll = state.jev!.find(leg => leg.from === 2000)!;
  assert.equal(stroll.kind, 'walk');
  assert.deepEqual(stroll.path[0], TRAY);
});

test('a visitor next to Jev gets him to stop, turn to them, and chat for five seconds', () => {
  const state = room();
  planJev(state, 0);
  const [stroll] = state.jev!;
  const now = (stroll.from + stroll.to!) / 2, [x, y] = jevAt(state.jev!, now).point;
  assert.equal(chatWithJev(state, [x + 200, y], now), false, 'too far away to hear');
  assert.ok(chatWithJev(state, [x + 12, y], now, () => 0));
  assertContinuous(state.jev!);
  const chat = state.jev!.at(-1)!;
  assert.equal(chat.kind, 'chat');
  assert.ok(chat.from > now && chat.from - now <= 300, 'he finishes his step before stopping');
  assert.equal(chat.to! - chat.from, CHAT_MS);
  const [dx, dy] = [x + 12 - chat.path[0][0], y - chat.path[0][1]];
  assert.equal(chat.facing, Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'down' : 'up', 'he turns to face them');
  assert.equal(chat.say, CHAT_LINES[0]);
  assert.equal(chatWithJev(state, [x + 12, y], chat.from + 1), false, 'one chat at a time');
  planJev(state, chat.from + 1000);
  assert.deepEqual(state.jev!.at(-1), chat, 'no wandering off mid-sentence');
  // Once he's said his piece he strolls on, from the spot where he stopped.
  planJev(state, chat.to!);
  assertContinuous(state.jev!);
  assert.equal(state.jev!.find(leg => leg.from === chat.to)?.kind, 'walk');
  // And he doesn't say the same thing twice in a row.
  const [nx, ny] = jevAt(state.jev!, chat.to! + 100).point;
  assert.ok(chatWithJev(state, [nx, ny + 12], chat.to! + 100, () => 0));
  assert.equal(state.jev!.at(-1)!.say, CHAT_LINES[1]);
  assert.equal(state.jev!.at(-1)!.facing, 'down');
});

test('Jev is too busy to chat with mail to sort, and new mail cuts a chat short', () => {
  const state = room();
  const message = note('a', 0);
  state.messages.push(message);
  planJev(state, 0);
  const [x, y] = jevAt(state.jev!, 100).point;
  assert.equal(chatWithJev(state, [x, y + 10], 100), false);

  const idle = room();
  planJev(idle, 0);
  const at = jevAt(idle.jev!, 0).point;
  assert.ok(chatWithJev(idle, [at[0], at[1] + 10], 0));
  const chat = idle.jev!.at(-1)!;
  idle.messages.push(note('b', chat.from + 1000));
  planJev(idle, chat.from + 1000);
  assertContinuous(idle.jev!);
  assert.equal(idle.jev!.find(leg => leg.kind === 'chat')!.to, chat.from + 1000, 'he drops the chat to fetch the note');
  assert.equal(idle.jev!.at(-1)!.kind, 'wait');
});
