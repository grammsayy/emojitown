import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
  type Role,
} from 'discord.js';
import type { AuditEntry, Ctx } from '../domain/context.js';
import { getRoleState, markRoleFailed, markRoleSynced } from '../domain/champion.js';
import { getChannel, getConfig, getStaffRoles } from '../domain/config.js';
import { UserError } from '../domain/errors.js';
import { COLORS, embed, json } from './ui.js';

/** Everything handlers need: the Discord client and the domain context. */
export interface Bot {
  client: Client;
  ctx: Ctx;
}

export type Level = 'member' | 'moderator' | 'admin';

export function isAdmin(member: GuildMember): boolean {
  return member.guild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

export function isModerator(bot: Bot, member: GuildMember): boolean {
  if (isAdmin(member)) return true;
  const roles = getStaffRoles(bot.ctx, member.guild.id);
  return roles.some((r) => member.roles.cache.has(r));
}

export function assertLevel(bot: Bot, member: GuildMember, level: Level): void {
  if (level === 'admin' && !isAdmin(member)) {
    throw new UserError('Only server administrators (Manage Server) can do that.');
  }
  if (level === 'moderator' && !isModerator(bot, member)) {
    throw new UserError('Only event staff (the Event Manager role) or administrators can do that.');
  }
}

/** Permissions that must never be granted by winning a game, or stripped from members by role sync. */
const PRIVILEGED_PERMISSIONS: [bigint, string][] = [
  [PermissionFlagsBits.Administrator, 'Administrator'],
  [PermissionFlagsBits.ManageGuild, 'Manage Server'],
  [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
  [PermissionFlagsBits.ManageWebhooks, 'Manage Webhooks'],
  [PermissionFlagsBits.ManageNicknames, 'Manage Nicknames'],
  [PermissionFlagsBits.ManageGuildExpressions, 'Manage Expressions'],
  [PermissionFlagsBits.ManageEvents, 'Manage Events'],
  [PermissionFlagsBits.ManageThreads, 'Manage Threads'],
  [PermissionFlagsBits.KickMembers, 'Kick Members'],
  [PermissionFlagsBits.BanMembers, 'Ban Members'],
  [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  [PermissionFlagsBits.MentionEveryone, 'Mention @everyone'],
  [PermissionFlagsBits.ViewAuditLog, 'View Audit Log'],
];

/**
 * The Champion role is handed to whoever wins and removed from everyone else
 * who holds it, so it must be a dedicated, permission-free role.
 */
export function assertSafeChampionRole(guild: Guild, role: Role, staffRoleIds: string[]): void {
  if (role.id === guild.id) throw new UserError('@everyone cannot be the Champion role. Create a dedicated role for it.');
  if (role.managed) throw new UserError('That role is managed by an integration and cannot be assigned.');
  if (staffRoleIds.includes(role.id)) throw new UserError('That role is an Event Manager role. Use a dedicated Champion role.');
  const granted = PRIVILEGED_PERMISSIONS.filter(([p]) => role.permissions.has(p, false)).map(([, n]) => n);
  if (granted.length) {
    throw new UserError(`${role} grants ${granted.join(', ')}. The Champion role is given to a game winner, so it must not carry moderation permissions.`);
  }
  if (role.members.size > 1) {
    throw new UserError(
      `${role} is already held by ${role.members.size} members. The bot removes the Champion role from everyone except the winner, so use a dedicated role.`,
    );
  }
}

export function assertSafeStaffRole(guild: Guild, role: Role): void {
  if (role.id === guild.id) throw new UserError('@everyone cannot be an Event Manager role; that would give every member staff access.');
  if (role.managed) throw new UserError('That role is managed by an integration. Pick a role you assign to your event staff.');
}

export async function fetchTextChannel(guild: Guild, channelId: string | null): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  try {
    const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    return ch && ch.isTextBased() && ch.type !== ChannelType.GuildVoice ? (ch as GuildTextBasedChannel) : null;
  } catch {
    return null;
  }
}

export function isMissingChannelError(err: unknown): boolean {
  return err instanceof DiscordAPIError && (err.code === 10003 || err.code === 50001 || err.code === 50013);
}

/** Posts to the configured staff log channel. Failures are logged, never thrown. */
export async function postToLogs(bot: Bot, guildId: string, options: MessageCreateOptions): Promise<void> {
  const guild = bot.client.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = await fetchTextChannel(guild, getChannel(bot.ctx, guildId, 'logs'));
  if (!channel) return;
  try {
    await channel.send({ ...options, allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn(`[${guildId}] could not post to log channel`, err);
  }
}

export function alertStaff(bot: Bot, guildId: string, title: string, description: string): Promise<void> {
  return postToLogs(bot, guildId, { embeds: [embed(COLORS.warn, `⚠️ ${title}`, description)] });
}

/** Mirrors each committed audit record into the staff log channel. */
export function auditLogger(bot: Bot) {
  return (entry: AuditEntry): void => {
    const e = embed(COLORS.staff, `Staff action: ${entry.action}`)
      .addFields(
        { name: 'Actor', value: entry.actorId === 'system' ? 'System' : `<@${entry.actorId}>`, inline: true },
        { name: 'Event', value: entry.eventId ? `\`${entry.eventId}\`` : '—', inline: true },
        { name: 'Member', value: entry.targetId ? `<@${entry.targetId}>` : '—', inline: true },
      )
      .setTimestamp(entry.createdAt);
    if (entry.before !== null) e.addFields({ name: 'Before', value: `\`\`\`json\n${json(entry.before)}\n\`\`\`` });
    if (entry.after !== null) e.addFields({ name: 'After', value: `\`\`\`json\n${json(entry.after)}\n\`\`\`` });
    if (entry.reason) e.addFields({ name: 'Reason', value: entry.reason.slice(0, 1024) });
    e.addFields({ name: 'Audit ID', value: `#${entry.id}`, inline: true });
    void postToLogs(bot, entry.guildId, { embeds: [e] });
  };
}

const roleSyncRunning = new Set<string>();

/**
 * Brings the Halloween Champion role in line with the stored desired holder.
 * Failures keep the correct standings, record the error, and alert staff once.
 * Retrying never touches collectibles or candy.
 */
export async function syncChampionRole(bot: Bot, guildId: string): Promise<{ ok: boolean; error?: string }> {
  if (roleSyncRunning.has(guildId)) return { ok: true };
  roleSyncRunning.add(guildId);
  try {
    const state = getRoleState(bot.ctx, guildId);
    if (!state.pending) return { ok: true };
    const roleId = getConfig(bot.ctx, guildId).championRoleId;
    const guild = bot.client.guilds.cache.get(guildId);
    if (!guild) return { ok: false, error: 'bot is not in this server' };
    if (!roleId) {
      markRoleSynced(bot.ctx, guildId, state.desiredId);
      return { ok: true };
    }
    try {
      const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId));
      if (!role) throw new Error('The configured Champion role no longer exists.');
      // Remove the role from anyone other than the desired holder.
      const holders = new Set(role.members.keys());
      if (state.holderId) holders.add(state.holderId);
      for (const id of holders) {
        if (id === state.desiredId) continue;
        const m = await guild.members.fetch(id).catch(() => null);
        if (m?.roles.cache.has(roleId)) await m.roles.remove(roleId, 'Halloween Champion changed');
      }
      if (state.desiredId) {
        const m = await guild.members.fetch(state.desiredId).catch(() => null);
        if (m && !m.roles.cache.has(roleId)) await m.roles.add(roleId, 'Halloween Champion');
      }
      markRoleSynced(bot.ctx, guildId, state.desiredId);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (markRoleFailed(bot.ctx, guildId, message)) {
        await alertStaff(
          bot,
          guildId,
          'Champion role update failed',
          `Could not give the Halloween Champion role to ${state.desiredId ? `<@${state.desiredId}>` : 'nobody'}: ${message}\n` +
            'Standings are correct. Check that the bot has **Manage Roles** and that its role sits above the Champion role, then run `/mod fix-role`.',
        );
      }
      return { ok: false, error: message };
    }
  } finally {
    roleSyncRunning.delete(guildId);
  }
}
