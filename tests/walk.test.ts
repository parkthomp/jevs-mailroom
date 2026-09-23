import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORIES, type Destination, type Point } from '../shared/protocol.js';
import { DESK, dropPoint, jevAt, LOUNGE, pathLength, route, TRAY } from '../shared/walk.js';

const destinations: Destination[] = [...CATEGORIES, 'trash'];
const spots: Point[] = [DESK, TRAY, ...destinations.map(dropPoint), ...LOUNGE, [212, 80], [110, 70], [186, 108]];
// The desk, trolley, and trash can in feet coordinates, as in shared/walk.ts.
const furniture = [[128, 192, 64, 86], [16, 73, 96, 125], [266, 298, 94, 123]];
const throughFurniture = (a: Point, b: Point) => furniture.some(([left, right, top, bottom]) =>
  Math.max(a[0], b[0]) >= left && Math.min(a[0], b[0]) <= right && Math.max(a[1], b[1]) >= top && Math.min(a[1], b[1]) <= bottom);

test('routes between any two spots go around the furniture, with right-angled steps', () => {
  for (const from of spots) for (const to of spots) {
    const path = route(from, to);
    assert.deepEqual(path[0], from);
    assert.deepEqual(path.at(-1), to);
    for (let i = 1; i < path.length; i++) {
      assert.ok(path[i][0] === path[i - 1][0] || path[i][1] === path[i - 1][1], `diagonal step in ${JSON.stringify(path)}`);
      assert.ok(!throughFurniture(path[i - 1], path[i]), `${JSON.stringify(path)} cuts through furniture`);
    }
  }
});

test('notes go straight from the tray to their destination', () => {
  for (const destination of destinations) {
    const path = route(TRAY, dropPoint(destination));
    assert.ok(!path.some(point => point[0] === DESK[0] && point[1] === DESK[1]));
    assert.ok(pathLength(path) <= 230);
  }
});

test('jevAt follows a leg over time and rests where the plan ends', () => {
  const legs = [{ kind: 'run' as const, path: [[0, 0], [100, 0]] as Point[], from: 1000, to: 2000 }, { kind: 'rest' as const, path: [[100, 0]] as Point[], from: 2000, to: 3000 }];
  assert.deepEqual(jevAt(legs, 500).point, [0, 0]);
  assert.deepEqual(jevAt(legs, 1500).point, [50, 0]);
  assert.equal(jevAt(legs, 2500).leg?.kind, 'rest');
  assert.deepEqual(jevAt(legs, 9000), { point: [100, 0] });
  assert.deepEqual(jevAt([], 0), { point: DESK });
});
