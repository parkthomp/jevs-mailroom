import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { decideMessage, aiMode } from './ai.js';
import { spendBudget, TRASH_REACTION } from './room.js';
import { planJev } from './jev.js';
import type { Store } from './store.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function startEngine(store: Store) {
  aiMode();
  let stopping = false;
  let leader = !store.pool;
  let leadership: pg.PoolClient | undefined;
  let queue: Queue | undefined;
  let worker: Worker | undefined;
  const connections: Redis[] = [];
  const inflight = new Set<Promise<void>>();
  const concurrency = Math.max(1, Math.min(4, Number(process.env.AI_CONCURRENCY || 2)));
  const dispatched = new Map<string, number>();
  let detachLeaderError: (() => void) | undefined;

  const processMessage = async (id: string) => {
    if (!leader || stopping || inflight.size >= concurrency) return;
    const claim = await store.mutate(state => {
      if (!leader || stopping) return null;
      const message = state.messages.find(item => item.id === id);
      if (!message || !['pending_review', 'failed'].includes(message.status) || message.nextAttemptAt > Date.now()) return null;
      if (!spendBudget(state)) {
        message.status = 'failed'; message.reason = 'Jev has reached today’s processing limit. Your message is saved for tomorrow.';
        message.nextAttemptAt = Date.parse(`${state.budget.date}T00:00:00Z`) + 86_400_000;
        state.version++;
        return null;
      }
      message.attempts = message.attempts >= 5 ? 1 : message.attempts + 1; message.status = 'classifying'; message.claimedAt = Date.now();
      message.reason = undefined; state.version++;
      return { text: message.text, attempt: message.attempts };
    });
    if (!claim) return;
    try {
      const decision = await decideMessage(claim.text);
      await store.mutate(state => {
        if (!leader || stopping) return;
        const message = state.messages.find(item => item.id === id);
        if (!message || message.status !== 'classifying' || message.attempts !== claim.attempt) return;
        message.decision = decision.destination === 'trash' ? { ...decision, reaction: TRASH_REACTION } : decision;
        message.status = decision.destination === 'trash' ? 'ready_to_discard' : 'ready';
        message.reason = decision.destination === 'trash' ? decision.reason || 'This message did not meet the public mailroom guidelines.' : undefined;
        state.version++;
      });
    } catch (error) {
      await store.mutate(state => {
        if (!leader || stopping) return;
        const message = state.messages.find(item => item.id === id);
        if (!message || message.status !== 'classifying' || message.attempts !== claim.attempt) return;
        message.status = 'failed'; message.reason = 'Jev’s sorting service is taking a break. Your message is saved and will be retried.';
        message.nextAttemptAt = Date.now() + Math.min(300_000, 3000 * 2 ** Math.min(message.attempts - 1, 7));
        if (message.attempts >= 5) {
          message.nextAttemptAt = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000;
          message.reason = 'Jev could not check this message after five attempts. It is saved for another try tomorrow.';
        }
        state.version++;
      });
      // decideMessage only throws fixed, sanitized messages (never message text or provider bodies),
      // so the cause is safe to log. Without it, a bad key or model fails silently forever.
      console.warn(JSON.stringify({ event: 'classification_delayed', id, attempt: claim.attempt, error: error instanceof Error ? error.message : 'unknown' }));
    }
  };
  const launch = (id: string) => {
    const task = processMessage(id).catch(error => console.error('Message processing failed:', error instanceof Error ? error.name : 'unknown'));
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
    return task;
  };

  if (process.env.REDIS_URL) {
    const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    const workerConnection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    connections.push(connection, workerConnection);
    for (const redis of connections) redis.on('error', () => { /* Postgres reconciliation remains authoritative. */ });
    queue = new Queue('jev-review', { connection });
    queue.on('error', () => {});
    worker = new Worker('jev-review', async job => { if (leader && inflight.size < concurrency) await launch(String(job.data.id)); }, { connection: workerConnection, concurrency });
    worker.on('error', () => {});
  }

  const run = async () => {
    let lastErrorAt = 0;
    while (!stopping) {
      try {
        if (!leader && store.pool) {
          const client = await store.pool.connect();
          const onError = () => { leader = false; if (leadership === client) { leadership = undefined; client.removeListener('error', onError); client.release(true); } };
          client.on('error', onError);
          try {
            const result = await client.query('SELECT pg_try_advisory_lock(745312904) AS acquired');
            if (result.rows[0].acquired) { leader = true; leadership = client; detachLeaderError = () => client.removeListener('error', onError); console.log('Jev room coordinator acquired leadership.'); }
            else { client.removeListener('error', onError); client.release(); }
          } catch (error) { client.removeListener('error', onError); client.release(true); throw error; }
        }
        if (leader) {
          // Pending rows are the durable outbox. Jobs/notifications are hints; a Redis outage cannot lose mail.
          await store.mutate(state => {
            if (!leader || stopping) return;
            const now = Date.now();
            for (const message of state.messages) {
              if (message.status === 'classifying' && (message.claimedAt || 0) < now - 120_000) {
                message.status = 'failed'; message.nextAttemptAt = now; message.reason = 'Jev is picking up your saved message after a restart.'; state.version++;
              }
            }
            planJev(state, now);
          });
          const state = await store.read();
          const candidates = state.messages.filter(item => ['pending_review', 'failed'].includes(item.status) && item.nextAttemptAt <= Date.now());
          for (const message of candidates) {
            const firstDispatch = dispatched.get(message.id);
            if (queue && !firstDispatch) {
              dispatched.set(message.id, Date.now());
              void queue.add('review', { id: message.id }, { jobId: `${message.id}-${message.attempts}`, removeOnComplete: true, removeOnFail: true }).catch(() => {});
            }
            // Reconcile unclaimed jobs after a grace period when Redis is unavailable or a job hint was lost.
            if ((!queue || (firstDispatch && firstDispatch < Date.now() - 5000)) && inflight.size < concurrency) void launch(message.id);
          }
          for (const [id, at] of dispatched) if (at < Date.now() - 60_000) dispatched.delete(id);
        }
      } catch (error) {
        if (Date.now() - lastErrorAt > 10_000) { console.error('Coordinator waiting for storage:', error instanceof Error ? error.name : 'unknown'); lastErrorAt = Date.now(); }
      }
      await sleep(200);
    }
  };
  const loop = run();
  return async () => {
    stopping = true;
    await loop;
    await worker?.close(true);
    await Promise.allSettled([...inflight]);
    await queue?.close();
    for (const connection of connections) connection.disconnect();
    if (leadership) { const client = leadership; await client.query('SELECT pg_advisory_unlock(745312904)').catch(() => {}); detachLeaderError?.(); if (leadership === client) { leadership = undefined; client.release(); } }
  };
}
