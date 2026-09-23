import { useEffect, useRef } from 'react';
import { BIN_META, CATEGORIES, type Category, type Point, type RoomSnapshot } from '../shared/protocol';
import { BIN_X, DESK, jevAt, samePoint } from '../shared/walk';
import { BIN_ICONS, BUBBLE, ENVELOPE, ENVELOPE_OWN, FONT, HEART_SMALL, JEV_STAND, JEV_STEP, PALETTE, PLANT, type SpriteData } from './pixels';

// A handheld-sized room, scaled up with crisp pixels.
const W = 320, H = 160;
const [INK, DARK, LIGHT, PAPER] = PALETTE;
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
    // A round wall clock showing the visitor's own local time; redrawn every frame, so it keeps itself current.
    const clock = (cx: number, cy: number) => {
      const disc = (radius: number, color: string) => {
        for (let dy = -radius; dy <= radius; dy++) { const half = Math.floor(Math.sqrt((radius + .5) ** 2 - dy * dy)); rect(cx - half, cy + dy, half * 2 + 1, 1, color); }
      };
      const hand = (turns: number, length: number) => {
        const angle = turns * 2 * Math.PI;
        for (let step = 0; step <= length; step += .5) rect(cx + Math.round(Math.sin(angle) * step), cy - Math.round(Math.cos(angle) * step), 1, 1, INK);
      };
      disc(7, INK); disc(6, PAPER);
      for (const [dx, dy] of [[0, -5], [5, 0], [0, 5], [-5, 0]]) rect(cx + dx, cy + dy, 1, 1, DARK);
      const time = new Date(), minutes = time.getMinutes() + time.getSeconds() / 60;
      hand((time.getHours() % 12 + minutes / 60) / 12, 3);
      hand(minutes / 60, 5);
    };
    // A speech bubble over Jev's head, kept inside the room. Up by the bins it drops below his feet
    // so it never covers the bin labels.
    const say = (line: string, x: number, head: number, feet: number) => {
      const w = line.length * 4 + 5, h = 11, above = head - h - 1 >= 42, top = above ? head - h - 1 : feet + 3;
      const left = Math.max(4, Math.min(W - 4 - w, x - Math.floor(w / 2))), tail = Math.max(left + 2, Math.min(left + w - 4, x));
      rect(left + 1, top, w - 2, h, INK); rect(left, top + 1, w, h - 2, INK); rect(left + 1, top + 1, w - 2, h - 2, PAPER);
      print(line, left + w / 2, top + 3);
      const edge = above ? top + h - 1 : top, out = above ? 1 : -1;
      rect(tail, edge, 2, 1, PAPER); rect(tail, edge + out, 1, 1, PAPER);
      rect(tail - 1, edge + out, 1, 1, INK); rect(tail + 1, edge + out, 1, 1, INK); rect(tail, edge + 2 * out, 1, 1, INK);
    };
    const drawRoom = (data: RoomSnapshot | null, mine: string[], tray: { id: string }[]) => {
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
      clock(303, 18);
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
      tray.slice(0, 8).forEach((item, i) => sprite(mine.includes(item.id) ? ENVELOPE_OWN : ENVELOPE, 26 + (i % 4) * 10, 99 - Math.floor(i / 4) * 4));
      print('INCOMING', 45, 126);
      // Trash can.
      rect(279, 96, 6, 2, INK); rect(272, 98, 20, 3, INK); rect(274, 101, 16, 20, INK); rect(276, 101, 12, 18, DARK);
      for (const x of [279, 283, 287]) rect(x - 1, 103, 1, 14, LIGHT);
      print('TRASH', 282, 126);
      sprite(PLANT, 13, 48); sprite(PLANT, 297, 48);
    };
    const draw = (time: number) => {
      const { room: data, ownIds: mine, offset } = state.current;
      const now = Date.now() + (offset ?? 0), reduced = media.matches, legs = data?.jev ?? [];
      // A note Jev is on his way to grab still sits on the trolley until he gets there.
      const unclaimed = legs.filter(leg => leg.kind === 'run' && leg.carrying && leg.from > now).map(leg => ({ id: leg.carrying! }));
      drawRoom(data, mine, [...unclaimed, ...(data?.queue || [])]);
      const { point, leg } = jevAt(legs, now);
      const moving = !!leg && (leg.kind === 'run' || leg.kind === 'walk'), running = leg?.kind === 'run';
      const position = reduced && moving ? leg.path.at(-1)! : point;
      const held = leg?.carrying && leg.kind !== 'drop' ? leg.carrying : undefined;
      let flight: { from: Point; to: Point; t: number; arc: number } | null = null;
      if (leg?.kind === 'drop' && leg.to !== null && !reduced) {
        // Toss over the can's rim, or drop through the bin's slot.
        const [dx, dy] = leg.path[0], trash = leg.destination === 'trash';
        flight = { from: [dx - 4, dy - 23], to: trash ? [278, 92] : [dx - 4, 20], t: (now - leg.from) / Math.max(1, leg.to - leg.from), arc: trash ? 16 : 4 };
      }
      const step = moving && !reduced && Math.floor(time / (running ? 70 : 140)) % 2 === 1;
      const x = Math.round(position[0]), y = Math.round(position[1]), bob = step ? 1 : 0;
      if (running && !reduced) {
        // Speed lines trailing behind a sprint.
        const before = jevAt(legs, now - 40).point, dx = Math.sign(Math.round(position[0] - before[0])), dy = Math.sign(Math.round(position[1] - before[1]));
        if (dx) for (const [oy, length] of [[-12, 4], [-8, 6], [-4, 4]]) rect(dx > 0 ? x - 8 - length : x + 8, y + oy, length, 1, DARK);
        else if (dy) for (const [ox, length] of [[-4, 3], [0, 5], [4, 3]]) rect(x + ox, dy > 0 ? y - 18 - length : y + 2, 1, length, DARK);
      }
      rect(x - 5, y - 2, 10, 3, LIGHT);
      sprite(step ? JEV_STEP : JEV_STAND, x - 6, y - 16 - bob);
      if (held) sprite(mine.includes(held) ? ENVELOPE_OWN : ENVELOPE, x - 4, y - 23 - bob);
      if (flight && flight.t < 1) {
        const t = Math.max(0, flight.t);
        sprite(leg?.carrying && mine.includes(leg.carrying) ? ENVELOPE_OWN : ENVELOPE, flight.from[0] + (flight.to[0] - flight.from[0]) * t, flight.from[1] + (flight.to[1] - flight.from[1]) * t - Math.sin(t * Math.PI) * flight.arc);
      }
      if (leg?.say) say(leg.say, x, y - 25 - bob, y);
      else if (!leg && samePoint(point, DESK)) { sprite(BUBBLE, x + 4, y - 27); sprite(HEART_SMALL, x + 7, y - 25); }
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
  return <canvas ref={canvas} width={W} height={H} className="room-canvas" role="img" onClick={event => { const category = hit(event); if (category) onSelect(category); }} onMouseMove={event => { event.currentTarget.style.cursor = hit(event) ? 'pointer' : 'default'; }} aria-label="A pixel-art mailroom with Jev, an incoming mail trolley, four sorting bins, a trash can, and a wall clock showing your local time. Browse the bins using the buttons below." />;
}
