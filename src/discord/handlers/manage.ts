import { AttachmentBuilder, type Guild, type GuildTextBasedChannel } from 'discord.js';
import { listDoors } from '../../domain/advent.js';
import { audit } from '../../domain/audit.js';
import { addChannel, getChannel, getChannels, getConfig, getStaffRoles, removeChannel, setStaffRole, updateConfig, type GuildConfig } from '../../domain/config.js';
import { getPack, importPack, latestVersion } from '../../domain/content.js';
import { tx } from '../../domain/context.js';
import { UserError } from '../../domain/errors.js';
import {
  ensureEvent,
  eventWindow,
  FEATURE_LABEL,
  getCurrentEvent,
  getCurrentOrLatestEvent,
  getEvent,
  listEvents,
  requireEvent,
  scheduleEvent,
  setEventState,
  windowFor,
  type Feature,
  type SeasonEvent,
} from '../../domain/events.js';
import { checkEvent, pauseEvent, resumeEvent, startEvent } from '../../domain/lifecycle.js';
import { exclude, include, type ExclusionScope } from '../../domain/members.js';
import { clearWarmup, getPlayer } from '../../domain/snowball.js';
import type { ContentFeature } from '../../content/types.js';
import { addDays, formatSeconds, isValidZone, parseDate, parseDuration, parseTime } from '../../util/time.js';
import { askConfirm, reply, type ChatHandler, type ChatInput, type HandlerSet } from '../interaction.js';
import { describeDiff, syncGuildCommands } from '../commandSync.js';
import { discordChecks, featureChannelIds } from '../results.js';
import { assertLevel, assertSafeStaffRole, syncChampionRole, type Bot } from '../runtime.js';
import { COLORS, embed, field, mention, when } from '../ui.js';
import { postDoor, showDoorForm } from './advent.js';
import { askGiveCandy, askUndoCandy, historyView } from './candy.js';
import { cancelVisitor, fixItem, fixRole, setChampionRole, syncEncounterMessage, visitorStatusText } from './halloween.js';
import { rescheduleSpawnIfSooner, wipeCollections } from '../../domain/halloween.js';
import { announcementEmbed, auditEmbed, exportFile, fetchAttachmentJson, finishEnd, requireTargetEvent, stateLabel } from './season.js';
import { askStatsFix } from './snowball.js';
import { messageTest } from './messageTest.js';

const GAME_ICON: Record<Feature, string> = { halloween: '🎃', snowball: '❄️', advent: '🎄' };

/** Formats an event's dates as "2026-10-01 → 2026-10-31" (inclusive end). */
function dateRange(ev: SeasonEvent): string {
  return `${ev.startLocal.slice(0, 10)} → ${addDays(ev.endLocal.slice(0, 10), -1)}`;
}

function roleList(ids: string[]): string {
  return ids.map((r) => `<@&${r}>`).join(', ') || 'none';
}

/** IDs from a multi-select form field, or null when the form didn't have that field. */
function idsOption(i: ChatInput, name: string): string[] | null {
  const opts = i.options as unknown as { getIds?: (n: string) => string[] | null };
  return opts.getIds ? opts.getIds(name) : null;
}

function channelList(ids: string[]): string {
  return ids.map((c) => `<#${c}>`).join(', ') || 'none';
}

/** Builds the standard reply: what changed (or that nothing did), then extra sections. */
function resultEmbed(title: string, changes: string[], color: number = COLORS.staff) {
  return embed(color, title, changes.length ? `**What changed**\n${changes.join('\n')}` : '**Nothing changed.** Here is the current setup.');
}

function readinessFields(errors: string[], warnings: string[]) {
  const out = [];
  if (errors.length) out.push(field('Still needed before it can go live', errors.map((e) => `❌ ${e}`).join('\n')));
  if (warnings.length) out.push(field('Heads-up', warnings.map((w) => `⚠️ ${w}`).join('\n')));
  return out;
}

async function readiness(bot: Bot, i: ChatInput, ev: SeasonEvent) {
  return readinessFor(bot, i.guild, ev);
}

async function readinessFor(bot: Bot, guild: Guild, ev: SeasonEvent) {
  const r = checkEvent(bot.ctx, guild.id, ev.id);
  const d = await discordChecks(bot, guild, ev.feature);
  return { errors: [...r.errors, ...d.errors], warnings: [...r.warnings, ...d.warnings] };
}

/**
 * Starts a scheduled event whose start time has passed, if it is ready.
 * Returns a change line, or null when it can't or shouldn't start yet.
 */
async function startIfDue(bot: Bot, i: ChatInput, ev: SeasonEvent): Promise<string | null> {
  if (ev.state !== 'scheduled') return null;
  const win = windowFor(bot.ctx, ev);
  if (bot.ctx.now() < win.startsAt || bot.ctx.now() >= win.endsAt) return null;
  const { errors } = await readiness(bot, i, ev);
  if (errors.length) return null;
  startEvent(bot.ctx, i.guildId, ev.id, i.user.id);
  if (ev.feature === 'halloween') void syncChampionRole(bot, i.guildId);
  return `**Status:** ${stateLabel(ev)} → 🟢 live now`;
}

