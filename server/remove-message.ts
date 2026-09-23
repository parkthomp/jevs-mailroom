import 'dotenv/config';
import { Store } from './store.js';
const id = process.argv[2];
if (!id) throw new Error('Usage: npm run remove-message -- <message-id>');
const store = new Store();
await store.init();
const removed = await store.mutate(state => {
  const message = state.messages.find(item => item.id === id && item.status === 'delivered');
  if (!message) return false;
  // Remove the public record and its stored text; this is moderation, never recategorization.
  state.messages = state.messages.filter(item => item.id !== id); state.version++; return true;
});
await store.close();
console.log(removed ? `Removed published message ${id}.` : 'No published message found with that ID.');
