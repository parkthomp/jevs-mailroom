import { randomBytes } from 'node:crypto';
import { cleanName, FACINGS, LOOKS, type Facing, type Visitor } from '../shared/protocol.js';
import { ROOM_H, ROOM_W } from '../shared/walk.js';

// Where each visitor's character is standing. Kept in memory on the web server only: positions are
// throwaway, so after a restart everyone simply walks back in. Nothing here is ever stored or typed
// by a visitor except a short name tag, limited to the capitals, digits, and few marks the room's
// pixel font can draw.
const MAX_SHOWN = 60, MAX_MOVES_PER_SECOND = 20;
export class Presence<Socket extends object> {
  private visitors = new Map<Socket, { id: string; visitor: Visitor | null; window: number; moves: number }>();
  dirty = false;
  join(socket: Socket): string {
    const id = randomBytes(6).toString('base64url');
    this.visitors.set(socket, { id, visitor: null, window: 0, moves: 0 });
    return id;
  }
  leave(socket: Socket) {
    if (this.visitors.get(socket)?.visitor) this.dirty = true;
    this.visitors.delete(socket);
  }
  // Accepts a character's new position; anything malformed or too frequent is ignored.
  move(socket: Socket, event: unknown, now = Date.now()): boolean {
    const entry = this.visitors.get(socket);
    if (!entry || typeof event !== 'object' || event === null) return false;
    const { type, name, x, y, facing, look, moving } = event as Record<string, unknown>;
    const tag = typeof name === 'string' ? cleanName(name).trim() : '';
    if (!tag) return false;
    if (type !== 'move' || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (!FACINGS.includes(facing as Facing) || !Number.isInteger(look) || (look as number) < 0 || (look as number) >= LOOKS || typeof moving !== 'boolean') return false;
    if (now - entry.window >= 1000) { entry.window = now; entry.moves = 0; }
    if (++entry.moves > MAX_MOVES_PER_SECOND) return false;
    const clamp = (value: number, max: number) => Math.round(Math.max(0, Math.min(max, value)));
    entry.visitor = { id: entry.id, name: tag, x: clamp(x, ROOM_W), y: clamp(y, ROOM_H), facing: facing as Facing, look: look as number, moving };
    this.dirty = true;
    return true;
  }
  list(): Visitor[] {
    return [...this.visitors.values()].flatMap(entry => entry.visitor ? [entry.visitor] : []).slice(0, MAX_SHOWN);
  }
}
