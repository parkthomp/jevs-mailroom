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
  startedAt: number;
  // Timed by shared/walk.ts: Jev picks up the note, carries it to its destination, drops it (endsAt), and walks home.
  pickupAt: number;
  arriveAt: number;
  endsAt: number;
  homeAt: number;
}
export interface RoomSnapshot {
  version: number;
  serverTime: number;
  counts: Record<Category, number>;
  queue: { id: string }[];
  active: ActiveDelivery | null;
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
export type ServerEvent = { type: 'snapshot'; room: RoomSnapshot };
export interface JevDecision { destination: Destination; reaction: string; reason?: string }
