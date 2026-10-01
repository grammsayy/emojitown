import { validateCalendar } from './advent.js';
import { audit } from './audit.js';
import { refreshChampion, refreshRoleTarget, storedChampion } from './champion.js';
import { getChannel, getChannels, getConfig } from './config.js';
import { getPack, latestVersion, validatePack } from './content.js';
import { tx, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { eventWindow, FEATURE_LABEL, getCurrentEvent, getEvent, listEvents, requireEvent, setEventState, type SeasonEvent } from './events.js';
import { closeOpenEncounters, scheduleNextSpawn, type Encounter } from './halloween.js';

export const SYSTEM_ACTOR = 'system';

export interface Readiness {
  errors: string[];
  warnings: string[];
}

/** Domain-level readiness. Discord-level checks (permissions, role hierarchy) are added by the bot layer. */
export function checkEvent(ctx: Ctx, guildId: string, eventId: string): Readiness {
  const ev = requireEvent(ctx, guildId, eventId);
  const cfg = getConfig(ctx, guildId);
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = ctx.now();
  const win = eventWindow(ev, cfg.timezone);

  if (!cfg.timezoneSet) warnings.push('The server timezone has not been set; UTC is being used.');
  if (!getChannel(ctx, guildId, 'logs')) warnings.push('No staff log channel is configured.');
  if (ev.state === 'ended') errors.push('This event has ended.');
  if (win.endsAt <= now && ev.state !== 'ended') errors.push('The event end date has already passed. Reschedule it first.');

  const running = getCurrentEvent(ctx, guildId, ev.feature);
  if (running && running.id !== ev.id) errors.push(`\`${running.id}\` is already running. Only one ${FEATURE_LABEL[ev.feature]} event can run at a time.`);

  if (ev.feature === 'snowball' || ev.feature === 'halloween') {
    if (getChannels(ctx, guildId, ev.feature).length === 0) errors.push(`No ${ev.feature} channels are configured.`);
    const version = ev.contentVersion ?? latestVersion(ctx, guildId, ev.feature);
    const result = validatePack(ev.feature, getPack(ctx, guildId, ev.feature, version));
    errors.push(...result.errors.map((e) => `Content: ${e}`));
    warnings.push(...result.warnings.slice(0, 5).map((w) => `Content: ${w}`));
    if (version === 0) warnings.push(`Using the built-in placeholder ${ev.feature} content. Import the emojitown pack with \`/admin season content\`.`);
  }
  if (ev.feature === 'halloween') {
    if (!cfg.championRoleId) warnings.push('No Halloween Champion role is configured.');
    const weights = cfg.hwWeightCommon + cfg.hwWeightUncommon + cfg.hwWeightRare;
    if (weights <= 0) errors.push('Rarity weights must add up to more than zero.');
  }
  if (ev.feature === 'advent') {
    if (!getChannel(ctx, guildId, 'advent')) errors.push('No Advent channel is configured.');
    if (!ev.adventPublishedAt) errors.push('The calendar has not been published (`/staff advent validate`, then `/admin advent publish`).');
    const issues = validateCalendar(ctx, guildId, ev.id);
    errors.push(...issues.slice(0, 10));
    if (issues.length > 10) errors.push(`…and ${issues.length - 10} more calendar issues.`);
  }
  return { errors, warnings };
}

function activate(ctx: Ctx, ev: SeasonEvent, actorId: string): SeasonEvent {
  const patch: Record<string, unknown> = { state: 'active', activated_at: ev.activatedAt ?? ctx.now(), pause_reason: null };
  if ((ev.feature === 'snowball' || ev.feature === 'halloween') && ev.contentVersion === null) {
    patch.content_version = latestVersion(ctx, ev.guildId, ev.feature);
  }
  setEventState(ctx, ev, patch);
  const after = getEvent(ctx, ev.guildId, ev.id)!;
  if (ev.feature === 'halloween') {
    scheduleNextSpawn(ctx, ev.guildId, ev.id);
    refreshChampion(ctx, after);
  }
  audit(ctx, { guildId: ev.guildId, actorId, action: 'event.start', eventId: ev.id, before: { state: ev.state }, after: { state: 'active', contentVersion: after.contentVersion } });
  return after;
}

export function startEvent(ctx: Ctx, guildId: string, eventId: string, actorId: string, extraErrors: string[] = []): SeasonEvent {
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId);
    if (ev.state === 'active') throw new UserError('This event is already active.');
    if (ev.state === 'paused') throw new UserError('This event is paused. Use `/staff event resume` instead.');
    const { errors } = checkEvent(ctx, guildId, eventId);
    const all = [...errors, ...extraErrors];
    if (all.length) throw new UserError(`This event isn't ready to start:\n• ${all.join('\n• ')}`);
    return activate(ctx, ev, actorId);
  });
}

