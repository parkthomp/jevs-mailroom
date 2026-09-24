import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { queueCategoryResort } from '../server/resort.js';
import { Store, type State, type StoredMessage } from '../server/store.js';
import { approveName, asPublic, binPage, progress, snapshot, submit, validPass } from '../server/room.js';

const message = (id: string, overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  id, submissionId: id, tokenHash: '', text: `A thoughtful idea ${id}`,
  status: 'delivered', createdAt: 10, deliveredAt: 100,
  attempts: 1, nextAttemptAt: 0,
  decision: { destination: 'big_ideas', reaction: 'An idea for the next update!' },
  ...overrides,
});
const stateWith = (messages: StoredMessage[]): State => ({
  version: 5, messages, active: null, budget: { date: '', calls: 0 },
});

test('private submissions and discarded content never appear in public history or snapshots', () => {
  const state = stateWith([
    message('published'),
    message('checking', { text: 'PRIVATE_UNREVIEWED', status: 'pending_review', decision: undefined }),
    message('trash', { text: 'PRIVATE_DISCARDED', status: 'discarded', decision: { destination: 'trash', reaction: 'PRIVATE_REACTION', reason: 'PRIVATE_REASON' } }),
  ]);
  state.active = { id: 'trash', destination: 'trash', reaction: 'PRIVATE_REACTION', endsAt: 4 };
  const room = snapshot(state, 2, 'demo');
  assert.equal(room.counts.big_ideas, 1);
  assert.equal(room.recent.length, 1);
  assert.deepEqual(room.queue, [{ id: 'checking' }]);
  assert.equal(room.active?.reaction, 'This one goes in the trash.');
  assert.doesNotMatch(JSON.stringify(room), /PRIVATE_/);
  assert.equal(asPublic(state.messages[2]), null);
  assert.equal(binPage(state, 'big_ideas').total, 1);
});

test('bin pagination handles matching timestamps and newly delivered messages without repeats', () => {
  const state = stateWith(Array.from({ length: 47 }, (_, i) => message(String(i).padStart(3, '0'))));
  const first = binPage(state, 'big_ideas');
  assert.equal(first.messages.length, 20);
  assert.ok(first.nextCursor);
  state.messages.push(message('new', { deliveredAt: 200 }));
  const second = binPage(state, 'big_ideas', first.nextCursor!);
  const third = binPage(state, 'big_ideas', second.nextCursor!);
  const ids = [...first.messages, ...second.messages, ...third.messages].map(item => item.id);
  assert.equal(ids.length, 47);
  assert.equal(new Set(ids).size, 47);
  assert.equal(third.nextCursor, null);
  assert.equal(binPage(state, 'feedback').total, 0);
  assert.throws(() => binPage(state, 'big_ideas', 'broken'), /Invalid page cursor/);
});

test('concurrent submissions are durable and idempotent, and receipts authorize private status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-store-test-'));
  const oldFile = process.env.DATA_FILE;
  const oldDatabase = process.env.DATABASE_URL;
  process.env.DATA_FILE = join(directory, 'state.json');
  delete process.env.DATABASE_URL;
  let store = new Store();
  try {
    await store.init();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => submit(store, 'Please add a garden.', 'same-submission', 'ADA')));
    assert.equal(new Set(receipts.map(item => item.id)).size, 1);
    assert.equal(new Set(receipts.map(item => item.token)).size, 1);
    const receipt = receipts[0];
    await assert.rejects(submit(store, 'Different text', 'same-submission', 'ADA'), /different message/);
    const state = await store.read();
    assert.equal(state.messages.length, 1);
    assert.throws(() => progress(state, receipt.id, 'incorrect'), /Receipt not found/);
    assert.equal(progress(state, receipt.id, receipt.token).status, 'pending_review');
    await store.close();
    store = new Store();
    await store.init();
    const recovered = await store.read();
    assert.equal(recovered.messages[0].text, 'Please add a garden.');
    assert.equal(progress(recovered, receipt.id, receipt.token).id, receipt.id);
    assert.equal((await submit(store, 'Please add a garden.', 'same-submission', 'ADA')).id, receipt.id);
  } finally {
    await store.close();
    if (oldFile === undefined) delete process.env.DATA_FILE; else process.env.DATA_FILE = oldFile;
    if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase;
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy storage waits for coordinator re-sort and never exposes obsolete bins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-category-migration-test-'));
  const oldFile = process.env.DATA_FILE;
  const oldDatabase = process.env.DATABASE_URL;
  const path = join(directory, 'state.json');
  process.env.DATA_FILE = path;
  delete process.env.DATABASE_URL;
  await writeFile(path, JSON.stringify({
    version: 8,
    messages: [
      { ...message('praise'), decision: { destination: 'compliments', reaction: 'Thanks!' } },
      { ...message('criticism'), decision: { destination: 'complaints', reaction: 'Noted!' } },
    ],
    active: { id: 'criticism', destination: 'complaints', reaction: 'Noted!', endsAt: 10 },
    jev: [{ kind: 'drop', path: [[190, 56]], from: 0, to: 10, destination: 'complaints', carrying: 'criticism' }],
    budget: { date: '', calls: 0 },
  }));
  const store = new Store();
  try {
    await store.init();
    const state = await store.read();
    assert.deepEqual(state.messages.map(item => item.decision?.destination), ['compliments', 'complaints']);
    assert.equal(state.version, 8, 'opening storage must not alter categories under the old worker');
    const publicRoom = snapshot(state, 0, 'live');
    assert.equal(publicRoom.recent.length, 1);
    assert.equal(publicRoom.active, null);
    assert.deepEqual(publicRoom.jev, []);
    await store.mutate(queueCategoryResort);
    const queued = await store.read();
    assert.ok(queued.messages.every(item => item.status === 'pending_review' && !item.decision));
    assert.equal(queued.active, null);
    assert.deepEqual(queued.jev, []);
    assert.equal(queued.version, 9);
  } finally {
    await store.close();
    if (oldFile === undefined) delete process.env.DATA_FILE; else process.env.DATA_FILE = oldFile;
    if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase;
    await rm(directory, { recursive: true, force: true });
  }
});

test('names Jev approves come back cleaned with a pass; turned-away names and forged passes do not', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-names-test-'));
  const env = { ...process.env };
  process.env.DATA_FILE = join(directory, 'state.json');
  delete process.env.DATABASE_URL;
  process.env.AI_MODE = 'demo';
  const store = new Store();
  try {
    await store.init();
    const approved = await approveName(store, ' ada’s  bot! ');
    assert.equal(approved.name, "ADA'S BOT!");
    assert.ok(validPass(approved.name, approved.pass));
    assert.ok(!validPass('SOMEONE ELSE', approved.pass), 'a pass only vouches for its own name');
    assert.ok(!validPass(approved.name, 'forged') && !validPass(approved.name, undefined));
    await assert.rejects(approveName(store, 'trash panda'), (error: Error & { status?: number }) => error.status === 422 && /TRASH/.test(error.message));
    await assert.rejects(approveName(store, '<>'), (error: Error & { status?: number }) => error.status === 400);
    assert.equal((await store.read()).budget.calls, 2, 'each new name costs one check');
    await approveName(store, "ada's bot!");
    assert.equal((await store.read()).budget.calls, 2, 'a name Jev already judged is not asked about again');
    process.env.DAILY_AI_LIMIT = '2';
    await assert.rejects(approveName(store, 'grace'), (error: Error & { status?: number }) => error.status === 503);
  } finally {
    await store.close();
    process.env = env;
    await rm(directory, { recursive: true, force: true });
  }
});
