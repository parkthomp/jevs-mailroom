import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { BIN_META, CATEGORIES, cleanName, LOOKS, NAME_MAX, type BinPage, type Category, type ClientEvent, type Facing, type NamePass, type PublicMessage, type RoomSnapshot, type ServerEvent, type SubmissionProgress, type SubmissionReceipt, type Visitor } from '../shared/protocol';
import { ARROW, CHECK, CLOSE, DOWN, ENVELOPE, EXCLAIM, JEV_FACE, PERSON, Sprite, TRASH_ICON, UP, visitorSprite } from './pixels';
import type { Spot } from './player';
import RoomCanvas, { type Move, type Pad } from './RoomCanvas';

type SavedReceipt = SubmissionReceipt & { progress?: SubmissionProgress; seen?: boolean };
// What's in the text box. It clears itself once there's been time to read it, or sooner when you
// start walking ('walk') or step away from what you used ('leave').
type Talk = { speaker: 'JEV' | null; line: string; ends?: 'walk' | 'leave' };
const readingTime = (line: string) => Math.max(4000, 2000 + line.length * 60);
const STORAGE_KEY = 'jevs-mailroom-receipts-v1', LOOK_KEY = 'jevs-mailroom-look-v1', NAME_KEY = 'jevs-mailroom-name-v1', PASS_KEY = 'jevs-mailroom-name-pass-v1';
// 'failed' is not terminal: the worker keeps retrying it, so the receipt must keep polling.
const terminal = new Set(['delivered', 'discarded']);
const isCategory = (value: unknown): value is Category => CATEGORIES.includes(value as Category);
const countLabel = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;
const PROMPTS: Record<Spot['kind'], string> = { bin: 'Read', incoming: 'Write a note', trash: 'Look in the trash' };
const promptFor = (spot: Spot) => spot.kind === 'bin' ? `Read ${BIN_META[spot.category].label}` : PROMPTS[spot.kind];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error || data.message || 'Something went wrong. Please try again.');
  return data as T;
}
function readReceipts(): SavedReceipt[] {
  try { const result: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(result) ? result.filter(item => typeof item.id === 'string' && typeof item.token === 'string').slice(0, 8) : []; } catch { return []; }
}
// Each browser keeps the same outfit between visits.
function readLook(): number {
  try {
    const saved = Number(localStorage.getItem(LOOK_KEY));
    if (Number.isInteger(saved) && saved >= 0 && saved < LOOKS && localStorage.getItem(LOOK_KEY) !== null) return saved;
    const look = Math.floor(Math.random() * LOOKS);
    localStorage.setItem(LOOK_KEY, String(look));
    return look;
  } catch { return Math.floor(Math.random() * LOOKS); }
}
// Your name tag and Jev's approval of it. A name saved before Jev checked names has no pass yet,
// so it's only offered back to you to confirm.
function savedName(): string {
  try { return cleanName(localStorage.getItem(NAME_KEY) || '').trim(); } catch { return ''; }
}
function readName(): NamePass | null {
  try { const name = savedName(), pass = localStorage.getItem(PASS_KEY); return name && pass ? { name, pass } : null; } catch { return null; }
}
function EnvelopeIcon({ className = '' }: { className?: string }) {
  return <Sprite data={ENVELOPE} className={className} />;
}
function Arrow() {
  return <Sprite data={ARROW} size={2} />;
}
// Phones and tablets get an on-screen pad; so does anyone who touches the screen.
function useTouch() {
  const [touch, setTouch] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    const touched = () => setTouch(true);
    window.addEventListener('touchstart', touched, { once: true, passive: true });
    return () => window.removeEventListener('touchstart', touched);
  }, []);
  return touch;
}
// Reveals a line letter by letter like a handheld text box; screen readers get the whole line at once.
function useTypewriter(line: string, length: number) {
  const [shown, setShown] = useState(length);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(length); return; }
    setShown(0);
    const timer = setInterval(() => setShown(count => { if (count >= length) clearInterval(timer); return Math.min(length, count + 1); }), 28);
    return () => clearInterval(timer);
  }, [line, length]);
  return shown;
}
function Dialogue({ talk, onDismiss }: { talk: Talk; onDismiss: () => void }) {
  const chars = Array.from(talk.line), shown = useTypewriter(talk.line, chars.length);
  return <div className={`dialogue ${talk.speaker ? '' : 'narration'}`} aria-live="polite" onClick={onDismiss}>
    {talk.speaker && <Sprite data={JEV_FACE} className="dialogue-face" />}
    <p>{talk.speaker && <span className="speaker">{talk.speaker}</span>}<span className="sr-only">{talk.line}</span><span aria-hidden="true">{chars.slice(0, shown).join('')}<span className="unrevealed">{chars.slice(shown).join('')}</span></span></p>
    {shown >= chars.length && <Sprite data={DOWN} size={2} className="dialogue-more" />}
  </div>;
}

