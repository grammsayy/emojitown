import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { tx } from './context.js';

// Item rewards: owning a Halloween item (in any season) can unlock a role
// and/or a personal channel override. The database says what each member
// should have; the Discord layer brings Discord in line and records what it
// gave, so it only ever takes back its own grants.

export type RewardKind = 'role' | 'channel';

export interface Reward {
  kind: RewardKind;
  targetId: string;
}

export interface ItemReward {
  itemId: string;
  roleId: string | null;
  channelId: string | null;
}

/** How long to wait before retrying a grant or removal Discord refused. */
export const REWARD_RETRY_MS = 10 * 60_000;

export function getItemReward(ctx: Ctx, guildId: string, itemId: string): ItemReward | null {
  const r = ctx.db.prepare('SELECT item_id, role_id, channel_id FROM item_rewards WHERE guild_id = ? AND item_id = ?').get(guildId, itemId) as
    | { item_id: string; role_id: string | null; channel_id: string | null }
    | undefined;
  return r ? { itemId: r.item_id, roleId: r.role_id, channelId: r.channel_id } : null;
}

export function listItemRewards(ctx: Ctx, guildId: string): ItemReward[] {
  return (
    ctx.db.prepare('SELECT item_id, role_id, channel_id FROM item_rewards WHERE guild_id = ? ORDER BY item_id').all(guildId) as {
      item_id: string;
      role_id: string | null;
      channel_id: string | null;
    }[]
  ).map((r) => ({ itemId: r.item_id, roleId: r.role_id, channelId: r.channel_id }));
}

/** Sets an item's rewards. Both null removes them. Returns the old and new values. */
export function setItemReward(
  ctx: Ctx,
  guildId: string,
  itemId: string,
  next: { roleId: string | null; channelId: string | null },
  actorId: string,
  action = 'reward.set',
): { before: ItemReward | null; after: ItemReward | null } {
  return tx(ctx, () => {
    const before = getItemReward(ctx, guildId, itemId);
    if ((before?.roleId ?? null) === next.roleId && (before?.channelId ?? null) === next.channelId) return { before, after: before };
    if (!next.roleId && !next.channelId) ctx.db.prepare('DELETE FROM item_rewards WHERE guild_id = ? AND item_id = ?').run(guildId, itemId);
    else
      ctx.db
        .prepare(
          `INSERT INTO item_rewards (guild_id, item_id, role_id, channel_id) VALUES (?, ?, ?, ?)
           ON CONFLICT (guild_id, item_id) DO UPDATE SET role_id = excluded.role_id, channel_id = excluded.channel_id`,
        )
        .run(guildId, itemId, next.roleId, next.channelId);
    const after = getItemReward(ctx, guildId, itemId);
    audit(ctx, { guildId, actorId, action, before: before ?? { itemId }, after: after ?? { itemId, removed: true } });
    return { before, after };
  });
}

/** Rewards a member should have: from every Halloween item they own, in any season. */
export function desiredRewards(ctx: Ctx, guildId: string, userId: string): Reward[] {
  return (
    ctx.db
      .prepare(
        `SELECT DISTINCT 'role' AS kind, r.role_id AS target_id FROM hw_items i
           JOIN item_rewards r ON r.guild_id = i.guild_id AND r.item_id = i.item_id
           WHERE i.guild_id = ? AND i.user_id = ? AND r.role_id IS NOT NULL
         UNION
         SELECT DISTINCT 'channel', r.channel_id FROM hw_items i
           JOIN item_rewards r ON r.guild_id = i.guild_id AND r.item_id = i.item_id
           WHERE i.guild_id = ? AND i.user_id = ? AND r.channel_id IS NOT NULL`,
      )
      .all(guildId, userId, guildId, userId) as { kind: RewardKind; target_id: string }[]
  ).map((r) => ({ kind: r.kind, targetId: r.target_id }));
}

export interface Grant extends Reward {
  preexisting: boolean;
}

/** What the bot has recorded as given to a member. */
export function grantedRewards(ctx: Ctx, guildId: string, userId: string): Grant[] {
  return (
    ctx.db.prepare('SELECT kind, target_id, preexisting FROM reward_grants WHERE guild_id = ? AND user_id = ?').all(guildId, userId) as {
      kind: RewardKind;
      target_id: string;
      preexisting: number;
    }[]
  ).map((r) => ({ kind: r.kind, targetId: r.target_id, preexisting: !!r.preexisting }));
}

