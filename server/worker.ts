import 'dotenv/config';
import { Store } from './store.js';
import { startEngine } from './engine.js';
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) throw new Error('The separate worker requires DATABASE_URL and REDIS_URL. Use npm run dev for the embedded local worker.');
const store = new Store();
await store.init();
const stop = await startEngine(store);
let closing = false;
async function shutdown() { if (closing) return; closing = true; await stop(); await store.close(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.log('Jev background worker is ready.');