function useRoom() {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState('');
  const [selfId, setSelfId] = useState<string | null>(null);
  // Characters move many times a second, so they skip React and go straight to the canvas.
  const visitors = useRef(new Map<string, Visitor>());
  const socket = useRef<WebSocket | undefined>(undefined);
  useEffect(() => {
    let stopped = false, reconnect: ReturnType<typeof setTimeout> | undefined;
    const accept = (snapshot: RoomSnapshot) => {
      if (stopped) return;
      setRoom(current => !current || snapshot.version >= current.version ? snapshot : current);
      setError('');
    };
    const refresh = () => request<RoomSnapshot>('/api/room').then(accept).catch(() => { if (!stopped) setError('The mailroom is reconnecting. Your saved messages are safe.'); });
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => { if (!stopped) void refresh(); };
      ws.onmessage = event => {
        try {
          const parsed = JSON.parse(event.data) as ServerEvent;
          if (parsed.type === 'snapshot' && parsed.room) accept(parsed.room);
          else if (parsed.type === 'hello') setSelfId(parsed.id);
          else if (parsed.type === 'visitors' && Array.isArray(parsed.visitors)) visitors.current = new Map(parsed.visitors.map(visitor => [visitor.id, visitor]));
        } catch { /* A later snapshot restores state. */ }
      };
      ws.onclose = () => { if (!stopped) { setSelfId(null); visitors.current = new Map(); reconnect = setTimeout(connect, 2000); } };
      ws.onerror = () => ws.close();
    };
    void refresh(); connect();
    const interval = setInterval(refresh, 10000);
    return () => { stopped = true; clearInterval(interval); clearTimeout(reconnect); socket.current?.close(); };
  }, []);
  const move = useCallback((next: Omit<ClientEvent, 'type'>) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'move', ...next })); }, []);
  return { room, error, selfId, visitors, move };
}

// Keeps keyboard focus inside a window, closes it on Escape, and hands focus back afterwards.
function useDialog(panel: RefObject<HTMLElement | null>, first: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    first.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea:not(:disabled), [tabindex="0"]');
        if (!nodes?.length) return;
        const start = nodes[0], end = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === start) { event.preventDefault(); end.focus(); }
        else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); start.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
}

function Receipt({ receipt, openBin }: { receipt: SavedReceipt; openBin: (category: Category, id?: string) => void }) {
  const progress = receipt.progress;
  const status = progress?.status || receipt.status;
  const category = isCategory(progress?.category) ? progress.category : undefined;
  const discarded = status === 'discarded', done = status === 'delivered';
  const labels: Record<string, string> = { pending_review: 'Checking your message', classifying: 'Jev is reading your note', ready: 'Your envelope is in line', ready_to_discard: 'Your envelope is in line', delivering: 'On its way to a bin', discarding: 'Jev is taking out the trash', delivered: category ? `Filed in ${BIN_META[category].label}` : 'Your note has been filed', discarded: 'Jev discarded your message', failed: 'Jev will try your note again' };
  return <div className={`receipt ${done ? 'receipt-done' : ''}`} aria-live="polite">
    <span className={`receipt-icon ${!terminal.has(status) ? 'receipt-pending' : ''}`}><Sprite data={done ? CHECK : discarded ? TRASH_ICON : ENVELOPE} /></span>
    <div><span className="eyebrow">YOUR LATEST NOTE</span><p>{labels[status] || 'Your envelope is in line'}</p>
      {progress?.queuePosition !== undefined && !terminal.has(status) && <small>Queue position: {progress.queuePosition}</small>}
      {(discarded || status === 'failed') && <small>{progress?.reason || (discarded ? 'It didn’t meet the public mailroom guidelines.' : 'Your message is saved and will be retried.')}</small>}
      {done && category && <button className="text-button" onClick={() => openBin(category, receipt.id)}>See your message <Arrow /></button>}
    </div>
  </div>;
}

