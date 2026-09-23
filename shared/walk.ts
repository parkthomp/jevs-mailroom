import { CATEGORIES, type Category, type Destination } from './protocol.js';

// The room's floor plan in canvas pixels (the room is 320×160). Positions are where Jev's feet land.
// Shared so the server can time each delivery by the distance Jev actually walks.
export type Point = readonly [number, number];
export const BIN_X: Record<Category, number> = { compliments: 82, ideas: 136, complaints: 190, misc: 244 };
export const DESK: Point = [160, 108], PICKUP: Point = [80, 116], TRASH: Point = [262, 122];
const CORRIDOR = 56; // The strip of floor in front of the bins.

export const TO_TRAY: Point[] = [DESK, [PICKUP[0], DESK[1]], PICKUP];
// From the tray straight to where the note goes: up the side aisle to the bins, or across the floor to the can.
export function toDestination(destination: Destination): Point[] {
  if (destination === 'trash') return [PICKUP, [PICKUP[0], TRASH[1]], TRASH];
  return [PICKUP, [PICKUP[0], CORRIDOR], [BIN_X[destination], CORRIDOR]];
}
// Empty-handed back to the desk, around it rather than through it.
export function toDesk(destination: Destination): Point[] {
  if (destination === 'trash') return [TRASH, [TRASH[0], DESK[1]], DESK];
  const x = BIN_X[destination], aisle = x < DESK[0] ? 110 : 212;
  return [[x, CORRIDOR], [aisle, CORRIDOR], [aisle, DESK[1]], DESK];
}
export const pathLength = (path: readonly Point[]) =>
  path.slice(1).reduce((sum, point, i) => sum + Math.abs(point[0] - path[i][0]) + Math.abs(point[1] - path[i][1]), 0);

// Share of the delivery duration spent dropping the envelope; a toss into the can takes longer.
const dropShare = (destination: Destination) => destination === 'trash' ? .115 : .06;
const DESTINATIONS: Destination[] = [...CATEGORIES, 'trash'];

// Jev keeps one steady pace, set so the longest trip from his desk to the drop takes `duration`;
// shorter trips finish sooner. The note is filed at endsAt, and he is back at his desk at homeAt.
export function deliveryTimeline(destination: Destination, startedAt: number, duration: number) {
  const pace = Math.max(...DESTINATIONS.map(item => (pathLength(TO_TRAY) + pathLength(toDestination(item))) / (duration * (1 - dropShare(item)))));
  const pickupAt = startedAt + pathLength(TO_TRAY) / pace;
  const arriveAt = pickupAt + pathLength(toDestination(destination)) / pace;
  const endsAt = arriveAt + duration * dropShare(destination);
  return { startedAt, pickupAt, arriveAt, endsAt, homeAt: endsAt + pathLength(toDesk(destination)) / pace };
}
