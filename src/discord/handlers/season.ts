import { AttachmentBuilder, type Guild } from 'discord.js';
import { listDoors } from '../../domain/advent.js';
import { listAudit } from '../../domain/audit.js';
import { storedChampion } from '../../domain/champion.js';
import { getConfig } from '../../domain/config.js';
import { currencyFor } from '../../domain/currency.js';
import { parsePackJson } from '../../domain/content.js';
import { UserError } from '../../domain/errors.js';
import {
  FEATURE_LABEL,
  FEATURES,
  getCurrentEvent,
  getTargetEvent,
  listEvents,
  resolveViewEvent,
  SETUP_ACTION,
  windowFor,
  type Feature,
  type SeasonEvent,
} from '../../domain/events.js';
import { endEvent } from '../../domain/lifecycle.js';
import { reply, type ChatInput, type HandlerSet } from '../interaction.js';
import { featureChannelIds, postResults } from '../results.js';
import { memberName, syncChampionRole, type Bot } from '../runtime.js';
import { COLORS, embed, field, truncate, when } from '../ui.js';
import { policyText } from './advent.js';
import { leaderboardView as candyLeaderboard } from './candy.js';
import { leaderboardView as halloweenLeaderboard, syncEncounterMessage } from './halloween.js';
import { leaderboardView as snowballLeaderboard } from './snowball.js';

const STATE_LABEL: Record<SeasonEvent['state'], string> = {
  draft: '📝 not scheduled',
  scheduled: '🗓️ starts automatically',
  active: '🟢 live now',
  paused: '⏸️ paused',
  ended: '🏁 ended',
};

export function stateLabel(ev: SeasonEvent): string {
  return `${STATE_LABEL[ev.state]}${ev.state === 'paused' && ev.pauseReason ? ` (${ev.pauseReason})` : ''}`;
}

/** The event a staff command about `game` acts on: the running one, else the upcoming one. */
export function requireTargetEvent(bot: Bot, guildId: string, game: Feature): SeasonEvent {
  const ev = getTargetEvent(bot.ctx, guildId, game);
  if (!ev) throw new UserError(`${FEATURE_LABEL[game]} isn't set up yet. Run \`/season\` → **${SETUP_ACTION[game]}** first.`);
  return ev;
}

async function events(bot: Bot, i: ChatInput) {
  const cfg = getConfig(bot.ctx, i.guildId);
  const e = embed(COLORS.brand, '🗓️ emojitown games', `Times are shown in your own timezone. Server timezone: ${cfg.timezone}.`);
  for (const f of FEATURES) {
    const ev = getTargetEvent(bot.ctx, i.guildId, f);
    const channels = featureChannelIds(bot, i.guildId, f).map((c) => `<#${c}>`).join(', ') || 'not set up';
    if (!ev || ev.state === 'draft') {
      e.addFields(field(FEATURE_LABEL[f], 'Not scheduled yet.'));
      continue;
    }
    const win = windowFor(bot.ctx, ev);
    const lines = [`**${ev.name}**: ${stateLabel(ev)}`, `${when(win.startsAt)} → ${when(win.endsAt)}`, `Where: ${channels}`];
    if (f === 'halloween' && ev.state !== 'scheduled') lines.push(`👑 Champion: ${memberName(bot, i.guildId, storedChampion(bot.ctx, i.guildId, ev.id))}`);
    if (f === 'advent') lines.push(policyText(cfg.adventPolicy, win.claimDeadline));
    e.addFields(field(FEATURE_LABEL[f], lines.join('\n')));
  }
  await reply(i, { embeds: [e] });
}

async function leaderboard(bot: Bot, i: ChatInput) {
  let game = i.options.getString('game');
  if (!game) {
    game = getCurrentEvent(bot.ctx, i.guildId, 'halloween') ? 'halloween' : getCurrentEvent(bot.ctx, i.guildId, 'snowball') ? 'snowball' : 'candy';
  }
  const season = i.options.getString('season');
  const page = i.options.getInteger('page') ?? 1;
  if (game === 'halloween') return reply(i, halloweenLeaderboard(bot, i.guildId, season, page));
  if (game === 'snowball') return reply(i, snowballLeaderboard(bot, i.guildId, season, page));
  return reply(i, candyLeaderboard(bot, i.guildId, season, page));
}

