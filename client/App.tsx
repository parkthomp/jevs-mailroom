import { useCallback, useEffect, useRef, useState } from 'react';
import { BIN_META, CATEGORIES, type BinPage, type Category, type PublicMessage, type RoomSnapshot, type SubmissionProgress, type SubmissionReceipt } from '../shared/protocol';
import { ARROW, BIN_ICONS, CHECK, CLOSE, DOWN, ENVELOPE, EXCLAIM, JEV_FACE, PERSON, Sprite, TRASH_ICON, UP } from './pixels';
import RoomCanvas from './RoomCanvas';

type SavedReceipt = SubmissionReceipt & { progress?: SubmissionProgress };
const STORAGE_KEY = 'jevs-mailroom-receipts-v1';
// 'failed' is not terminal: the worker keeps retrying it, so the receipt must keep polling.
const terminal = new Set(['delivered', 'discarded']);
const isCategory = (value: unknown): value is Category => CATEGORIES.includes(value as Category);
const countLabel = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error || data.message || 'Something went wrong. Please try again.');
  return data as T;
}
function readReceipts(): SavedReceipt[] {
  try { const result: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(result) ? result.filter(item => typeof item.id === 'string' && typeof item.token === 'string').slice(0, 8) : []; } catch { return []; }
}
function EnvelopeIcon({ className = '' }: { className?: string }) {
  return <Sprite data={ENVELOPE} className={className} />;
}
function Arrow() {
  return <Sprite data={ARROW} size={2} />;
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
function Dialogue({ line }: { line: string }) {
  const chars = Array.from(line), shown = useTypewriter(line, chars.length);
  return <div className="dialogue" aria-live="polite">
    <Sprite data={JEV_FACE} className="dialogue-face" />
    <p><span className="speaker">JEV</span><span className="sr-only">{line}</span><span aria-hidden="true">{chars.slice(0, shown).join('')}<span className="unrevealed">{chars.slice(shown).join('')}</span></span></p>
    {shown >= chars.length && <Sprite data={DOWN} size={2} className="dialogue-more" />}
  </div>;
}

function useRoom() {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false, socket: WebSocket | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
    const accept = (snapshot: RoomSnapshot) => {
      if (stopped) return;
      setRoom(current => !current || snapshot.version >= current.version ? snapshot : current);
      setError('');
    };
    const refresh = () => request<RoomSnapshot>('/api/room').then(accept).catch(() => { if (!stopped) setError('The mailroom is reconnecting. Your saved messages are safe.'); });
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socket.onopen = () => { if (!stopped) { setConnected(true); void refresh(); } };
      socket.onmessage = event => { try { const parsed = JSON.parse(event.data); if (parsed.type === 'snapshot' && parsed.room) accept(parsed.room); } catch { /* A later snapshot restores state. */ } };
      socket.onclose = () => { if (!stopped) { setConnected(false); reconnect = setTimeout(connect, 2000); } };
      socket.onerror = () => socket?.close();
    };
    void refresh(); connect();
    const interval = setInterval(refresh, 10000);
    return () => { stopped = true; clearInterval(interval); clearTimeout(reconnect); socket?.close(); };
  }, []);
  return { room, connected, error };
}

