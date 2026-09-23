export const CATEGORIES = ['compliments', 'ideas', 'complaints', 'misc'] as const;
export type Category = typeof CATEGORIES[number];
export type Destination = Category | 'trash';
export const BIN_META: Record<Category, { label: string; description: string }> = {
  compliments: { label: 'Compliments', description: 'A little appreciation goes a long way.' },
  ideas: { label: 'Ideas', description: 'Small sparks. Big possibilities.' },
  complaints: { label: 'Complaints', description: 'Something could be better.' },
  misc: { label: 'Misc', description: 'A home for everything else.' },
};
export interface PublicMessage {
  id: string;
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
  kind: 'run' | 'walk' | 'wait' | 'drop' | 'rest';
  path: Point[]; // A single point for wait, drop, and rest.
  from: number;
  to: number | null; // null: until something new comes in.
  carrying?: string; // Id of the envelope in Jev's hands.
  destination?: Destination;
  say?: string; // Speech bubble text.
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
export type ClientEvent = { type: 'move' } & Omit<Visitor, 'id'>;
export interface JevDecision { destination: Destination; reaction: string; reason?: string }
