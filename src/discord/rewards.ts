import { ChannelType, PermissionFlagsBits, type Guild, type GuildBasedChannel, type GuildMember, type Role } from 'discord.js';
import { getConfig, getStaffRoles } from '../domain/config.js';
import { UserError } from '../domain/errors.js';
import { membersNeedingSync, recordFailure, recordGrant, recordRevoke, rewardPlan, type Grant, type Reward } from '../domain/rewards.js';
import { alertStaff, type Bot } from './runtime.js';

/** What a channel reward lets the member do in that channel. */
const CHANNEL_ACCESS = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true } as const;
const CHANNEL_ACCESS_BITS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory;
const REASON = 'emojitown item reward';

/** Permissions a reward role must not carry: it is handed out by winning a game. */
const PRIVILEGED = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
];

export function assertSafeRewardRole(bot: Bot, guild: Guild, role: Role): void {
  if (role.id === guild.id) throw new UserError('@everyone already has every member. Pick a dedicated reward role.');
  if (role.managed) throw new UserError('That role is managed by an integration and cannot be given out.');
  if (getStaffRoles(bot.ctx, guild.id).includes(role.id)) throw new UserError('That is an Event Manager role. Winning an item must not give staff access.');
  if (getConfig(bot.ctx, guild.id).championRoleId === role.id) throw new UserError('That is the Halloween Champion role, which the bot manages separately. Pick another role.');
  if (PRIVILEGED.some((p) => role.permissions?.has(p, false))) {
    throw new UserError(`${role} has moderation or admin permissions. A role won in a game must not carry those.`);
  }
  const top = guild.members.me?.roles.highest.position;
  if (top !== undefined && role.position >= top) {
    throw new UserError(`${role} is above (or level with) the bot's own role, so the bot can't give it. In Server Settings → Roles, drag the bot's role above it.`);
  }
}

export function assertUsableRewardChannel(guild: Guild, channel: GuildBasedChannel): void {
  if (!('permissionOverwrites' in channel) || channel.type === ChannelType.GuildCategory) {
    throw new UserError('Pick a text, voice, forum or announcement channel (not a thread or category).');
  }
  const me = guild.members.me;
  const perms = me && 'permissionsFor' in channel ? channel.permissionsFor(me) : null;
  if (perms && !perms.has(PermissionFlagsBits.ManageRoles)) {
    throw new UserError(`The bot needs **Manage Permissions** in ${channel} to let members in. Add it in the channel's permission settings for the bot's role.`);
  }
  if (perms && !perms.has(CHANNEL_ACCESS_BITS)) {
    throw new UserError(`The bot can only grant access it has itself. Give the bot's role View Channel, Send Messages and Read Message History in ${channel}.`);
  }
}

/** Human-readable reward text, e.g. "the @VIP role and #secret-room". Uses names (mentions don't show on phones in embeds). */
export function rewardText(guild: Guild | undefined, roleId: string | null, channelId: string | null): string {
  const parts: string[] = [];
  if (roleId) parts.push(`the **@${guild?.roles.cache.get(roleId)?.name ?? 'reward'}** role`);
  if (channelId) parts.push(`access to <#${channelId}>`);
  return parts.join(' and ');
}

async function fetchRole(guild: Guild, id: string): Promise<Role | null> {
  return guild.roles.cache.get(id) ?? (await guild.roles.fetch(id).catch(() => null));
}

async function fetchChannel(guild: Guild, id: string): Promise<GuildBasedChannel | null> {
  return guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
}

type Overwritable = GuildBasedChannel & {
  permissionOverwrites: {
    cache: Map<string, { allow: { bitfield: bigint; has(p: bigint): boolean }; deny: { bitfield: bigint } }>;
    edit(id: string, perms: Record<string, boolean | null>, opts?: { reason?: string }): Promise<unknown>;
    delete(id: string, reason?: string): Promise<unknown>;
  };
};

async function grant(guild: Guild, member: GuildMember | null, r: Reward): Promise<{ preexisting: boolean }> {
  if (!member) throw new Error('they are not in the server');
  if (r.kind === 'role') {
    const role = await fetchRole(guild, r.targetId);
    if (!role) throw new Error('the reward role no longer exists');
    if (member.roles.cache.has(role.id)) return { preexisting: true };
    await member.roles.add(role.id, REASON);
    return { preexisting: false };
  }
  const channel = (await fetchChannel(guild, r.targetId)) as Overwritable | null;
  if (!channel || !('permissionOverwrites' in channel)) throw new Error('the reward channel no longer exists');
  const existing = channel.permissionOverwrites.cache.get(member.id);
  if (existing && existing.allow.has(PermissionFlagsBits.ViewChannel)) return { preexisting: true };
  await channel.permissionOverwrites.edit(member.id, CHANNEL_ACCESS, { reason: REASON });
  return { preexisting: false };
}

