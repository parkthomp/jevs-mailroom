import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearby, step, toward } from '../client/player.js';
import { Presence } from '../server/visitors.js';
import { BIN_X, DOOR, walkable } from '../shared/walk.js';

test('visitors stay on the floor and walk around the furniture', () => {
  assert.ok(walkable(DOOR));
  assert.ok(!walkable([100, DOOR[1]]), 'only the doorway opens onto the bottom wall');
  assert.ok(!walkable([100, 40]), 'the bins sit against the wall');
  assert.ok(!walkable([160, 70]), 'Jev’s desk is solid');
  // Walking straight up into the desk stops just below it...
  let at: [number, number] = [160, 120];
  for (let i = 0; i < 100; i++) at = step(at, 0, -1, 1) as [number, number];
  assert.deepEqual(at, [160, 87]);
  // ...and pushing diagonally slides along its edge instead of sticking.
  const slid = step(at, -1, -1, 2);
  assert.ok(slid[0] < 160 && slid[1] === 87);
  assert.equal(toward([160, 120], [160, 60], 100), null, 'a clicked walk stops at furniture');
  assert.deepEqual(toward([100, 120], [100, 60], 100), [100, 60]);
});

test('walking up to a bin, the incoming desk, or the trash offers to use it', () => {
  assert.deepEqual(nearby([BIN_X.ideas, 54])?.spot, { kind: 'bin', category: 'ideas' });
  assert.deepEqual(nearby([45, 132])?.spot, { kind: 'incoming' });
  assert.deepEqual(nearby([282, 132])?.spot, { kind: 'trash' });
  assert.equal(nearby([200, 136]), null, 'nothing to use in the open floor, even with Jev nearby');
});

test('presence shares well-formed moves with approved names only, at a limited rate', () => {
  const presence = new Presence<object>((name, pass) => pass === `ok:${name}`), socket = {}, lurker = {};
  const id = presence.join(socket);
  presence.join(lurker);
  assert.deepEqual(presence.list(), [], 'nobody appears until they move');
  const move = { type: 'move', name: ' ada’s  <b>bot</b>! ', x: 100.4, y: 999, facing: 'left', look: 3, moving: true, pass: "ok:ADA'S BBOTB!" };
  for (const bad of [null, { ...move, pass: 'forged' }, { ...move, pass: undefined }, 'move', { ...move, type: 'chat' }, { ...move, x: Infinity }, { ...move, facing: 'north' }, { ...move, look: 99 }, { ...move, look: 1.5 }, { ...move, moving: 'yes' }, { ...move, name: '<>' }, { ...move, name: 42 }]) {
    assert.equal(presence.move(socket, bad, 0), false);
  }
  assert.equal(presence.dirty, false);
  assert.equal(presence.move(socket, move, 0), true);
  assert.deepEqual(presence.list(), [{ id, name: "ADA'S BBOTB!", x: 100, y: 160, facing: 'left', look: 3, moving: true }]);
  for (let i = 1; i < 20; i++) assert.equal(presence.move(socket, move, 500), true);
  assert.equal(presence.move(socket, move, 900), false, 'more than 20 moves a second are dropped');
  assert.equal(presence.move(socket, move, 1000), true);
  presence.dirty = false;
  presence.leave(socket);
  assert.equal(presence.dirty, true);
  assert.deepEqual(presence.list(), []);
});
