import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Category } from '../shared/protocol.js';
import { aiMode, decideMessage, REACTIONS } from './ai.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.AI_MODE;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});
const HAZARDS = ['abuse', 'private_info', 'explicit', 'spam', 'threats'] as const;
// Builds a System One response; every hazard defaults to clearly absent.
function jev(category: string, reaction: string, hazards: Partial<Record<typeof HAZARDS[number], number>> = {}) {
  const choice = (value: string) => ({ type: 'choice', choice: value, probabilities: { [value]: 1 }, confidence: 1 });
  return { model: 'typesafe/jev-1.13-20260917', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
    ...Object.fromEntries(HAZARDS.map(hazard => [hazard, { type: 'noul', noul: hazards[hazard] ?? 0.02 }])),
    category: choice(category),
    ...Object.fromEntries(['compliments', 'ideas', 'complaints', 'misc'].map(bin => [`reaction_${bin}`, choice(bin === category ? reaction : REACTIONS[bin as Category][0])])),
  } };
}
function live(responses: unknown[]) {
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'typesafe/jev-1.13';
  const requests: { url: string; body: Record<string, any> }[] = [];
  globalThis.fetch = async (url, init) => {
    // Real fetch rejects non-ByteString header values (e.g. a curly apostrophe) before sending.
    new Headers(init?.headers);
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const content = responses.shift();
    if (content instanceof Response) return content;
    return new Response(typeof content === 'string' ? content : JSON.stringify(content), { status: 200 });
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
test('negative feedback is published with one System One call and a pre-written reaction', async () => {
  const requests = live([jev('complaints', 'Thanks for telling me straight.')]);
  assert.deepEqual(await decideMessage('The page is painfully slow.'), { destination: 'complaints', reaction: 'Thanks for telling me straight.' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(requests[0].body.model, 'typesafe/jev-1.13');
  // The message travels only as state, never inside a question.
  assert.deepEqual(requests[0].body.state, { message: 'The page is painfully slow.' });
  assert.doesNotMatch(JSON.stringify(requests[0].body.questions), /painfully/);
  assert.deepEqual(Object.keys(requests[0].body.questions.category.criteria), ['compliments', 'ideas', 'complaints', 'misc']);
  assert.deepEqual(Object.keys(requests[0].body.questions.reaction_complaints.criteria), REACTIONS.complaints);
});
test('a likely hazard discards privately with the strongest reason', async () => {
  live([jev('misc', REACTIONS.misc[0], { spam: 0.75, private_info: 0.93 })]);
  const result = await decideMessage('private fixture content');
  assert.deepEqual(result, { destination: 'trash', reaction: 'This one goes in the trash.', reason: 'This message appears to contain private information or credentials.' });
  assert.ok(!result.reaction.includes('private fixture content'));
});
test('hazards below the threshold are published', async () => {
  live([jev('ideas', REACTIONS.ideas[1], { abuse: 0.69 })]);
  assert.equal((await decideMessage('An idea')).destination, 'ideas');
});
test('an unknown reaction falls back to the bin’s standard line', async () => {
  live([jev('ideas', 'unsafe fixture')]);
  assert.deepEqual(await decideMessage('An idea'), { destination: 'ideas', reaction: 'A fresh idea for the collection!' });
});
test('malformed answers and invalid categories fail closed for worker retry', async () => {
  live(['not json']);
  await assert.rejects(decideMessage('hello'), /invalid decision/);
  live([jev('trash', 'bad enum')]);
  await assert.rejects(decideMessage('hello'), /invalid decision/);
  const missing = jev('ideas', REACTIONS.ideas[0]);
  delete (missing.answers as Record<string, unknown>).threats;
  live([missing]);
  await assert.rejects(decideMessage('hello'), /invalid decision/);
});
test('provider failures do not leak provider response bodies or silently classify', async () => {
  const requests = live([new Response('sensitive provider details', { status: 429 })]);
  await assert.rejects(decideMessage('hello'), (error: Error) => /HTTP 429/.test(error.message) && !error.message.includes('sensitive'));
  assert.equal(requests.length, 1);
});
test('network timeout fails without leaking raw error details', async () => {
  live([]);
  globalThis.fetch = async () => { throw new DOMException('secret diagnostic', 'TimeoutError'); };
  await assert.rejects(decideMessage('hello'), (error: Error) => /in time/.test(error.message) && !error.message.includes('secret'));
  globalThis.fetch = async () => { throw new TypeError('secret diagnostic'); };
  await assert.rejects(decideMessage('hello'), (error: Error) => /could not send/.test(error.message) && !error.message.includes('secret'));
});
