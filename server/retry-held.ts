import 'dotenv/config';
import { Store } from './store.js';
// Releases failed messages that are waiting for tomorrow's retry window, e.g. after fixing
// the AI configuration. The worker picks them up on its next pass.
const store = new Store();
await store.init();
const released = await store.mutate(state => {
  const held = state.messages.filter(message => message.status === 'failed' && message.nextAttemptAt > Date.now());
  for (const message of held) { message.nextAttemptAt = 0; message.reason = 'Jev is taking another look at your saved message.'; }
  if (held.length) state.version++;
  return held.length;
});
await store.close();
console.log(`Released ${released} held ${released === 1 ? 'message' : 'messages'} for retry.`);