// ── /settings ────────────────────────────────────────────────────

async function setupServer(bot: Bot, i: ChatInput) {
  const zone = i.options.getString('timezone');
  if (zone && !isValidZone(zone)) throw new UserError(`\`${zone}\` isn't a timezone I know. Pick one from the list, e.g. Europe/Copenhagen.`);
  // The form shows the current staff roles preselected; whatever is selected on submit becomes the list.
  const wanted = idsOption(i, 'staff_roles');
  const current = getStaffRoles(bot.ctx, i.guildId);
  const addRoles = wanted ? wanted.filter((r) => !current.includes(r)).map((r) => i.guild.roles.cache.get(r)!).filter(Boolean) : [];
  const dropRoles = wanted ? current.filter((r) => !wanted.includes(r)) : [];
  const logs = i.options.getChannel('log_channel');
  const support = i.options.getString('support');
  for (const role of addRoles) {
    assertSafeStaffRole(i.guild, role);
    if (role.id === getConfig(bot.ctx, i.guildId).championRoleId) throw new UserError('That is the Halloween Champion role. Pick a staff role.');
  }

  const changes: string[] = [];
  const before = getConfig(bot.ctx, i.guildId);
  const shifted = listEvents(bot.ctx, i.guildId).filter((e) => e.state !== 'ended');
  tx(bot.ctx, () => {
    const change = updateConfig(bot.ctx, i.guildId, { timezone: zone ?? undefined, supportDestination: support ?? undefined, setupSavedAt: bot.ctx.now() });
    if ('timezone' in change.after) {
      changes.push(`**Timezone:** ${before.timezoneSet ? before.timezone : 'not set (UTC)'} → ${zone}`);
      for (const ev of shifted) {
        const a = eventWindow(ev, before.timezone).startsAt;
        const b = eventWindow(ev, zone!).startsAt;
        if (a !== b) changes.push(`  ↳ ${ev.name} start moves: ${when(a)} → ${when(b)}`);
      }
    }
    if ('supportDestination' in change.after) changes.push(`**Support link:** ${before.supportDestination ?? 'none'} → ${support}`);
    if (logs) {
      const previous = addChannel(bot.ctx, i.guildId, 'logs', logs.id);
      if (previous[0] !== logs.id) changes.push(`**Log channel:** ${previous[0] ? `<#${previous[0]}>` : 'none'} → ${logs}`);
    }
    if (addRoles.length || dropRoles.length) {
      for (const role of addRoles) setStaffRole(bot.ctx, i.guildId, role.id, true);
      for (const id of dropRoles) setStaffRole(bot.ctx, i.guildId, id, false);
      changes.push(`**Staff roles:** ${roleList(current)} → ${roleList(getStaffRoles(bot.ctx, i.guildId))}`);
    }
    if (changes.length) audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'setup.server', after: { changes } });
  });

  const cfg = getConfig(bot.ctx, i.guildId);
  const e = resultEmbed('⚙️ Server setup', changes).addFields(
    field('Timezone', cfg.timezoneSet ? cfg.timezone : 'not set (UTC). Set it with `timezone:`', true),
    field('Staff roles', getStaffRoles(bot.ctx, i.guildId).map((r) => `<@&${r}>`).join(', ') || 'none', true),
    field('Log channel', getChannel(bot.ctx, i.guildId, 'logs') ? `<#${getChannel(bot.ctx, i.guildId, 'logs')}>` : 'none', true),
    field('Support link', cfg.supportDestination ?? 'none', true),
  );
  if (addRoles.length) {
    e.addFields(
      field(
        'One more step',
        `So ${addRoles.join(', ')} can see the staff commands: **Server Settings → Integrations → emojitown**, open \`/season\` and \`/player\`, and add the role to each.`,
      ),
    );
  }
  e.addFields(field('Next', 'Set up a game with `/season`.'));
  await reply(i, { embeds: [e] });
}

// ── /season halloween | snowball | advent ─────────────────────────────

function durationOption(i: ChatInput, name: string, label: string, min: number, max: number, unit: 's' | 'm' = 'm'): number | undefined {
  const raw = i.options.getString(name);
  if (raw === null) return undefined;
  const s = parseDuration(raw, unit);
  if (s === null) throw new UserError(`${label}: "${raw}" isn't a duration. Use something like 30s, 10m, 2h or 1d (m = minutes).`);
  if (s < min || s > max) throw new UserError(`${label} must be between ${formatSeconds(min)} and ${formatSeconds(max)}.`);
  return s;
}

function dateOption(i: ChatInput, name: string): string | null {
  const raw = i.options.getString(name);
  if (raw === null) return null;
  const d = parseDate(raw);
  if (!d) throw new UserError(`\`${name}\` must be a date like 2026-10-05.`);
  return d;
}

