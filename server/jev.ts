import type { Destination, Facing, JevLeg, Point } from '../shared/protocol.js';
import { chatty, DESK, dropPoint, jevAt, LOUNGE, pathLength, partial, route, TALK_RANGE, TRAY } from '../shared/walk.js';
import { TRASH_REACTION } from './room.js';
import type { State } from './store.js';

// Jev sprints for notes and strolls about otherwise. Speeds are in room pixels per millisecond.
const RUN = .15, WALK = .045;
const DROP_MS = { bin: 350, trash: 700 };
const ANNOUNCE: Record<Destination, string> = {
  compliments: 'KIND WORDS COMING THROUGH!', feedback: 'FILING THIS FEEDBACK!',
  important: 'IMPORTANT DELIVERY!', big_ideas: 'FILING THIS BIG IDEA!',
  dad_jokes: 'THIS ONE IS A GROANER!', art: 'ART FOR THE COLLECTION!',
  spam: 'JUNK MAIL HAS A HOME!', trash: 'ANOTHER ONE FOR THE BIN!',
};
const INCOMING = ['pending_review', 'classifying', 'ready', 'ready_to_discard'];

function travel(kind: 'run' | 'walk', from: Point, to: Point, start: number, extra: Partial<JevLeg> = {}): JevLeg | null {
  const path = route(from, to), length = pathLength(path);
  return length ? { kind, path, from: start, to: start + length / (kind === 'run' ? RUN : WALK), ...extra } : null;
}

// Jev's plan cut off at time t, and where that leaves him standing.
function haltAt(legs: readonly JevLeg[], t: number): { legs: JevLeg[]; point: Point } {
  const kept: JevLeg[] = [];
  let point = legs.length ? legs[0].path[0] : DESK;
  for (const leg of legs) {
    if (leg.from >= t) break;
    if (leg.to !== null && leg.to <= t) { kept.push(leg); point = leg.path.at(-1)!; continue; }
    const path = leg.to === null || leg.path.length < 2 ? leg.path : partial(leg.path, (t - leg.from) / Math.max(1, leg.to - leg.from));
    kept.push({ ...leg, path, to: t }); point = path.at(-1)!;
    break;
  }
  return { legs: kept, point };
}