export function pauseEvent(ctx: Ctx, guildId: string, eventId: string, reason: string, actorId: string): { event: SeasonEvent; closed: Encounter[] } {
  if (!reason.trim()) throw new UserError('A reason is required.');
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId);
    if (ev.state !== 'active') throw new UserError(`Only active events can be paused. \`${ev.id}\` is ${ev.state}.`);
    setEventState(ctx, ev, { state: 'paused', pause_reason: reason });
    const closed = ev.feature === 'halloween' ? closeOpenEncounters(ctx, guildId, 'cancelled', 'event paused') : [];
    audit(ctx, { guildId, actorId, action: 'event.pause', eventId, before: { state: 'active' }, after: { state: 'paused' }, reason });
    return { event: getEvent(ctx, guildId, eventId)!, closed };
  });
}

export function resumeEvent(ctx: Ctx, guildId: string, eventId: string, actorId: string): SeasonEvent {
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId);
    if (ev.state !== 'paused') throw new UserError(`Only paused events can be resumed. \`${ev.id}\` is ${ev.state}.`);
    if (eventWindow(ev, getConfig(ctx, guildId).timezone).endsAt <= ctx.now()) {
      throw new UserError("This event's end date has passed, so it can't be resumed.");
    }
    setEventState(ctx, ev, { state: 'active', pause_reason: null });
    // Resume starts a fresh interval; missed visitors are never replayed.
    if (ev.feature === 'halloween') scheduleNextSpawn(ctx, guildId, ev.id);
    audit(ctx, { guildId, actorId, action: 'event.resume', eventId, before: { state: 'paused' }, after: { state: 'active' } });
    return getEvent(ctx, guildId, eventId)!;
  });
}

/** Freezes an event. Idempotent: ending an already ended event is rejected without side effects. */
export function endEvent(ctx: Ctx, guildId: string, eventId: string, actorId: string, reason?: string | null): { event: SeasonEvent; closed: Encounter[] } {
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId);
    if (ev.state === 'ended') throw new UserError('This event has already ended.');
    const cfg = getConfig(ctx, guildId);
    let closed: Encounter[] = [];
    const patch: Record<string, unknown> = { state: 'ended', ended_at: ctx.now() };
    if (ev.feature === 'halloween') {
      closed = closeOpenEncounters(ctx, guildId, 'cancelled', 'event ended');
      if (ev.state === 'active' || ev.state === 'paused') refreshChampion(ctx, ev);
      patch.final_champion_id = storedChampion(ctx, guildId, ev.id);
      patch.champion_keep_role = cfg.championEndPolicy === 'keep' ? 1 : 0;
    }
    setEventState(ctx, ev, patch);
    const after = getEvent(ctx, guildId, eventId)!;
    if (ev.feature === 'halloween') refreshRoleTarget(ctx, guildId);
    audit(ctx, {
      guildId,
      actorId,
      action: 'event.end',
      eventId,
      before: { state: ev.state },
      after: { state: 'ended', finalChampion: after.finalChampionId, keepRole: after.championKeepRole },
      reason: reason ?? null,
    });
    return { event: after, closed };
  });
}

export type Transition =
  | { kind: 'started'; event: SeasonEvent }
  | { kind: 'start-blocked'; event: SeasonEvent; errors: string[] }
  | { kind: 'ended'; event: SeasonEvent; closed: Encounter[] };

/** Applies scheduled activations and endings. Safe to run repeatedly and after downtime. */
export function tickEvents(ctx: Ctx, guildId: string): Transition[] {
  const out: Transition[] = [];
  const tz = getConfig(ctx, guildId).timezone;
  const now = ctx.now();
  for (const ev of listEvents(ctx, guildId).reverse()) {
    const win = eventWindow(ev, tz);
    if ((ev.state === 'active' || ev.state === 'paused' || ev.state === 'scheduled') && now >= win.endsAt) {
      if (ev.state === 'scheduled') {
        // Never activated. Freeze it so it cannot start late.
        out.push({ kind: 'ended', ...endEvent(ctx, guildId, ev.id, SYSTEM_ACTOR, 'end date passed before activation') });
      } else {
        out.push({ kind: 'ended', ...endEvent(ctx, guildId, ev.id, SYSTEM_ACTOR, 'scheduled end') });
      }
      continue;
    }
    if (ev.state === 'scheduled' && ev.autoActivate && now >= win.startsAt) {
      const { errors } = checkEvent(ctx, guildId, ev.id);
      if (errors.length) out.push({ kind: 'start-blocked', event: ev, errors });
      else out.push({ kind: 'started', event: tx(ctx, () => activate(ctx, ev, SYSTEM_ACTOR)) });
    }
  }
  return out;
}

export function pendingResults(ctx: Ctx, guildId: string): SeasonEvent[] {
  return listEvents(ctx, guildId).filter((e) => e.state === 'ended' && !e.resultsPosted && e.activatedAt !== null);
}