async function setupGame(bot: Bot, i: ChatInput, game: Feature) {
  const o = i.options;
  const changes: string[] = [];
  const warnings: string[] = [];
  const before = getConfig(bot.ctx, i.guildId);

  // Validate every option before changing anything.
  const start = dateOption(i, 'start');
  const end = game === 'advent' ? null : dateOption(i, 'end');
  const cfgPatch: Partial<GuildConfig> = {};
  if (game === 'halloween') {
    const min = durationOption(i, 'wait_min', 'Shortest wait', 10, 30 * 86400);
    const max = durationOption(i, 'wait_max', 'Longest wait', 10, 30 * 86400);
    const visit = durationOption(i, 'visit_length', 'Visit length', 10, 3600);
    const cleanupRaw = o.getString('delete_after');
    const cleanup = cleanupRaw !== null && /^(off|never|no|keep|0s?)$/i.test(cleanupRaw.trim()) ? 0 : durationOption(i, 'delete_after', 'Delete after', 1, 86400, 's');
    const newMin = min ?? before.hwSpawnMinS;
    const newMax = max ?? before.hwSpawnMaxS;
    if (newMin > newMax) {
      throw new UserError(`The shortest wait (${formatSeconds(newMin)}) can't be longer than the longest wait (${formatSeconds(newMax)}).`);
    }
    Object.assign(cfgPatch, {
      hwSpawnMinS: min,
      hwSpawnMaxS: max,
      hwEncounterS: visit,
      hwCleanupS: cleanup,
      candyPerHalloweenWin: o.getInteger('candy_per_win') ?? undefined,
      candyHalloweenDailyLimit: o.getInteger('daily_candy_limit') ?? undefined,
    });
  }
  if (game === 'advent') {
    const unlockRaw = o.getString('unlock_time');
    const unlock = unlockRaw === null ? undefined : parseTime(unlockRaw);
    if (unlock === null) throw new UserError('`unlock_time` must look like 09:00.');
    const catchUp = o.getBoolean('catch_up');
    Object.assign(cfgPatch, {
      adventDoorCount: o.getInteger('doors') ?? undefined,
      adventUnlockTime: unlock,
      adventAnnounceTime: unlock,
      adventPolicy: catchUp === null ? undefined : catchUp ? 'catch-up' : 'same-day',
    });
  }
  const championRole = game === 'halloween' ? o.getRole('champion_role') : null;
  const channel = o.getChannel('channel');
  const removeCh = game === 'advent' ? null : o.getChannel('remove_channel');
  const wantedChannels = game === 'advent' ? null : idsOption(i, 'channels');

  const LABELS: Partial<Record<keyof GuildConfig, [string, (v: any) => string]>> = {
    hwSpawnMinS: ['Shortest wait between visitors', formatSeconds],
    hwSpawnMaxS: ['Longest wait between visitors', formatSeconds],
    hwEncounterS: ['Visit length', formatSeconds],
    hwCleanupS: ['Finished visitor messages', (v: number) => (v > 0 ? `deleted after ${formatSeconds(v)}` : 'kept')],
    candyPerHalloweenWin: ['Candy per win', String],
    candyHalloweenDailyLimit: ['Daily Halloween candy limit', String],
    adventDoorCount: ['Doors', String],
    adventUnlockTime: ['Doors open at', String],
    adventPolicy: ['Missed doors', (v) => (v === 'catch-up' ? 'can be claimed later' : 'same day only')],
  };

  let ev!: SeasonEvent;
  tx(bot.ctx, () => {
    // Channels
    if (channel) {
      if (game === 'advent') {
        const previous = addChannel(bot.ctx, i.guildId, 'advent', channel.id);
        if (previous[0] !== channel.id) changes.push(`**Channel:** ${previous[0] ? `<#${previous[0]}>` : 'none'} → ${channel}`);
      } else if (!getChannels(bot.ctx, i.guildId, game).includes(channel.id)) {
        const previous = getChannels(bot.ctx, i.guildId, game);
        addChannel(bot.ctx, i.guildId, game, channel.id);
        changes.push(`**Channels:** ${channelList(previous)} → ${channelList(getChannels(bot.ctx, i.guildId, game))}`);
      }
    }
    if (wantedChannels) {
      const g = game as 'halloween' | 'snowball';
      const previous = getChannels(bot.ctx, i.guildId, g);
      for (const id of wantedChannels) if (!previous.includes(id)) addChannel(bot.ctx, i.guildId, g, id);
      for (const id of previous) if (!wantedChannels.includes(id)) removeChannel(bot.ctx, i.guildId, g, id);
      const now = getChannels(bot.ctx, i.guildId, g);
      if (now.join() !== previous.join()) changes.push(`**Channels:** ${channelList(previous)} → ${channelList(now)}`);
    }
    if (removeCh && getChannels(bot.ctx, i.guildId, game as 'halloween' | 'snowball').includes(removeCh.id)) {
      const previous = getChannels(bot.ctx, i.guildId, game as 'halloween' | 'snowball');
      removeChannel(bot.ctx, i.guildId, game as 'halloween' | 'snowball', removeCh.id);
      changes.push(`**Channels:** ${channelList(previous)} → ${channelList(getChannels(bot.ctx, i.guildId, game as 'halloween' | 'snowball'))}`);
    }

    // Settings
    const change = updateConfig(bot.ctx, i.guildId, cfgPatch);
    for (const key of Object.keys(change.after) as (keyof GuildConfig)[]) {
      const label = LABELS[key];
      if (label && key !== 'adventAnnounceTime') changes.push(`**${label[0]}:** ${label[1](change.before[key])} → ${label[1](change.after[key])}`);
    }

    // The season itself: create it if needed, then set dates and turn on automatic start.
    const ensured = ensureEvent(bot.ctx, i.guildId, game, i.user.id);
    ev = ensured.event;
    if (ensured.created) changes.push(`**Season:** none → ${ev.name}`);
    const doors = getConfig(bot.ctx, i.guildId).adventDoorCount;
    const curStart = ev.startLocal.slice(0, 10);
    const curEnd = addDays(ev.endLocal.slice(0, 10), -1);
    const newStart = start ?? curStart;
    const newEnd = game === 'advent' ? addDays(newStart, doors - 1) : (end ?? curEnd);
    const running = ev.state === 'active' || ev.state === 'paused';
    if (newStart !== curStart || newEnd !== curEnd || (!running && !ev.autoActivate)) {
      const beforeRange = dateRange(ev);
      const beforeState = ev.state;
      ev = scheduleEvent(bot.ctx, i.guildId, ev.id, { startDate: newStart, endDate: newEnd, autoActivate: true, claimDeadline: null }, i.user.id);
      if (dateRange(ev) !== beforeRange) changes.push(`**Dates:** ${ensured.created ? 'default' : beforeRange} → ${dateRange(ev)}`);
      if (ev.state !== beforeState) changes.push(`**Status:** ${STATE_WORD[beforeState]} → ${STATE_WORD[ev.state]}`);
    }
    if (changes.length) audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: `setup.${game}`, eventId: ev.id, after: { changes } });
  });

  if (game === 'halloween' && (cfgPatch.hwSpawnMinS !== undefined || cfgPatch.hwSpawnMaxS !== undefined)) {
    const at = rescheduleSpawnIfSooner(bot.ctx, i.guildId);
    if (at !== null) changes.push(`**Next visitor:** moved up to ${when(at)}`);
  }

  if (championRole) {
    const r = await setChampionRole(bot, i, championRole);
    changes.push(...r.changes);
    warnings.push(...r.warnings);
  }

  ev = getEvent(bot.ctx, i.guildId, ev.id)!;
  const started = await startIfDue(bot, i, ev);
  if (started) changes.push(started);
  const visible = describeDiff(await syncGuildCommands(bot, i.guild));
  if (visible) changes.push(visible);
  ev = getEvent(bot.ctx, i.guildId, ev.id)!;

  const cfg = getConfig(bot.ctx, i.guildId);
  const win = windowFor(bot.ctx, ev);
  const e = resultEmbed(`${GAME_ICON[game]} ${FEATURE_LABEL[game]} setup`, changes).addFields(
    field('Season', `${ev.name}: ${stateLabel(ev)}`),
    field('Dates', `${when(win.startsAt)} → ${when(win.endsAt)}`),
    field(game === 'advent' ? 'Channel' : 'Channels', channelList(featureChannelIds(bot, i.guildId, game))),
  );
  if (game === 'halloween') {
    e.addFields(
      field('Visitors', `every ${formatSeconds(cfg.hwSpawnMinS)}–${formatSeconds(cfg.hwSpawnMaxS)}, stay ${formatSeconds(cfg.hwEncounterS)}`, true),
      field('Candy', `${cfg.candyPerHalloweenWin} per win, max ${cfg.candyHalloweenDailyLimit}/day`, true),
      field('Champion role', cfg.championRoleId ? `<@&${cfg.championRoleId}>` : 'none (optional)', true),
    );
    if (ev.state === 'active') e.addFields(field('Visitors right now', visitorStatusText(bot, i.guildId)));
  }
  if (game === 'advent') {
    const filled = listDoors(bot.ctx, i.guildId, ev.id).length;
    e.addFields(
      field('Doors', `${filled}/${cfg.adventDoorCount} written · open daily at ${cfg.adventUnlockTime}`, true),
      field('Missed doors', cfg.adventPolicy === 'catch-up' ? 'can be claimed later' : 'same day only', true),
    );
  }
  if (ev.state !== 'active') {
    const r = await readiness(bot, i, ev);
    e.addFields(...readinessFields(r.errors, [...warnings, ...r.warnings]));
    if (!r.errors.length && ev.state === 'scheduled') e.addFields(field('Next', `Nothing else needed: it goes live on its own ${when(win.startsAt)}.`));
  } else if (warnings.length) {
    e.addFields(...readinessFields([], warnings));
  }
  await reply(i, { embeds: [e] });
}

