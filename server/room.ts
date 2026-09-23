import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CATEGORIES, type BinPage, type Category, type PublicMessage, type RoomSnapshot, type SubmissionProgress, type SubmissionReceipt } from '../shared/protocol.js';
import type { State, Store, StoredMessage } from './store.js';

export const TRASH_REACTION = 'This one goes in the trash.';
export const pending = (message: StoredMessage) => !['delivered', 'discarded'].includes(message.status);
const secret = () => process.env.RECEIPT_SECRET || 'local-demo-only-receipt-secret-change-in-production';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenFor = (submissionId: string) => createHmac('sha256', secret()).update(submissionId).digest('base64url');
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function asPublic(message: StoredMessage): PublicMessage | null {
  if (message.status !== 'delivered' || !message.deliveredAt || !message.decision || message.decision.destination === 'trash') return null;
  return { id: message.id, text: message.text, category: message.decision.destination, reaction: message.decision.reaction, createdAt: message.createdAt, deliveredAt: message.deliveredAt };
}
export function snapshot(state: State, online: number, mode: 'demo' | 'live'): RoomSnapshot {
  const messages = state.messages.flatMap(message => { const item = asPublic(message); return item ? [item] : []; });
  const counts = Object.fromEntries(CATEGORIES.map(category => [category, messages.filter(message => message.category === category).length])) as Record<Category, number>;
  return { version: state.version, serverTime: Date.now(), counts, online, mode,
    queue: state.messages.filter(message => pending(message) && message.id !== state.active?.id).map(({ id }) => ({ id })),
    active: state.active ? { ...state.active, reaction: state.active.destination === 'trash' ? TRASH_REACTION : state.active.reaction } : null,
    recent: messages.sort((a, b) => b.deliveredAt - a.deliveredAt).slice(0, 8) };
}
export async function submit(store: Store, text: string, submissionId: string): Promise<SubmissionReceipt> {
  return store.mutate(state => {
    const existing = state.messages.find(message => message.submissionId === submissionId);
    if (existing) {
      if (existing.text !== text) throw new HttpError(409, 'This submission ID was already used for a different message.');
      return { id: existing.id, token: tokenFor(submissionId), status: existing.status };
    }
    if (state.messages.filter(pending).length >= Number(process.env.MAX_QUEUE || 40)) throw new HttpError(503, 'The mail tray is full. Please try again after Jev catches up.');
    const token = tokenFor(submissionId);
    const message: StoredMessage = { id: randomUUID(), text, submissionId, tokenHash: hash(token),
      status: 'pending_review', createdAt: Date.now(), attempts: 0, nextAttemptAt: 0 };
    state.messages.push(message); state.version++;
    return { id: message.id, token, status: message.status };
  });
}
export function progress(state: State, id: string, token: string): SubmissionProgress {
  const message = state.messages.find(item => item.id === id);
  if (!message || !timingSafeEqual(Buffer.from(message.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'))) throw new HttpError(404, 'Receipt not found.');
  const category = message.decision?.destination;
  return { id, status: message.status, ...(category && category !== 'trash' ? { category } : {}),
    ...(message.reason ? { reason: message.reason } : {}),
    ...(pending(message) ? { queuePosition: state.messages.filter(pending).findIndex(item => item.id === id) + 1 } : {}) };
}
export function binPage(state: State, category: Category, cursor?: string): BinPage {
  const all = state.messages.flatMap(item => { const message = asPublic(item); return message?.category === category ? [message] : []; })
    .sort((a, b) => b.deliveredAt - a.deliveredAt || b.id.localeCompare(a.id));
  let offset = 0;
  if (cursor) {
    let data: { time: number; id: string };
    try { data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); if (typeof data.time !== 'number' || typeof data.id !== 'string') throw new Error(); }
    catch { throw new HttpError(400, 'Invalid page cursor.'); }
    offset = all.findIndex(message => message.deliveredAt < data.time || (message.deliveredAt === data.time && message.id.localeCompare(data.id) < 0));
    if (offset < 0) offset = all.length;
  }
  const messages = all.slice(offset, offset + 20);
  const last = messages.at(-1);
  return { messages, total: all.length, nextCursor: offset + messages.length < all.length && last ? Buffer.from(JSON.stringify({ time: last.deliveredAt, id: last.id })).toString('base64url') : null };
}