// Advances the shared room by one step: files the note in hand, sends Jev after the next one the
// moment it arrives, and otherwise keeps him milling about. Every change to his plan starts from
// wherever he is right now, so he never jumps. Returns whether anything changed.
export function planJev(state: State, now: number, random = Math.random): boolean {
  const before = JSON.stringify([state.jev, state.active, state.messages.map(message => message.status)]);
  let legs = [...(state.jev ?? [])];
  // Forget finished legs, keeping the last so Jev's resting place is known.
  while (legs.length > 1 && legs[0].to !== null && legs[0].to <= now) legs.shift();

  const finish = () => {
    state.jev = legs;
    const changed = JSON.stringify([state.jev, state.active, state.messages.map(message => message.status)]) !== before;
    if (changed) state.version++;
    return changed;
  };
  if (state.active) {
    const active = state.active, message = state.messages.find(item => item.id === active.id);
    if (active.endsAt <= now && message && ['delivering', 'discarding'].includes(message.status)) {
      message.status = active.destination === 'trash' ? 'discarded' : 'delivered';
      message.deliveredAt ??= active.endsAt;
    }
    if (active.endsAt > now) return finish();
    state.active = null;
  }

  // Stops Jev where he is right now, dropping the rest of his plan.
  const halt = (): Point => { const stopped = haltAt(legs, now); legs = stopped.legs; return stopped.point; };
  const last = legs.at(-1);
  const incoming = state.messages.filter(message => INCOMING.includes(message.status));
  const ready = incoming.find(message => message.decision && ['ready', 'ready_to_discard'].includes(message.status));

  if (ready?.decision) {
    // Straight from the tray to the bin; if he's still running over, he sets off the moment he gets there.
    let start: number;
    if (last?.kind === 'wait') {
      start = Math.max(now, last.from); last.to = start;
      if (last.to === last.from) legs.pop();
    } else {
      const fetch = travel('run', halt(), TRAY, now);
      if (fetch) legs.push(fetch);
      start = fetch?.to ?? now;
    }
    const destination = ready.decision.destination, drop = dropPoint(destination), say = ANNOUNCE[destination];
    const carry = travel('run', TRAY, drop, start, { carrying: ready.id, destination, say })!;
    const landed = carry.to! + (destination === 'trash' ? DROP_MS.trash : DROP_MS.bin);
    legs.push(carry, { kind: 'drop', path: [drop], from: carry.to!, to: landed, carrying: ready.id, destination, say });
    state.active = { id: ready.id, destination, reaction: destination === 'trash' ? TRASH_REACTION : ready.decision.reaction, endsAt: landed };
    ready.status = destination === 'trash' ? 'discarding' : 'delivering';
  } else if (incoming.length) {
    // A note just arrived: run over and wait at the tray for Jev's decision.
    if (last?.kind !== 'wait') {
      const fetch = travel('run', halt(), TRAY, now);
      if (fetch) legs.push(fetch);
      legs.push({ kind: 'wait', path: [TRAY], from: fetch?.to ?? now, to: null });
    }
  } else if (!last || last.to === null || last.to <= now) {
    // Nothing to sort: stroll somewhere else in the room and linger a moment.
    const from = halt(), options = LOUNGE.filter(spot => pathLength([from, spot]) > 40);
    const spot = options[Math.floor(random() * options.length)];
    const stroll = travel('walk', from, spot, now), start = stroll?.to ?? now;
    if (stroll) legs.push(stroll);
    legs.push({ kind: 'rest', path: [spot], from: start, to: start + 1000 + random() * 3000 });
  }
  return finish();
}

export const CHAT_MS = 5000;
export const CHAT_LINES = [
  'ONLY A SITH DEALS IN ABSOLUTES', 'I HEAR PARKER IS A GREAT TEAM MEMBER', "THIS IS NOT THE DROID YOU'RE LOOKING FOR", 'BEEP BOOP',
  'HELLO THERE', 'RENDER IS MY HOME', 'I LOVE JSON', 'THIS COULD HAVE BEEN AN EMAIL',
];
// Room for the visitor and Jev to have moved a little since the visitor's last reported position.
const CHAT_SLACK = 16;
// Jev stops this far ahead, so visitors see him finish his step instead of snapping back to where the server caught him.
const CHAT_LEAD = 300;

// A visitor standing next to Jev says hi: if he's only milling about, he stops, turns to them, and says
// something for a few seconds before wandering on. Returns whether he stopped to chat.
export function chatWithJev(state: State, visitor: Point, now: number, random = Math.random): boolean {
  const legs = state.jev ?? [], at = now + CHAT_LEAD, { point, leg } = jevAt(legs, now);
  if (state.active || state.messages.some(message => INCOMING.includes(message.status))) return false;
  if (!chatty(leg) || !chatty(jevAt(legs, at).leg)) return false;
  if (Math.hypot(visitor[0] - point[0], visitor[1] - point[1]) > TALK_RANGE + CHAT_SLACK) return false;
  const stopped = haltAt(legs, at), [dx, dy] = [visitor[0] - stopped.point[0], visitor[1] - stopped.point[1]];
  const facing: Facing = Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'down' : 'up';
  // Never the same line twice in a row.
  const lines = CHAT_LINES.filter(line => !legs.some(item => item.kind === 'chat' && item.say === line));
  const say = lines[Math.floor(random() * lines.length)];
  // If his plan runs out sooner (standing about, waiting for his next stroll), he starts right then.
  const from = Math.max(now, Math.min(at, stopped.legs.at(-1)?.to ?? now));
  state.jev = [...stopped.legs, { kind: 'chat', path: [stopped.point], from, to: from + CHAT_MS, say, facing }];
  state.version++;
  return true;
}
