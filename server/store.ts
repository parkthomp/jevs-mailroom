import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { ActiveDelivery, Destination, JevDecision, JevLeg, SubmissionStatus } from '../shared/protocol.js';

export interface StoredMessage {
  id: string; text: string; submissionId: string; tokenHash: string;
  status: SubmissionStatus; createdAt: number; deliveredAt?: number;
  decision?: JevDecision; attempts: number; nextAttemptAt: number; claimedAt?: number;
  reason?: string;
  name?: string; // The sender's approved name tag. Absent on notes sent before names were attached.
}
export interface State {
  version: number; messages: StoredMessage[]; active: ActiveDelivery | null;
  jev?: JevLeg[]; // Absent in rooms saved before Jev planned his own route.
  budget: { date: string; calls: number };
}
const empty = (): State => ({ version: 1, messages: [], active: null, jev: [], budget: { date: '', calls: 0 } });
// Versions before the Bugs/Feedback rename stored the old public category keys. Convert them as
// storage opens so snapshots, receipts, active deliveries, and Jev's route all use the new schema.
const legacyDestination = (value: unknown): Destination | undefined =>
  value === 'compliments' || value === 'complaints' ? 'feedback' : undefined;
function migrateLegacyCategories(state: State): boolean {
  let changed = false;
  for (const message of state.messages) {
    if (!message.decision) continue;
    const destination = legacyDestination((message.decision as { destination: unknown }).destination);
    if (destination) { message.decision = { ...message.decision, destination }; changed = true; }
  }
  if (state.active) {
    const destination = legacyDestination((state.active as { destination: unknown }).destination);
    if (destination) { state.active = { ...state.active, destination }; changed = true; }
  }
  state.jev = (state.jev ?? []).map(leg => {
    const destination = legacyDestination((leg as { destination?: unknown }).destination);
    if (!destination) return leg;
    changed = true; return { ...leg, destination };
  });
  return changed;
}
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
      // A freshly created service's private network, or a database that is still starting, can
      // briefly refuse connections. Wait it out instead of crash-looping and failing the deploy.
      for (let attempt = 1; ; attempt++) {
        try { await this.createSchema(this.pool); break; }
        catch (error) {
          if (attempt >= 10) throw error;
          const code = (error as NodeJS.ErrnoException).code || 'error';
          console.warn(`Database not reachable yet (${code}); retrying in ${attempt * 2}s.`);
          await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        }
      }
      await this.mutate(state => { if (migrateLegacyCategories(state)) state.version++; });
      return;
    }
    try { this.state = JSON.parse(await readFile(this.path, 'utf8')) as State; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.mutate(state => { if (migrateLegacyCategories(state)) state.version++; });
  }
  private async createSchema(pool: pg.Pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(745312905)');
      await client.query('CREATE TABLE IF NOT EXISTS jev_room (id integer PRIMARY KEY CHECK (id = 1), state jsonb NOT NULL)');
      await client.query('INSERT INTO jev_room (id, state) VALUES (1, $1) ON CONFLICT DO NOTHING', [JSON.stringify(empty())]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
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
