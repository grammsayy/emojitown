import { audit } from './audit.js';
import { refreshAllChampions } from './champion.js';
import { tx, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { FEATURE_LABEL, FEATURES, type Feature } from './events.js';

export type ExclusionScope = Feature | 'all';

export function isExcluded(ctx: Ctx, guildId: string, userId: string, feature: Feature): boolean {
  return !!ctx.db
    .prepare('SELECT 1 FROM exclusions WHERE guild_id = ? AND user_id = ? AND feature = ?')
    .get(guildId, userId, feature);
}

export function excludedFeatures(ctx: Ctx, guildId: string, userId: string): Feature[] {
  return (
    ctx.db.prepare('SELECT feature FROM exclusions WHERE guild_id = ? AND user_id = ?').all(guildId, userId) as {
      feature: Feature;
    }[]
  ).map((r) => r.feature);
}

export function isDeparted(ctx: Ctx, guildId: string, userId: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM departed_members WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}

/** A member left the server: they leave active standings and the Champion is recalculated. Records are kept. */
export function markDeparted(ctx: Ctx, guildId: string, userId: string): void {
  tx(ctx, () => {
    ctx.db
      .prepare('INSERT OR REPLACE INTO departed_members (guild_id, user_id, departed_at) VALUES (?, ?, ?)')
      .run(guildId, userId, ctx.now());
    refreshAllChampions(ctx, guildId);
  });
}

/** A member rejoined: saved progress counts again unless they are still excluded. */
export function markReturned(ctx: Ctx, guildId: string, userId: string): boolean {
  return tx(ctx, () => {
    const changed = ctx.db.prepare('DELETE FROM departed_members WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes > 0;
    if (changed) refreshAllChampions(ctx, guildId);
    return changed;
  });
}

/**
 * SQL fragment keeping only members eligible for standings in `feature`. Binds guild_id twice.
 * `userCol` must be table-qualified, or it resolves to the subquery's own column.
 */
export function eligibleSql(userCol: string, feature: Feature): string {
  return `NOT EXISTS (SELECT 1 FROM departed_members d WHERE d.guild_id = ? AND d.user_id = ${userCol})
    AND NOT EXISTS (SELECT 1 FROM exclusions x WHERE x.guild_id = ? AND x.user_id = ${userCol} AND x.feature = '${feature}')`;
}

export function isEligible(ctx: Ctx, guildId: string, userId: string, feature: Feature): boolean {
  return !isDeparted(ctx, guildId, userId) && !isExcluded(ctx, guildId, userId, feature);
}

export function assertNotExcluded(ctx: Ctx, guildId: string, userId: string, feature: Feature): void {
  if (isExcluded(ctx, guildId, userId, feature)) {
    throw new UserError(`You can't take part in ${FEATURE_LABEL[feature]} right now. Contact the event staff if you think this is a mistake.`);
  }
}

function scopeFeatures(scope: ExclusionScope): Feature[] {
  return scope === 'all' ? FEATURES : [scope];
}

/** Returns the features whose exclusion state changed. */
export function exclude(ctx: Ctx, guildId: string, userId: string, scope: ExclusionScope, reason: string, actorId: string): Feature[] {
  if (!reason.trim()) throw new UserError('A reason is required.');
  return tx(ctx, () => {
    const changed: Feature[] = [];
    for (const f of scopeFeatures(scope)) {
      const info = ctx.db
        .prepare('INSERT OR IGNORE INTO exclusions (guild_id, user_id, feature, reason, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(guildId, userId, f, reason, actorId, ctx.now());
      if (info.changes) changed.push(f);
    }
    if (changed.length === 0) throw new UserError('That member is already excluded from the selected features.');
    if (changed.includes('halloween')) refreshAllChampions(ctx, guildId);
    audit(ctx, { guildId, actorId, action: 'member.exclude', targetId: userId, after: { features: changed }, reason });
    return changed;
  });
}

export function include(ctx: Ctx, guildId: string, userId: string, scope: ExclusionScope, reason: string, actorId: string): Feature[] {
  if (!reason.trim()) throw new UserError('A reason is required.');
  return tx(ctx, () => {
    const changed: Feature[] = [];
    for (const f of scopeFeatures(scope)) {
      const info = ctx.db.prepare('DELETE FROM exclusions WHERE guild_id = ? AND user_id = ? AND feature = ?').run(guildId, userId, f);
      if (info.changes) changed.push(f);
    }
    if (changed.length === 0) throw new UserError('That member is not excluded from the selected features.');
    if (changed.includes('halloween')) refreshAllChampions(ctx, guildId);
    audit(ctx, { guildId, actorId, action: 'member.include', targetId: userId, before: { features: changed }, reason });
    return changed;
  });
}

export function isSnowballOptedOut(ctx: Ctx, guildId: string, userId: string): boolean {
  const r = ctx.db.prepare('SELECT snowball_opt_out FROM member_prefs WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as
    | { snowball_opt_out: number }
    | undefined;
  return !!r?.snowball_opt_out;
}

export function setSnowballParticipation(ctx: Ctx, guildId: string, userId: string, participating: boolean): void {
  ctx.db
    .prepare(
      `INSERT INTO member_prefs (guild_id, user_id, snowball_opt_out) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET snowball_opt_out = excluded.snowball_opt_out`,
    )
    .run(guildId, userId, participating ? 0 : 1);
}
