import { useEffect, useRef, type RefObject } from 'react';
import { BIN_META, CATEGORIES, type Category, type Facing, type Point, type RoomSnapshot, type Visitor } from '../shared/protocol';
import { BIN_WIDTH, BIN_X, DOOR, jevAt, ROOM_H as H, ROOM_W as W, route } from '../shared/walk';
import { ENVELOPE, ENVELOPE_OWN, FONT, jevSprite, PALETTE, PLANT, visitorSprite, type SpriteData } from './pixels';
import { canUse, clicked, facingFor, nearby, sameSpot, SPEED, step, toward, type Spot } from './player';

const [INK, DARK, LIGHT, PAPER] = PALETTE;
// Screen space, in CSS pixels, taken by the HUD at the top and the touch pad at the bottom.
const HUD = 64, PAD = 200;
// Directions held on the on-screen pad, and a press of its A button waiting to be handled.
export interface Pad { held: Set<Facing>; use: boolean }
export type Move = Omit<Visitor, 'id'>;
interface Props {
  room: RoomSnapshot | null;
  ownIds: string[];
  look: number;
  name: string | null; // Your name tag. You stay outside the door until you've given one.
  selfId: string | null;
  visitors: RefObject<Map<string, Visitor>>;
  pad: RefObject<Pad>;
  paused: boolean; // A window is open: the room keeps going, but your character stands still.
  beacon: Category | null; // A bin to point out, such as the one your note was just filed in.
  onNearby: (spot: Spot | null) => void;
  onUse: (spot: Spot | null) => void;
  onWalk: () => void;
  onMove: (move: Move) => void;
}
const KEYS: Record<string, Facing> = { arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right' };
const USE_KEYS = new Set([' ', 'enter', 'e', 'z']);
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const pressable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('button, a[href], summary');

export default function RoomCanvas(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const offset = useRef<number | null>(null);
  useEffect(() => {
    if (!props.room) return;
    // Anchor the clock to a genuinely new snapshot only. Re-measuring on every render pinned
    // `now` to the last snapshot's timestamp, so Jev stalled and rewound mid-walk.
    const measured = props.room.serverTime - Date.now();
    if (offset.current === null || Math.abs(measured - offset.current) > 400) offset.current = measured;
  }, [props.room]);
  useEffect(() => {
    const el = canvas.current;
    const screen = el?.getContext('2d');
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const c = off.getContext('2d');
    if (!el || !screen || !c) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarse = window.matchMedia('(pointer: coarse)');
    let raf = 0;

    // Fill the screen. Phones zoom in and follow your character; bigger screens show the whole room.
    const view = { scale: 1, ox: 0, oy: 0, top: 0, room: 0 };
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.max(1, Math.round(el.clientWidth * dpr)); el.height = Math.max(1, Math.round(el.clientHeight * dpr));
      // On touch screens, keep the room between the HUD and the pad when there's height to spare.
      view.top = coarse.matches ? HUD * dpr : 0; view.room = el.height - (coarse.matches ? (HUD + PAD) * dpr : 0);
      if (view.room < H * 2 * dpr) { view.top = 0; view.room = el.height; }
      const whole = Math.min(el.width / W, view.room / H), close = coarse.matches || el.clientWidth < 700 ? 3 * dpr : 0;
      const scale = Math.max(whole, Math.min(close, view.room / H));
      view.scale = Math.floor(scale) / scale >= .85 ? Math.floor(scale) : scale;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    fit();

    // Your character comes in through the door and takes a few steps into the room.
    const me = { x: DOOR[0] + Math.round(Math.random() * 12 - 6), y: DOOR[1], facing: 'up' as Facing, moving: false };
    let auto: { path: Point[]; use?: Spot; entrance?: boolean } | null = { path: [[me.x, 138]], entrance: true };
    let jevFacing: Facing = 'down', camera: Point = [me.x, me.y], shown: Spot | null = null, sent = '', sentAt = 0, sentTo: string | null = null, wasMoving = false, useKey = false;
    const others = new Map<string, { x: number; y: number }>();
    const keys = new Set<Facing>();

    const keydown = (event: KeyboardEvent) => {
      if (latest.current.paused || typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase(), direction = KEYS[key];
      // Walking takes focus off any HUD button, so Space goes back to using things in the room.
      if (direction) { keys.add(direction); event.preventDefault(); if (pressable(event.target)) (event.target as HTMLElement).blur(); }
      else if (USE_KEYS.has(key) && !pressable(event.target) && !event.repeat) { useKey = true; event.preventDefault(); }
    };
    const keyup = (event: KeyboardEvent) => { const direction = KEYS[event.key.toLowerCase()]; if (direction) keys.delete(direction); };
    const blur = () => keys.clear();
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);

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
    // A label printed dark on light, or light on dark when it's the thing you can use (or should look at).
    const label = (value: string, centerX: number, y: number, lit: boolean) => {
      if (lit) rect(Math.round(centerX - (value.length * 4 - 1) / 2) - 2, y - 2, value.length * 4 + 3, 9, INK);
      print(value, centerX, y, lit ? PAPER : INK);
    };
    const drawRoom = (data: RoomSnapshot | null, mine: string[], tray: { id: string }[], lit: (spot: Spot) => boolean) => {
      // Wall, baseboard, and a tiled floor inside a dark frame, with a doorway in the bottom wall.
      rect(0, 0, W, H, PAPER);
      rect(0, 0, W, 38, LIGHT);
      rect(0, 38, W, 2, DARK); rect(0, 40, W, 1, INK);
      for (let x = 8; x < W; x += 16) for (let y = 48; y < H - 4; y += 16) rect(x, y, 1, 1, LIGHT);
      rect(0, 0, W, 2, INK); rect(0, 0, 2, H, INK); rect(W - 2, 0, 2, H, INK);
      rect(0, H - 2, DOOR[0] - 12, 2, INK); rect(DOOR[0] + 12, H - 2, W - DOOR[0] - 12, 2, INK);
      rect(DOOR[0] - 14, H - 4, 2, 4, INK); rect(DOOR[0] + 12, H - 4, 2, 4, INK);
      rect(DOOR[0] - 11, H - 9, 22, 7, DARK);
      for (let x = DOOR[0] - 9; x < DOOR[0] + 10; x += 3) rect(x, H - 8, 1, 5, LIGHT);
      // A small clock above seven bins, in the same order as the menu.
      clock(160, 11);
      for (const key of CATEGORIES) {
        const width = BIN_WIDTH[key], x = BIN_X[key] - width / 2, count = data?.counts[key] || 0;
        rect(x, 24, width, 20, INK); rect(x + 2, 26, width - 4, 5, DARK);
        if (count) sprite(ENVELOPE, x + 7, 22);
        if (count > 1) sprite(ENVELOPE, x + width - 17, 21);
        rect(x + 2, 31, width - 4, 11, LIGHT); rect(x + 2, 31, width - 4, 1, PAPER);
        label(BIN_META[key].label.toUpperCase(), BIN_X[key], 34, lit({ kind: 'bin', category: key }));
        rect(x + 2, 44, width - 4, 2, LIGHT);
      }
      // The rug stays in the open center of the room.
      rect(118, 80, 84, 36, DARK); rect(120, 82, 80, 32, LIGHT);
      for (let y = 82; y < 114; y += 3) { rect(116, y, 2, 1, DARK); rect(202, y, 2, 1, DARK); }
      // The desk replaces the incoming trolley: lamp, paperwork, and waiting notes, without a sign.
      rect(19, 98, 52, 14, INK); rect(21, 100, 48, 6, LIGHT); rect(21, 106, 48, 4, DARK);
      rect(22, 112, 3, 6, INK); rect(65, 112, 3, 6, INK);
      rect(35, 101, 10, 4, PAPER); rect(37, 102, 6, 1, LIGHT); rect(55, 101, 5, 4, INK); rect(56, 102, 3, 2, PAPER);
      rect(24, 91, 9, 3, DARK); rect(25, 91, 7, 1, LIGHT); rect(28, 94, 1, 6, INK);
      tray.slice(0, 8).forEach((item, i) => sprite(mine.includes(item.id) ? ENVELOPE_OWN : ENVELOPE, 35 + (i % 4) * 8, 97 - Math.floor(i / 4) * 4));
      // Trash can.
      rect(279, 96, 6, 2, INK); rect(272, 98, 20, 3, INK); rect(274, 101, 16, 20, INK); rect(276, 101, 12, 18, DARK);
      for (const x of [279, 283, 287]) rect(x - 1, 103, 1, 14, LIGHT);
      sprite(PLANT, 13, 48); sprite(PLANT, 297, 48);
    };

    // Clicking the floor walks you there; clicking a bin, the desk, the trash, or Jev walks you over and uses it.
    const toRoom = (event: PointerEvent): Point => {
      const dpr = window.devicePixelRatio || 1, bounds = el.getBoundingClientRect();
      return [((event.clientX - bounds.left) * dpr - view.ox) / view.scale, ((event.clientY - bounds.top) * dpr - view.oy) / view.scale];
    };
    const pointerdown = (event: PointerEvent) => {
      if (latest.current.paused || event.button !== 0) return;
      const point = toRoom(event), place = clicked(point), feet: Point = [me.x, me.y];
      if (place && canUse(feet, place)) { latest.current.onUse(place.spot); return; }
      const goal: Point = place ? place.approach : [Math.round(point[0]), Math.round(point[1])];
      const path = route([Math.round(me.x), Math.round(me.y)], goal).slice(1);
      auto = { path: [[Math.round(me.x), Math.round(me.y)], ...path], use: place?.spot };
    };
    const pointermove = (event: PointerEvent) => { el.style.cursor = clicked(toRoom(event)) ? 'pointer' : 'default'; };
    el.addEventListener('pointerdown', pointerdown);
    el.addEventListener('pointermove', pointermove);

    let last = performance.now();
    const draw = (time: number) => {
      const p = latest.current, { room: data, ownIds: mine } = p;
      const dt = Math.max(0, Math.min(.05, (time - last) / 1000)); last = time;
      const now = Date.now() + (offset.current ?? 0), reduced = media.matches, legs = data?.jev ?? [];
      const jev = jevAt(legs, now);

      // Move your character: held keys and the pad first, then any walk you clicked for.
      const held = new Set([...keys, ...(p.pad.current?.held ?? [])]);
      // The few steps in through the door finish first, so nobody gets wedged in the doorway.
      const still = p.paused || !!auto?.entrance;
      const dx = still ? 0 : +held.has('right') - +held.has('left'), dy = still ? 0 : +held.has('down') - +held.has('up');
      const before: Point = [me.x, me.y];
      if (dx || dy) {
        auto = null;
        [me.x, me.y] = step(before, dx, dy, SPEED * dt);
        me.facing = facingFor(dx, dy, me.facing);
      } else if (auto && !p.paused) {
        const target = auto.path[0], next = target && toward(before, target, SPEED * dt);
        if (!target || !next) auto = null;
        else {
          [me.x, me.y] = next;
          me.facing = facingFor(Math.sign(Math.round((next[0] - before[0]) * 100)), Math.sign(Math.round((next[1] - before[1]) * 100)), me.facing);
          if (Math.abs(me.x - target[0]) < .01 && Math.abs(me.y - target[1]) < .01) {
            [me.x, me.y] = target;
            auto.path.shift();
            if (!auto.path.length) {
              const use = auto.use; auto = null;
              if (use) { const place = nearby([me.x, me.y]); if (place && sameSpot(place.spot, use)) p.onUse(use); }
            }
          }
        }
      }
      me.moving = me.x !== before[0] || me.y !== before[1];
      if (me.moving && !wasMoving && !auto?.entrance) p.onWalk();
      wasMoving = me.moving;
      const place = nearby([me.x, me.y]);
      if (!sameSpot(place?.spot ?? null, shown)) { shown = place?.spot ?? null; p.onNearby(shown); }
      const pad = p.pad.current;
      if ((useKey || pad?.use) && !p.paused) p.onUse(shown);
      useKey = false; if (pad) pad.use = false;

      // Tell everyone else where you are, a few times a second at most.
      const move: Move = { name: p.name ?? '', x: Math.round(me.x), y: Math.round(me.y), facing: me.facing, look: p.look, moving: me.moving }, encoded = JSON.stringify(move);
      if (p.selfId && p.name && (encoded !== sent || sentTo !== p.selfId) && time - sentAt > 100) { p.onMove(move); sent = encoded; sentAt = time; sentTo = p.selfId; }

      // A note Jev is on his way to grab still sits on the desk until he gets there.
      const unclaimed = legs.filter(leg => leg.kind === 'run' && leg.carrying && leg.from > now).map(leg => ({ id: leg.carrying! }));
      const blink = reduced || Math.floor(time / 500) % 2 === 0;
      const beacon: Spot | null = p.beacon ? { kind: 'bin', category: p.beacon } : null;
      drawRoom(data, mine, [...unclaimed, ...(data?.queue || [])], spot => (!p.paused && sameSpot(spot, place?.spot ?? null)) || (blink && sameSpot(spot, beacon)));
      const { leg } = jev;
      const moving = !!leg && (leg.kind === 'run' || leg.kind === 'walk'), running = leg?.kind === 'run';
      const position = reduced && moving ? leg.path.at(-1)! : jev.point;
      const carried = leg?.carrying && leg.kind !== 'drop' ? leg.carrying : undefined;
      let flight: { from: Point; to: Point; t: number; arc: number } | null = null;
      if (leg?.kind === 'drop' && leg.to !== null && !reduced) {
        // Toss over the can's rim, or drop through the bin's slot.
        const [fx, fy] = leg.path[0], trash = leg.destination === 'trash';
        flight = { from: [fx - 4, fy - 23], to: trash ? [278, 92] : [fx - 4, 20], t: (now - leg.from) / Math.max(1, leg.to - leg.from), arc: trash ? 16 : 4 };
      }
      const jevStep = moving && !reduced && Math.floor(time / (running ? 70 : 140)) % 2 === 1;
      const x = Math.round(position[0]), y = Math.round(position[1]), bob = jevStep ? 1 : 0;
      // Which way Jev is headed; at a corner he keeps facing the way he was going. Standing still, he
      // faces the bin or can he's dropping into, the desk he's waiting at, or the room.
      const behind = jevAt(legs, now - 40).point, sx = Math.sign(Math.round(jev.point[0] - behind[0])), sy = Math.sign(Math.round(jev.point[1] - behind[1]));
      if (moving) jevFacing = facingFor(sx, sy, jevFacing);
      else jevFacing = leg?.kind === 'drop' ? leg.destination === 'trash' ? 'right' : 'up' : leg?.kind === 'wait' ? 'left' : 'down';

      // Everyone in the room, drawn back to front.
      const people: { y: number; draw: () => void }[] = [{ y, draw: () => {
        if (running && !reduced) {
          // Speed lines trailing behind a sprint.
          if (sx) for (const [oy, length] of [[-12, 4], [-8, 6], [-4, 4]]) rect(sx > 0 ? x - 8 - length : x + 8, y + oy, length, 1, DARK);
          else if (sy) for (const [ox, length] of [[-4, 3], [0, 5], [4, 3]]) rect(x + ox, sy > 0 ? y - 18 - length : y + 2, 1, length, DARK);
        }
        rect(x - 5, y - 2, 10, 3, LIGHT);
        sprite(jevSprite(jevFacing, jevStep), x - 6, y - 16 - bob);
        if (carried) sprite(mine.includes(carried) ? ENVELOPE_OWN : ENVELOPE, x - 4, y - 23 - bob);
      } }];
      const tags: { name: string; x: number; y: number }[] = [];
      const character = (vx: number, vy: number, name: string | null, look: number, facing: Facing, walking: boolean) => {
        const stepping = walking && Math.floor(time / 130) % 2 === 1, px = Math.round(vx), py = Math.round(vy);
        if (name) tags.push({ name, x: px, y: py + 3 });
        return { y: py, draw: () => { rect(px - 5, py - 2, 10, 3, LIGHT); sprite(visitorSprite(look, facing, stepping), px - 6, py - 16 - (stepping ? 1 : 0)); } };
      };
      const seen = new Set<string>(), names: string[] = [];
      for (const visitor of p.visitors.current?.values() ?? []) {
        if (visitor.id === p.selfId) continue;
        seen.add(visitor.id); names.push(visitor.name);
        let at = others.get(visitor.id);
        // Glide between updates; jump if they've wandered far (or just arrived).
        if (!at || reduced || Math.abs(at.x - visitor.x) + Math.abs(at.y - visitor.y) > 48) { at = { x: visitor.x, y: visitor.y }; others.set(visitor.id, at); }
        else { const k = Math.min(1, dt * 12); at.x += (visitor.x - at.x) * k; at.y += (visitor.y - at.y) * k; }
        people.push(character(at.x, at.y, visitor.name, visitor.look, visitor.facing, visitor.moving));
      }
      for (const id of others.keys()) if (!seen.has(id)) others.delete(id);
      people.push(character(me.x, me.y, p.name, p.look, me.facing, me.moving));
      people.sort((a, b) => a.y - b.y).forEach(person => person.draw());

      if (flight && flight.t < 1) {
        const t = Math.max(0, flight.t);
        sprite(leg?.carrying && mine.includes(leg.carrying) ? ENVELOPE_OWN : ENVELOPE, flight.from[0] + (flight.to[0] - flight.from[0]) * t, flight.from[1] + (flight.to[1] - flight.from[1]) * t - Math.sin(t * Math.PI) * flight.arc);
      }
      if (leg?.say) say(leg.say, x, y - 25 - bob, y);

      // Scale the room up onto the screen, following your character when it doesn't all fit.
      const rw = W * view.scale, rh = H * view.scale, follow = reduced ? 1 : Math.min(1, dt * 6);
      camera = [camera[0] + (me.x - camera[0]) * follow, camera[1] + (me.y - camera[1]) * follow];
      const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
      view.ox = Math.round(rw <= el.width ? (el.width - rw) / 2 : clamp(el.width / 2 - camera[0] * view.scale, el.width - rw, 0));
      view.oy = Math.round(rh <= view.room ? view.top + (view.room - rh) / 2 : clamp(el.height / 2 - camera[1] * view.scale, el.height - rh, 0));
      screen.fillStyle = INK; screen.fillRect(0, 0, el.width, el.height);
      screen.imageSmoothingEnabled = false;
      screen.drawImage(off, view.ox, view.oy, rw, rh);
      // Names sit below the characters and are drawn at half the room's pixel scale, so they stay
      // crisp without competing with the characters. Every tag uses light text on a dark background.
      const unit = Math.max(window.devicePixelRatio || 1, Math.floor(view.scale / 2));
      for (const tag of tags) {
        const textWidth = (tag.name.length * 4 - 1) * unit, width = textWidth + 2 * unit, height = 7 * unit;
        const roomLeft = view.ox + 2 * view.scale, roomRight = view.ox + (W - 2) * view.scale;
        const roomTop = view.oy + 2 * view.scale, roomBottom = view.oy + (H - 2) * view.scale;
        const left = Math.round(Math.max(roomLeft, Math.min(roomRight - width, view.ox + tag.x * view.scale - width / 2)));
        const top = Math.round(Math.max(roomTop, Math.min(roomBottom - height, view.oy + tag.y * view.scale)));
        screen.fillStyle = INK; screen.fillRect(left, top, width, height);
        screen.fillStyle = PAPER;
        let letterX = left + unit;
        for (const char of tag.name) {
          const glyph = FONT[char] ?? FONT[' '];
          for (let i = 0; i < 15; i++) if (glyph[i] === '1') screen.fillRect(letterX + i % 3 * unit, top + unit + Math.floor(i / 3) * unit, unit, unit);
          letterX += 4 * unit;
        }
      }

      // Exposes positions for end-to-end checks; updated only when they change.
      const report = { jevX: String(x), playerX: String(Math.round(me.x)), playerY: String(Math.round(me.y)), visitors: String(others.size), names: names.join(',') };
      for (const [key, value] of Object.entries(report)) if (el.dataset[key] !== value) el.dataset[key] = value;
      raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(raf); observer.disconnect();
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur);
      el.removeEventListener('pointerdown', pointerdown); el.removeEventListener('pointermove', pointermove);
    };
  }, []);
  return <canvas ref={canvas} className="room-canvas" role="img" aria-label="A pixel-art mailroom you can walk around. Jev sorts notes into seven bins along the wall: Compliments, Feedback, Important, Big Ideas, Dad Jokes, Art, and Spam. Walk to a bin to read its notes, or to the incoming desk to write one. Use the arrow keys to walk and Space to use things, or the Menu button for the same options." />;
}