const STATE_WORD: Record<SeasonEvent['state'], string> = {
  draft: 'not scheduled',
  scheduled: 'starts automatically',
  active: 'live',
  paused: 'paused',
  ended: 'ended',
};

// ── /season door | content | status ───────────────────────────────────

async function setupDoor(bot: Bot, i: ChatInput) {
  const ev = requireTargetEvent(bot, i.guildId, 'advent');
  await showDoorForm(bot, i, ev, i.options.getInteger('day', true), i.options.getInteger('candy'), i.options.getString('reason'));
}

async function setupContent(bot: Bot, i: ChatInput) {
  const game = i.options.getString('game', true) as ContentFeature;
  const file = i.options.getAttachment('file');
  const version = latestVersion(bot.ctx, i.guildId, game);
  const label = (v: number) => (v === 0 ? 'v0 (built-in placeholder)' : `v${v}`);
  if (!file) {
    const pack = getPack(bot.ctx, i.guildId, game);
    await reply(i, {
      content: `Here is the current ${FEATURE_LABEL[game]} content (${label(version)}). Edit it and upload it back with \`/season\` → **Content file**. Nothing changed.`,
      files: [new AttachmentBuilder(Buffer.from(JSON.stringify(pack, null, 2)), { name: `${game}-content.json` })],
    });
    return;
  }
  if (file.size > 2_000_000) throw new UserError('Content files are limited to 2 MB.');
  const data = await fetchAttachmentJson(file.url);
  const changes: string[] = [];
  const r = tx(bot.ctx, () => {
    const result = importPack(bot.ctx, i.guildId, game, data, i.user.id);
    if (result.version === null) return result;
    changes.push(`**${FEATURE_LABEL[game]} content:** ${label(version)} → ${label(result.version)}`);
    // Stable IDs are guaranteed by the import, so a running season can switch safely.
    const running = getCurrentEvent(bot.ctx, i.guildId, game);
    if (running) {
      setEventState(bot.ctx, running, { content_version: result.version });
      changes.push(`**${running.name}:** now uses ${label(result.version)} (live)`);
    }
    audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'content.import', eventId: running?.id ?? null, after: { game, version: result.version } });
    return result;
  });
  if (r.version === null) {
    await reply(i, { embeds: [embed(COLORS.error, 'Upload rejected. Nothing changed.', `Fix these in the file and upload it again:\n• ${r.errors.slice(0, 25).join('\n• ')}`)] });
    return;
  }
  const e = resultEmbed('📦 Content uploaded', changes, COLORS.hit);
  if (r.warnings.length) e.addFields(field('Heads-up', r.warnings.slice(0, 10).map((w) => `⚠️ ${w}`).join('\n')));
  await reply(i, { embeds: [e] });
}

