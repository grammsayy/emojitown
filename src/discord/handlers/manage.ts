import { AttachmentBuilder, type GuildTextBasedChannel } from 'discord.js';
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
import { askConfirm, reply, type ChatInput, type HandlerSet } from '../interaction.js';
import { discordChecks, featureChannelIds } from '../results.js';
import { assertSafeStaffRole, syncChampionRole, type Bot } from '../runtime.js';
import { COLORS, embed, field, when } from '../ui.js';
import { doorPreview, postDoor, showDoorForm } from './advent.js';
import { askGiveCandy, askUndoCandy, historyView } from './candy.js';
import { cancelVisitor, fixItem, fixRole, halloweenPreview, setChampionRole, syncEncounterMessage } from './halloween.js';
import { announcementEmbed, auditEmbed, exportFile, fetchAttachmentJson, finishEnd, requireTargetEvent, stateLabel } from './season.js';
import { askStatsFix, snowballPreview } from './snowball.js';

const GAME_ICON: Record<Feature, string> = { halloween: '🎃', snowball: '❄️', advent: '🎄' };

/** Formats an event's dates as "2026-10-01 → 2026-10-31" (inclusive end). */
function dateRange(ev: SeasonEvent): string {
  return `${ev.startLocal.slice(0, 10)} → ${addDays(ev.endLocal.slice(0, 10), -1)}`;
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
  const r = checkEvent(bot.ctx, i.guildId, ev.id);
  const d = await discordChecks(bot, i.guild, ev.feature);
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

// ── /setup server ────────────────────────────────────────────────────

async function setupServer(bot: Bot, i: ChatInput) {
  const zone = i.options.getString('timezone');
  if (zone && !isValidZone(zone)) throw new UserError(`\`${zone}\` isn't a timezone I know. Pick one from the list, e.g. Europe/Copenhagen.`);
  const staffRole = i.options.getRole('staff_role');
  const removeRole = i.options.getRole('remove_staff_role');
  const logs = i.options.getChannel('log_channel');
  const support = i.options.getString('support');
  if (staffRole) assertSafeStaffRole(i.guild, staffRole);
  if (staffRole && staffRole.id === getConfig(bot.ctx, i.guildId).championRoleId) throw new UserError('That is the Halloween Champion role. Pick a staff role.');

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
    if (staffRole && setStaffRole(bot.ctx, i.guildId, staffRole.id, true)) changes.push(`**Staff roles:** added ${staffRole}`);
    if (removeRole && setStaffRole(bot.ctx, i.guildId, removeRole.id, false)) changes.push(`**Staff roles:** removed ${removeRole}`);
    if (changes.length) audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'setup.server', after: { changes } });
  });

  const cfg = getConfig(bot.ctx, i.guildId);
  const e = resultEmbed('⚙️ Server setup', changes).addFields(
    field('Timezone', cfg.timezoneSet ? cfg.timezone : 'not set (UTC). Set it with `timezone:`', true),
    field('Staff roles', getStaffRoles(bot.ctx, i.guildId).map((r) => `<@&${r}>`).join(', ') || 'none', true),
    field('Log channel', getChannel(bot.ctx, i.guildId, 'logs') ? `<#${getChannel(bot.ctx, i.guildId, 'logs')}>` : 'none', true),
    field('Support link', cfg.supportDestination ?? 'none', true),
  );
  if (staffRole && changes.some((c) => c.includes('added'))) {
    e.addFields(field('One more step', `So ${staffRole} can see \`/mod\`: **Server Settings → Integrations → emojitown → /mod** → add the role.`));
  }
  e.addFields(field('Next', 'Set up a game: `/setup halloween`, `/setup snowball` or `/setup advent`.'));
  await reply(i, { embeds: [e] });
}

// ── /setup halloween | snowball | advent ─────────────────────────────

