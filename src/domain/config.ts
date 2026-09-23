import type { Ctx } from './context.js';
import { UserError } from './errors.js';

export type ChannelFeature = 'snowball' | 'halloween' | 'advent' | 'logs';
export const CHANNEL_FEATURES: ChannelFeature[] = ['snowball', 'halloween', 'advent', 'logs'];
/** Features that use exactly one channel. Adding a new one replaces the old one. */
const SINGLE_CHANNEL: ReadonlySet<ChannelFeature> = new Set(['advent', 'logs']);

export type AdventPolicy = 'catch-up' | 'same-day';
export type ChampionEndPolicy = 'keep' | 'remove';

export interface GuildConfig {
  guildId: string;
  timezone: string;
  timezoneSet: boolean;
  supportDestination: string | null;
  setupSavedAt: number | null;
  hwSpawnMinS: number;
  hwSpawnMaxS: number;
  hwEncounterS: number;
  hwActivityWindowS: number;
  hwWeightCommon: number;
  hwWeightUncommon: number;
  hwWeightRare: number;
  candyPerHalloweenWin: number;
  candyHalloweenDailyLimit: number;
  championRoleId: string | null;
  championEndPolicy: ChampionEndPolicy;
  adventDoorCount: number;
  adventUnlockTime: string;
  adventAnnounceTime: string;
  adventPolicy: AdventPolicy;
}

const COLUMNS: Record<Exclude<keyof GuildConfig, 'guildId' | 'timezoneSet'>, string> = {
  timezone: 'timezone',
  supportDestination: 'support_destination',
  setupSavedAt: 'setup_saved_at',
  hwSpawnMinS: 'hw_spawn_min_s',
  hwSpawnMaxS: 'hw_spawn_max_s',
  hwEncounterS: 'hw_encounter_s',
  hwActivityWindowS: 'hw_activity_window_s',
  hwWeightCommon: 'hw_weight_common',
  hwWeightUncommon: 'hw_weight_uncommon',
  hwWeightRare: 'hw_weight_rare',
  candyPerHalloweenWin: 'candy_per_halloween_win',
  candyHalloweenDailyLimit: 'candy_halloween_daily_limit',
  championRoleId: 'champion_role_id',
  championEndPolicy: 'champion_end_policy',
  adventDoorCount: 'advent_door_count',
  adventUnlockTime: 'advent_unlock_time',
  adventAnnounceTime: 'advent_announce_time',
  adventPolicy: 'advent_policy',
};

export function getConfig(ctx: Ctx, guildId: string): GuildConfig {
  ctx.db.prepare('INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)').run(guildId);
  const r = ctx.db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId) as Record<string, any>;
  return {
    guildId,
    timezone: r.timezone,
    timezoneSet: !!r.timezone_set,
    supportDestination: r.support_destination,
    setupSavedAt: r.setup_saved_at,
    hwSpawnMinS: r.hw_spawn_min_s,
    hwSpawnMaxS: r.hw_spawn_max_s,
    hwEncounterS: r.hw_encounter_s,
    hwActivityWindowS: r.hw_activity_window_s,
    hwWeightCommon: r.hw_weight_common,
    hwWeightUncommon: r.hw_weight_uncommon,
    hwWeightRare: r.hw_weight_rare,
    candyPerHalloweenWin: r.candy_per_halloween_win,
    candyHalloweenDailyLimit: r.candy_halloween_daily_limit,
    championRoleId: r.champion_role_id,
    championEndPolicy: r.champion_end_policy,
    adventDoorCount: r.advent_door_count,
    adventUnlockTime: r.advent_unlock_time,
    adventAnnounceTime: r.advent_announce_time,
    adventPolicy: r.advent_policy,
  };
}

