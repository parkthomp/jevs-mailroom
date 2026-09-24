import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startEngine } from '../server/engine.js';
import { Store } from '../server/store.js';
import { progress, snapshot, submit } from '../server/room.js';

async function eventually(check: () => Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Expected room transition did not occur in time');
}

test('worker sorts valid criticism, discards privately, and recovers an unfinished delivery once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-engine-test-'));
  const keys = ['DATA_FILE', 'DATABASE_URL', 'REDIS_URL', 'AI_MODE', 'NODE_ENV', 'DAILY_AI_LIMIT'] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DATA_FILE = join(directory, 'state.json');
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  process.env.AI_MODE = 'demo';
  process.env.NODE_ENV = 'test';
  process.env.DAILY_AI_LIMIT = '100';
  let store = new Store();
  let stop: (() => Promise<void>) | undefined;
  try {
    await store.init();
    const bug = await submit(store, 'The form is broken and slow.', 'bug', 'ADA');
    const discarded = await submit(store, '[trash] PRIVATE_FIXTURE_DO_NOT_PUBLISH', 'screened', 'ADA');
    stop = await startEngine(store);
    await eventually(async () => {
      const state = await store.read();
      return progress(state, bug.id, bug.token).status === 'delivered' && progress(state, discarded.id, discarded.token).status === 'discarded';
    }, 15000);
    const room = snapshot(await store.read(), 1, 'demo');
    assert.equal(room.counts.feedback, 1);
    assert.equal(room.recent.length, 1);
    assert.equal(room.recent[0].name, 'ADA', 'published notes carry their sender’s name');
    assert.doesNotMatch(JSON.stringify(room), /PRIVATE_FIXTURE/);
    await stop(); stop = undefined;

    const recovery = await submit(store, 'A saved idea', 'recover', 'ADA');
    await store.mutate(state => {
      const item = state.messages.find(item => item.id === recovery.id)!;
      item.status = 'delivering';
      item.decision = { destination: 'big_ideas', reaction: 'Saved for later!' };
      state.active = { id: item.id, destination: 'big_ideas', reaction: 'Saved for later!', endsAt: 4 };
      state.version++;
    });
    await store.close();
    store = new Store();
    await store.init();
    stop = await startEngine(store);
    await eventually(async () => progress(await store.read(), recovery.id, recovery.token).status === 'delivered');
    await new Promise(resolve => setTimeout(resolve, 350));
    const recovered = snapshot(await store.read(), 1, 'demo');
    assert.equal(recovered.counts.big_ideas, 1);
    assert.equal(recovered.recent.filter(item => item.id === recovery.id).length, 1);
    assert.equal(recovered.active, null);
  } finally {
    await stop?.();
    await store.close();
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});

test('the worker re-sorts old published and discarded mail once and keeps original dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-resort-engine-'));
  const env = { ...process.env };
  process.env.DATA_FILE = join(directory, 'state.json');
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  process.env.AI_MODE = 'demo';
  process.env.NODE_ENV = 'test';
  process.env.DAILY_AI_LIMIT = '100';
  let store = new Store();
  let stop: (() => Promise<void>) | undefined;
  try {
    await store.init();
    const fixtures = [
      ['May the Force be with you', 'delivered', 'important'],
      ['Buy now! test', 'discarded', 'spam'],
      ['[trash] PRIVATE_HARMFUL_FIXTURE', 'discarded', 'trash'],
    ] as const;
    const receipts = [];
    for (const [text, status] of fixtures) {
      const receipt = await submit(store, text, text, 'ADA');
      receipts.push(receipt);
      await store.mutate(state => {
        const message = state.messages.find(item => item.id === receipt.id)!;
        message.status = status;
        message.deliveredAt = 100;
        message.decision = { destination: status === 'discarded' ? 'trash' : 'feedback', reaction: 'Old reaction' };
      });
    }
    stop = await startEngine(store);
    await eventually(async () => (await store.read()).messages.every(item => ['delivered', 'discarded'].includes(item.status)), 15000);
    const sorted = await store.read();
    assert.deepEqual(sorted.messages.map(item => item.decision?.destination), fixtures.map(item => item[2]));
    assert.deepEqual(sorted.messages.map(item => item.deliveredAt), [100, 100, 100]);
    assert.deepEqual(sorted.messages.map(item => item.name), ['ADA', 'ADA', 'ADA']);
    assert.equal(progress(sorted, receipts[1].id, receipts[1].token).status, 'delivered');
    assert.doesNotMatch(JSON.stringify(snapshot(sorted, 0, 'demo')), /PRIVATE_HARMFUL/);
    const calls = sorted.budget.calls;
    await stop(); stop = undefined;
    await store.close();
    store = new Store();
    await store.init();
    stop = await startEngine(store);
    await new Promise(resolve => setTimeout(resolve, 450));
    const restarted = await store.read();
    assert.equal(restarted.budget.calls, calls, 'restart must not classify the archive again');
    assert.deepEqual(restarted.messages, JSON.parse(JSON.stringify(sorted.messages)));
  } finally {
    await stop?.(); await store.close();
    process.env = env;
    await rm(directory, { recursive: true, force: true });
  }
});