export function announcementEmbed(bot: Bot, ev: SeasonEvent) {
  const win = windowFor(bot.ctx, ev);
  const channels = featureChannelIds(bot, ev.guildId, ev.feature).map((c) => `<#${c}>`).join(', ') || '—';
  const cur = currencyFor(bot.ctx, ev.guildId, ev.feature);
  const how: Record<Feature, string> = {
    snowball:
      'Use `/collect` to make a snowball (one every 30 seconds), then `/throw` it at a friend. Half of all throws hit! Getting hit means a 2-minute warm-up before you can collect again, but you can still throw snowballs you already have. Check `/stats` and `/leaderboard`. Rather not play? `/snowball leave`.',
    halloween:
      `Keep chatting and emojitown visitors will drop by. Each one asks for a **Trick** or a **Treat**; the first correct answer wins an item and ${cur.name}. A wrong answer uses up your try for that visitor. Collect all items and become the Halloween Champion! See \`/inventory\` and \`/leaderboard\`.`,
    advent: `A new door opens every day. Press **Open Door** or use \`/advent\` for a surprise and ${cur.name}.`,
  };
  const e = embed(COLORS.brand, `✨ ${ev.name} is ${ev.state === 'active' ? 'on' : 'coming'}!`, how[ev.feature]).addFields(
    field('When', `${when(win.startsAt)} → ${when(win.endsAt)}`),
    field('Where', channels),
  );
  if (ev.feature === 'advent') e.addFields(field('Missed a day?', policyText(getConfig(bot.ctx, ev.guildId).adventPolicy, win.claimDeadline)));
  e.addFields(field('Questions?', '`/help` explains everything.'));
  return e;
}

/** Ends an event, updates any open visitor message, syncs the Champion role and posts results once. */
export async function finishEnd(bot: Bot, guild: Guild, eventId: string, actorId: string, keepChampionRole?: boolean): Promise<SeasonEvent> {
  const { event, closed } = endEvent(bot.ctx, guild.id, eventId, actorId, null, { keepChampionRole });
  for (const enc of closed) await syncEncounterMessage(bot, guild, enc);
  if (event.feature === 'halloween') void syncChampionRole(bot, guild.id);
  await postResults(bot, guild, event);
  return event;
}

export function exportFile(bot: Bot, guildId: string, ev: SeasonEvent): AttachmentBuilder {
  const q = (sql: string) => bot.ctx.db.prepare(sql).all(guildId, ev.id);
  const data = {
    exportedAt: new Date(bot.ctx.now()).toISOString(),
    guildId,
    config: getConfig(bot.ctx, guildId),
    event: ev,
    snowball:
      ev.feature === 'snowball'
        ? { players: q('SELECT * FROM snowball_players WHERE guild_id = ? AND event_id = ?'), throws: q('SELECT * FROM snowball_throws WHERE guild_id = ? AND event_id = ?') }
        : undefined,
    halloween:
      ev.feature === 'halloween'
        ? {
            contentVersion: ev.contentVersion,
            items: q('SELECT * FROM hw_items WHERE guild_id = ? AND event_id = ?'),
            encounters: q('SELECT * FROM hw_encounters WHERE guild_id = ? AND event_id = ?'),
            champion: q('SELECT * FROM hw_champion WHERE guild_id = ? AND event_id = ?'),
          }
        : undefined,
    advent: ev.feature === 'advent' ? { doors: listDoors(bot.ctx, guildId, ev.id), claims: q('SELECT * FROM advent_claims WHERE guild_id = ? AND event_id = ?') } : undefined,
    candyTransactions: q('SELECT * FROM candy_txns WHERE guild_id = ? AND event_id = ?'),
    audit: q('SELECT * FROM audit_log WHERE guild_id = ? AND event_id = ?'),
  };
  return new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2)), { name: `${ev.id}-export.json` });
}

export function auditEmbed(bot: Bot, guildId: string, memberId: string | null) {
  const entries = listAudit(bot.ctx, guildId, { memberId: memberId ?? undefined, limit: 15 });
  const lines = entries.map(
    (a) =>
      `\`#${a.id}\` <t:${Math.floor(a.createdAt / 1000)}:g> **${a.action}** by ${a.actorId === 'system' ? 'the bot' : `<@${a.actorId}>`}${a.targetId ? ` → <@${a.targetId}>` : ''}${a.reason ? ` · ${truncate(a.reason, 60)}` : ''}`,
  );
  return embed(COLORS.staff, memberId ? '📋 Staff actions involving this member' : '📋 Staff log', lines.join('\n') || 'No staff actions yet.');
}

const ATTACHMENT_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

/** Downloads an attached text file from Discord's CDN. */
export async function fetchAttachmentText(url: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ATTACHMENT_HOSTS.includes(u.hostname)) throw new UserError('Attach the file directly to the command.');
  const res = await fetch(u, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!res.ok) throw new UserError(`Could not download the file (HTTP ${res.status}).`);
  return res.text();
}

/** Downloads an attached JSON file from Discord's CDN. */
export async function fetchAttachmentJson(url: string): Promise<unknown> {
  return parsePackJson(await fetchAttachmentText(url));
}

/** Past and present events for `season` autocomplete. */
export function seasonChoices(bot: Bot, guildId: string, feature: Feature | undefined, q: string) {
  return listEvents(bot.ctx, guildId, feature)
    .filter((e) => e.state !== 'draft' && e.state !== 'scheduled')
    .filter((e) => e.id.includes(q) || e.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((e) => ({ name: `${e.name}${e.state === 'ended' ? '' : ' (current)'}`.slice(0, 100), value: e.id }));
}

export { resolveViewEvent };

export const seasonHandlers: HandlerSet = {
  chat: {
    events,
    leaderboard,
  },
};