function durationOption(i: ChatInput, name: string, label: string, min: number, max: number): number | undefined {
  const raw = i.options.getString(name);
  if (raw === null) return undefined;
  const s = parseDuration(raw);
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
    const newMin = min ?? before.hwSpawnMinS;
    const newMax = max ?? before.hwSpawnMaxS;
    if (newMin > newMax) {
      throw new UserError(`The shortest wait (${formatSeconds(newMin)}) can't be longer than the longest wait (${formatSeconds(newMax)}).`);
    }
    Object.assign(cfgPatch, {
      hwSpawnMinS: min,
      hwSpawnMaxS: max,
      hwEncounterS: visit,
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

  const LABELS: Partial<Record<keyof GuildConfig, [string, (v: any) => string]>> = {
    hwSpawnMinS: ['Shortest wait between visitors', formatSeconds],
    hwSpawnMaxS: ['Longest wait between visitors', formatSeconds],
    hwEncounterS: ['Visit length', formatSeconds],
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

  if (championRole) {
    const r = await setChampionRole(bot, i, championRole);
    changes.push(...r.changes);
    warnings.push(...r.warnings);
  }

  ev = getEvent(bot.ctx, i.guildId, ev.id)!;
  const started = await startIfDue(bot, i, ev);
  if (started) changes.push(started);
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

// ── /setup door | content | status ───────────────────────────────────

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
      content: `Here is the current ${FEATURE_LABEL[game]} content (${label(version)}). Edit it and upload it back with \`/setup content game:${game} file:\`. Nothing changed.`,
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
  const cfg = getConfig(bot.ctx, i.guildId);
  const e = embed(COLORS.staff, '🩺 emojitown setup status').addFields(
    field(
      'Server',
      [
        `${cfg.timezoneSet ? '✅' : '⚠️'} Timezone: ${cfg.timezoneSet ? cfg.timezone : 'not set (UTC)'}`,
        `${getStaffRoles(bot.ctx, i.guildId).length ? '✅' : '⚠️'} Staff roles: ${getStaffRoles(bot.ctx, i.guildId).map((r) => `<@&${r}>`).join(', ') || 'none'}`,
        `${getChannel(bot.ctx, i.guildId, 'logs') ? '✅' : '⚠️'} Log channel: ${getChannel(bot.ctx, i.guildId, 'logs') ? `<#${getChannel(bot.ctx, i.guildId, 'logs')}>` : 'none'}`,
        `Fix with \`/setup server\`.`,
      ].join('\n'),
    ),
  );
  for (const game of ['halloween', 'snowball', 'advent'] as Feature[]) {
    const ev = getCurrentEvent(bot.ctx, i.guildId, game) ?? listEvents(bot.ctx, i.guildId, game).find((x) => x.state === 'draft' || x.state === 'scheduled');
    if (!ev) {
      e.addFields(field(`${GAME_ICON[game]} ${FEATURE_LABEL[game]}`, `Not set up. Run \`/setup ${game}\`.`));
      continue;
    }
    const win = windowFor(bot.ctx, ev);
    const lines = [`${ev.name}: ${stateLabel(ev)}`, `${when(win.startsAt)} → ${when(win.endsAt)}`, `Channels: ${channelList(featureChannelIds(bot, i.guildId, game))}`];
    if (game !== 'advent') {
      const v = ev.contentVersion ?? latestVersion(bot.ctx, i.guildId, game);
      lines.push(v === 0 ? '⚠️ Using placeholder content (`/setup content`)' : `Content: v${v}`);
    } else {
      lines.push(`Doors written: ${listDoors(bot.ctx, i.guildId, ev.id).length}/${cfg.adventDoorCount}`);
    }
    if (ev.state !== 'active' && ev.state !== 'ended') {
      const r = await readiness(bot, i, ev);
      lines.push(...r.errors.slice(0, 5).map((x) => `❌ ${x}`), ...r.warnings.slice(0, 3).map((x) => `⚠️ ${x}`));
      if (!r.errors.length) lines.push('✅ Ready');
    }
    e.addFields(field(`${GAME_ICON[game]} ${FEATURE_LABEL[game]}`, lines.join('\n')));
  }
  await reply(i, { embeds: [e] });
}

// ── /admin ───────────────────────────────────────────────────────────

const game = (i: ChatInput) => i.options.getString('game', true) as Feature;

async function adminStart(bot: Bot, i: ChatInput) {
  const ev = requireTargetEvent(bot, i.guildId, game(i));
  if (ev.state === 'active') return reply(i, `**${ev.name}** is already live. Nothing changed.`);
  if (ev.state === 'paused') throw new UserError(`**${ev.name}** is paused. Use \`/mod resume game:${ev.feature}\` instead.`);
  const d = await discordChecks(bot, i.guild, ev.feature);
  const started = startEvent(bot.ctx, i.guildId, ev.id, i.user.id, d.errors);
  if (started.feature === 'halloween') void syncChampionRole(bot, i.guildId);
  const e = resultEmbed(`${GAME_ICON[ev.feature]} ${ev.name}`, [`**Status:** ${stateLabel(ev)} → 🟢 live now`], COLORS.hit).addFields(
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

async function adminFixItem(bot: Bot, i: ChatInput) {
  const ev = getCurrentOrLatestEvent(bot.ctx, i.guildId, 'halloween');
  if (!ev) throw new UserError("Halloween hasn't run yet, so there are no collections to fix.");
  const text = await fixItem(
    bot,
    i,
    ev.id,
    i.options.getUser('member', true),
    i.options.getString('action', true) as 'grant' | 'revoke',
    i.options.getString('item', true),
    i.options.getString('reason', true),
  );
  await reply(i, text);
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
  const ev = season ? requireEvent(bot.ctx, i.guildId, season, game(i)) : (getCurrentOrLatestEvent(bot.ctx, i.guildId, game(i)) ?? requireTargetEvent(bot, i.guildId, game(i)));
  audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'export', eventId: ev.id });
  await reply(i, { content: `All data for **${ev.name}** (staff only, handle with care):`, files: [exportFile(bot, i.guildId, ev)] });
}

// ── /mod ─────────────────────────────────────────────────────────────

async function modPause(bot: Bot, i: ChatInput) {
  const ev = getCurrentEvent(bot.ctx, i.guildId, game(i));
  if (!ev) throw new UserError(`${FEATURE_LABEL[game(i)]} isn't live, so there's nothing to pause.`);
  if (ev.state === 'paused') return reply(i, `**${ev.name}** is already paused. Nothing changed.`);
  const { event, closed } = pauseEvent(bot.ctx, i.guildId, ev.id, i.options.getString('reason', true), i.user.id);
  for (const enc of closed) await syncEncounterMessage(bot, i.guild, enc);
  await reply(i, `**${event.name}:** 🟢 live → ⏸️ paused. Progress is kept; nothing new happens until \`/mod resume\`.`);
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
  await reply(i, `${lines.join('\n')}\n${on ? 'Their progress is kept. Candy is unchanged (`/admin give-candy` with a negative amount if needed).' : 'Standings were recalculated.'}`);
}

async function modPreview(bot: Bot, i: ChatInput) {
  const g = game(i);
  if (g === 'snowball') return reply(i, { content: '**Preview** (nothing is saved):', embeds: snowballPreview(bot, i.guildId, `${i.user}`, `${i.client.user}`) });
  if (g === 'halloween') return reply(i, halloweenPreview(bot, i.guildId, i.channelId, i.user.id, i.options.getString('visitor')));
  const day = i.options.getInteger('day');
  if (!day) throw new UserError('Pick a door with `day:`.');
  return reply(i, doorPreview(bot, i.guildId, requireTargetEvent(bot, i.guildId, 'advent'), day));
}

async function modRepostDoor(bot: Bot, i: ChatInput) {
  const ev = getCurrentEvent(bot.ctx, i.guildId, 'advent');
  if (!ev) throw new UserError("The Advent Calendar isn't live.");
  const day = i.options.getInteger('day', true);
  const url = await postDoor(bot, i.guildId, ev, day);
  audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'advent.repost', eventId: ev.id, after: { day, url } });
  await reply(i, `Door ${day} announcement posted again: ${url}. Nobody's claims changed.`);
}

export const manageHandlers: HandlerSet = {
  chat: {
    'setup server': setupServer,
    'setup halloween': (bot, i) => setupGame(bot, i, 'halloween'),
    'setup snowball': (bot, i) => setupGame(bot, i, 'snowball'),
    'setup advent': (bot, i) => setupGame(bot, i, 'advent'),
    'setup door': setupDoor,
    'setup content': setupContent,
    'setup status': setupStatus,

    'admin start': adminStart,
    'admin end': adminEnd,
    'admin give-candy': (bot, i) => askGiveCandy(bot, i, i.options.getUser('member', true), i.options.getInteger('amount', true), i.options.getString('reason', true)),
    'admin undo-candy': (bot, i) => askUndoCandy(bot, i, i.options.getInteger('transaction', true), i.options.getString('reason', true)),
    'admin fix-stats': adminFixStats,
    'admin fix-item': adminFixItem,
    'admin clear-warmup': adminClearWarmup,
    'admin announce': adminAnnounce,
    'admin export': adminExport,
    'admin audit': async (bot, i) => {
      const u = i.options.getUser('member');
      await reply(i, { embeds: [auditEmbed(bot, i.guildId, u ? { id: u.id, displayName: u.displayName } : null)] });
    },

    'mod pause': modPause,
    'mod resume': modResume,
    'mod exclude': (bot, i) => modExclude(bot, i, true),
    'mod include': (bot, i) => modExclude(bot, i, false),
    'mod cancel-visitor': async (bot, i) => reply(i, await cancelVisitor(bot, i, i.options.getString('reason', true))),
    'mod preview': modPreview,
    'mod candy-history': async (bot, i) => reply(i, historyView(bot, i.guildId, i.options.getUser('member', true).id, 1, null)),
    'mod repost-door': modRepostDoor,
    'mod fix-role': async (bot, i) => reply(i, { embeds: [await fixRole(bot, i)] }),
  },
  confirms: {
    'season.end': {
      level: 'admin',
      run: async (bot, i, { eventId, keep }: { eventId: string; keep?: boolean }) => {
        const before = requireEvent(bot.ctx, i.guildId, eventId);
        const ev = await finishEnd(bot, i.guild, eventId, i.user.id, keep);
        return `**${ev.name}:** ${stateLabel(before)} → 🏁 ended. Results were posted.`;
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