function HistoryPanel({ category, highlight, room, onSelect, onClose, onCompose }: { category: Category; highlight: string | null; room: RoomSnapshot | null; onSelect: (category: Category, id?: string) => void; onClose: () => void; onCompose: () => void }) {
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newMessages, setNewMessages] = useState(false);
  const [retry, setRetry] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const baseline = useRef<number | undefined>(undefined);
  const meta = BIN_META[category];
  const total = room?.counts[category] || 0;
  useDialog(panel, closeButton, onClose);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const page = await request<BinPage>(`/api/bins/${category}/messages`, { signal });
    let list = page.messages;
    if (highlight && !list.some(message => message.id === highlight)) {
      const focused = await request<PublicMessage>(`/api/messages/${encodeURIComponent(highlight)}`, { signal }).catch(() => null);
      if (focused?.category === category) list = [focused, ...list];
    }
    setMessages(list); setCursor(page.nextCursor); setNewMessages(false);
  }, [category, highlight]);
  useEffect(() => {
    const controller = new AbortController();
    baseline.current = undefined; setLoading(true); setError(''); setMessages([]); scroll.current?.scrollTo(0, 0);
    void refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh, retry]);
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = total;
    if (previous !== undefined && total !== previous && !loading) {
      if ((scroll.current?.scrollTop || 0) < 70) void refresh().catch(() => setNewMessages(true));
      else setNewMessages(true);
    }
  }, [total, loading, refresh]);
  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true); setError('');
    try {
      const page = await request<BinPage>(`/api/bins/${category}/messages?cursor=${encodeURIComponent(cursor)}`);
      setMessages(current => [...current, ...page.messages.filter(item => !current.some(existing => existing.id === item.id))]); setCursor(page.nextCursor);
    } catch (error) { setError((error as Error).message); } finally { setLoading(false); }
  };
  return <div className="panel-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="history-panel" ref={panel} role="dialog" aria-modal="true" aria-labelledby="bin-title">
      <div className="panel-top"><span className="eyebrow">THE MESSAGE ARCHIVE</span><button className="icon-button" ref={closeButton} onClick={onClose} aria-label="Close message archive"><Sprite data={CLOSE} size={2} /></button></div>
      <div className="panel-heading"><div><h2 id="bin-title">{meta.label}</h2><p>{meta.description}</p></div></div>
      <nav className="category-tabs" aria-label="Choose a bin">{CATEGORIES.map(key => <button key={key} onClick={() => onSelect(key)} aria-pressed={category === key} className={category === key ? 'selected' : ''}>{BIN_META[key].label}</button>)}</nav>
      <div className="archive-summary"><span>{countLabel(total)} · newest first</span></div>
      {newMessages && <button className="new-messages" onClick={() => { scroll.current?.scrollTo({ top: 0, behavior: 'smooth' }); void refresh().catch(error => setError(error.message)); }}>New messages have arrived <Sprite data={UP} size={2} /></button>}
      <div className="message-list" ref={scroll}>
        {error && <div className="inline-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
        {loading && !messages.length && <div className="archive-empty"><span className="loading-dots">···</span><p>Opening the drawer…</p></div>}
        {!loading && !messages.length && !error && <div className="archive-empty"><EnvelopeIcon /><h3>A little room for your thoughts.</h3><p>No messages here yet. Leave Jev a note at the incoming desk and give this bin its first story.</p><button className="text-button" onClick={onCompose}>Write a note <Arrow /></button></div>}
        {messages.map(message => <article key={message.id} className={`message-card ${message.id === highlight ? 'highlighted' : ''}`}>
          <div className="message-meta"><span>{message.id === highlight ? 'YOUR NOTE' : message.name ? `FROM ${message.name}` : 'A NOTE FROM SOMEONE'}</span><time dateTime={new Date(message.deliveredAt).toISOString()}>{new Date(message.deliveredAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></div>
          <p className="message-body">{message.text}</p>
        </article>)}
        {cursor && <button className="load-more" onClick={loadMore} disabled={loading}>{loading ? 'Opening more mail…' : 'Load more messages'}</button>}
      </div>
      <div className="panel-footer"><span className="status-dot" /> Filed with care by Jev.</div>
    </aside>
  </div>;
}

// The incoming desk: write a note and leave it in the tray for Jev.
function ComposePanel({ identity, onClose, onSent }: { identity: NamePass; onClose: () => void; onSent: (receipt: SubmissionReceipt) => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const submission = useRef<{ text: string; id: string } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useDialog(panel, textarea, onClose);
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); if (!text.trim() || sending) return;
    const clean = text.trim();
    if (submission.current?.text !== clean) submission.current = { text: clean, id: crypto.randomUUID() };
    setSending(true); setError('');
    try {
      const receipt = await request<SubmissionReceipt>('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clean, clientSubmissionId: submission.current.id, name: identity.name, namePass: identity.pass }) });
      submission.current = null; onSent(receipt);
    } catch (error) { setError((error as Error).message); setSending(false); }
  };
  return <div className="panel-backdrop centered" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="composer window" ref={panel} role="dialog" aria-modal="true" aria-label="The incoming desk">
      <div className="panel-top"><span className="eyebrow">THE INCOMING DESK</span><button className="icon-button" onClick={onClose} aria-label="Close the incoming desk"><Sprite data={CLOSE} size={2} /></button></div>
      <form onSubmit={send}><label htmlFor="message" className="sr-only">Your message to Jev</label><div className="textarea-wrap"><textarea id="message" ref={textarea} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send(event); }} placeholder="Leave a note for Jev" maxLength={280} rows={5} required disabled={sending} aria-describedby="public-note character-count" /><span id="character-count" className={text.length > 260 ? 'character-count near-limit' : 'character-count'}>{text.length}<span> / 280</span></span></div>
        <button className="send-button" type="submit" disabled={!text.trim() || sending}>{sending ? 'Handing it to Jev…' : 'Send to Jev'}</button><p className="public-note" id="public-note"><Sprite data={EXCLAIM} size={2} /> Accepted notes are public. Leave out personal details.</p>{error && <p className="inline-error" role="alert">{error}</p>}
      </form>
    </section>
  </div>;
}

