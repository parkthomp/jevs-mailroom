import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORIES, type Destination } from '../shared/protocol.js';
import { DESK, PICKUP, deliveryTimeline, pathLength, toDesk, toDestination } from '../shared/walk.js';

const destinations: Destination[] = [...CATEGORIES, 'trash'];

test('Jev carries a note straight from the tray to its destination, then walks home', () => {
  for (const destination of destinations) {
    const outbound = toDestination(destination), home = toDesk(destination);
    assert.deepEqual(outbound[0], PICKUP);
    assert.ok(!outbound.some(([x, y]) => x === DESK[0] && y === DESK[1]), `${destination} detours past the desk`);
    assert.deepEqual(home[0], outbound.at(-1));
    assert.deepEqual(home.at(-1), DESK);
  }
});

test('deliveries keep one pace, so shorter trips finish sooner and the longest drops at the duration', () => {
  const timelines = destinations.map(destination => ({ destination, ...deliveryTimeline(destination, 1000, 6500) }));
  const pace = (from: number, to: number, distance: number) => distance / (to - from);
  const reference = pace(timelines[0].pickupAt, timelines[0].arriveAt, pathLength(toDestination(timelines[0].destination)));
  for (const t of timelines) {
    assert.ok(t.startedAt < t.pickupAt && t.pickupAt < t.arriveAt && t.arriveAt < t.endsAt && t.endsAt < t.homeAt);
    assert.ok(t.endsAt <= 1000 + 6500 + 1e-6);
    assert.ok(Math.abs(pace(t.pickupAt, t.arriveAt, pathLength(toDestination(t.destination))) - reference) < 1e-9);
    assert.ok(Math.abs(pace(t.endsAt, t.homeAt, pathLength(toDesk(t.destination))) - reference) < 1e-9);
  }
  assert.equal(Math.max(...timelines.map(t => t.endsAt)), 1000 + 6500);
  const byDestination = Object.fromEntries(timelines.map(t => [t.destination, t.endsAt]));
  assert.ok(byDestination.compliments < byDestination.misc);
});
