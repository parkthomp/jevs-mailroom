import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearby, step, toward } from '../client/player.js';
import { Presence } from '../server/visitors.js';
import { BIN_X, DESK, DOOR, walkable } from '../shared/walk.js';

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

test('the bins, the desk, and the trash win the prompt over Jev strolling past', () => {
  const bin = nearby([BIN_X.ideas, 54], [BIN_X.ideas, 56]);
  assert.deepEqual(bin?.spot, { kind: 'bin', category: 'ideas' });
  assert.deepEqual(nearby([45, 132], [80, 116])?.spot, { kind: 'incoming' });
  assert.deepEqual(nearby([282, 132], [262, 122])?.spot, { kind: 'trash' });
  assert.deepEqual(nearby([200, 136], [206, 136])?.spot, { kind: 'jev' });
  assert.equal(nearby([200, 136], DESK), null);
});

test('presence shares well-formed moves only, at a limited rate', () => {
  const presence = new Presence<object>(), socket = {}, lurker = {};
  const id = presence.join(socket);
  presence.join(lurker);
  assert.deepEqual(presence.list(), [], 'nobody appears until they move');
  const move = { type: 'move', x: 100.4, y: 999, facing: 'left', look: 3, moving: true };
  for (const bad of [null, 'move', { ...move, type: 'chat' }, { ...move, x: Infinity }, { ...move, facing: 'north' }, { ...move, look: 99 }, { ...move, look: 1.5 }, { ...move, moving: 'yes' }]) {
    assert.equal(presence.move(socket, bad, 0), false);
  }
  assert.equal(presence.dirty, false);
  assert.equal(presence.move(socket, move, 0), true);
  assert.deepEqual(presence.list(), [{ id, x: 100, y: 160, facing: 'left', look: 3, moving: true }]);
  for (let i = 1; i < 20; i++) assert.equal(presence.move(socket, move, 500), true);
  assert.equal(presence.move(socket, move, 900), false, 'more than 20 moves a second are dropped');
  assert.equal(presence.move(socket, move, 1000), true);
  presence.dirty = false;
  presence.leave(socket);
  assert.equal(presence.dirty, true);
  assert.deepEqual(presence.list(), []);
});