// Everything the room offers, without walking: for keyboard and screen reader visitors, or anyone in a hurry.
function MenuPanel({ room, touch, name, onClose, onCompose, onBin, onRename }: { room: RoomSnapshot | null; touch: boolean; name: string | null; onClose: () => void; onCompose: () => void; onBin: (category: Category) => void; onRename: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useDialog(panel, closeButton, onClose);
  const total = CATEGORIES.reduce((sum, category) => sum + (room?.counts[category] || 0), 0);
  return <div className="panel-backdrop centered" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="menu window" ref={panel} role="dialog" aria-modal="true" aria-labelledby="menu-title">
      <div className="panel-top"><h2 id="menu-title" className="eyebrow">MENU</h2><button className="icon-button" ref={closeButton} onClick={onClose} aria-label="Close menu"><Sprite data={CLOSE} size={2} /></button></div>
      <button className="menu-item menu-write" onClick={onCompose}><Sprite data={ARROW} size={2} className="menu-cursor" /><EnvelopeIcon /> Write a note</button>
      <div className="menu-list" role="group" aria-label="Bins">{CATEGORIES.map(category => <button key={category} className="menu-item" onClick={() => onBin(category)} aria-label={`Browse ${BIN_META[category].label}, ${countLabel(room?.counts[category] || 0)}`}>
        <Sprite data={ARROW} size={2} className="menu-cursor" /><span>{BIN_META[category].label}</span><span className="menu-count">{room?.counts[category] || 0}</span>
      </button>)}</div>
      <button className="menu-item" onClick={onRename}><Sprite data={ARROW} size={2} className="menu-cursor" /><Sprite data={PERSON} size={3} /><span>Change name</span><span className="menu-count">{name}</span></button>
      <p className="menu-help">{touch ? 'Walk with the pad, or tap anywhere to walk there. Press A next to a bin to read it, or at the desk on the left to write a note.' : 'Walk with the arrow keys or WASD, or click anywhere to walk there. Press Space next to a bin to read it, or at the desk on the left to write a note.'}</p>
      {room?.mode === 'demo' && <p className="demo-notice"><span>DEMO MODE</span> Jev is using local sorting rules.</p>}
      <p className="menu-footer">{total} notes filed with care</p>
    </section>
  </div>;
}

// Asks who's visiting before you walk in (and again from the menu). Jev checks the name before it
// rides above your head, and turns away anything obscene or aimed at someone.
function NamePanel({ current, look, onClose, onDone }: { current: string | null; look: number; onClose?: () => void; onDone: (identity: NamePass) => void }) {
  const [value, setValue] = useState(() => current ?? savedName());
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const clean = value.trim();
  const stay = useCallback(() => {}, []); // Escape can't skip naming yourself the first time.
  useDialog(panel, input, onClose ?? stay);
  return <div className="panel-backdrop centered">
    <section className="window name-window" ref={panel} role="dialog" aria-modal="true" aria-labelledby="name-title">
      <div className="panel-top"><span className="eyebrow">{current ? 'YOUR NAME TAG' : 'BEFORE YOU COME IN'}</span>{onClose && <button className="icon-button" onClick={onClose} aria-label="Keep your name"><Sprite data={CLOSE} size={2} /></button>}</div>
      <div className="name-heading"><span className="name-avatar"><Sprite data={visitorSprite(look, 'down', false)} size={4} /></span><h2 id="name-title">What’s your name?</h2></div>
      <form onSubmit={async event => {
        event.preventDefault(); if (!clean || checking) return;
        setChecking(true); setError('');
        try { onDone(await request<NamePass>('/api/names', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: clean }) })); }
        catch (error) { setError((error as Error).message); setChecking(false); }
      }}>
        <label htmlFor="visitor-name" className="sr-only">Your name</label>
        <input id="visitor-name" ref={input} className="name-input" value={value} onChange={event => { setValue(cleanName(event.target.value)); setError(''); }} maxLength={NAME_MAX} disabled={checking} autoComplete="nickname" autoCapitalize="characters" spellCheck={false} placeholder="YOUR NAME" aria-describedby="name-note" />
        <button className="send-button" type="submit" disabled={!clean || checking}>{checking ? 'Jev is checking…' : current ? 'Save name' : 'Walk in'}</button>
        <p className="public-note" id="name-note"><Sprite data={EXCLAIM} size={2} /> Everyone in the room can see it, and it signs your notes. Letters and numbers, up to {NAME_MAX}.</p>
        {error && <p className="inline-error" role="alert">{error}</p>}
      </form>
    </section>
  </div>;
}

