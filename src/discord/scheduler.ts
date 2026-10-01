import type { Guild } from 'discord.js';
import { dueAnnouncements, getDoor, markPosted, doorTimes } from '../domain/advent.js';
import { getRoleState } from '../domain/champion.js';
import { getChannel, getChannels, getConfig } from '../domain/config.js';
import { FEATURE_LABEL, getCurrentEvent, SETUP_ACTION, type Feature } from '../domain/events.js';
import { abortEncounter, attachMessage, packFor, tickHalloween, unsyncedEncounters } from '../domain/halloween.js';
import { pauseEvent, pendingResults, SYSTEM_ACTOR, tickEvents } from '../domain/lifecycle.js';
import { announcementMessage, recoveryMessage } from './handlers/advent.js';
import { syncEncounterMessage, visitorMessage } from './handlers/halloween.js';
import { syncGuildCommands } from './commandSync.js';
import { postResults } from './results.js';
import { alertStaff, fetchTextChannel, isMissingChannelError, syncChampionRole, type Bot } from './runtime.js';

const running = new Set<string>();
/** Throttles repeated staff alerts (key → last alert time). */
const alerted = new Map<string, number>();
const ALERT_EVERY_MS = 60 * 60_000;

function throttled(bot: Bot, key: string): boolean {
  const last = alerted.get(key) ?? 0;
  if (bot.ctx.now() - last < ALERT_EVERY_MS) return true;
  alerted.set(key, bot.ctx.now());
  return false;
}

/** Pauses a running feature whose channel is gone, and tells staff once. */
async function pauseForMissingChannel(bot: Bot, guild: Guild, feature: Feature, channelId: string): Promise<void> {
  const ev = getCurrentEvent(bot.ctx, guild.id, feature);
  if (!ev || ev.state !== 'active') return;
  const { closed } = pauseEvent(bot.ctx, guild.id, ev.id, `channel <#${channelId}> is missing or not accessible`, SYSTEM_ACTOR);
  for (const enc of closed) await syncEncounterMessage(bot, guild, enc);
  await alertStaff(
    bot,
    guild.id,
    `${FEATURE_LABEL[feature]} paused`,
    `The bot can't use <#${channelId}>, so **${ev.name}** was paused. Fix the channel or its permissions (or pick a new one with \`/season\` → **${SETUP_ACTION[feature]}**), then run \`/season\` → **Resume a paused game**.`,
  );
}

async function checkChannels(bot: Bot, guild: Guild): Promise<void> {
  for (const feature of ['snowball', 'halloween', 'advent'] as Feature[]) {
    const ev = getCurrentEvent(bot.ctx, guild.id, feature);
    if (!ev || ev.state !== 'active') continue;
    const ids = feature === 'advent' ? [getChannel(bot.ctx, guild.id, 'advent')].filter((c): c is string => !!c) : getChannels(bot.ctx, guild.id, feature);
    for (const id of ids) {
      if (!(await fetchTextChannel(guild, id))) {
        await pauseForMissingChannel(bot, guild, feature, id);
        break;
      }
    }
  }
}

async function tickLifecycle(bot: Bot, guild: Guild): Promise<void> {
  for (const t of tickEvents(bot.ctx, guild.id)) {
    if (t.kind === 'started') {
      await alertStaff(bot, guild.id, `${t.event.name} started`, `\`${t.event.id}\` activated on schedule.`).catch(() => undefined);
      if (t.event.feature === 'halloween') void syncChampionRole(bot, guild.id);
    } else if (t.kind === 'start-blocked') {
      if (!throttled(bot, `blocked:${guild.id}:${t.event.id}`)) {
        await alertStaff(bot, guild.id, `${t.event.name} could not start`, `It is scheduled to start now, but:\n• ${t.errors.join('\n• ')}\nFix these and it will start on the next check.`);
      }
    } else if (t.kind === 'ended') {
      for (const enc of t.closed) await syncEncounterMessage(bot, guild, enc);
      if (t.event.feature === 'halloween') void syncChampionRole(bot, guild.id);
    }
  }
  for (const ev of pendingResults(bot.ctx, guild.id)) await postResults(bot, guild, ev);
}

