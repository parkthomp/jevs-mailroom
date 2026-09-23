import { useEffect, useRef } from 'react';
import { BIN_META, CATEGORIES, type Category, type RoomSnapshot } from '../shared/protocol';

const W = 960, H = 470;
// Jev stops beside the trolley rather than on top of it, so his nameplate clears the INCOMING label.
const points = { desk: [477, 286], pickup: [266, 322], compliments: [327, 173], ideas: [473, 173], complaints: [619, 173], misc: [765, 173], trash: [782, 352] } as const;
type Point = readonly [number, number];
function travel(a: Point, b: Point, progress: number): Point {
  const t = Math.max(0, Math.min(1, progress));
  // Right-angle paths give the little room a tile-based rhythm.
  const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
  const split = dx / (dx + dy || 1);
  return t < split ? [a[0] + (b[0] - a[0]) * t / split, a[1]] : [b[0], a[1] + (b[1] - a[1]) * (t - split) / (1 - split || 1)];
}

export default function RoomCanvas({ room, ownIds, onSelect }: { room: RoomSnapshot | null; ownIds: string[]; onSelect: (category: Category) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef<{ room: RoomSnapshot | null; ownIds: string[]; offset: number | null }>({ room, ownIds, offset: null });
  useEffect(() => {
    state.current.room = room;
    if (!room) return;
    // Anchor the clock to a genuinely new snapshot only. Re-measuring on every render pinned
    // `now` to the last snapshot's timestamp, so Jev stalled and rewound mid-walk.
    const measured = room.serverTime - Date.now();
    if (state.current.offset === null || Math.abs(measured - state.current.offset) > 400) state.current.offset = measured;
  }, [room]);
  useEffect(() => { state.current.ownIds = ownIds; }, [ownIds]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const c = ctx;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    const rect = (x: number, y: number, w: number, h: number, color: string) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h); };
    const text = (value: string, x: number, y: number, size = 12, color = '#655c48', align: CanvasTextAlign = 'center') => { c.font = `${size}px ui-monospace, monospace`; c.fillStyle = color; c.textAlign = align; c.fillText(value, x, y); };
    const envelope = (x: number, y: number, own = false, scale = 1) => {
      rect(x - scale, y - scale, 23 * scale, 17 * scale, '#73644e'); rect(x, y, 21 * scale, 15 * scale, own ? '#f8d887' : '#fffbea');
      c.strokeStyle = own ? '#ad7b32' : '#c6bfa5'; c.lineWidth = scale; c.beginPath(); c.moveTo(x, y); c.lineTo(x + 10 * scale, y + 8 * scale); c.lineTo(x + 21 * scale, y); c.stroke();
    };
    const plant = (x: number, y: number) => {
      rect(x + 3, y + 28, 30, 6, '#b9aa8b'); rect(x + 6, y + 10, 23, 20, '#b78464'); rect(x + 3, y + 8, 29, 7, '#c99774'); rect(x + 16, y - 17, 5, 29, '#64805b');
      rect(x + 2, y - 10, 15, 9, '#789568'); rect(x - 3, y - 17, 15, 8, '#8fa77a'); rect(x + 20, y - 21, 14, 12, '#6f8d60'); rect(x + 28, y - 27, 9, 9, '#8ca575');
    };
    const draw = (time: number) => {
      const { room: data, ownIds: mine, offset } = state.current;
      const now = Date.now() + (offset ?? 0), active = data?.active, reduced = media.matches;
      c.imageSmoothingEnabled = false;
      rect(0, 0, W, H, '#eeeade');
      // The outside wall, shallow shadows, and warm checkerboard floor.
      rect(72, 44, 824, 376, '#d2cbb9'); rect(64, 36, 824, 374, '#bcb19a'); rect(70, 42, 812, 362, '#e2d8bf');
      for (let row = 0; row < 11; row++) for (let col = 0; col < 25; col++) {
        const x = 80 + col * 32, y = 58 + row * 31;
        rect(x, y, 31, 30, (row + col) % 2 ? '#e8dfcb' : '#e2d8c2');
        if ((row * 7 + col * 11) % 17 === 0) rect(x + 8, y + 8, 3, 2, '#d5cab1');
      }
      rect(65, 36, 823, 42, '#d0c4aa'); rect(73, 42, 807, 25, '#e4dcc9'); rect(72, 72, 809, 7, '#baa98c');
      rect(68, 78, 8, 323, '#c7b89b'); rect(879, 78, 8, 323, '#c7b89b'); rect(65, 401, 823, 9, '#bca989');
      // Mailroom sign.
      rect(382, 26, 202, 38, '#84765e'); rect(385, 23, 196, 35, '#fbf6e9'); text('J E V ’ S  M A I L R O O M', 483, 45, 11);
      // Window and wall clock.
      rect(112, 91, 98, 79, '#b3a184'); rect(117, 94, 88, 67, '#fbf7e7'); rect(122, 98, 78, 57, '#b7cec5'); rect(122, 127, 78, 28, '#cbd9c0');
      rect(128, 111, 19, 5, '#edf1e5'); rect(168, 105, 25, 5, '#edf1e5'); rect(158, 95, 5, 63, '#faf4df'); rect(120, 124, 81, 5, '#faf4df'); rect(109, 160, 105, 8, '#a99371');
      // Clock has a fixed readable face rather than pretending this is a live timer.
      rect(824, 91, 31, 31, '#a69474'); rect(829, 95, 21, 22, '#fbf4de'); rect(839, 98, 2, 10, '#77715c'); rect(840, 106, 6, 2, '#77715c');
      // Four sorting shelves. The DOM cards below are the accessible hit targets.
      CATEGORIES.forEach((key, i) => {
        const x = points[key][0] - 45, color = BIN_META[key].color;
        rect(x + 4, 145, 91, 20, '#c7bda5'); rect(x - 4, 106, 98, 46, '#8c8067'); rect(x, 111, 90, 40, '#fff7e1');
        rect(x + 5, 116, 80, 18, '#7e7760');
        const count = data?.counts[key] || 0;
        if (count) { envelope(x + 14, 117); if (count > 1) envelope(x + 38, 114); }
        rect(x - 2, 131, 94, 24, color); rect(x + 4, 137, 82, 2, '#ffffff50');
        rect(x + 34, 138, 24, 8, '#fbf6e5'); rect(x + 42, 141, 8, 2, '#8c816b');
        text(['COMPLIMENTS', 'IDEAS', 'COMPLAINTS', 'MISC'][i], x + 45, 96, 10);
      });
      // Woven rug and desk.
      rect(335, 203, 286, 153, '#c1c1a3'); rect(341, 209, 274, 141, '#b8b99a');
      for (let i = 0; i < 13; i++) rect(342, 214 + i * 10, 272, 1, '#aeb18f');
      rect(350, 218, 256, 122, '#c3c5a7'); rect(356, 224, 244, 110, '#c8c9ae');
      for (let i = 0; i < 13; i++) { rect(330, 208 + i * 11, 5, 3, '#b6b897'); rect(621, 208 + i * 11, 5, 3, '#b6b897'); }
      rect(401, 232, 155, 12, '#a2a384'); rect(407, 214, 9, 33, '#9c7551'); rect(542, 214, 9, 33, '#9c7551');
      rect(398, 202, 162, 30, '#ab835b'); rect(398, 196, 162, 30, '#c59e70'); rect(402, 198, 154, 3, '#dbb98c');
      rect(457, 201, 36, 19, '#f5efd9'); rect(463, 206, 24, 2, '#c5bba2'); rect(463, 211, 17, 2, '#c5bba2');
      rect(516, 202, 15, 13, '#eee6ce'); rect(531, 205, 5, 7, '#eee6ce'); rect(519, 202, 9, 3, '#856c50');
      rect(417, 186, 5, 24, '#697659'); rect(403, 182, 33, 9, '#87916b'); rect(410, 177, 19, 5, '#9ca580'); rect(410, 207, 20, 4, '#697659');
      // Incoming trolley, waiting sealed letters only.
      rect(123, 285, 115, 63, '#bea783'); rect(119, 279, 121, 45, '#cfb48a'); rect(124, 283, 111, 27, '#9d8a6b');
      rect(125, 328, 8, 33, '#9b896d'); rect(224, 328, 8, 33, '#9b896d'); rect(121, 357, 14, 7, '#807a65'); rect(222, 357, 14, 7, '#807a65');
      const queued = data?.queue || [];
      queued.slice(0, 7).forEach((item, i) => envelope(133 + (i % 3) * 28, 292 - Math.floor(i / 3) * 5, mine.includes(item.id)));
      text('INCOMING', 179, 342, 10, '#6e5f46');
      // Trash can, with a clearly different silhouette from the public bins.
      rect(805, 330, 40, 9, '#b8af97'); rect(808, 294, 34, 38, '#8a9180'); rect(804, 290, 42, 6, '#6b7668'); rect(810, 287, 30, 4, '#a1aa97');
      [815, 825, 835].forEach(x => rect(x, 298, 3, 27, '#a8b09d')); text('TRASH', 825, 356, 10);
      plant(108, 208); plant(839, 216);
      // A tiny notice board and floor details make a quiet room still feel inhabited.
      rect(695, 295, 54, 42, '#baa17d'); rect(699, 299, 46, 34, '#dac79f'); rect(706, 302, 22, 22, '#fff5d6'); rect(711, 309, 13, 2, '#c3b494'); rect(711, 315, 10, 2, '#c3b494'); rect(717, 302, 3, 3, '#c78065');
      text('EST. TODAY', 477, 385, 10, '#9a9078');
      let position: Point = points.desk, carrying = false, walking = false, toss = 0;
      if (active) {
        const pickup = active.pickupAt, depart = active.departAt, end = active.endsAt;
        if (now < pickup) { position = travel(points.desk, points.pickup, (now - active.startedAt) / (pickup - active.startedAt)); walking = true; }
        else if (now < depart) { position = travel(points.pickup, points.desk, Math.min(1, (now - pickup) / Math.max(1, (depart - pickup) * .55))); carrying = true; walking = now < pickup + (depart - pickup) * .55; }
        else { const finishWalk = end - (active.destination === 'trash' ? 750 : 400); position = travel(points.desk, points[active.destination], (now - depart) / (finishWalk - depart)); carrying = now < finishWalk; walking = now < finishWalk; toss = active.destination === 'trash' && now >= finishWalk ? Math.min(1, (now - finishWalk) / 650) : 0; }
        if (reduced) { position = now < depart ? points.desk : points[active.destination]; walking = false; }
      }
      const bob = reduced ? 0 : walking ? Math.sin(time / 75) * 2 : Math.sin(time / 440) * .7;
      const x = Math.round(position[0]), y = Math.round(position[1]);
      rect(x - 14, y + 7, 31, 6, '#73755a35');
      // Jev: blue workwear, dark hair, tiny red mail bag.
      const step = walking && !reduced ? Math.floor(time / 130) % 2 * 3 : 0;
      rect(x - 9, y - 2 + step, 7, 11 - step, '#46505a'); rect(x + 4, y - 2, 7, 11 - step, '#46505a');
      rect(x - 12, y - 19 + bob, 26, 20, '#6f92a3'); rect(x - 8, y - 18 + bob, 18, 12, '#89aabb');
      rect(x - 17, y - 16 + bob, 5, 15, '#e4b990'); rect(x + 14, y - 16 + bob, 5, 15, '#e4b990');
      rect(x - 9, y - 36 + bob, 23, 22, '#e6bd94'); rect(x - 12, y - 39 + bob, 25, 10, '#655a47'); rect(x - 12, y - 31 + bob, 6, 12, '#655a47'); rect(x + 10, y - 31 + bob, 5, 9, '#655a47');
      rect(x - 4, y - 27 + bob, 3, 3, '#4e4b40'); rect(x + 7, y - 27 + bob, 3, 3, '#4e4b40'); rect(x + 1, y - 20 + bob, 5, 2, '#af7e65');
      rect(x + 8, y - 9 + bob, 13, 13, '#b87d62'); rect(x + 11, y - 17 + bob, 3, 13, '#986e57');
      if (carrying) envelope(x - 9, y - 13 + bob, !!active && mine.includes(active.id));
      // Jev stands beside the can and lobs the envelope over its rim.
      if (toss > 0 && toss < 1 && !reduced) envelope(x + 6 + toss * 30, y - 20 - Math.sin(toss * Math.PI) * 26 - toss * 40);
      text('JEV', x + 2, y + 26, 10, '#65705d');
      if (!active) { rect(x + 27, y - 51, 30, 24, '#fbf7e9'); rect(x + 24, y - 33, 7, 5, '#fbf7e9'); text('♥', x + 42, y - 34, 15, '#b77b63'); }
      else if (now >= active.pickupAt && now < active.departAt) { rect(x + 24, y - 54, 42, 25, '#fbf7e9'); rect(x + 22, y - 34, 7, 5, '#fbf7e9'); text('···', x + 45, y - 36, 20); }
      raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, []);
  const hit = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * W / bounds.width, y = (event.clientY - bounds.top) * H / bounds.height;
    return y > 84 && y < 178 ? CATEGORIES.find(category => Math.abs(x - points[category][0]) < 60) : undefined;
  };
  return <canvas ref={canvas} width={W} height={H} className="room-canvas" role="img" onClick={event => { const category = hit(event); if (category) onSelect(category); }} onMouseMove={event => { event.currentTarget.style.cursor = hit(event) ? 'pointer' : 'default'; }} aria-label="A pixel-art mailroom with Jev, an incoming mail trolley, four sorting bins, and a trash can. Browse the bins using the buttons below." />;
}
