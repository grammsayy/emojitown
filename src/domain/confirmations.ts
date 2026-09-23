import { randomBytes } from 'node:crypto';
import type { Ctx } from './context.js';
import { UserError } from './errors.js';

const TTL_MS = 10 * 60_000;

/** Stores a staff action awaiting a Confirm button press. */
export function createPending(ctx: Ctx, guildId: string, userId: string, kind: string, payload: unknown): string {
  const token = randomBytes(9).toString('base64url');
  ctx.db.prepare('DELETE FROM pending_actions WHERE expires_at < ?').run(ctx.now());
  ctx.db
    .prepare('INSERT INTO pending_actions (token, guild_id, user_id, kind, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, guildId, userId, kind, JSON.stringify(payload), ctx.now() + TTL_MS);
  return token;
}

/** Removes and returns a pending action. Only the member who requested it can confirm it, once. */
export function consumePending<T>(ctx: Ctx, guildId: string, userId: string, token: string): { kind: string; payload: T } {
  const r = ctx.db.prepare('SELECT * FROM pending_actions WHERE token = ?').get(token) as
    | { guild_id: string; user_id: string; kind: string; payload: string; expires_at: number }
    | undefined;
  if (!r || r.guild_id !== guildId) throw new UserError('This confirmation has already been used or has expired. Run the command again.');
  if (r.user_id !== userId) throw new UserError('Only the staff member who ran the command can confirm it.');
  const deleted = ctx.db.prepare('DELETE FROM pending_actions WHERE token = ?').run(token);
  if (deleted.changes === 0) throw new UserError('This confirmation has already been used.');
  if (r.expires_at < ctx.now()) throw new UserError('This confirmation expired. Run the command again.');
  return { kind: r.kind, payload: JSON.parse(r.payload) as T };
}

export function discardPending(ctx: Ctx, token: string): void {
  ctx.db.prepare('DELETE FROM pending_actions WHERE token = ?').run(token);
}