async function setupStatus(bot: Bot, i: ChatInput) {
  await reply(i, { embeds: [await statusEmbed(bot, i.guild, true)] });
}

/** Setup checklist: the server basics (optional) and each game's state and readiness. */
export async function statusEmbed(bot: Bot, guild: Guild, withServer: boolean) {
  const i = { guildId: guild.id, guild };
  const cfg = getConfig(bot.ctx, i.guildId);
  const e = embed(COLORS.staff, withServer ? '⚙️ emojitown settings' : '🗓️ emojitown seasons');
  if (withServer) e.addFields(
    field(
      'Server',
      [
        `${cfg.timezoneSet ? '✅' : '⚠️'} Timezone: ${cfg.timezoneSet ? cfg.timezone : 'not set (UTC)'}`,
        `${getStaffRoles(bot.ctx, i.guildId).length ? '✅' : '⚠️'} Staff roles: ${getStaffRoles(bot.ctx, i.guildId).map((r) => `<@&${r}>`).join(', ') || 'none'}`,
        `${getChannel(bot.ctx, i.guildId, 'logs') ? '✅' : '⚠️'} Log channel: ${getChannel(bot.ctx, i.guildId, 'logs') ? `<#${getChannel(bot.ctx, i.guildId, 'logs')}>` : 'none'}`,
        `Support link: ${cfg.supportDestination ?? 'none'}`,
      ].join('\n'),
    ),
  );
  for (const game of ['halloween', 'snowball', 'advent'] as Feature[]) {
    const ev = getCurrentEvent(bot.ctx, i.guildId, game) ?? listEvents(bot.ctx, i.guildId, game).find((x) => x.state === 'draft' || x.state === 'scheduled');
    if (!ev) {
      e.addFields(field(`${GAME_ICON[game]} ${FEATURE_LABEL[game]}`, 'Not set up yet.'));
      continue;
    }
    const win = windowFor(bot.ctx, ev);
    const lines = [`${ev.name}: ${stateLabel(ev)}`, `${when(win.startsAt)} → ${when(win.endsAt)}`, `Channels: ${channelList(featureChannelIds(bot, i.guildId, game))}`];
    if (game === 'halloween' && ev.state === 'active') lines.push(visitorStatusText(bot, i.guildId));
    if (game !== 'advent') {
      const v = ev.contentVersion ?? latestVersion(bot.ctx, i.guildId, game);
      lines.push(v === 0 ? '⚠️ Using placeholder content (`/season` → **Content file**)' : `Content: v${v}`);
    } else {
      lines.push(`Doors written: ${listDoors(bot.ctx, i.guildId, ev.id).length}/${cfg.adventDoorCount}`);
    }
    if (ev.state !== 'active' && ev.state !== 'ended') {
      const r = await readinessFor(bot, guild, ev);
      lines.push(...r.errors.slice(0, 5).map((x) => `❌ ${x}`), ...r.warnings.slice(0, 3).map((x) => `⚠️ ${x}`));
      if (!r.errors.length) lines.push('✅ Ready');
    }
    e.addFields(field(`${GAME_ICON[game]} ${FEATURE_LABEL[game]}`, lines.join('\n')));
  }
  return e;
}

