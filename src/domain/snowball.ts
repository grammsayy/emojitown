import type { SnowballPack } from '../content/types.js';
import { discordTime } from '../util/time.js';
import { audit } from './audit.js';
import { fill, getPack } from './content.js';
import { tx, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { getCurrentEvent, requireActiveEvent, requireEvent, resolveViewEvent, type SeasonEvent } from './events.js';
import { assertNotExcluded, eligibleSql, isDeparted, isExcluded, isSnowballOptedOut } from './members.js';
import { paginate, rankRows, type Page, type Ranked } from './ranking.js';

/** Fixed gameplay rules carried over from the original snowball bot. */
export const COLLECT_COOLDOWN_MS = 30_000;
export const WARMUP_MS = 120_000;
export const HIT_CHANCE = 0.5;

export interface SnowballStats {
  userId: string;
  snowballs: number;
  hits: number;
  misses: number;
  kosReceived: number;
  collected: number;
  nextCollectAt: number;
  warmUntil: number;
  hitsReachedAt: number | null;
}

function fromRow(r: Record<string, any>): SnowballStats {
  return {
    userId: r.user_id,
    snowballs: r.snowballs,
    hits: r.hits,
    misses: r.misses,
    kosReceived: r.kos_received,
    collected: r.collected,
    nextCollectAt: r.next_collect_at,
    warmUntil: r.warm_until,
    hitsReachedAt: r.hits_reached_at,
  };
}

function ensurePlayer(ctx: Ctx, guildId: string, eventId: string, userId: string): SnowballStats {
  ctx.db
    .prepare('INSERT OR IGNORE INTO snowball_players (guild_id, event_id, user_id) VALUES (?, ?, ?)')
    .run(guildId, eventId, userId);
  return getPlayer(ctx, guildId, eventId, userId)!;
}

export function getPlayer(ctx: Ctx, guildId: string, eventId: string, userId: string): SnowballStats | null {
  const r = ctx.db
    .prepare('SELECT * FROM snowball_players WHERE guild_id = ? AND event_id = ? AND user_id = ?')
    .get(guildId, eventId, userId);
  return r ? fromRow(r as Record<string, any>) : null;
}

export function packFor(ctx: Ctx, ev: SeasonEvent): SnowballPack {
  return getPack(ctx, ev.guildId, 'snowball', ev.contentVersion);
}

function assertCanPlay(ctx: Ctx, guildId: string, userId: string): void {
  assertNotExcluded(ctx, guildId, userId, 'snowball');
  if (isSnowballOptedOut(ctx, guildId, userId)) {
    throw new UserError("You've opted out of snowball fights. Use `/snowball participation state:on` to join in again.");
  }
}

/** When the player may next collect, taking both the cooldown and the post-hit warm-up into account. */
export function collectReadyAt(p: SnowballStats): number {
  return Math.max(p.nextCollectAt, p.warmUntil);
}

export function collect(ctx: Ctx, guildId: string, userId: string): { event: SeasonEvent; stats: SnowballStats; message: string } {
  const ev = requireActiveEvent(ctx, guildId, 'snowball');
  assertCanPlay(ctx, guildId, userId);
  const pack = packFor(ctx, ev);
  return tx(ctx, () => {
    const now = ctx.now();
    const p = ensurePlayer(ctx, guildId, ev.id, userId);
    if (now < p.warmUntil) throw new UserError(fill(pack.warmup, { when: discordTime(p.warmUntil, 'R') }));
    if (now < p.nextCollectAt) throw new UserError(fill(pack.cooldown, { when: discordTime(p.nextCollectAt, 'R') }));
    ctx.db
      .prepare(
        `UPDATE snowball_players SET snowballs = snowballs + 1, collected = collected + 1, next_collect_at = ?
         WHERE guild_id = ? AND event_id = ? AND user_id = ?`,
      )
      .run(now + COLLECT_COOLDOWN_MS, guildId, ev.id, userId);
    const stats = getPlayer(ctx, guildId, ev.id, userId)!;
    const message = fill(pack.collect, { count: stats.snowballs, s: stats.snowballs === 1 ? '' : 's' });
    return { event: ev, stats, message };
  });
}

export interface ThrowResult {
  event: SeasonEvent;
  hit: boolean;
  message: string;
  image: string | undefined;
  thrower: SnowballStats;
  target: SnowballStats;
}

/**
 * Validates the target, then spends one snowball and resolves the throw in one
 * transaction. Discord-side checks (bots, channel access, membership) run
 * before this is called; any rejection here happens before anything changes.
 */
export function throwSnowball(ctx: Ctx, guildId: string, throwerId: string, targetId: string): ThrowResult {
  if (throwerId === targetId) throw new UserError("You can't throw a snowball at yourself. Pick a friend instead!");
  const ev = requireActiveEvent(ctx, guildId, 'snowball');
  assertCanPlay(ctx, guildId, throwerId);
  if (isDeparted(ctx, guildId, targetId)) throw new UserError("That member isn't in the server anymore. Pick someone else.");
  if (isExcluded(ctx, guildId, targetId, 'snowball') || isSnowballOptedOut(ctx, guildId, targetId)) {
    throw new UserError("That member isn't playing snowball fights right now. Pick someone else.");
  }
  const pack = packFor(ctx, ev);

  return tx(ctx, () => {
    const now = ctx.now();
    ensurePlayer(ctx, guildId, ev.id, throwerId);
    const spent = ctx.db
      .prepare(
        'UPDATE snowball_players SET snowballs = snowballs - 1 WHERE guild_id = ? AND event_id = ? AND user_id = ? AND snowballs > 0',
      )
      .run(guildId, ev.id, throwerId);
    if (spent.changes === 0) throw new UserError(pack.noSnowballs);

    // Decide the result first so the number of messages never changes the odds.
    const hit = ctx.random() < HIT_CHANCE;
    const list = hit ? pack.hit : pack.miss;
    const messageIndex = Math.min(list.length - 1, Math.floor(ctx.random() * list.length));

    if (hit) {
      ctx.db
        .prepare('UPDATE snowball_players SET hits = hits + 1, hits_reached_at = ? WHERE guild_id = ? AND event_id = ? AND user_id = ?')
        .run(now, guildId, ev.id, throwerId);
      ensurePlayer(ctx, guildId, ev.id, targetId);
      ctx.db
        .prepare(
          'UPDATE snowball_players SET kos_received = kos_received + 1, warm_until = ? WHERE guild_id = ? AND event_id = ? AND user_id = ?',
        )
        .run(now + WARMUP_MS, guildId, ev.id, targetId);
    } else {
      ctx.db
        .prepare('UPDATE snowball_players SET misses = misses + 1 WHERE guild_id = ? AND event_id = ? AND user_id = ?')
        .run(guildId, ev.id, throwerId);
    }
    ctx.db
      .prepare(
        'INSERT INTO snowball_throws (guild_id, event_id, thrower_id, target_id, hit, message_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(guildId, ev.id, throwerId, targetId, hit ? 1 : 0, messageIndex, now);

    return {
      event: ev,
      hit,
      message: fill(list[messageIndex]!, { thrower: `<@${throwerId}>`, target: `<@${targetId}>` }),
      image: hit ? pack.images.hit : pack.images.miss,
      thrower: getPlayer(ctx, guildId, ev.id, throwerId)!,
      target: getPlayer(ctx, guildId, ev.id, targetId) ?? ensurePlayer(ctx, guildId, ev.id, targetId),
    };
  });
}

export function stats(ctx: Ctx, guildId: string, userId: string, eventId?: string | null): { event: SeasonEvent; stats: SnowballStats } {
  const ev = resolveViewEvent(ctx, guildId, 'snowball', eventId);
  const p = getPlayer(ctx, guildId, ev.id, userId) ?? {
    userId,
    snowballs: 0,
    hits: 0,
    misses: 0,
    kosReceived: 0,
    collected: 0,
    nextCollectAt: 0,
    warmUntil: 0,
    hitsReachedAt: null,
  };
  return { event: ev, stats: p };
}

export function leaderboard(ctx: Ctx, guildId: string, eventId: string | null | undefined, page: number): { event: SeasonEvent; page: Page<Ranked<SnowballStats>> } {
  const ev = resolveViewEvent(ctx, guildId, 'snowball', eventId);
  const rows = ctx.db
    .prepare(
      `SELECT * FROM snowball_players p WHERE p.guild_id = ? AND p.event_id = ? AND p.hits > 0 AND ${eligibleSql('p.user_id', 'snowball')}
       ORDER BY hits DESC, hits_reached_at ASC, user_id ASC`,
    )
    .all(guildId, ev.id, guildId, guildId) as Record<string, any>[];
  return { event: ev, page: paginate(rankRows(rows.map(fromRow), (r) => r.hits), page) };
}

export type CorrectionField = 'hits' | 'misses' | 'kos-received' | 'collected';

export interface CorrectionPlan {
  eventId: string;
  userId: string;
  field: CorrectionField;
  before: Pick<SnowballStats, 'hits' | 'misses' | 'kosReceived' | 'collected' | 'snowballs'>;
  after: Pick<SnowballStats, 'hits' | 'misses' | 'kosReceived' | 'collected' | 'snowballs'>;
}

/**
 * Computes a statistic correction without saving it. Available snowballs are
 * derived as collected − hits − misses, so every correction keeps the totals
 * internally consistent and nonnegative.
 */
export function planCorrection(ctx: Ctx, guildId: string, eventId: string, userId: string, field: CorrectionField, value: number): CorrectionPlan {
  const ev = requireEvent(ctx, guildId, eventId, 'snowball');
  if (!Number.isInteger(value) || value < 0) throw new UserError('The new value must be a whole number of zero or more.');
  const p = getPlayer(ctx, guildId, ev.id, userId);
  const before = {
    hits: p?.hits ?? 0,
    misses: p?.misses ?? 0,
    kosReceived: p?.kosReceived ?? 0,
    collected: p?.collected ?? 0,
    snowballs: p?.snowballs ?? 0,
  };
  const after = { ...before };
  if (field === 'hits') after.hits = value;
  if (field === 'misses') after.misses = value;
  if (field === 'kos-received') after.kosReceived = value;
  if (field === 'collected') after.collected = value;
  after.snowballs = after.collected - after.hits - after.misses;
  if (after.snowballs < 0) {
    throw new UserError(
      `That would make hits + misses (${after.hits + after.misses}) exceed snowballs collected (${after.collected}). Correct collected first.`,
    );
  }
  return { eventId: ev.id, userId, field, before, after };
}

export function applyCorrection(ctx: Ctx, guildId: string, plan: CorrectionPlan, reason: string, actorId: string): void {
  if (!reason.trim()) throw new UserError('A reason is required.');
  tx(ctx, () => {
    // Re-plan inside the transaction so concurrent play since the preview is not overwritten blindly.
    const fresh = planCorrection(ctx, guildId, plan.eventId, plan.userId, plan.field, fieldValue(plan));
    ensurePlayer(ctx, guildId, plan.eventId, plan.userId);
    const a = fresh.after;
    ctx.db
      .prepare(
        `UPDATE snowball_players SET hits = ?, misses = ?, kos_received = ?, collected = ?, snowballs = ?
         WHERE guild_id = ? AND event_id = ? AND user_id = ?`,
      )
      .run(a.hits, a.misses, a.kosReceived, a.collected, a.snowballs, guildId, plan.eventId, plan.userId);
    audit(ctx, {
      guildId,
      actorId,
      action: 'snowball.correct',
      eventId: plan.eventId,
      targetId: plan.userId,
      before: fresh.before,
      after: fresh.after,
      reason,
    });
  });
}

function fieldValue(plan: CorrectionPlan): number {
  switch (plan.field) {
    case 'hits':
      return plan.after.hits;
    case 'misses':
      return plan.after.misses;
    case 'kos-received':
      return plan.after.kosReceived;
    case 'collected':
      return plan.after.collected;
  }
}

export function clearWarmup(ctx: Ctx, guildId: string, userId: string, reason: string, actorId: string): void {
  if (!reason.trim()) throw new UserError('A reason is required.');
  const ev = getCurrentEvent(ctx, guildId, 'snowball');
  if (!ev) throw new UserError('No snowball event is running.');
  tx(ctx, () => {
    const p = getPlayer(ctx, guildId, ev.id, userId);
    if (!p || p.warmUntil <= ctx.now()) throw new UserError('That member has no active warm-up restriction.');
    ctx.db
      .prepare('UPDATE snowball_players SET warm_until = 0 WHERE guild_id = ? AND event_id = ? AND user_id = ?')
      .run(guildId, ev.id, userId);
    audit(ctx, {
      guildId,
      actorId,
      action: 'snowball.clear-warmup',
      eventId: ev.id,
      targetId: userId,
      before: { warmUntil: p.warmUntil },
      after: { warmUntil: 0 },
      reason,
    });
  });
}
