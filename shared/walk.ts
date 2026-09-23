import type { Category, Destination, JevLeg, Point } from './protocol.js';

// The room's floor plan in canvas pixels (the room is 320×160). Positions are where Jev's feet land.
// Shared so the server plans the same walks every visitor draws.
export const BIN_X: Record<Category, number> = { compliments: 82, ideas: 136, complaints: 190, misc: 244 };
export const DESK: Point = [160, 108], TRAY: Point = [80, 116], TRASH: Point = [262, 122];
const CORRIDOR = 56; // The strip of floor in front of the bins.
const AISLES = [110, 212]; // Either side of the desk.
// Furniture Jev goes around rather than through, padded by half his width: the desk, the incoming
// trolley, and the trash can.
const BLOCKS = [
  { left: 128, right: 192, top: 57, bottom: 86 },
  { left: 16, right: 73, top: 96, bottom: 125 },
  { left: 266, right: 298, top: 94, bottom: 123 },
];
// Places Jev drifts between when there's nothing to sort.
export const LOUNGE: Point[] = [DESK, [96, 72], [44, 76], [118, 56], [226, 56], [236, 92], [286, 72], [120, 136], [200, 136]];

export const dropPoint = (destination: Destination): Point => destination === 'trash' ? TRASH : [BIN_X[destination], CORRIDOR];
export const samePoint = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
export const pathLength = (path: readonly Point[]) =>
  path.slice(1).reduce((sum, point, i) => sum + Math.abs(point[0] - path[i][0]) + Math.abs(point[1] - path[i][1]), 0);
// Paths are axis-aligned, so a segment hits furniture exactly when its bounding box overlaps it.
const blocked = (a: Point, b: Point) => BLOCKS.some(block =>
  Math.max(a[0], b[0]) >= block.left && Math.min(a[0], b[0]) <= block.right && Math.max(a[1], b[1]) >= block.top && Math.min(a[1], b[1]) <= block.bottom);
const tidy = (path: Point[]) => path.filter((point, i) =>
  i === 0 || !samePoint(point, path[i - 1])).filter((point, i, all) =>
  i === 0 || i === all.length - 1 || !((all[i - 1][0] === point[0] && point[0] === all[i + 1][0]) || (all[i - 1][1] === point[1] && point[1] === all[i + 1][1])));

// The shortest right-angled route between two spots that doesn't cut through furniture.
export function route(from: Point, to: Point): Point[] {
  const options = ([
    [from, [from[0], to[1]], to],
    [from, [to[0], from[1]], to],
    ...AISLES.map(aisle => [from, [aisle, from[1]], [aisle, to[1]], to]),
    ...AISLES.map(aisle => [from, [from[0], CORRIDOR], [aisle, CORRIDOR], [aisle, to[1]], to]),
  ] as Point[][]).map(tidy);
  const clear = options.filter(path => path.slice(1).every((point, i) => !blocked(path[i], point)));
  return (clear.length ? clear : options).reduce((best, path) => pathLength(path) < pathLength(best) ? path : best);
}

// The point `progress` (0–1) of the way along a path, and the path walked so far.
export function along(path: readonly Point[], progress: number): Point {
  return partial(path, progress).at(-1)!;
}
export function partial(path: readonly Point[], progress: number): Point[] {
  let remaining = Math.max(0, Math.min(1, progress)) * pathLength(path);
  const walked: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]], length = pathLength([a, b]);
    if (remaining < length) { const f = remaining / length; walked.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); return walked; }
    remaining -= length; walked.push(b);
  }
  return walked;
}

// Where Jev is at time t, and the leg he's on (none once the plan has run out).
export function jevAt(legs: readonly JevLeg[], t: number): { point: Point; leg?: JevLeg } {
  if (!legs.length) return { point: DESK };
  if (t < legs[0].from) return { point: legs[0].path[0] };
  for (const leg of legs) {
    if (t >= leg.from && (leg.to === null || t < leg.to)) {
      return { point: leg.to === null || leg.path.length < 2 ? leg.path.at(-1)! : along(leg.path, (t - leg.from) / Math.max(1, leg.to - leg.from)), leg };
    }
  }
  return { point: legs.at(-1)!.path.at(-1)! };
}