async function revoke(guild: Guild, member: GuildMember | null, userId: string, g: Grant): Promise<void> {
  if (g.preexisting) return; // They had it before the bot did anything; leave it.
  if (g.kind === 'role') {
    if (member?.roles.cache.has(g.targetId)) await member.roles.remove(g.targetId, REASON);
    return;
  }
  const channel = (await fetchChannel(guild, g.targetId)) as Overwritable | null;
  if (!channel || !('permissionOverwrites' in channel)) return; // Channel gone: nothing to take back.
  if (!channel.permissionOverwrites.cache.get(userId)) return;
  // Reset only what the bot granted, keeping anything staff set on this member by hand.
  await channel.permissionOverwrites.edit(userId, { ViewChannel: null, SendMessages: null, ReadMessageHistory: null }, { reason: REASON });
  const left = channel.permissionOverwrites.cache.get(userId);
  if (left && left.allow.bitfield === 0n && left.deny.bitfield === 0n) await channel.permissionOverwrites.delete(userId, REASON);
}

const describe = (r: Reward) => (r.kind === 'role' ? `the <@&${r.targetId}> role` : `access to <#${r.targetId}>`);

/**
 * Brings one member's reward roles and channel access in line with the items
 * they own. Refusals are recorded and retried later; staff are alerted once.
 */
export function syncMemberRewards(bot: Bot, guild: Guild, userId: string): Promise<SyncResult> {
  // One sync per member at a time: two at once could see a role the other just
  // gave and wrongly record it as one the member already had.
  const key = `${guild.id}:${userId}`;
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => syncNow(bot, guild, userId));
  queues.set(key, run);
  void run.finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  }).catch(() => undefined);
  return run;
}

type SyncResult = { granted: Reward[]; revoked: Reward[]; failed: Reward[] };
const queues = new Map<string, Promise<SyncResult>>();

async function syncNow(bot: Bot, guild: Guild, userId: string): Promise<SyncResult> {
  const plan = rewardPlan(bot.ctx, guild.id, userId);
  const out = { granted: [] as Reward[], revoked: [] as Reward[], failed: [] as Reward[] };
  if (!plan.grant.length && !plan.revoke.length) return out;
  const member = await guild.members.fetch(userId).catch(() => null);
  for (const r of plan.grant) {
    try {
      const { preexisting } = await grant(guild, member, r);
      recordGrant(bot.ctx, guild.id, userId, r, preexisting);
      if (!preexisting) out.granted.push(r);
    } catch (err) {
      out.failed.push(r);
      const message = err instanceof Error ? err.message : String(err);
      if (recordFailure(bot.ctx, guild.id, userId, r, message) && member) {
        await alertStaff(
          bot,
          guild.id,
          'Item reward could not be given',
          `Could not give <@${userId}> ${describe(r)}: ${message}.\nCheck that the bot's role is above the reward role and has **Manage Permissions** on the channel. It retries automatically every 10 minutes.`,
        );
      }
    }
  }
  for (const g of plan.revoke) {
    try {
      await revoke(guild, member, userId, g);
      recordRevoke(bot.ctx, guild.id, userId, g);
      if (!g.preexisting) out.revoked.push(g);
    } catch (err) {
      out.failed.push(g);
      const message = err instanceof Error ? err.message : String(err);
      if (recordFailure(bot.ctx, guild.id, userId, g, message)) {
        await alertStaff(bot, guild.id, 'Item reward could not be removed', `Could not take ${describe(g)} back from <@${userId}>: ${message}. It retries automatically every 10 minutes.`);
      }
    }
  }
  return out;
}

const syncing = new Set<string>();

/** Catches up on members whose rewards are out of date (after a win, a wipe, a reward change, or a failed attempt). */
export async function syncPendingRewards(bot: Bot, guild: Guild, limit = 10): Promise<number> {
  if (syncing.has(guild.id)) return 0;
  syncing.add(guild.id);
  try {
    const users = membersNeedingSync(bot.ctx, guild.id, limit);
    for (const u of users) await syncMemberRewards(bot, guild, u);
    return users.length;
  } finally {
    syncing.delete(guild.id);
  }
}