// A handheld-style pad: slide your thumb around it to walk, and press A to use what's in front of you.
function TouchPad({ pad, onUse }: { pad: RefObject<Pad>; onUse: () => void }) {
  const [held, setHeld] = useState<Facing | null>(null);
  const aim = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect(), dx = event.clientX - bounds.left - bounds.width / 2, dy = event.clientY - bounds.top - bounds.height / 2;
    const direction: Facing | null = Math.hypot(dx, dy) < bounds.width * .12 ? null : Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'down' : 'up';
    pad.current?.held.clear();
    if (direction) pad.current?.held.add(direction);
    setHeld(direction);
  };
  const release = () => { pad.current?.held.clear(); setHeld(null); };
  useEffect(() => release, []);
  return <div className="touch-controls">
    <div className="dpad" aria-hidden="true" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); aim(event); }} onPointerMove={event => { if (event.buttons || event.pointerType === 'touch') { if (event.currentTarget.hasPointerCapture(event.pointerId)) aim(event); } }} onPointerUp={release} onPointerCancel={release} onContextMenu={event => event.preventDefault()}>
      {(['up', 'right', 'down', 'left'] as Facing[]).map(direction => <span key={direction} className={`dpad-${direction} ${held === direction ? 'pressed' : ''}`} />)}
      <span className="dpad-center" />
    </div>
    <button className="a-button" onPointerDown={event => { event.preventDefault(); onUse(); }} onClick={event => { if (event.detail === 0) onUse(); }} aria-label="Use">A</button>
  </div>;
}