// ── /season start | end | announce | export | wipe-items ───────────────────────────────────────────────────────────

const game = (i: ChatInput) => i.options.getString('game', true) as Feature;

async function adminStart(bot: Bot, i: ChatInput) {
  const ev = requireTargetEvent(bot, i.guildId, game(i));
  if (ev.state === 'active') return reply(i, `**${ev.name}** is already live. Nothing changed.`);
  if (ev.state === 'paused') throw new UserError(`**${ev.name}** is paused. Use \`/season\` → **Resume a paused game** instead.`);
  const d = await discordChecks(bot, i.guild, ev.feature);
  const started = startEvent(bot.ctx, i.guildId, ev.id, i.user.id, d.errors);
  if (started.feature === 'halloween') void syncChampionRole(bot, i.guildId);
  const lines = [`**Status:** ${stateLabel(ev)} → 🟢 live now`];
  const visible = describeDiff(await syncGuildCommands(bot, i.guild));
  if (visible) lines.push(visible);
  const e = resultEmbed(`${GAME_ICON[ev.feature]} ${ev.name}`, lines, COLORS.hit).addFields(
    field('Ends', when(windowFor(bot.ctx, started).endsAt)),
  );
  if (d.warnings.length) e.addFields(...readinessFields([], d.warnings));
  await reply(i, { embeds: [e] });
}

async function adminEnd(bot: Bot, i: ChatInput) {
  const g = game(i);
  const ev = getCurrentEvent(bot.ctx, i.guildId, g) ?? requireTargetEvent(bot, i.guildId, g);
  const keep = (i.options.getString('champion_role') ?? 'keep') === 'keep';
  const effects = [`**Status:** ${stateLabel(ev)} → 🏁 ended`, 'New play stops, results are frozen and posted once.'];
  if (g === 'halloween') {
    effects.push('Any visitor still around leaves without rewards.');
    effects.push(keep ? 'The Champion keeps their role until next Halloween starts.' : 'The Champion role is removed now.');
  }
  if (g === 'advent') effects.push('Doors can no longer be claimed; they stay readable.');
  await askConfirm(bot, i, 'season.end', { eventId: ev.id, keep }, embed(COLORS.warn, `End ${ev.name}?`, effects.join('\n')));
}

async function adminFixStats(bot: Bot, i: ChatInput) {
  const ev = getCurrentOrLatestEvent(bot.ctx, i.guildId, 'snowball');
  if (!ev) throw new UserError("Snowball Fights hasn't run yet, so there are no stats to fix.");
  await askStatsFix(
    bot,
    i,
    ev.id,
    i.options.getUser('member', true),
    i.options.getString('stat', true) as Parameters<typeof askStatsFix>[4],
    i.options.getInteger('value', true),
    i.options.getString('reason', true),
  );
}

function halloweenSeasonFor(bot: Bot, guildId: string): SeasonEvent {
  const ev = getCurrentOrLatestEvent(bot.ctx, guildId, 'halloween');
  if (!ev) throw new UserError("Halloween hasn't run yet, so nobody has any items.");
  return ev;
}

async function playerItem(bot: Bot, i: ChatInput, action: 'grant' | 'revoke') {
  const ev = halloweenSeasonFor(bot, i.guildId);
  await reply(i, await fixItem(bot, i, ev.id, i.options.getUser('member', true), action, i.options.getString('item', true), i.options.getString('reason', true)));
}

