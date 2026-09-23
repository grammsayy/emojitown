import type { DB } from '../db/database.js';

export interface AuditEntry {
  id: number;
  guildId: string;
  actorId: string;
  action: string;
  eventId: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: number;
}

/**
 * Everything domain code needs from the outside world. Tests inject a fixed
 * clock and a scripted random source; production uses Date.now and Math.random.
 */
export interface Ctx {
  db: DB;
  now(): number;
  random(): number;
  /** Called after an audit record commits, for example to post it to the log channel. */
  onAudit?: (entry: AuditEntry) => void;
}

const pendingHooks = new WeakMap<Ctx, Array<() => void>>();

/**
 * Runs `fn` in one SQLite transaction. Nested calls join the outer transaction,
 * so linked changes (a throw and both players' stats, a claim and its candy)
 * commit or roll back together.
 */
export function tx<T>(ctx: Ctx, fn: () => T): T {
  if (ctx.db.inTransaction) return fn();
  pendingHooks.set(ctx, []);
  let result: T;
  try {
    result = ctx.db.transaction(fn).immediate();
  } catch (err) {
    pendingHooks.delete(ctx);
    throw err;
  }
  const hooks = pendingHooks.get(ctx) ?? [];
  pendingHooks.delete(ctx);
  for (const hook of hooks) {
    try {
      hook();
    } catch (err) {
      console.error('after-commit hook failed', err);
    }
  }
  return result;
}

/** Runs `hook` once the current transaction commits, or immediately outside one. */
export function afterCommit(ctx: Ctx, hook: () => void): void {
  const queue = ctx.db.inTransaction ? pendingHooks.get(ctx) : undefined;
  if (queue) queue.push(hook);
  else if (!ctx.db.inTransaction) hook();
}

export function randomInt(ctx: Ctx, min: number, max: number): number {
  return min + Math.floor(ctx.random() * (max - min + 1));
}

export function pick<T>(ctx: Ctx, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from empty list');
  return items[Math.min(items.length - 1, Math.floor(ctx.random() * items.length))]!;
}