/** Writes the given fields. Returns the before/after values of changed fields for auditing. */
export function updateConfig(
  ctx: Ctx,
  guildId: string,
  patch: Partial<Omit<GuildConfig, 'guildId' | 'timezoneSet'>>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const current = getConfig(ctx, guildId);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch) as [keyof typeof COLUMNS, unknown][]) {
    if (value === undefined || !(key in COLUMNS)) continue;
    if (current[key] === value) continue;
    before[key] = current[key];
    after[key] = value;
    ctx.db.prepare(`UPDATE guild_config SET ${COLUMNS[key]} = ? WHERE guild_id = ?`).run(value, guildId);
    if (key === 'timezone') ctx.db.prepare('UPDATE guild_config SET timezone_set = 1 WHERE guild_id = ?').run(guildId);
  }
  return { before, after };
}

export function getChannels(ctx: Ctx, guildId: string, feature: ChannelFeature): string[] {
  return (
    ctx.db
      .prepare('SELECT channel_id FROM feature_channels WHERE guild_id = ? AND feature = ? ORDER BY rowid')
      .all(guildId, feature) as { channel_id: string }[]
  ).map((r) => r.channel_id);
}

export function getChannel(ctx: Ctx, guildId: string, feature: ChannelFeature): string | null {
  return getChannels(ctx, guildId, feature)[0] ?? null;
}

/** Adds a channel assignment. For single-channel features, returns the replaced channel. */
export function addChannel(ctx: Ctx, guildId: string, feature: ChannelFeature, channelId: string): string[] {
  const previous = getChannels(ctx, guildId, feature);
  if (SINGLE_CHANNEL.has(feature)) {
    ctx.db.prepare('DELETE FROM feature_channels WHERE guild_id = ? AND feature = ?').run(guildId, feature);
  } else if (previous.includes(channelId)) {
    throw new UserError(`<#${channelId}> is already a ${feature} channel.`);
  }
  ctx.db
    .prepare('INSERT OR IGNORE INTO feature_channels (guild_id, feature, channel_id) VALUES (?, ?, ?)')
    .run(guildId, feature, channelId);
  return previous;
}

export function removeChannel(ctx: Ctx, guildId: string, feature: ChannelFeature, channelId: string): void {
  const info = ctx.db
    .prepare('DELETE FROM feature_channels WHERE guild_id = ? AND feature = ? AND channel_id = ?')
    .run(guildId, feature, channelId);
  if (info.changes === 0) throw new UserError(`<#${channelId}> is not assigned to ${feature}.`);
}

export function getStaffRoles(ctx: Ctx, guildId: string): string[] {
  return (
    ctx.db.prepare('SELECT role_id FROM staff_roles WHERE guild_id = ?').all(guildId) as { role_id: string }[]
  ).map((r) => r.role_id);
}

export function setStaffRole(ctx: Ctx, guildId: string, roleId: string, grant: boolean): boolean {
  const info = grant
    ? ctx.db.prepare('INSERT OR IGNORE INTO staff_roles (guild_id, role_id) VALUES (?, ?)').run(guildId, roleId)
    : ctx.db.prepare('DELETE FROM staff_roles WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
  return info.changes > 0;
}

/** Setup items still missing, shown after /season setup and in /season config. */
export function missingSetup(ctx: Ctx, guildId: string): string[] {
  const cfg = getConfig(ctx, guildId);
  const missing: string[] = [];
  if (!cfg.timezoneSet) missing.push('Timezone (`/season timezone`)');
  if (!cfg.supportDestination) missing.push('Support destination (`/season support`)');
  if (!getChannel(ctx, guildId, 'logs')) missing.push('Staff log channel (`/season channel feature:logs`)');
  if (getStaffRoles(ctx, guildId).length === 0) missing.push('Event Manager role (`/season staff`)');
  if (getChannels(ctx, guildId, 'snowball').length === 0) missing.push('Snowball channel (`/season channel feature:snowball`)');
  if (getChannels(ctx, guildId, 'halloween').length === 0) missing.push('Halloween channel (`/season channel feature:halloween`)');
  if (!getChannel(ctx, guildId, 'advent')) missing.push('Advent channel (`/season channel feature:advent`)');
  return missing;
}