async function askWipe(bot: Bot, i: ChatInput, everyone: boolean) {
  const ev = halloweenSeasonFor(bot, i.guildId);
  const member = everyone ? null : i.options.getUser('member', true);
  const reason = i.options.getString('reason', true);
  const row = bot.ctx.db
    .prepare(`SELECT COUNT(DISTINCT user_id) members, COUNT(*) items FROM hw_items WHERE guild_id = ? AND event_id = ?${member ? ' AND user_id = ?' : ''}`)
    .get(...(member ? [i.guildId, ev.id, member.id] : [i.guildId, ev.id])) as { members: number; items: number };
  if (row.items === 0) return reply(i, `${member ? `${member} has` : 'Nobody has'} any items in **${ev.name}**. Nothing changed.`);
  const who = member ? `${member}'s collection` : `**every** collection (${row.members} members)`;
  await askConfirm(
    bot,
    i,
    'halloween.wipe',
    { eventId: ev.id, userId: member?.id ?? null, reason },
    embed(
      COLORS.error,
      `Wipe ${member ? 'items' : 'ALL items'} in ${ev.name}?`,
      [
        `This deletes ${who}: **${row.items}** owned item${row.items === 1 ? '' : 's'}.`,
        'Candy already earned is kept. The Champion is recalculated.',
        "**This can't be undone** (items can only be given back one at a time with `/player` → **Give an item**).",
      ].join('\n'),
    ),
  );
}

async function adminClearWarmup(bot: Bot, i: ChatInput) {
  const member = i.options.getUser('member', true);
  const ev = getCurrentEvent(bot.ctx, i.guildId, 'snowball');
  const before = ev ? getPlayer(bot.ctx, i.guildId, ev.id, member.id)?.warmUntil : undefined;
  clearWarmup(bot.ctx, i.guildId, member.id, i.options.getString('reason', true), i.user.id);
  await reply(i, `**${member}'s warm-up:** until ${before ? when(before) : '—'} → cleared. They can collect snowballs now.`);
}

async function adminAnnounce(bot: Bot, i: ChatInput) {
  const ev = requireTargetEvent(bot, i.guildId, game(i));
  const target = i.options.getChannel('channel', true);
  await askConfirm(bot, i, 'season.announce', { eventId: ev.id, channelId: target.id }, announcementEmbed(bot, ev).setAuthor({ name: `Preview · will be posted in #${target.name}` }));
}

async function adminExport(bot: Bot, i: ChatInput) {
  const season = i.options.getString('season');
  const ev = season ? requireEvent(bot.ctx, i.guildId, season) : (getCurrentOrLatestEvent(bot.ctx, i.guildId, game(i)) ?? requireTargetEvent(bot, i.guildId, game(i)));
  audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'export', eventId: ev.id });
  await reply(i, { content: `All data for **${ev.name}** (staff only, handle with care):`, files: [exportFile(bot, i.guildId, ev)] });
}

// ── /game and /player ─────────────────────────────────────────────────────────────

async function modPause(bot: Bot, i: ChatInput) {
  const ev = getCurrentEvent(bot.ctx, i.guildId, game(i));
  if (!ev) throw new UserError(`${FEATURE_LABEL[game(i)]} isn't live, so there's nothing to pause.`);
  if (ev.state === 'paused') return reply(i, `**${ev.name}** is already paused. Nothing changed.`);
  const { event, closed } = pauseEvent(bot.ctx, i.guildId, ev.id, i.options.getString('reason', true), i.user.id);
  for (const enc of closed) await syncEncounterMessage(bot, i.guild, enc);
  await reply(i, `**${event.name}:** 🟢 live → ⏸️ paused. Progress is kept; nothing new happens until \`/season\` → **Resume a paused game**.`);
}

async function modResume(bot: Bot, i: ChatInput) {
  const ev = getCurrentEvent(bot.ctx, i.guildId, game(i));
  if (!ev || ev.state !== 'paused') throw new UserError(`${FEATURE_LABEL[game(i)]} isn't paused. Nothing changed.`);
  const resumed = resumeEvent(bot.ctx, i.guildId, ev.id, i.user.id);
  await reply(i, `**${resumed.name}:** ⏸️ paused → 🟢 live.${resumed.feature === 'halloween' ? ' The next visitor comes after the normal wait.' : ''}`);
}

async function modExclude(bot: Bot, i: ChatInput, on: boolean) {
  const member = i.options.getUser('member', true);
  const scope = i.options.getString('game', true) as ExclusionScope;
  const reason = i.options.getString('reason', true);
  const changed = on ? exclude(bot.ctx, i.guildId, member.id, scope, reason, i.user.id) : include(bot.ctx, i.guildId, member.id, scope, reason, i.user.id);
  if (changed.includes('halloween')) void syncChampionRole(bot, i.guildId);
  const lines = changed.map((f) => `**${member} in ${FEATURE_LABEL[f]}:** ${on ? 'playing → excluded' : 'excluded → playing'}`);
  await reply(i, `${lines.join('\n')}\n${on ? 'Their progress is kept. Candy is unchanged (an admin can use `/player` → **Give or take candy** with a negative amount if needed).' : 'Standings were recalculated.'}`);
}

