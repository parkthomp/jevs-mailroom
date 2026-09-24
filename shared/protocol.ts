export const CATEGORIES = ['compliments', 'feedback', 'important', 'big_ideas', 'dad_jokes', 'art', 'spam'] as const;
export type Category = typeof CATEGORIES[number];
export type Destination = Category | 'trash';
export const BIN_META: Record<Category, { label: string; description: string }> = {
  compliments: { label: 'Compliments', description: 'Kind words and little pick-me-ups.' },
  feedback: { label: 'Feedback', description: 'What’s working and what could be better.' },
  important: { label: 'Important', description: 'Jev gives these special attention.' },
  big_ideas: { label: 'Big Ideas', description: 'Small sparks. Big possibilities.' },
  dad_jokes: { label: 'Dad Jokes', description: 'Puns, groaners, and very proud punchlines.' },
  art: { label: 'Art', description: 'A little room for creativity.' },
  spam: { label: 'Spam', description: 'Junk mail has a home here, too.' },
};
export interface PublicMessage {
  id: string;
  name: string | null; // Who sent it. Null on notes from before names were attached.
  text: string;
  category: Category;
  reaction: string;
  createdAt: number;
  deliveredAt: number;
}
export interface ActiveDelivery {
  id: string;
  destination: Destination;
  reaction: string;
  // The note is filed when it lands, and Jev is free for the next one.
  endsAt: number;
}
// Where Jev's feet are, in room pixels (the room is 320×160).
export type Point = readonly [number, number];
// One stretch of Jev's plan. Legs follow on from each other, and every visitor draws the same ones.
export interface JevLeg {
  kind: 'run' | 'walk' | 'wait' | 'drop' | 'rest' | 'chat';
  path: Point[]; // A single point for wait, drop, rest, and chat.
  from: number;
  to: number | null; // null: until something new comes in.
  carrying?: string; // Id of the envelope in Jev's hands.
  destination?: Destination;
  say?: string; // Speech bubble text.
  facing?: Facing; // Who Jev turns to while chatting.
}
export interface RoomSnapshot {
  version: number;
  serverTime: number;
  counts: Record<Category, number>;
  queue: { id: string }[];
  active: ActiveDelivery | null;
  jev: JevLeg[];
  recent: PublicMessage[];
  online: number;
  mode: 'demo' | 'live';
}
export type SubmissionStatus = 'pending_review' | 'classifying' | 'ready' | 'ready_to_discard' | 'delivering' | 'discarding' | 'delivered' | 'discarded' | 'failed';
export interface SubmissionReceipt {
  id: string;
  token: string;
  status: SubmissionStatus;
}
export interface SubmissionProgress {
  id: string;
  status: SubmissionStatus;
  category?: Category;
  reason?: string;
  queuePosition?: number;
}
export interface BinPage { messages: PublicMessage[]; nextCursor: string | null; total: number }
export type Facing = 'up' | 'down' | 'left' | 'right';
export const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right'];
// How many outfits a visitor's character can wear (see client/pixels.tsx).
export const LOOKS = 18;
// A visitor's character standing in the room. Positions are feet, in room pixels, like Jev's.
export interface Visitor { id: string; name: string; x: number; y: number; facing: Facing; look: number; moving: boolean }
// Name tags are drawn in the room's pixel font, so names keep to the capitals, digits, and few marks it has.
export const NAME_MAX = 12;
export const cleanName = (value: string) =>
  value.replace(/[‘’]/g, "'").toUpperCase().replace(/[^A-Z0-9 .'!?-]/g, '').replace(/\s+/g, ' ').trimStart().slice(0, NAME_MAX);
export type ServerEvent =
  | { type: 'snapshot'; room: RoomSnapshot }
  | { type: 'hello'; id: string } // Which of the visitors is you.
  | { type: 'visitors'; visitors: Visitor[] };
// A name Jev has approved, with the server's proof of it. Characters and notes need one.
export interface NamePass { name: string; pass: string }
export type ClientEvent = ({ type: 'move'; pass: string } & Omit<Visitor, 'id'>) | { type: 'talk' };
export interface JevDecision { destination: Destination; reaction: string; reason?: string }
