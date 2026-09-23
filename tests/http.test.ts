import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { RoomSnapshot, SubmissionReceipt } from '../shared/protocol.js';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function until(check: () => Promise<boolean>, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  assert.fail('HTTP integration condition timed out');
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(kill); }
}

test('HTTP + WebSockets share a durable room and never disclose a discarded message', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-http-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_FILE: join(directory, 'state.json'), AI_MODE: 'demo', NODE_ENV: 'test', DELIVERY_DURATION_MS: '150', DATABASE_URL: '', REDIS_URL: '', RECEIPT_SECRET: 'integration-test-secret-that-is-not-used-elsewhere' };
  let output = '';
  const start = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    return child;
  };
  let child = start();
  const sockets: WebSocket[] = [];
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
      return fetch(`${base}/healthz`).then(response => response.ok).catch(() => false);
    });
    const invalid = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ', clientSubmissionId: 'empty' }) });
    assert.equal(invalid.status, 400);
    const views: RoomSnapshot[][] = [[], []];
    for (const records of views) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      sockets.push(socket);
      socket.on('message', data => { const event = JSON.parse(data.toString()); if (event.type === 'snapshot') records.push(event.room); });
      await once(socket, 'open');
    }
    const post = async (text: string, clientSubmissionId: string) => {
      const response = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, clientSubmissionId }) });
      assert.ok(response.ok, `Submit failed ${response.status}: ${await response.clone().text()}`);
      return response.json() as Promise<SubmissionReceipt>;
    };
    const receipt = await post('Please add a sunny garden.', 'http-idea-submission-0001');
    const duplicate = await post('Please add a sunny garden.', 'http-idea-submission-0001');
    assert.equal(receipt.id, duplicate.id);
    const trash = await post('[trash] PRIVATE_HTTP_MESSAGE', 'http-trash-submission-0001');
    const unauthorized = await fetch(`${base}/api/submissions/${trash.id}`);
    assert.ok([401, 404].includes(unauthorized.status));
    await until(async () => {
      const response = await fetch(`${base}/api/submissions/${trash.id}`, { headers: { 'x-receipt-token': trash.token } });
      return (await response.json()).status === 'discarded';
    });
    await until(async () => views.every(records => records.some(room => room.counts.ideas === 1)));
    assert.doesNotMatch(JSON.stringify(views), /PRIVATE_HTTP_MESSAGE/);
    assert.equal((await fetch(`${base}/api/messages/${trash.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/bins/trash/messages`)).status, 404);
    const page = await (await fetch(`${base}/api/bins/ideas/messages`)).json();
    assert.equal(page.total, 1);
    assert.equal(page.messages[0].text, 'Please add a sunny garden.');
    assert.equal((await (await fetch(`${base}/api/messages/${receipt.id}`)).json()).id, receipt.id);
    sockets.forEach(socket => socket.close());
    await stopChild(child);
    child = start();
    await until(async () => fetch(`${base}/healthz`).then(response => response.ok).catch(() => false));
    const recovered = await (await fetch(`${base}/api/room`)).json();
    assert.equal(recovered.counts.ideas, 1);
    assert.equal(recovered.active, null);
  } finally {
    sockets.forEach(socket => socket.terminate());
    await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});
