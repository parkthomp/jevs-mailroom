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
  const keys = ['DATA_FILE', 'DATABASE_URL', 'REDIS_URL', 'AI_MODE', 'NODE_ENV', 'JEV_PAUSE_MS', 'DAILY_AI_LIMIT'] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DATA_FILE = join(directory, 'state.json');
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  process.env.AI_MODE = 'demo';
  process.env.NODE_ENV = 'test';
  process.env.JEV_PAUSE_MS = '50';
  process.env.DAILY_AI_LIMIT = '100';
  let store = new Store();
  let stop: (() => Promise<void>) | undefined;
  try {
    await store.init();
    const complaint = await submit(store, 'The form is broken and slow.', 'complaint');
    const discarded = await submit(store, '[trash] PRIVATE_FIXTURE_DO_NOT_PUBLISH', 'screened');
    stop = await startEngine(store);
    await eventually(async () => {
      const state = await store.read();
      return progress(state, complaint.id, complaint.token).status === 'delivered' && progress(state, discarded.id, discarded.token).status === 'discarded';
    }, 15000);
    const room = snapshot(await store.read(), 1, 'demo');
    assert.equal(room.counts.complaints, 1);
    assert.equal(room.recent.length, 1);
    assert.doesNotMatch(JSON.stringify(room), /PRIVATE_FIXTURE/);
    await stop(); stop = undefined;

    const recovery = await submit(store, 'A saved idea', 'recover');
    await store.mutate(state => {
      const item = state.messages.find(item => item.id === recovery.id)!;
      item.status = 'delivering';
      item.decision = { destination: 'ideas', reaction: 'Saved for later!' };
      state.active = { id: item.id, destination: 'ideas', reaction: 'Saved for later!', endsAt: 4, doneAt: 4 };
      state.version++;
    });
    await store.close();
    store = new Store();
    await store.init();
    stop = await startEngine(store);
    await eventually(async () => progress(await store.read(), recovery.id, recovery.token).status === 'delivered');
    await new Promise(resolve => setTimeout(resolve, 350));
    const recovered = snapshot(await store.read(), 1, 'demo');
    assert.equal(recovered.counts.ideas, 1);
    assert.equal(recovered.recent.filter(item => item.id === recovery.id).length, 1);
    assert.equal(recovered.active, null);
  } finally {
    await stop?.();
    await store.close();
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
