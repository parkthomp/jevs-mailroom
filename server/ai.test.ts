import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { aiMode, decideMessage } from './ai.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.AI_MODE;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_SCREENING_MODEL;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});
function live(responses: unknown[]) {
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'test/classifier';
  process.env.OPENROUTER_SCREENING_MODEL = 'test/screener';
  const requests: Record<string, any>[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const content = responses.shift();
    if (content instanceof Response) return content;
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: 200 });
  };
  return requests;
}

test('local demo is deterministic and offers an explicit safe trash fixture', async () => {
  assert.equal(aiMode(), 'demo');
  assert.equal((await decideMessage('I love the mailroom')).destination, 'compliments');
  assert.equal((await decideMessage('Please add dark mode')).destination, 'ideas');
  assert.equal((await decideMessage('This is broken')).destination, 'complaints');
  assert.equal((await decideMessage('What time is it?')).destination, 'misc');
  assert.equal((await decideMessage('[trash] test envelope')).destination, 'trash');
});
test('production refuses to silently use demo, including explicit demo', () => {
  process.env.NODE_ENV = 'production';
  assert.throws(aiMode, /OPENROUTER_API_KEY/);
  process.env.AI_MODE = 'demo';
  assert.throws(aiMode, /development-only/);
});
test('partial live configuration fails clearly', () => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  assert.throws(aiMode, /OPENROUTER_MODEL/);
});
test('negative feedback is published and screened independently of the reaction', async () => {
  const requests = live([
    { publishable: true, reason: 'none' },
    { category: 'complaints', reaction: 'A rough edge worth recording.' },
    { publishable: true, reason: 'none' },
  ]);
  assert.deepEqual(await decideMessage('The page is painfully slow.'), { destination: 'complaints', reaction: 'A rough edge worth recording.' });
  assert.deepEqual(requests.map((request) => request.model), ['test/screener', 'test/classifier', 'test/screener']);
  for (const request of requests) {
    assert.equal(request.provider.require_parameters, true);
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
  }
});
test('rejected message bypasses classification and never enters the public reaction', async () => {
  const requests = live([{ publishable: false, reason: 'private_info' }]);
  const result = await decideMessage('private fixture content');
  assert.equal(requests.length, 1);
  assert.deepEqual(result, { destination: 'trash', reaction: 'This one goes in the trash.', reason: 'This message appears to contain private information or credentials.' });
  assert.ok(!result.reaction.includes('private fixture content'));
});
test('unsafe generated reaction falls back without discarding the accepted message', async () => {
  live([{ publishable: true, reason: 'none' }, { category: 'ideas', reaction: 'unsafe fixture' }, { publishable: false, reason: 'abuse' }]);
  assert.deepEqual(await decideMessage('An idea'), { destination: 'ideas', reaction: 'A fresh idea for the collection!' });
});
test('unavailable reaction screening uses a safe acknowledgment', async () => {
  live([{ publishable: true, reason: 'none' }, { category: 'ideas', reaction: 'New idea!' }, new Response('', { status: 503 })]);
  assert.equal((await decideMessage('An idea')).reaction, 'A fresh idea for the collection!');
});
test('malformed screening and invalid categories fail closed for worker retry', async () => {
  live(['not json']);
  await assert.rejects(decideMessage('hello'), /invalid message_screening/);
  live([{ publishable: true, reason: 'none' }, { category: 'trash', reaction: 'bad enum' }]);
  await assert.rejects(decideMessage('hello'), /invalid message_category/);
});
test('provider failures do not leak provider response bodies or silently classify', async () => {
  const requests = live([new Response('sensitive provider details', { status: 429 })]);
  await assert.rejects(decideMessage('hello'), (error: Error) => /HTTP 429/.test(error.message) && !error.message.includes('sensitive'));
  assert.equal(requests.length, 1);
});
test('network timeout fails without leaking raw error details', async () => {
  live([]);
  globalThis.fetch = async () => { throw new Error('secret diagnostic'); };
  await assert.rejects(decideMessage('hello'), (error: Error) => /in time/.test(error.message) && !error.message.includes('secret'));
});