async function modRepostDoor(bot: Bot, i: ChatInput) {
  const ev = getCurrentEvent(bot.ctx, i.guildId, 'advent');
  if (!ev) throw new UserError("The Advent Calendar isn't live.");
  const day = i.options.getInteger('day', true);
  const url = await postDoor(bot, i.guildId, ev, day);
  audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'advent.repost', eventId: ev.id, after: { day, url } });
  await reply(i, `Door ${day} announcement posted again: ${url}. Nobody's claims changed.`);
}

/** Staff actions, run from the /settings, /season and /player menus (see panels.ts). */
export const manageActions: Record<string, ChatHandler> = {
  'settings edit': setupServer,
  'settings status': setupStatus,

  'season halloween': (bot, i) => setupGame(bot, i, 'halloween'),
  'season snowball': (bot, i) => setupGame(bot, i, 'snowball'),
  'season advent': (bot, i) => setupGame(bot, i, 'advent'),
  'season door': setupDoor,
  'season content': setupContent,
  'season start': adminStart,
  'season end': adminEnd,
  'season announce': adminAnnounce,
  'season wipe-items': (bot, i) => askWipe(bot, i, true),
  'season export': adminExport,

  'adjust candy': (bot, i) => askGiveCandy(bot, i, i.options.getUser('member', true), i.options.getInteger('amount', true), i.options.getString('reason', true)),
  'adjust undo-candy': (bot, i) => askUndoCandy(bot, i, i.options.getInteger('transaction', true), i.options.getString('reason', true)),
  'adjust snowball-stats': adminFixStats,

  'game pause': modPause,
  'game resume': modResume,
  'game preview': messageTest,
  'game send-visitor-away': async (bot, i) => reply(i, await cancelVisitor(bot, i, i.options.getString('reason', true))),
  'game fix-champion': async (bot, i) => reply(i, { embeds: [await fixRole(bot, i)] }),
  'game repost-door': modRepostDoor,

  'player history': async (bot, i) => {
    const u = i.options.getUser('member');
    if (!u) return reply(i, { embeds: [auditEmbed(bot, i.guildId, null)] });
    const h = historyView(bot, i.guildId, u.id, 1, null);
    await reply(i, { ...h, embeds: [...h.embeds, auditEmbed(bot, i.guildId, u.id)] });
  },
  'player give-item': (bot, i) => playerItem(bot, i, 'grant'),
  'player remove-item': (bot, i) => playerItem(bot, i, 'revoke'),
  'player wipe-items': (bot, i) => askWipe(bot, i, false),
  'player clear-warmup': adminClearWarmup,
  'player exclude': (bot, i) => modExclude(bot, i, true),
  'player include': (bot, i) => modExclude(bot, i, false),
};

export const manageHandlers: HandlerSet = {
  confirms: {
    'halloween.wipe': {
      level: 'moderator',
      run: async (bot, i, { eventId, userId, reason }: { eventId: string; userId: string | null; reason: string }) => {
        // Wiping everyone is an admin action even though the confirm is shared.
        if (userId === null) assertLevel(bot, i.member, 'admin');
        const r = wipeCollections(bot.ctx, i.guildId, eventId, userId, reason, i.user.id);
        await syncChampionRole(bot, i.guildId);
        if (r.items === 0) return 'Those items were already gone. Nothing changed.';
        const who = userId ? `<@${userId}>'s collection` : `Collections (${r.members} members)`;
        return `**${who} in ${r.event.name}:** ${r.items} item${r.items === 1 ? '' : 's'} → 0\n**Champion:** ${mention(r.champion.championId)}\nCandy was not changed.`;
      },
    },
    'season.end': {
      level: 'admin',
      run: async (bot, i, { eventId, keep }: { eventId: string; keep?: boolean }) => {
        const before = requireEvent(bot.ctx, i.guildId, eventId);
        const ev = await finishEnd(bot, i.guild, eventId, i.user.id, keep);
        const visible = describeDiff(await syncGuildCommands(bot, i.guild));
        return `**${ev.name}:** ${stateLabel(before)} → 🏁 ended. Results were posted.${visible ? `\n${visible}` : ''}`;
      },
    },
    'season.announce': {
      level: 'admin',
      run: async (bot, i, { eventId, channelId }: { eventId: string; channelId: string }) => {
        const ev = requireEvent(bot.ctx, i.guildId, eventId);
        const channel = (await i.guild.channels.fetch(channelId).catch(() => null)) as GuildTextBasedChannel | null;
        if (!channel?.isTextBased()) throw new UserError('That channel is no longer available.');
        const msg = await channel.send({ embeds: [announcementEmbed(bot, ev)], allowedMentions: { parse: [] } });
        audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'announce', eventId, after: { channel: channelId, message: msg.id } });
        return `Posted the ${ev.name} instructions: ${msg.url}`;
      },
    },
  },
};