const same = (a: Reward, b: Reward) => a.kind === b.kind && a.targetId === b.targetId;

/** What has to change for one member to match what they own. */
export function rewardPlan(ctx: Ctx, guildId: string, userId: string): { grant: Reward[]; revoke: Grant[] } {
  const desired = desiredRewards(ctx, guildId, userId);
  const granted = grantedRewards(ctx, guildId, userId);
  return {
    grant: desired.filter((d) => !granted.some((g) => same(g, d))),
    revoke: granted.filter((g) => !desired.some((d) => same(g, d))),
  };
}

/** Members whose rewards don't match what they own (skipping ones waiting for a retry). */
export function membersNeedingSync(ctx: Ctx, guildId: string, limit: number): string[] {
  const rows = ctx.db
    .prepare(
      `WITH desired AS (
         SELECT DISTINCT i.user_id, 'role' AS kind, r.role_id AS target_id FROM hw_items i
           JOIN item_rewards r ON r.guild_id = i.guild_id AND r.item_id = i.item_id
           WHERE i.guild_id = ? AND r.role_id IS NOT NULL
         UNION
         SELECT DISTINCT i.user_id, 'channel', r.channel_id FROM hw_items i
           JOIN item_rewards r ON r.guild_id = i.guild_id AND r.item_id = i.item_id
           WHERE i.guild_id = ? AND r.channel_id IS NOT NULL
       ),
       granted AS (SELECT user_id, kind, target_id FROM reward_grants WHERE guild_id = ?),
       diff AS (
         SELECT * FROM (SELECT * FROM desired EXCEPT SELECT * FROM granted)
         UNION
         SELECT * FROM (SELECT * FROM granted EXCEPT SELECT * FROM desired)
       )
       SELECT DISTINCT d.user_id FROM diff d
       WHERE NOT EXISTS (
         SELECT 1 FROM reward_failures f
         WHERE f.guild_id = ? AND f.user_id = d.user_id AND f.kind = d.kind AND f.target_id = d.target_id AND f.retry_at > ?
       )
       LIMIT ?`,
    )
    .all(guildId, guildId, guildId, guildId, ctx.now(), limit) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

export function recordGrant(ctx: Ctx, guildId: string, userId: string, r: Reward, preexisting: boolean): void {
  ctx.db
    .prepare(
      `INSERT INTO reward_grants (guild_id, user_id, kind, target_id, preexisting, granted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, kind, target_id) DO NOTHING`,
    )
    .run(guildId, userId, r.kind, r.targetId, preexisting ? 1 : 0, ctx.now());
  clearFailure(ctx, guildId, userId, r);
}

export function recordRevoke(ctx: Ctx, guildId: string, userId: string, r: Reward): void {
  ctx.db.prepare('DELETE FROM reward_grants WHERE guild_id = ? AND user_id = ? AND kind = ? AND target_id = ?').run(guildId, userId, r.kind, r.targetId);
  clearFailure(ctx, guildId, userId, r);
}

/** Records a refused grant or removal. Returns true the first time, so staff are alerted once. */
export function recordFailure(ctx: Ctx, guildId: string, userId: string, r: Reward, error: string): boolean {
  const existed = !!ctx.db
    .prepare('SELECT 1 FROM reward_failures WHERE guild_id = ? AND user_id = ? AND kind = ? AND target_id = ?')
    .get(guildId, userId, r.kind, r.targetId);
  ctx.db
    .prepare(
      `INSERT INTO reward_failures (guild_id, user_id, kind, target_id, error, retry_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, kind, target_id) DO UPDATE SET error = excluded.error, retry_at = excluded.retry_at`,
    )
    .run(guildId, userId, r.kind, r.targetId, error, ctx.now() + REWARD_RETRY_MS);
  return !existed;
}

function clearFailure(ctx: Ctx, guildId: string, userId: string, r: Reward): void {
  ctx.db.prepare('DELETE FROM reward_failures WHERE guild_id = ? AND user_id = ? AND kind = ? AND target_id = ?').run(guildId, userId, r.kind, r.targetId);
}

/** How many members own an item, in any season. */
export function itemOwnerCount(ctx: Ctx, guildId: string, itemId: string): number {
  return (ctx.db.prepare('SELECT COUNT(DISTINCT user_id) n FROM hw_items WHERE guild_id = ? AND item_id = ?').get(guildId, itemId) as { n: number }).n;
}
