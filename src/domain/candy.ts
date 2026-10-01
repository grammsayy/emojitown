import { msToLocalDate } from '../util/time.js';
import { audit } from './audit.js';
import { getConfig } from './config.js';
import { tx, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { paginate, rankRows, type Page, type Ranked } from './ranking.js';

export type CandySource = 'halloween' | 'advent' | 'staff' | 'reversal';

export interface CandyTxn {
  id: number;
  guildId: string;
  userId: string;
  amount: number;
  source: CandySource;
  eventId: string | null;
  reason: string | null;
  actorId: string | null;
  idemKey: string;
  localDay: string;
  balanceAfter: number;
  reversesId: number | null;
  reversedById: number | null;
  createdAt: number;
}

function fromRow(r: Record<string, any>): CandyTxn {
  return {
    id: r.id,
    guildId: r.guild_id,
    userId: r.user_id,
    amount: r.amount,
    source: r.source,
    eventId: r.event_id,
    reason: r.reason,
    actorId: r.actor_id,
    idemKey: r.idem_key,
    localDay: r.local_day,
    balanceAfter: r.balance_after,
    reversesId: r.reverses_id,
    reversedById: r.reversed_by_id,
    createdAt: r.created_at,
  };
}

export function getBalance(ctx: Ctx, guildId: string, userId: string): number {
  const r = ctx.db.prepare('SELECT balance FROM candy_balances WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as
    | { balance: number }
    | undefined;
  return r?.balance ?? 0;
}

export function getTxn(ctx: Ctx, guildId: string, id: number): CandyTxn | null {
  const r = ctx.db.prepare('SELECT * FROM candy_txns WHERE guild_id = ? AND id = ?').get(guildId, id);
  return r ? fromRow(r as Record<string, any>) : null;
}

export interface CreditInput {
  guildId: string;
  userId: string;
  amount: number;
  source: CandySource;
  eventId?: string | null;
  reason?: string | null;
  actorId?: string | null;
  /** Unique per reward. Re-processing the same key returns the original transaction. */
  idemKey: string;
  reversesId?: number | null;
}

/**
 * Applies a candy change exactly once per idempotency key. Rejects changes that
 * would make the balance negative.
 */
export function applyCandy(ctx: Ctx, input: CreditInput): { txn: CandyTxn; duplicate: boolean } {
  if (!Number.isInteger(input.amount) || input.amount === 0) throw new UserError('The amount must be a non-zero whole number.');
  return tx(ctx, () => {
    const existing = ctx.db
      .prepare('SELECT * FROM candy_txns WHERE guild_id = ? AND idem_key = ?')
      .get(input.guildId, input.idemKey);
    if (existing) return { txn: fromRow(existing as Record<string, any>), duplicate: true };

    const balance = getBalance(ctx, input.guildId, input.userId);
    const next = balance + input.amount;
    if (next < 0) {
      throw new UserError(`That would leave a negative balance. The member has ${balance} candy.`);
    }
    ctx.db
      .prepare(
        `INSERT INTO candy_balances (guild_id, user_id, balance) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = excluded.balance`,
      )
      .run(input.guildId, input.userId, next);
    const tz = getConfig(ctx, input.guildId).timezone;
    const info = ctx.db
      .prepare(
        `INSERT INTO candy_txns (guild_id, user_id, amount, source, event_id, reason, actor_id, idem_key, local_day, balance_after, reverses_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.guildId,
        input.userId,
        input.amount,
        input.source,
        input.eventId ?? null,
        input.reason ?? null,
        input.actorId ?? null,
        input.idemKey,
        msToLocalDate(ctx.now(), tz),
        next,
        input.reversesId ?? null,
        ctx.now(),
      );
    return { txn: getTxn(ctx, input.guildId, Number(info.lastInsertRowid))!, duplicate: false };
  });
}

/** Candy from Halloween wins credited today (server-local day). */
export function halloweenCandyToday(ctx: Ctx, guildId: string, userId: string): number {
  const tz = getConfig(ctx, guildId).timezone;
  const r = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) s FROM candy_txns WHERE guild_id = ? AND user_id = ? AND source = 'halloween' AND local_day = ?",
    )
    .get(guildId, userId, msToLocalDate(ctx.now(), tz)) as { s: number };
  return r.s;
}

/**
 * Credits a Halloween win, capped by the daily limit. Returns the amount
 * credited (possibly 0) and whether the cap reduced it.
 */
export function creditHalloweenWin(
  ctx: Ctx,
  guildId: string,
  userId: string,
  eventId: string,
  encounterId: number,
): { amount: number; capped: boolean; txnId: number | null } {
  return tx(ctx, () => {
    const cfg = getConfig(ctx, guildId);
    const remaining = Math.max(0, cfg.candyHalloweenDailyLimit - halloweenCandyToday(ctx, guildId, userId));
    const amount = Math.min(cfg.candyPerHalloweenWin, remaining);
    const capped = amount < cfg.candyPerHalloweenWin;
    if (amount <= 0) return { amount: 0, capped, txnId: null };
    const { txn } = applyCandy(ctx, {
      guildId,
      userId,
      amount,
      source: 'halloween',
      eventId,
      reason: `Halloween encounter #${encounterId}`,
      idemKey: `halloween:encounter:${encounterId}`,
    });
    return { amount: txn.amount, capped, txnId: txn.id };
  });
}

export function adjustCandy(
  ctx: Ctx,
  input: { guildId: string; userId: string; amount: number; label: string; reason: string; actorId: string; eventId?: string | null; nonce: string },
): CandyTxn {
  if (!input.reason.trim()) throw new UserError('A reason is required.');
  return tx(ctx, () => {
    const before = getBalance(ctx, input.guildId, input.userId);
    const { txn, duplicate } = applyCandy(ctx, {
      guildId: input.guildId,
      userId: input.userId,
      amount: input.amount,
      source: 'staff',
      eventId: input.eventId ?? null,
      reason: `${input.label}: ${input.reason}`,
      actorId: input.actorId,
      idemKey: `staff:${input.nonce}`,
    });
    if (!duplicate) {
      audit(ctx, {
        guildId: input.guildId,
        actorId: input.actorId,
        action: 'candy.adjust',
        eventId: input.eventId ?? null,
        targetId: input.userId,
        before: { balance: before },
        after: { balance: txn.balanceAfter, amount: txn.amount, source: input.label, txn: txn.id },
        reason: input.reason,
      });
    }
    return txn;
  });
}

export function reverseTxn(ctx: Ctx, guildId: string, txnId: number, reason: string, actorId: string): CandyTxn {
  if (!reason.trim()) throw new UserError('A reason is required.');
  return tx(ctx, () => {
    const original = getTxn(ctx, guildId, txnId);
    if (!original) throw new UserError(`No candy transaction #${txnId} in this server.`);
    if (original.source === 'reversal') throw new UserError('A reversal cannot itself be reversed. Use `/admin candy adjust` instead.');
    if (original.reversedById) throw new UserError(`Transaction #${txnId} was already reversed by #${original.reversedById}.`);
    const before = getBalance(ctx, guildId, original.userId);
    const { txn } = applyCandy(ctx, {
      guildId,
      userId: original.userId,
      amount: -original.amount,
      source: 'reversal',
      eventId: original.eventId,
      reason: `Reversal of #${txnId}: ${reason}`,
      actorId,
      idemKey: `reverse:${txnId}`,
      reversesId: txnId,
    });
    ctx.db.prepare('UPDATE candy_txns SET reversed_by_id = ? WHERE id = ?').run(txn.id, txnId);
    audit(ctx, {
      guildId,
      actorId,
      action: 'candy.reverse',
      eventId: original.eventId,
      targetId: original.userId,
      before: { balance: before, txn: txnId },
      after: { balance: txn.balanceAfter, txn: txn.id },
      reason,
    });
    return txn;
  });
}

export function history(ctx: Ctx, guildId: string, userId: string, page: number, eventId?: string | null): Page<CandyTxn> {
  const rows = (
    eventId
      ? ctx.db.prepare('SELECT * FROM candy_txns WHERE guild_id = ? AND user_id = ? AND event_id = ? ORDER BY id DESC').all(guildId, userId, eventId)
      : ctx.db.prepare('SELECT * FROM candy_txns WHERE guild_id = ? AND user_id = ? ORDER BY id DESC').all(guildId, userId)
  ) as Record<string, any>[];
  return paginate(rows.map(fromRow), page);
}

export function eventTotal(ctx: Ctx, guildId: string, userId: string, eventId: string): number {
  const r = ctx.db
    .prepare('SELECT COALESCE(SUM(amount), 0) s FROM candy_txns WHERE guild_id = ? AND user_id = ? AND event_id = ?')
    .get(guildId, userId, eventId) as { s: number };
  return r.s;
}

export interface CandyStanding {
  userId: string;
  amount: number;
}

const STANDINGS_FILTER = `NOT EXISTS (SELECT 1 FROM departed_members d WHERE d.guild_id = t.guild_id AND d.user_id = t.user_id)
  AND (SELECT COUNT(*) FROM exclusions x WHERE x.guild_id = t.guild_id AND x.user_id = t.user_id) < 3`;

/** All-time standings by current balance, or an event's standings by net candy attributed to it. */
export function candyLeaderboard(ctx: Ctx, guildId: string, eventId: string | null, page: number): Page<Ranked<CandyStanding>> {
  const rows = (
    eventId
      ? ctx.db
          .prepare(
            `SELECT user_id, SUM(amount) amount, MAX(id) last_id FROM candy_txns t
             WHERE guild_id = ? AND event_id = ? AND ${STANDINGS_FILTER}
             GROUP BY user_id HAVING SUM(amount) > 0 ORDER BY amount DESC, user_id`,
          )
          .all(guildId, eventId)
      : ctx.db
          .prepare(
            `SELECT user_id, balance amount FROM candy_balances t
             WHERE guild_id = ? AND balance > 0 AND ${STANDINGS_FILTER} ORDER BY balance DESC, user_id`,
          )
          .all(guildId)
  ) as { user_id: string; amount: number }[];
  return paginate(
    rankRows(rows.map((r) => ({ userId: r.user_id, amount: r.amount })), (r) => r.amount),
    page,
  );
}

/** Members whose stored balance differs from the sum of their transactions. Empty means everything reconciles. */
export function reconcileBalances(ctx: Ctx, guildId: string): { userId: string; balance: number; ledger: number }[] {
  return (
    ctx.db
      .prepare(
        `SELECT b.user_id, b.balance, COALESCE((SELECT SUM(amount) FROM candy_txns t WHERE t.guild_id = b.guild_id AND t.user_id = b.user_id), 0) ledger
         FROM candy_balances b WHERE b.guild_id = ?`,
      )
      .all(guildId) as { user_id: string; balance: number; ledger: number }[]
  )
    .filter((r) => r.balance !== r.ledger)
    .map((r) => ({ userId: r.user_id, balance: r.balance, ledger: r.ledger }));
}
