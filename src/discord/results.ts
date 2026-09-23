import { PermissionFlagsBits, type Guild } from 'discord.js';
import { listDoors } from '../domain/advent.js';
import { candyLeaderboard } from '../domain/candy.js';
import { getChannel, getChannels, getConfig } from '../domain/config.js';
import { FEATURE_LABEL, getEvent, markResultsPosted, type Feature, type SeasonEvent } from '../domain/events.js';
import { leaderboard as hwLeaderboard } from '../domain/halloween.js';
import { leaderboard as sbLeaderboard } from '../domain/snowball.js';
import { fetchTextChannel, postToLogs, type Bot } from './runtime.js';
import { COLORS, embed, field, mention, rankLabel } from './ui.js';

export function featureChannelIds(bot: Bot, guildId: string, feature: Feature): string[] {
  return feature === 'advent' ? [getChannel(bot.ctx, guildId, 'advent')].filter((c): c is string => !!c) : getChannels(bot.ctx, guildId, feature);
}

export function resultsEmbed(bot: Bot, ev: SeasonEvent) {
  const e = embed(COLORS.brand, `🏁 ${ev.name} has ended!`, `Thanks for playing ${FEATURE_LABEL[ev.feature]} in emojitown. Final results:`);
  if (ev.feature === 'snowball') {
    const lb = sbLeaderboard(bot.ctx, ev.guildId, ev.id, 1).page;
    e.addFields(field('Top throwers', lb.items.map((r) => `${rankLabel(r.rank)} <@${r.row.userId}> · ${r.row.hits} hits`).join('\n') || 'No hits recorded.'));
  } else if (ev.feature === 'halloween') {
    const lb = hwLeaderboard(bot.ctx, ev.guildId, ev.id, 1);
    e.addFields(
      field('👑 Halloween Champion', mention(ev.finalChampionId)),
      field('Top collectors', lb.page.items.map((r) => `${rankLabel(r.rank)} <@${r.row.userId}> · ${r.row.unique}/${lb.total}`).join('\n') || 'No items collected.'),
    );
  } else {
    const claims = bot.ctx.db
      .prepare('SELECT COUNT(*) n, COUNT(DISTINCT user_id) members FROM advent_claims WHERE guild_id = ? AND event_id = ?')
      .get(ev.guildId, ev.id) as { n: number; members: number };
    e.addFields(field('Doors opened', `${claims.n} door openings by ${claims.members} members across ${listDoors(bot.ctx, ev.guildId, ev.id).length} doors`));
  }
  const candy = candyLeaderboard(bot.ctx, ev.guildId, ev.id, 1);
  if (candy.total) e.addFields(field('🍬 Most candy this event', candy.items.slice(0, 5).map((r) => `${rankLabel(r.rank)} <@${r.row.userId}> · ${r.row.amount}`).join('\n')));
  e.addFields(field('Archive', `Results stay viewable with \`event:${ev.id}\` on the leaderboard and stats commands.`));
  return e;
}

const posting = new Set<string>();

/** Publishes an ended event's results once. Retries on the next tick if posting fails. */
export async function postResults(bot: Bot, guild: Guild, ev: SeasonEvent): Promise<void> {
  const key = `${guild.id}:${ev.id}`;
  if (posting.has(key)) return;
  const fresh = getEvent(bot.ctx, guild.id, ev.id);
  if (!fresh || fresh.resultsPosted) return;
  posting.add(key);
  try {
    await publish(bot, guild, fresh);
  } finally {
    posting.delete(key);
  }
}

async function publish(bot: Bot, guild: Guild, ev: SeasonEvent): Promise<void> {
  const e = resultsEmbed(bot, ev);
  let posted = false;
  for (const id of featureChannelIds(bot, guild.id, ev.feature).slice(0, 1)) {
    const channel = await fetchTextChannel(guild, id);
    if (!channel) continue;
    try {
      await channel.send({ embeds: [e], allowedMentions: { parse: [] } });
      posted = true;
    } catch (err) {
      console.warn(`[${guild.id}] could not post results for ${ev.id}`, err);
    }
  }
  await postToLogs(bot, guild.id, { content: `Final results for \`${ev.id}\`:`, embeds: [e] });
  if (posted || featureChannelIds(bot, guild.id, ev.feature).length === 0) markResultsPosted(bot.ctx, guild.id, ev.id);
}

const CHANNEL_PERMS: [bigint, string][] = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.AttachFiles, 'Attach Files'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
];

/** Discord-side readiness: channels exist, the bot can post there, and the Champion role is assignable. */
export async function discordChecks(bot: Bot, guild: Guild, feature: Feature | null): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const check = async (channelId: string, label: string, fatal: boolean) => {
    const channel = await fetchTextChannel(guild, channelId);
    if (!channel) {
      (fatal ? errors : warnings).push(`${label} <#${channelId}> is missing or not visible to the bot.`);
      return;
    }
    const perms = channel.permissionsFor(me);
    const missing = CHANNEL_PERMS.filter(([p]) => !perms?.has(p)).map(([, n]) => n);
    if (missing.length) (fatal ? errors : warnings).push(`In ${channel}, the bot is missing: ${missing.join(', ')}.`);
  };
  const features: Feature[] = feature ? [feature] : ['snowball', 'halloween', 'advent'];
  for (const f of features) for (const id of featureChannelIds(bot, guild.id, f)) await check(id, `${FEATURE_LABEL[f]} channel`, true);
  const logs = getChannel(bot.ctx, guild.id, 'logs');
  if (logs) await check(logs, 'Log channel', false);
  if (!feature || feature === 'halloween') {
    const roleId = getConfig(bot.ctx, guild.id).championRoleId;
    if (roleId) {
      const role = guild.roles.cache.get(roleId);
      if (!role) warnings.push('The configured Champion role no longer exists.');
      else {
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) warnings.push('The bot needs **Manage Roles** to assign the Champion role.');
        if (role.position >= me.roles.highest.position) warnings.push(`The bot's role must sit above ${role} to assign it.`);
      }
    }
  }
  if (me.permissions.has(PermissionFlagsBits.Administrator)) warnings.push('The bot has Administrator. It does not need it; consider removing it.');
  return { errors, warnings };
}
