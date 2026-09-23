import 'dotenv/config';
import { Store } from './store.js';
const store = new Store();
await store.init();
await store.close();
console.log('Mailroom storage is ready.');
