import { useEffect, useRef } from 'react';
import { BIN_META, CATEGORIES, type Category, type Destination, type RoomSnapshot } from '../shared/protocol';
import { BIN_ICONS, BUBBLE, ENVELOPE, ENVELOPE_OWN, FONT, HEART_SMALL, JEV_STAND, JEV_STEP, PALETTE, PLANT, type SpriteData } from './pixels';

// A handheld-sized room, scaled up with crisp pixels.
const W = 320, H = 160;
const [INK, DARK, LIGHT, PAPER] = PALETTE;
const BIN_X: Record<Category, number> = { compliments: 82, ideas: 136, complaints: 190, misc: 244 };
type Point = readonly [number, number];
// Positions are where Jev's feet land.
const DESK: Point = [160, 108], PICKUP: Point = [80, 116], TRASH: Point = [262, 122];
const TO_TRAY: Point[] = [DESK, [PICKUP[0], DESK[1]], PICKUP];
const FROM_TRAY = [...TO_TRAY].reverse();

// Jev walks around the desk: out along a side aisle, then across the corridor in front of the bins.
function route(destination: Destination): Point[] {
  if (destination === 'trash') return [DESK, [TRASH[0], DESK[1]], TRASH];
  const x = BIN_X[destination], aisle = x < DESK[0] ? 110 : 212;
  return [DESK, [aisle, DESK[1]], [aisle, 56], [x, 56]];
}
function along(path: readonly Point[], progress: number): Point {
  const lengths = path.slice(1).map((point, i) => Math.abs(point[0] - path[i][0]) + Math.abs(point[1] - path[i][1]));
  let remaining = Math.max(0, Math.min(1, progress)) * lengths.reduce((sum, length) => sum + length, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? Math.min(1, remaining / lengths[i]) : 1, a = path[i], b = path[i + 1];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    remaining -= lengths[i];
  }
  return path[path.length - 1];
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
    const el = canvas.current, wrap = el?.parentElement;
    if (!el || !wrap) return;
    // Whole-number scaling keeps every pixel the same size; fill the screen instead when that would waste too much room.
    const fit = () => {
      const available = wrap.clientWidth, dpr = window.devicePixelRatio || 1;
      const whole = Math.floor(available * dpr / W) * W / dpr;
      el.style.width = whole >= available * .88 ? `${whole}px` : '100%';
    };
    const observer = new ResizeObserver(fit);
    observer.observe(wrap);
    fit();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = canvas.current;
    const c = el?.getContext('2d');
    if (!el || !c) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    const rect = (x: number, y: number, w: number, h: number, color: string) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h); };
    const sprite = (data: SpriteData, x: number, y: number) => {
      x = Math.round(x); y = Math.round(y);
      data.forEach((row, dy) => { for (let dx = 0; dx < row.length; dx++) if (row[dx] !== '.') rect(x + dx, y + dy, 1, 1, PALETTE[+row[dx]]); });
    };
    const print = (value: string, centerX: number, y: number, color: string = INK) => {
      let x = Math.round(centerX - (value.length * 4 - 1) / 2);
      c.fillStyle = color;
      for (const char of value) {
        const glyph = FONT[char] ?? FONT[' '];
        for (let i = 0; i < 15; i++) if (glyph[i] === '1') c.fillRect(x + i % 3, y + Math.floor(i / 3), 1, 1);
        x += 4;
      }
    };
    const drawRoom = (data: RoomSnapshot | null, mine: string[]) => {
      // Wall, baseboard, and a tiled floor inside a dark frame.
      rect(0, 0, W, H, PAPER);
      rect(0, 0, W, 38, LIGHT);
      for (let x = 4; x < W; x += 8) for (let y = 4; y < 36; y += 8) rect(x, y, 1, 1, PAPER);
      rect(0, 38, W, 2, DARK); rect(0, 40, W, 1, INK);
      for (let x = 8; x < W; x += 16) for (let y = 48; y < H - 4; y += 16) rect(x, y, 1, 1, LIGHT);
      rect(0, 0, W, 2, INK); rect(0, H - 2, W, 2, INK); rect(0, 0, 2, H, INK); rect(W - 2, 0, 2, H, INK);
      // Sign, window, and clock.
      rect(128, 3, 64, 11, INK); rect(129, 4, 62, 9, PAPER); print('JEV\'S MAILROOM', 160, 6);
      rect(12, 8, 34, 25, INK); rect(14, 10, 30, 21, PAPER); rect(28, 10, 2, 21, DARK); rect(14, 19, 30, 2, DARK);
      rect(17, 13, 6, 2, LIGHT); rect(33, 24, 7, 2, LIGHT); rect(10, 32, 38, 3, DARK); rect(10, 35, 38, 1, INK);
      rect(298, 10, 10, 12, INK); rect(296, 12, 14, 8, INK); rect(298, 12, 10, 8, PAPER); rect(302, 13, 1, 4, INK); rect(302, 16, 3, 1, INK);
      // Four bins along the wall; the icons tell them apart without colour.
      for (const key of CATEGORIES) {
        const x = BIN_X[key] - 19, count = data?.counts[key] || 0;
        print(BIN_META[key].label.toUpperCase(), BIN_X[key], 15);
        rect(x, 24, 38, 20, INK); rect(x + 2, 26, 34, 5, DARK);
        if (count) sprite(ENVELOPE, x + 7, 22);
        if (count > 1) sprite(ENVELOPE, x + 21, 21);
        rect(x + 2, 31, 34, 11, LIGHT); rect(x + 2, 31, 34, 1, PAPER);
        sprite(BIN_ICONS[key], BIN_X[key] - 4, 33);
        rect(x + 2, 44, 34, 2, LIGHT);
      }
      // Rug, desk, lamp, and paperwork.
      rect(118, 80, 84, 36, DARK); rect(120, 82, 80, 32, LIGHT);
      for (let y = 82; y < 114; y += 3) { rect(116, y, 2, 1, DARK); rect(202, y, 2, 1, DARK); }
      rect(134, 64, 52, 14, INK); rect(136, 66, 48, 6, LIGHT); rect(136, 72, 48, 4, DARK);
      rect(137, 78, 3, 6, INK); rect(180, 78, 3, 6, INK);
      rect(150, 67, 10, 4, PAPER); rect(152, 68, 6, 1, LIGHT); rect(170, 67, 5, 4, INK); rect(171, 68, 3, 2, PAPER);
      rect(139, 57, 9, 3, DARK); rect(140, 57, 7, 1, LIGHT); rect(143, 60, 1, 6, INK);
      // Incoming trolley with the waiting envelopes.
      rect(22, 98, 46, 12, INK); rect(24, 100, 42, 6, DARK); rect(24, 106, 42, 2, LIGHT);
      rect(26, 110, 2, 10, INK); rect(62, 110, 2, 10, INK); rect(24, 120, 6, 3, INK); rect(60, 120, 6, 3, INK);
      (data?.queue || []).slice(0, 8).forEach((item, i) => sprite(mine.includes(item.id) ? ENVELOPE_OWN : ENVELOPE, 26 + (i % 4) * 10, 99 - Math.floor(i / 4) * 4));
      print('INCOMING', 45, 126);
      // Trash can.
      rect(279, 96, 6, 2, INK); rect(272, 98, 20, 3, INK); rect(274, 101, 16, 20, INK); rect(276, 101, 12, 18, DARK);
      for (const x of [279, 283, 287]) rect(x - 1, 103, 1, 14, LIGHT);
      print('TRASH', 282, 126);
      sprite(PLANT, 13, 48); sprite(PLANT, 297, 48);
      print('EST. TODAY', 160, 149, DARK);
    };
    const draw = (time: number) => {
      const { room: data, ownIds: mine, offset } = state.current;
      const now = Date.now() + (offset ?? 0), active = data?.active, reduced = media.matches;
      drawRoom(data, mine);
      let position = DESK, carrying = false, walking = false, reading = false;
      let flight: { from: Point; to: Point; t: number; arc: number } | null = null;
      if (active) {
        const { startedAt, pickupAt, departAt, endsAt, destination } = active;
        const arrive = endsAt - (destination === 'trash' ? 750 : 400);
        if (now < pickupAt) { position = along(TO_TRAY, (now - startedAt) / (pickupAt - startedAt)); walking = true; }
        else if (now < departAt) {
          const back = (now - pickupAt) / Math.max(1, (departAt - pickupAt) * .55);
          position = along(FROM_TRAY, back); carrying = true; walking = back < 1; reading = back >= 1;
        } else {
          const walk = (now - departAt) / Math.max(1, arrive - departAt);
          position = along(route(destination), walk); carrying = walk < 1; walking = walk < 1;
          // Toss over the can's rim, or drop through the bin's slot.
          if (walk >= 1) flight = { from: [position[0] - 4, position[1] - 23], to: destination === 'trash' ? [278, 92] : [position[0] - 4, 20], t: (now - arrive) / (endsAt - arrive), arc: destination === 'trash' ? 16 : 4 };
        }
        if (reduced) { position = now < departAt ? DESK : route(destination).at(-1)!; walking = false; reading = now >= pickupAt && now < departAt; flight = null; }
      }
      const step = walking && !reduced && Math.floor(time / 140) % 2 === 1;
      const x = Math.round(position[0]), y = Math.round(position[1]), bob = step ? 1 : 0;
      rect(x - 5, y - 2, 10, 3, LIGHT);
      sprite(step ? JEV_STEP : JEV_STAND, x - 6, y - 16 - bob);
      if (reading) sprite(active && mine.includes(active.id) ? ENVELOPE_OWN : ENVELOPE, x - 4, y - 8);
      else if (carrying) sprite(active && mine.includes(active.id) ? ENVELOPE_OWN : ENVELOPE, x - 4, y - 23 - bob);
      if (flight && flight.t < 1) {
        const t = Math.max(0, flight.t);
        sprite(ENVELOPE, flight.from[0] + (flight.to[0] - flight.from[0]) * t, flight.from[1] + (flight.to[1] - flight.from[1]) * t - Math.sin(t * Math.PI) * flight.arc);
      }
      if (!active || reading) {
        sprite(BUBBLE, x + 4, y - 27);
        if (reading) { const dots = reduced ? 3 : 1 + Math.floor(time / 300) % 3; for (let i = 0; i < dots; i++) rect(x + 7 + i * 2, y - 23, 1, 1, INK); }
        else sprite(HEART_SMALL, x + 7, y - 25);
      }
      // Exposes Jev's position for end-to-end checks; updated only when it changes.
      if (el.dataset.jevX !== String(x)) el.dataset.jevX = String(x);
      raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, []);
  const hit = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * W / bounds.width, y = (event.clientY - bounds.top) * H / bounds.height;
    return y > 14 && y < 48 ? CATEGORIES.find(category => Math.abs(x - BIN_X[category]) < 22) : undefined;
  };
  return <canvas ref={canvas} width={W} height={H} className="room-canvas" role="img" onClick={event => { const category = hit(event); if (category) onSelect(category); }} onMouseMove={event => { event.currentTarget.style.cursor = hit(event) ? 'pointer' : 'default'; }} aria-label="A pixel-art mailroom with Jev, an incoming mail trolley, four sorting bins, and a trash can. Browse the bins using the buttons below." />;
}
