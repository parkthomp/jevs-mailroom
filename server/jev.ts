import type { Destination, JevLeg, Point } from '../shared/protocol.js';
import { DESK, dropPoint, LOUNGE, pathLength, partial, route, TRAY } from '../shared/walk.js';
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
  const halt = (): Point => {
    const kept: JevLeg[] = [];
    let point = legs.length ? legs[0].path[0] : DESK;
    for (const leg of legs) {
      if (leg.from >= now) break;
      if (leg.to !== null && leg.to <= now) { kept.push(leg); point = leg.path.at(-1)!; continue; }
      const path = leg.to === null || leg.path.length < 2 ? leg.path : partial(leg.path, (now - leg.from) / Math.max(1, leg.to - leg.from));
      kept.push({ ...leg, path, to: now }); point = path.at(-1)!;
      break;
    }
    legs = kept;
    return point;
  };
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
