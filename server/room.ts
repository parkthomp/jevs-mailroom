import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CATEGORIES, cleanName, type BinPage, type Category, type PublicMessage, type RoomSnapshot, type NamePass, type SubmissionProgress, type SubmissionReceipt } from '../shared/protocol.js';
import { checkName, type NameVerdict } from './ai.js';
import type { State, Store, StoredMessage } from './store.js';

export const TRASH_REACTION = 'This one goes in the trash.';
export const pending = (message: StoredMessage) => !['delivered', 'discarded'].includes(message.status);
const secret = () => process.env.RECEIPT_SECRET || 'local-demo-only-receipt-secret-change-in-production';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenFor = (submissionId: string) => createHmac('sha256', secret()).update(submissionId).digest('base64url');
// Proof that Jev approved a name, so the socket and the mail tray can trust it without asking him again.
const passFor = (name: string) => createHmac('sha256', secret()).update(`name:${name}`).digest('base64url');
export const validPass = (name: string, pass: unknown) => {
  const expected = Buffer.from(passFor(name)), given = Buffer.from(typeof pass === 'string' ? pass : '');
  return expected.length === given.length && timingSafeEqual(expected, given);
};
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function asPublic(message: StoredMessage): PublicMessage | null {
  if (message.status !== 'delivered' || !message.deliveredAt || !message.decision || message.decision.destination === 'trash') return null;
  return { id: message.id, name: message.name ?? null, text: message.text, category: message.decision.destination, reaction: message.decision.reaction, createdAt: message.createdAt, deliveredAt: message.deliveredAt };
}
export function snapshot(state: State, online: number, mode: 'demo' | 'live'): RoomSnapshot {
  const messages = state.messages.flatMap(message => { const item = asPublic(message); return item ? [item] : []; });
  const counts = Object.fromEntries(CATEGORIES.map(category => [category, messages.filter(message => message.category === category).length])) as Record<Category, number>;
  return { version: state.version, serverTime: Date.now(), counts, online, mode,
    queue: state.messages.filter(message => pending(message) && message.id !== state.active?.id).map(({ id }) => ({ id })),
    active: state.active ? { ...state.active, reaction: state.active.destination === 'trash' ? TRASH_REACTION : state.active.reaction } : null,
    jev: state.jev ?? [],
    recent: messages.sort((a, b) => b.deliveredAt - a.deliveredAt).slice(0, 8) };
}
// Counts one call against the daily AI budget, or returns false once it's spent.
export function spendBudget(state: State): boolean {
  const date = new Date().toISOString().slice(0, 10);
  if (state.budget.date !== date) state.budget = { date, calls: 0 };
  if (state.budget.calls >= Number(process.env.DAILY_AI_LIMIT || 500)) return false;
  state.budget.calls++;
  return true;
}
// Names come from a tiny alphabet and Jev always judges one the same way, so each is only asked about once.
const verdicts = new Map<string, NameVerdict>();
export async function approveName(store: Store, raw: string): Promise<NamePass> {
  const name = cleanName(raw).trim();
  if (!name) throw new HttpError(400, 'Pick a name with at least one letter or number.');
  let verdict = verdicts.get(name);
  if (!verdict) {
    if (!await store.mutate(spendBudget)) throw new HttpError(503, 'Jev has checked all the names he can for today. Please try again tomorrow.');
    try { verdict = await checkName(name); }
    catch { throw new HttpError(503, 'Jev can’t check names right now. Please try again in a moment.'); }
    if (verdicts.size >= 5000) verdicts.clear();
    verdicts.set(name, verdict);
  }
  if (!verdict.allowed) throw new HttpError(422, verdict.reason);
  return { name, pass: passFor(name) };
}
export async function submit(store: Store, text: string, submissionId: string, name: string): Promise<SubmissionReceipt> {
  return store.mutate(state => {
    const existing = state.messages.find(message => message.submissionId === submissionId);
    if (existing) {
      if (existing.text !== text) throw new HttpError(409, 'This submission ID was already used for a different message.');
      return { id: existing.id, token: tokenFor(submissionId), status: existing.status };
    }
    if (state.messages.filter(pending).length >= Number(process.env.MAX_QUEUE || 40)) throw new HttpError(503, 'The mail tray is full. Please try again after Jev catches up.');
    const token = tokenFor(submissionId);
    const message: StoredMessage = { id: randomUUID(), name, text, submissionId, tokenHash: hash(token),
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
