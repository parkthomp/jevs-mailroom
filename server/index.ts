import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { CATEGORIES, type Category } from '../shared/protocol.js';
import { aiMode } from './ai.js';
import { startEngine } from './engine.js';
import { chatWithJev } from './jev.js';
import { approveName, asPublic, binPage, HttpError, progress, snapshot, submit, validPass } from './room.js';
import { Store } from './store.js';
import { Presence } from './visitors.js';

if (process.env.NODE_ENV === 'production') {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) throw new Error('Production requires DATABASE_URL and REDIS_URL.');
  if ((process.env.RECEIPT_SECRET || '').length < 32) throw new Error('Production requires a RECEIPT_SECRET of at least 32 characters.');
}
const mode = aiMode();
const store = new Store();
await store.init();
const stopEngine = !process.env.DATABASE_URL ? await startEngine(store) : undefined;
const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '8kb' }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const rate = new Map<string, { count: number; expires: number }>();
function limit(key: string, max: number, message = 'You’ve sent a few letters already. Please give Jev a minute.') {
  const now = Date.now();
  const entry = rate.get(key);
  if (!entry || entry.expires < now) { rate.set(key, { count: 1, expires: now + 60_000 }); return; }
  if (entry.count >= max) throw new HttpError(429, message);
  entry.count++;
}
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const presence = new Presence<WebSocket>(validPass);
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws') { socket.destroy(); return; }
  if (request.headers.origin) {
    try {
      if (new URL(request.headers.origin).host !== request.headers.host && process.env.NODE_ENV === 'production') { socket.destroy(); return; }
    } catch { socket.destroy(); return; }
  }
  wss.handleUpgrade(request, socket, head, websocket => wss.emit('connection', websocket, request));
});
const currentRoom = async () => snapshot(await store.read(), wss.clients.size, mode);
const asyncRoute = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next); };

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', asyncRoute(async (_req, res) => { await store.healthy(); res.json({ ok: true }); }));
app.get('/api/room', asyncRoute(async (_req, res) => { res.json(await currentRoom()); }));
app.post('/api/names', asyncRoute(async (req, res) => {
  const name = req.body?.name;
  if (typeof name !== 'string' || name.length > 100) throw new HttpError(400, 'Pick a name with at least one letter or number.');
  limit(`name:${req.ip || req.socket.remoteAddress || 'unknown'}`, Number(process.env.NAMES_PER_MINUTE || 10), 'That’s a lot of names! Please give Jev a minute.');
  res.json(await approveName(store, name));
}));
app.post('/api/messages', asyncRoute(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const submissionId = req.body?.clientSubmissionId;
  const name = req.body?.name;
  if (typeof name !== 'string' || !validPass(name, req.body?.namePass)) throw new HttpError(400, 'Tell Jev your name before sending a note.');
  if (!text || [...text].length > 280 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new HttpError(400, 'Write a message between 1 and 280 characters.');
  if (typeof submissionId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(submissionId)) throw new HttpError(400, 'A valid client submission ID is required.');
  // Retrying a saved submission is idempotent and does not consume another rate-limit slot.
  const state = await store.read();
  if (!state.messages.some(message => message.submissionId === submissionId)) {
    limit(`ip:${req.ip || req.socket.remoteAddress || 'unknown'}`, Number(process.env.SUBMISSIONS_PER_MINUTE || 5));
    const session = req.header('x-session-id');
    if (session && /^[a-zA-Z0-9_-]{16,100}$/.test(session)) limit(`session:${session}`, Number(process.env.SUBMISSIONS_PER_MINUTE || 5));
  }
  res.status(202).json(await submit(store, text, submissionId, name));
}));
app.get('/api/submissions/:id', asyncRoute(async (req, res) => { res.json(progress(await store.read(), String(req.params.id), req.header('x-receipt-token') || '')); }));
app.get('/api/bins/:category/messages', asyncRoute(async (req, res) => {
  const category = String(req.params.category);
  if (!CATEGORIES.includes(category as Category)) throw new HttpError(404, 'That bin does not exist.');
  const cursor = req.query.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 500)) throw new HttpError(400, 'Invalid page cursor.');
  res.json(binPage(await store.read(), category as Category, cursor as string | undefined));
}));
app.get('/api/messages/:id', asyncRoute(async (req, res) => {
  const stored = (await store.read()).messages.find(message => message.id === req.params.id);
  const message = stored ? asPublic(stored) : null;
  if (!message) throw new HttpError(404, 'This message is not in a public bin.');
  res.json(message);
}));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Endpoint not found.')));
app.use(express.static(resolve('dist/client')));
app.use((req, res, next) => {
  if (req.method !== 'GET') { next(new HttpError(404, 'Not found.')); return; }
  res.sendFile(resolve('dist/client/index.html'), error => { if (error) next(new HttpError(404, 'Frontend not built yet. Run npm run dev or npm run build.')); });
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : (error as { status?: number })?.status === 413 ? 413 : 503;
  if (status === 429) res.setHeader('Retry-After', '60');
  res.status(status).json({ error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid JSON request.' : status === 413 ? 'This message is too large.' : 'The mailroom is temporarily unavailable. Please try again.' });
});
let lastVersion = -1;
let lastOnline = -1;
let broadcasting = false;
const alive = new WeakSet<WebSocket>();
const send = (socket: WebSocket, data: string) => {
  if (socket.readyState === WebSocket.OPEN) { if (socket.bufferedAmount > 1_000_000) socket.close(1013, 'Reconnect for current room'); else socket.send(data); }
};
wss.on('connection', socket => {
  // Join first, then read the durable snapshot. Every event is a full snapshot, so reconnects and gaps are self-healing.
  void currentRoom().then(room => send(socket, JSON.stringify({ type: 'snapshot', room }))).catch(() => socket.close(1013, 'Room unavailable'));
  send(socket, JSON.stringify({ type: 'hello', id: presence.join(socket) }));
  send(socket, JSON.stringify({ type: 'visitors', visitors: presence.list() }));
  socket.on('message', data => {
    let event: unknown;
    try { event = JSON.parse(String(data)); } catch { return; /* Ignore anything that isn't JSON. */ }
    if ((event as { type?: unknown })?.type !== 'talk') { presence.move(socket, event); return; }
    const at = presence.talk(socket);
    if (at) void store.mutate(state => chatWithJev(state, at, Date.now())).catch(() => { /* Jev just doesn't answer this time. */ });
  });
  socket.on('close', () => presence.leave(socket));
  socket.on('error', () => {});
  alive.add(socket);
  socket.on('pong', () => alive.add(socket));
});
const broadcastTimer = setInterval(async () => {
  if (broadcasting) return;
  broadcasting = true;
  try {
    const room = await currentRoom();
    if (room.version !== lastVersion || room.online !== lastOnline) {
      lastVersion = room.version; lastOnline = room.online;
      const data = JSON.stringify({ type: 'snapshot', room });
      for (const socket of wss.clients) send(socket, data);
    }
  } catch { /* A later poll recovers missed state without exposing database errors. */ }
  finally { broadcasting = false; }
}, 250);
// Characters move far more often than the room changes, so they travel in their own small updates.
const visitorsTimer = setInterval(() => {
  if (!presence.dirty) return;
  presence.dirty = false;
  const data = JSON.stringify({ type: 'visitors', visitors: presence.list() });
  for (const socket of wss.clients) send(socket, data);
}, 100);
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!alive.has(socket)) { socket.terminate(); continue; }
    alive.delete(socket);
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }
  for (const [key, entry] of rate) if (entry.expires < Date.now()) rate.delete(key);
}, 30_000);
const port = Number(process.env.PORT || 3001);
server.listen(port, '0.0.0.0', () => console.log(`Jev’s mailroom listening on http://localhost:${port} (${mode})`));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  clearInterval(broadcastTimer); clearInterval(visitorsTimer); clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, 'Mailroom restarting');
  wss.close();
  server.close();
  await stopEngine?.();
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
