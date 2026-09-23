import { CATEGORIES, type Category, type Facing, type Point } from '../shared/protocol';
import { BIN_X, walkable } from '../shared/walk';

// Your character walks a little slower than Jev strolls when he's in a hurry, and faster than his amble.
export const SPEED = 72; // Room pixels per second.

// The things in the room you can walk up to and use.
export type Spot = { kind: 'bin'; category: Category } | { kind: 'incoming' } | { kind: 'trash' };
interface Box { left: number; right: number; top: number; bottom: number }
interface Place {
  spot: Spot;
  zone: Box; // Where your feet need to be to use it.
  hit: Box; // What you click or tap to walk over to it.
  approach: Point; // Where you walk to when you click it.
}
const box = (left: number, right: number, top: number, bottom: number): Box => ({ left, right, top, bottom });
const inside = ([x, y]: Point, b: Box) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
export const PLACES: Place[] = [
  ...CATEGORIES.map(category => ({ spot: { kind: 'bin' as const, category }, zone: box(BIN_X[category] - 20, BIN_X[category] + 20, 0, 68),
    hit: box(BIN_X[category] - 20, BIN_X[category] + 20, 12, 48), approach: [BIN_X[category], 54] as Point })),
  { spot: { kind: 'incoming' }, zone: box(6, 88, 84, 140), hit: box(18, 72, 86, 124), approach: [45, 132] },
  { spot: { kind: 'trash' }, zone: box(254, 312, 84, 140), hit: box(270, 294, 90, 128), approach: [282, 132] },
];
const distance = (a: Point, b: Point) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
export const sameSpot = (a: Spot | null, b: Spot | null) => a?.kind === b?.kind && (a?.kind !== 'bin' || a.category === (b as typeof a).category);

// The closest thing you're standing close enough to use.
export function nearby(feet: Point): Place | null {
  return PLACES.filter(place => inside(feet, place.zone)).sort((a, b) => distance(feet, a.approach) - distance(feet, b.approach))[0] ?? null;
}
// What's under a click, in room pixels.
export function clicked(point: Point): Place | null {
  return PLACES.find(place => inside(point, place.hit)) ?? null;
}
export const canUse = (feet: Point, place: Place) => inside(feet, place.zone);

// Held arrow keys move you, sliding along furniture rather than stopping dead against it.
export function step(from: Point, dx: number, dy: number, distance: number): Point {
  const length = Math.hypot(dx, dy);
  if (!length) return from;
  let [x, y] = from;
  if (walkable([x + dx / length * distance, y])) x += dx / length * distance;
  if (walkable([x, y + dy / length * distance])) y += dy / length * distance;
  return [x, y];
}
// One right-angled stretch toward a waypoint, across then along. Null when furniture is in the way.
export function toward(from: Point, target: Point, distance: number): Point | null {
  const [x, y] = from, horizontal = Math.abs(target[0] - x) > .01;
  const move = (value: number, goal: number) => value + Math.max(-distance, Math.min(distance, goal - value));
  const next: Point = horizontal ? [move(x, target[0]), y] : [x, move(y, target[1])];
  return walkable(next) ? next : null;
}
export function facingFor(dx: number, dy: number, current: Facing): Facing {
  if (dx) return dx > 0 ? 'right' : 'left';
  if (dy) return dy > 0 ? 'down' : 'up';
  return current;
}