async function tickTrickOrTreat(bot: Bot, guild: Guild): Promise<void> {
  const t = tickHalloween(bot.ctx, guild.id);
  for (const enc of t.closed) await syncEncounterMessage(bot, guild, enc);
  if (t.spawned) {
    const enc = t.spawned;
    const ev = getCurrentEvent(bot.ctx, guild.id, 'halloween')!;
    const channel = await fetchTextChannel(guild, enc.channelId);
    try {
      if (!channel) throw Object.assign(new Error('channel missing'), { code: 10003 });
      const msg = await channel.send(visitorMessage(bot, guild.id, packFor(bot.ctx, ev), enc) as never);
      attachMessage(bot.ctx, guild.id, enc.id, msg.id);
      console.log(`[${guild.name}] visitor ${enc.visitorId} appeared in #${channel.name} asking for a ${enc.request}`);
    } catch (err) {
      abortEncounter(bot.ctx, guild.id, enc.id, 'could not post visitor');
      console.warn(`[${guild.name}] could not post a visitor in channel ${enc.channelId}:`, (err as Error).message);
      if (!channel || isMissingChannelError(err)) await pauseForMissingChannel(bot, guild, 'halloween', enc.channelId);
      else console.warn(`[${guild.id}] visitor post failed`, err);
    }
  }
  for (const enc of unsyncedEncounters(bot.ctx, guild.id)) await syncEncounterMessage(bot, guild, enc);
}

async function tickAdvent(bot: Bot, guild: Guild): Promise<void> {
  const plan = dueAnnouncements(bot.ctx, guild.id);
  if (!plan) return;
  const channelId = getChannel(bot.ctx, guild.id, 'advent');
  const channel = await fetchTextChannel(guild, channelId);
  if (!channel) {
    if (channelId) await pauseForMissingChannel(bot, guild, 'advent', channelId);
    return;
  }
  const cfg = getConfig(bot.ctx, guild.id);
  try {
    if (plan.kind === 'daily') {
      const door = getDoor(bot.ctx, guild.id, plan.event.id, plan.day);
      if (!door) return;
      const msg = await channel.send(announcementMessage(plan.event, door, doorTimes(plan.event, cfg, plan.day).claimEndsAt, cfg.adventPolicy));
      markPosted(bot.ctx, guild.id, plan.event.id, [plan.day], channel.id, msg.id, false);
    } else {
      const doors = plan.days.map((d) => getDoor(bot.ctx, guild.id, plan.event.id, d)).filter((d) => d !== null);
      if (!doors.length) return;
      const msg = await channel.send(recoveryMessage(plan.event, doors));
      markPosted(bot.ctx, guild.id, plan.event.id, plan.days, channel.id, msg.id, true);
    }
  } catch (err) {
    if (isMissingChannelError(err) && channelId) await pauseForMissingChannel(bot, guild, 'advent', channelId);
    else console.warn(`[${guild.id}] advent post failed`, err);
  }
}

/** One pass of all timed work for a server. Safe to repeat; each step is idempotent. */
export async function tickGuild(bot: Bot, guild: Guild): Promise<void> {
  if (running.has(guild.id)) return;
  running.add(guild.id);
  try {
    await tickLifecycle(bot, guild);
    await checkChannels(bot, guild);
    await tickTrickOrTreat(bot, guild);
    await tickAdvent(bot, guild);
    // Show or hide game commands as games start and end (no-op when unchanged).
    await syncGuildCommands(bot, guild);
    if (getRoleState(bot.ctx, guild.id).pending) await syncChampionRole(bot, guild.id);
  } catch (err) {
    console.error(`[${guild.id}] scheduler tick failed`, err);
  } finally {
    running.delete(guild.id);
  }
}

export function startScheduler(bot: Bot, intervalMs: number): () => void {
  const tick = () => {
    for (const guild of bot.client.guilds.cache.values()) void tickGuild(bot, guild);
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