export default function App() {
  const { room, error: roomError, selfId, visitors, move } = useRoom();
  const [receipts, setReceipts] = useState<SavedReceipt[]>(readReceipts);
  const [selection, setSelection] = useState(() => { const params = new URLSearchParams(location.search); const value = params.get('bin'); return { category: isCategory(value) ? value : null, message: params.get('message') }; });
  const [overlay, setOverlay] = useState<'menu' | 'compose' | 'name' | null>(null);
  const [near, setNear] = useState<Spot | null>(null);
  const [look] = useState(readLook);
  const touch = useTouch();
  const [identity, setIdentity] = useState(readName);
  const name = identity?.name ?? null;
  const [talk, setTalk] = useState<Talk | null>(null);
  // Your name tag. A first-timer gets Jev's welcome once they've said who they are.
  const named = useCallback((next: NamePass) => {
    try { localStorage.setItem(NAME_KEY, next.name); localStorage.setItem(PASS_KEY, next.pass); } catch { /* Private modes ask again next visit. */ }
    if (!name) setTalk({ speaker: 'JEV', ends: 'walk', line: touch ? `Welcome in, ${next.name}! Walk with the pad and press A to use things. Read notes at the bins, or write one at the desk on the left.` : `Welcome in, ${next.name}! Walk with the arrow keys and press SPACE to use things. Read notes at the bins, or write one at the desk on the left.` });
    setIdentity(next); setOverlay(null);
  }, [name, touch]);
  // Your character only shows up for others with Jev's approval of its name tag.
  const moveAs = useCallback((next: Move) => { if (identity) move({ ...next, pass: identity.pass }); }, [identity, move]);
  useEffect(() => {
    if (!talk) return;
    const timer = setTimeout(() => setTalk(current => current === talk ? null : current), readingTime(talk.line));
    return () => clearTimeout(timer);
  }, [talk]);
  const pad = useRef<Pad>({ held: new Set(), use: false });
  const reacted = useRef(new Set<string>());
  const ownIds = receipts.map(receipt => receipt.id);
  const latest = receipts[0], latestStatus = latest?.progress?.status || latest?.status;
  const beacon = latest && latestStatus === 'delivered' && !latest.seen && isCategory(latest.progress?.category) ? latest.progress.category : null;
  // The receipt stays up while your note is on its way, then tucks itself away a few seconds after it
  // lands. One already finished on an earlier visit starts hidden.
  const [receiptHidden, setReceiptHidden] = useState(() => { const first = readReceipts()[0]; return !!first && terminal.has(first.progress?.status || first.status); });
  useEffect(() => {
    if (!latestStatus || !terminal.has(latestStatus)) { setReceiptHidden(false); return; }
    const timer = setTimeout(() => setReceiptHidden(true), 8000);
    return () => clearTimeout(timer);
  }, [latest?.id, latestStatus]);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(receipts.slice(0, 8))); } catch { /* In private storage modes the current session still works. */ } }, [receipts]);
  // Previously delivered notes can move during an archive re-sort. Refresh saved receipts once
  // on entry, including terminal ones; their original tokens still authorize the current result.
  useEffect(() => {
    let stopped = false;
    void Promise.all(readReceipts().map(async receipt => {
      try {
        const progress = await request<SubmissionProgress>(`/api/submissions/${encodeURIComponent(receipt.id)}`, { headers: { 'x-receipt-token': receipt.token } });
        if (!stopped) setReceipts(current => current.map(item => item.id === receipt.id ? { ...item, progress } : item));
      } catch { /* Keep the saved receipt if the connection is temporarily unavailable. */ }
    }));
    return () => { stopped = true; };
  }, []);
  useEffect(() => {
    let stopped = false;
    const pending = receipts.filter(receipt => !terminal.has(receipt.progress?.status || receipt.status));
    if (!pending.length) return;
    const poll = async () => {
      const updates = await Promise.all(pending.map(async receipt => {
        try { const progress = await request<SubmissionProgress>(`/api/submissions/${encodeURIComponent(receipt.id)}`, { headers: { 'x-receipt-token': receipt.token } }); return { id: receipt.id, progress }; } catch { return null; }
      }));
      if (!stopped) setReceipts(current => current.map(receipt => { const update = updates.find(update => update?.id === receipt.id); return update ? { ...receipt, progress: update.progress } : receipt; }));
    };
    const timer = setInterval(poll, 1500); void poll();
    return () => { stopped = true; clearInterval(timer); };
  // Progress updates must not restart the polling interval.
  }, [receipts.map(receipt => `${receipt.id}:${terminal.has(receipt.progress?.status || receipt.status)}`).join(',')]);
  // When Jev files your own note, he tells you what he thought of it.
  useEffect(() => {
    const active = room?.active;
    if (!active || !ownIds.includes(active.id) || reacted.current.has(active.id)) return;
    reacted.current.add(active.id);
    setTalk({ speaker: 'JEV', line: active.reaction });
  }, [room?.active?.id, ownIds.join(',')]);
  useEffect(() => {
    const pop = () => { const params = new URLSearchParams(location.search); const category = params.get('bin'); setSelection({ category: isCategory(category) ? category : null, message: params.get('message') }); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  const openBin = useCallback((category: Category, message?: string) => {
    const url = new URL(location.href); url.searchParams.set('bin', category); if (message) url.searchParams.set('message', message); else url.searchParams.delete('message');
    history.pushState({}, '', url); setSelection({ category, message: message || null }); setOverlay(null); setTalk(null);
    setReceipts(current => current.map((receipt, i) => i === 0 && receipt.progress?.category === category ? { ...receipt, seen: true } : receipt));
  }, []);
  const closeBin = useCallback(() => { const url = new URL(location.href); url.searchParams.delete('bin'); url.searchParams.delete('message'); history.pushState({}, '', url); setSelection({ category: null, message: null }); }, []);
  const closeWindow = useCallback(() => setOverlay(null), []);
  const compose = useCallback(() => { setOverlay('compose'); setTalk(null); if (selection.category) closeBin(); }, [selection.category, closeBin]);
  const sent = useCallback((receipt: SubmissionReceipt) => {
    setReceipts(current => [receipt, ...current.filter(item => item.id !== receipt.id)].slice(0, 8));
    setOverlay(null);
    setTalk({ speaker: null, line: 'You leave your note on the desk. Jev’s on his way!' });
  }, []);
  const use = useCallback((spot: Spot | null) => {
    if (!spot) { setTalk(null); return; }
    if (spot.kind === 'bin') openBin(spot.category);
    else if (spot.kind === 'incoming') compose();
    else setTalk({ speaker: null, line: 'The trash can. Notes that break the mailroom rules end up in here, and Jev never shows anyone what they said.', ends: 'leave' });
  }, [openBin, compose]);
  const walked = useCallback(() => setTalk(current => current?.ends === 'walk' ? null : current), []);
  const nearby = useCallback((spot: Spot | null) => { setNear(spot); setTalk(current => current?.ends === 'leave' ? null : current); }, []);
  const naming = (!name || overlay === 'name') && !selection.category;
  const paused = !!overlay || !!selection.category || naming;
  // On touch screens the text box sits at the top, clear of the floor and the pad.
  const dialogue = talk && !paused && <Dialogue talk={talk} onDismiss={() => setTalk(null)} />;
  return <div className={`game ${touch ? 'touch' : ''}`}>
    <RoomCanvas room={room} ownIds={ownIds} look={look} name={name} selfId={selfId} visitors={visitors} pad={pad} paused={paused} beacon={beacon} onNearby={nearby} onUse={use} onWalk={walked} onMove={moveAs} />
    {!room && <div className="room-loading">Getting the mailroom ready<span className="loading-dots">…</span></div>}
    <header className="hud-top">
      <h1 className="brand"><span className="brand-mark"><EnvelopeIcon /></span><span>jev’s mailroom<span className="brand-period">.</span></span></h1>
      <span className="room-live"><span className="visitors"><Sprite data={PERSON} size={2} /> {room ? `${room.online} here` : '…'}</span></span>
      <button className="start-button" onClick={() => setOverlay('menu')}>MENU</button>
    </header>
    <div className="hud-notices">
      {touch && dialogue}
      {latest && !receiptHidden && <Receipt receipt={latest} openBin={openBin} />}
      {roomError && <div className="connection-warning" role="status">{roomError}</div>}
    </div>
    {!paused && <div className="hud-bottom">
      {!touch && dialogue}
      {near && <button className="prompt" onClick={() => use(near)}><span className="key">{touch ? 'A' : 'SPACE'}</span>{promptFor(near)}</button>}
    </div>}
    {touch && !paused && <TouchPad pad={pad} onUse={() => { pad.current.use = true; }} />}
    {overlay === 'menu' && <MenuPanel room={room} touch={touch} name={name} onClose={closeWindow} onCompose={compose} onBin={openBin} onRename={() => setOverlay('name')} />}
    {naming && <NamePanel current={name} look={look} onClose={name ? closeWindow : undefined} onDone={named} />}
    {overlay === 'compose' && identity && <ComposePanel identity={identity} onClose={closeWindow} onSent={sent} />}
    {selection.category && <HistoryPanel category={selection.category} highlight={selection.message} room={room} onSelect={openBin} onClose={closeBin} onCompose={compose} />}
  </div>;
}
