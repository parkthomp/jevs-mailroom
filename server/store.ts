import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { ActiveDelivery, JevDecision, SubmissionStatus } from '../shared/protocol.js';

export interface StoredMessage {
  id: string; text: string; submissionId: string; tokenHash: string;
  status: SubmissionStatus; createdAt: number; deliveredAt?: number;
  decision?: JevDecision; attempts: number; nextAttemptAt: number; claimedAt?: number;
  reason?: string;
}
export interface State {
  version: number; messages: StoredMessage[]; active: ActiveDelivery | null;
  budget: { date: string; calls: number };
}
const empty = (): State => ({ version: 1, messages: [], active: null, budget: { date: '', calls: 0 } });
export class Store {
  readonly pool: pg.Pool | undefined;
  private state = empty();
  private serial: Promise<unknown> = Promise.resolve();
  private path = resolve(process.env.DATA_FILE || '.data/state.json');
  constructor() {
    if (process.env.DATABASE_URL) {
      this.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
      this.pool.on('error', () => console.warn('A database connection closed; the pool will reconnect.'));
    }
  }
  async init() {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(745312905)');
        await client.query('CREATE TABLE IF NOT EXISTS jev_room (id integer PRIMARY KEY CHECK (id = 1), state jsonb NOT NULL)');
        await client.query('INSERT INTO jev_room (id, state) VALUES (1, $1) ON CONFLICT DO NOTHING', [JSON.stringify(empty())]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } else {
      try { this.state = JSON.parse(await readFile(this.path, 'utf8')) as State; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  async read(): Promise<State> {
    if (this.pool) return (await this.pool.query('SELECT state FROM jev_room WHERE id = 1')).rows[0].state as State;
    await this.serial;
    return structuredClone(this.state);
  }
  async mutate<T>(fn: (state: State) => T): Promise<T> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const state = (await client.query('SELECT state FROM jev_room WHERE id = 1 FOR UPDATE')).rows[0].state as State;
        const before = JSON.stringify(state);
        const result = fn(state);
        const after = JSON.stringify(state);
        if (before !== after) await client.query('UPDATE jev_room SET state = $1 WHERE id = 1', [after]);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const operation = this.serial.then(async () => {
      const next = structuredClone(this.state);
      const result = fn(next);
      if (JSON.stringify(next) === JSON.stringify(this.state)) return result;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      this.state = next;
      return result;
    });
    this.serial = operation.catch(() => undefined);
    return operation;
  }
  async healthy() { if (this.pool) await this.pool.query('SELECT 1'); else await this.read(); }
  async close() { await this.serial; await this.pool?.end(); }
}