function Receipt({ receipt, openBin }: { receipt: SavedReceipt; openBin: (category: Category, id?: string) => void }) {
  const progress = receipt.progress;
  const status = progress?.status || receipt.status;
  const category = progress?.category;
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

function HistoryPanel({ category, highlight, room, onSelect, onClose }: { category: Category; highlight: string | null; room: RoomSnapshot | null; onSelect: (category: Category, id?: string) => void; onClose: () => void }) {
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newMessages, setNewMessages] = useState(false);
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const baseline = useRef<number | undefined>(undefined);
  const meta = BIN_META[category];
  const total = room?.counts[category] || 0;
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
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
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
  const share = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy the address from your browser to share this bin.'); }
  };
  return <div className="panel-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="history-panel" ref={panel} role="dialog" aria-modal="true" aria-labelledby="bin-title">
      <div className="panel-top"><span className="eyebrow">THE MESSAGE ARCHIVE</span><button className="icon-button" ref={closeButton} onClick={onClose} aria-label="Close message archive"><Sprite data={CLOSE} size={2} /></button></div>
      <div className="panel-heading"><span className="big-bin"><Sprite data={BIN_ICONS[category]} size={6} /></span><div><h2 id="bin-title">{meta.label}</h2><p>{meta.description}</p></div></div>
      <nav className="category-tabs" aria-label="Choose a bin">{CATEGORIES.map(key => <button key={key} onClick={() => onSelect(key)} aria-pressed={category === key} className={category === key ? 'selected' : ''}>{BIN_META[key].label}</button>)}</nav>
      <div className="archive-summary"><span>{countLabel(total)} · newest first</span><button className="text-button" onClick={share}>{copied ? 'Link copied!' : 'Copy link'} {!copied && <Arrow />}</button></div>
      {newMessages && <button className="new-messages" onClick={() => { scroll.current?.scrollTo({ top: 0, behavior: 'smooth' }); void refresh().catch(error => setError(error.message)); }}>New messages have arrived <Sprite data={UP} size={2} /></button>}
      <div className="message-list" ref={scroll}>
        {error && <div className="inline-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
        {loading && !messages.length && <div className="archive-empty"><span className="loading-dots">···</span><p>Opening the drawer…</p></div>}
        {!loading && !messages.length && !error && <div className="archive-empty"><EnvelopeIcon /><h3>A little room for your thoughts.</h3><p>No messages here yet. Send Jev a note and give this bin its first story.</p><button className="text-button" onClick={onClose}>Write a note <Arrow /></button></div>}
        {messages.map(message => <article key={message.id} className={`message-card ${message.id === highlight ? 'highlighted' : ''}`}>
          <div className="message-meta"><span>{message.id === highlight ? 'YOUR NOTE' : 'A NOTE FROM SOMEONE'}</span><time dateTime={new Date(message.deliveredAt).toISOString()}>{new Date(message.deliveredAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></div>
          <p className="message-body">{message.text}</p><div className="jev-reaction"><Sprite data={JEV_FACE} size={2} className="mini-face" /><span>{message.reaction}</span></div>
        </article>)}
        {cursor && <button className="load-more" onClick={loadMore} disabled={loading}>{loading ? 'Opening more mail…' : 'Load more messages'}</button>}
      </div>
      <div className="panel-footer"><span className="status-dot" /> Filed with care by Jev.</div>
    </aside>
  </div>;
}

export default function App() {
  const { room, connected, error: roomError } = useRoom();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [receipts, setReceipts] = useState<SavedReceipt[]>(readReceipts);
  const [selection, setSelection] = useState(() => { const params = new URLSearchParams(location.search); const value = params.get('bin'); return { category: isCategory(value) ? value : null, message: params.get('message') }; });
  const submission = useRef<{ text: string; id: string } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const total = CATEGORIES.reduce((sum, category) => sum + (room?.counts[category] || 0), 0);
  const ownIds = receipts.map(receipt => receipt.id);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(receipts.slice(0, 8))); } catch { /* In private storage modes the current session still works. */ } }, [receipts]);
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
  useEffect(() => {
    const pop = () => { const params = new URLSearchParams(location.search); const category = params.get('bin'); setSelection({ category: isCategory(category) ? category : null, message: params.get('message') }); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  const openBin = useCallback((category: Category, message?: string) => {
    const url = new URL(location.href); url.searchParams.set('bin', category); if (message) url.searchParams.set('message', message); else url.searchParams.delete('message');
    history.pushState({}, '', url); setSelection({ category, message: message || null });
  }, []);
  const closeBin = useCallback(() => { const url = new URL(location.href); url.searchParams.delete('bin'); url.searchParams.delete('message'); history.pushState({}, '', url); setSelection({ category: null, message: null }); }, []);
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); if (!text.trim() || sending) return;
    const clean = text.trim();
    if (submission.current?.text !== clean) submission.current = { text: clean, id: crypto.randomUUID() };
    setSending(true); setSendError('');
    try {
      const receipt = await request<SubmissionReceipt>('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clean, clientSubmissionId: submission.current.id }) });
      setReceipts(current => [receipt, ...current.filter(item => item.id !== receipt.id)].slice(0, 8)); setText(''); submission.current = null;
    } catch (error) { setSendError((error as Error).message); } finally { setSending(false); }
  };
  const active = room?.active;
  // The canvas interpolates exact server timing; this label remains deliberately simple.
  const activity = active ? active.destination === 'trash' ? 'Jev is taking out the trash' : `Jev is sorting a little mail` : room?.queue.length ? 'A few notes are being checked' : 'Jev is ready for your next note';
  return <div className="app-shell">
    <header className="site-header"><h1 className="brand-heading"><a href="/" className="brand"><span className="brand-mark"><EnvelopeIcon /></span><span>jev’s mailroom<span className="brand-period">.</span></span></a></h1><div className="header-right"><span className="room-live"><span className={`status-dot ${connected ? '' : 'offline'}`} />{connected ? 'THE MAILROOM IS OPEN' : 'CONNECTING TO THE MAILROOM'}</span></div></header>
    <main>
      <div className="main-layout">
        <section className="mailroom" aria-label="Shared live mailroom">
          <div className="bezel">
            <div className="room-toolbar"><span><span className={`power-led ${connected ? 'on' : ''}`} />LIVE FROM THE MAILROOM</span><span className="visitors"><Sprite data={PERSON} size={2} /> {room ? `${room.online} here now` : 'Opening the door…'}</span></div>
            <div className="canvas-wrap"><RoomCanvas room={room} ownIds={ownIds} onSelect={openBin} />{!room && <div className="room-loading">Getting the mailroom ready<span className="loading-dots">…</span></div>}</div>
            <div className="room-caption"><div className="activity"><span className={`activity-light ${active ? 'busy' : ''}`} /><span>{activity}</span></div><span className="queue-count">{room?.queue.length || 0} in the queue</span></div>
          </div>
          <Dialogue line={active ? active.reaction : room ? 'Got a note for me? I’ll find it a home!' : 'Just opening up the mailroom…'} />
          {roomError && <div className="connection-warning" role="status">{roomError}</div>}
          <div className="bin-grid">{CATEGORIES.map(category => <button key={category} className="bin-card" onClick={() => openBin(category)} aria-label={`Browse ${BIN_META[category].label}, ${countLabel(room?.counts[category] || 0)}`}>
            <span className="bin-icon"><Sprite data={BIN_ICONS[category]} size={4} /></span>
            <span className="bin-label"><Sprite data={ARROW} size={2} className="bin-cursor" />{BIN_META[category].label}</span><span className="bin-count">{countLabel(room?.counts[category] || 0)}</span>
          </button>)}</div>
        </section>
        <aside className="compose-column">
          <section className="composer"><h2>Send a little note.</h2>
            <form onSubmit={send}><label htmlFor="message" className="sr-only">Your message to Jev</label><div className="textarea-wrap"><textarea id="message" ref={textarea} value={text} onChange={event => setText(event.target.value)} placeholder={"Dear Jev,\nI’ve been thinking…"} maxLength={280} rows={5} required disabled={sending} aria-describedby="public-note character-count" /><span id="character-count" className={text.length > 260 ? 'character-count near-limit' : 'character-count'}>{text.length}<span> / 280</span></span></div>
              <button className="send-button" type="submit" disabled={!text.trim() || sending}>{sending ? 'Handing it to Jev…' : 'Send to Jev'}</button><p className="public-note" id="public-note"><Sprite data={EXCLAIM} size={2} /> Accepted notes are public. Leave out personal details.</p>{sendError && <p className="inline-error" role="alert">{sendError}</p>}
            </form>
          </section>
          {receipts[0] && <Receipt receipt={receipts[0]} openBin={openBin} />}
        </aside>
      </div>
      {room?.mode === 'demo' && <div className="demo-notice"><span>DEMO MODE</span> Jev is using local sorting rules. Connect OpenRouter to give him AI-powered judgment.</div>}
    </main>
    <footer className="site-footer"><span>{total} notes filed with care <Sprite data={BIN_ICONS.compliments} size={2} className="footer-flower" /></span></footer>
    {selection.category && <HistoryPanel category={selection.category} highlight={selection.message} room={room} onSelect={openBin} onClose={closeBin} />}
  </div>;
}
