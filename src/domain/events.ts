import { DateTime } from 'luxon';
import { addDays, localToMs, parseDate } from '../util/time.js';
import { audit } from './audit.js';
import { getConfig } from './config.js';
import { tx, type Ctx } from './context.js';
import { UserError } from './errors.js';

export type Feature = 'snowball' | 'halloween' | 'advent';
export const FEATURES: Feature[] = ['snowball', 'halloween', 'advent'];
export type EventState = 'draft' | 'scheduled' | 'active' | 'paused' | 'ended';

/** The /season menu entry that sets up each game. */
export const SETUP_ACTION: Record<Feature, string> = {
  halloween: 'Set up Halloween',
  snowball: 'Set up Snowball Fights',
  advent: 'Set up the Advent Calendar',
};

export const FEATURE_LABEL: Record<Feature, string> = {
  snowball: 'Snowball Fights',
  halloween: 'Trick or Treat',
  advent: 'Advent Calendar',
};

export interface SeasonEvent {
  guildId: string;
  id: string;
  feature: Feature;
  name: string;
  state: EventState;
  /** Local `YYYY-MM-DDTHH:mm` in the server timezone. Inclusive. */
  startLocal: string;
  /** Local `YYYY-MM-DDTHH:mm` in the server timezone. Exclusive. */
  endLocal: string;
  claimDeadlineLocal: string | null;
  autoActivate: boolean;
  contentVersion: number | null;
  adventPublishedAt: number | null;
  pauseReason: string | null;
  activatedAt: number | null;
  endedAt: number | null;
  resultsPosted: boolean;
  finalChampionId: string | null;
  /** Whether the final Champion keeps the role until the next Halloween event starts. */
  championKeepRole: boolean;
  createdAt: number;
}

function fromRow(r: Record<string, any>): SeasonEvent {
  return {
    guildId: r.guild_id,
    id: r.id,
    feature: r.feature,
    name: r.name,
    state: r.state,
    startLocal: r.start_local,
    endLocal: r.end_local,
    claimDeadlineLocal: r.claim_deadline_local,
    autoActivate: !!r.auto_activate,
    contentVersion: r.content_version,
    adventPublishedAt: r.advent_published_at,
    pauseReason: r.pause_reason,
    activatedAt: r.activated_at,
    endedAt: r.ended_at,
    resultsPosted: !!r.results_posted,
    finalChampionId: r.final_champion_id,
    championKeepRole: !!r.champion_keep_role,
    createdAt: r.created_at,
  };
}

export function getEvent(ctx: Ctx, guildId: string, id: string): SeasonEvent | null {
  const r = ctx.db.prepare('SELECT * FROM events WHERE guild_id = ? AND id = ?').get(guildId, id);
  return r ? fromRow(r as Record<string, any>) : null;
}

export function requireEvent(ctx: Ctx, guildId: string, id: string, feature?: Feature): SeasonEvent {
  const ev = getEvent(ctx, guildId, id);
  if (!ev) throw new UserError(`No season called \`${id}\`. Pick one from the list.`);
  if (feature && ev.feature !== feature) {
    throw new UserError(`\`${id}\` is a ${FEATURE_LABEL[ev.feature]} event, not ${FEATURE_LABEL[feature]}.`);
  }
  return ev;
}

export function listEvents(ctx: Ctx, guildId: string, feature?: Feature): SeasonEvent[] {
  const rows = feature
    ? ctx.db.prepare('SELECT * FROM events WHERE guild_id = ? AND feature = ? ORDER BY start_local DESC, created_at DESC').all(guildId, feature)
    : ctx.db.prepare('SELECT * FROM events WHERE guild_id = ? ORDER BY start_local DESC, created_at DESC').all(guildId);
  return (rows as Record<string, any>[]).map(fromRow);
}

/** The feature's running event: active or paused. At most one exists. */
export function getCurrentEvent(ctx: Ctx, guildId: string, feature: Feature): SeasonEvent | null {
  const r = ctx.db
    .prepare("SELECT * FROM events WHERE guild_id = ? AND feature = ? AND state IN ('active','paused') LIMIT 1")
    .get(guildId, feature);
  return r ? fromRow(r as Record<string, any>) : null;
}

/** The running event, else the most recently started or ended one. Used for read-only views. */
export function getCurrentOrLatestEvent(ctx: Ctx, guildId: string, feature: Feature): SeasonEvent | null {
  const current = getCurrentEvent(ctx, guildId, feature);
  if (current) return current;
  const r = ctx.db
    .prepare(
      "SELECT * FROM events WHERE guild_id = ? AND feature = ? AND state = 'ended' ORDER BY COALESCE(ended_at, 0) DESC, start_local DESC LIMIT 1",
    )
    .get(guildId, feature);
  return r ? fromRow(r as Record<string, any>) : null;
}

/** Resolves an optional event argument for a member view, defaulting to the current or latest event. */
export function resolveViewEvent(ctx: Ctx, guildId: string, feature: Feature, eventId?: string | null): SeasonEvent {
  if (eventId) {
    // A season that hasn't started simply shows empty standings.
    return requireEvent(ctx, guildId, eventId, feature);
  }
  const ev = getCurrentOrLatestEvent(ctx, guildId, feature);
  if (!ev) throw new UserError(`There hasn't been a ${FEATURE_LABEL[feature]} event yet. Check \`/events\` for what's coming up.`);
  return ev;
}

/** Returns the active event, or explains why gameplay is unavailable. */
export function requireActiveEvent(ctx: Ctx, guildId: string, feature: Feature): SeasonEvent {
  const ev = getCurrentEvent(ctx, guildId, feature);
  if (ev?.state === 'active') return ev;
  if (ev?.state === 'paused') {
    throw new UserError(
      `${FEATURE_LABEL[feature]} is paused right now${ev.pauseReason ? ` (${ev.pauseReason})` : ''}. Your progress is safe; check back soon.`,
    );
  }
  throw new UserError(`${FEATURE_LABEL[feature]} isn't running right now. Check \`/events\` for what's coming up.`);
}

export interface EventWindow {
  startsAt: number;
  endsAt: number;
  claimDeadline: number | null;
}

export function eventWindow(ev: SeasonEvent, timezone: string): EventWindow {
  return {
    startsAt: localToMs(ev.startLocal, timezone),
    endsAt: localToMs(ev.endLocal, timezone),
    claimDeadline: ev.claimDeadlineLocal ? localToMs(ev.claimDeadlineLocal, timezone) : null,
  };
}

export function windowFor(ctx: Ctx, ev: SeasonEvent): EventWindow {
  return eventWindow(ev, getConfig(ctx, ev.guildId).timezone);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

/** Default dates for a new event in the given year. */
export function defaultDates(feature: Feature, year: number): { start: string; end: string; claimDeadline: string | null } {
  switch (feature) {
    case 'halloween':
      return { start: `${year}-10-01T00:00`, end: `${year}-11-01T00:00`, claimDeadline: null };
    case 'snowball':
      return { start: `${year}-12-01T00:00`, end: `${year + 1}-01-01T00:00`, claimDeadline: null };
    case 'advent':
      return { start: `${year}-12-01T00:00`, end: `${year}-12-25T00:00`, claimDeadline: `${year}-12-25T00:00` };
  }
}

/** The year whose default dates a new event for `feature` would use (next year once this year's season is over). */
export function seasonYear(ctx: Ctx, guildId: string, feature: Feature): number {
  const tz = getConfig(ctx, guildId).timezone;
  const year = DateTime.fromMillis(ctx.now(), { zone: tz }).year;
  return localToMs(defaultDates(feature, year).end, tz) <= ctx.now() ? year + 1 : year;
}

export const DEFAULT_EVENT_NAME: Record<Feature, string> = { halloween: 'Halloween', snowball: 'Snowball Fights', advent: 'Advent Calendar' };

/** The running event for a feature, else the next one that hasn't started yet. */
export function getTargetEvent(ctx: Ctx, guildId: string, feature: Feature): SeasonEvent | null {
  return (
    getCurrentEvent(ctx, guildId, feature) ??
    listEvents(ctx, guildId, feature)
      .filter((e) => e.state === 'draft' || e.state === 'scheduled')
      .sort((a, b) => a.startLocal.localeCompare(b.startLocal))[0] ??
    null
  );
}

/** Returns the running or upcoming event for a feature, creating this season's event if there is none. */
export function ensureEvent(ctx: Ctx, guildId: string, feature: Feature, actorId: string): { event: SeasonEvent; created: boolean } {
  const existing = getTargetEvent(ctx, guildId, feature);
  if (existing) return { event: existing, created: false };
  const name = `${DEFAULT_EVENT_NAME[feature]} ${seasonYear(ctx, guildId, feature)}`;
  return { event: createEvent(ctx, guildId, feature, name, actorId), created: true };
}

export function createEvent(ctx: Ctx, guildId: string, feature: Feature, name: string, actorId: string): SeasonEvent {
  const trimmed = name.trim();
  if (!trimmed) throw new UserError('Give the event a name, such as "Halloween 2026".');
  return tx(ctx, () => {
    const tz = getConfig(ctx, guildId).timezone;
    const localNow = DateTime.fromMillis(ctx.now(), { zone: tz });
    let year = localNow.year;
    if (localToMs(defaultDates(feature, year).end, tz) <= ctx.now()) year += 1;
    const dates = defaultDates(feature, year);

    const prefix = feature === 'snowball' ? 'winter' : feature;
    let base = slugify(trimmed) || `${prefix}-${year}`;
    if (!/[a-z]/.test(base)) base = `${prefix}-${base}`;
    let id = base;
    for (let n = 2; getEvent(ctx, guildId, id); n++) id = `${base}-${n}`;

    ctx.db
      .prepare(
        `INSERT INTO events (guild_id, id, feature, name, state, start_local, end_local, claim_deadline_local, created_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      )
      .run(guildId, id, feature, trimmed, dates.start, dates.end, dates.claimDeadline, ctx.now());
    const ev = getEvent(ctx, guildId, id)!;
    audit(ctx, { guildId, actorId, action: 'event.create', eventId: id, after: ev });
    return ev;
  });
}

export interface ScheduleInput {
  /** YYYY-MM-DD, first day of the event. */
  startDate: string;
  /** YYYY-MM-DD, last day of the event (inclusive). */
  endDate: string;
  autoActivate: boolean;
  /** Advent only. YYYY-MM-DD or YYYY-MM-DD HH:mm local. */
  claimDeadline?: string | null;
}

function parseLocalDateTime(value: string, label: string): string {
  const v = value.trim().replace(' ', 'T');
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/.exec(v);
  if (!m || !parseDate(m[1]!)) throw new UserError(`${label} must look like 2026-12-25 or 2026-12-25 00:00.`);
  return `${m[1]}T${m[2] ?? '00:00'}`;
}

export function scheduleEvent(ctx: Ctx, guildId: string, eventId: string, input: ScheduleInput, actorId: string): SeasonEvent {
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId);
    if (ev.state === 'ended') throw new UserError('Ended events are frozen and cannot be rescheduled.');
    const start = parseDate(input.startDate);
    const endDay = parseDate(input.endDate);
    if (!start) throw new UserError('Start date must look like 2026-10-01.');
    if (!endDay) throw new UserError('End date must look like 2026-10-31.');
    const startLocal = `${start}T00:00`;
    const endLocal = `${addDays(endDay, 1)}T00:00`;
    const tz = getConfig(ctx, guildId).timezone;
    if (localToMs(endLocal, tz) <= localToMs(startLocal, tz)) throw new UserError('The end date must be on or after the start date.');
    if ((ev.state === 'active' || ev.state === 'paused') && startLocal !== ev.startLocal) {
      throw new UserError('This event is already running, so only its end date can change.');
    }
    if ((ev.state === 'active' || ev.state === 'paused') && localToMs(endLocal, tz) <= ctx.now()) {
      throw new UserError('A running event needs an end date in the future. Use `/season` → **End a game** to end it now.');
    }

    let claimDeadlineLocal: string | null = null;
    if (ev.feature === 'advent') {
      claimDeadlineLocal = input.claimDeadline?.trim()
        ? parseLocalDateTime(input.claimDeadline, 'Claim deadline')
        : endLocal;
      if (localToMs(claimDeadlineLocal, tz) > localToMs(endLocal, tz)) {
        throw new UserError('The claim deadline must be on or before the end of the event.');
      }
      if (localToMs(claimDeadlineLocal, tz) <= localToMs(startLocal, tz)) {
        throw new UserError('The claim deadline must be after the event starts.');
      }
    }

    const overlap = listEvents(ctx, guildId, ev.feature).find(
      (o) =>
        o.id !== ev.id &&
        o.state !== 'ended' &&
        localToMs(o.startLocal, tz) < localToMs(endLocal, tz) &&
        localToMs(startLocal, tz) < localToMs(o.endLocal, tz),
    );
    if (overlap) {
      throw new UserError(`These dates overlap \`${overlap.id}\`. Only one ${FEATURE_LABEL[ev.feature]} event can run at a time.`);
    }

    let state = ev.state;
    if (state === 'draft' || state === 'scheduled') state = input.autoActivate ? 'scheduled' : 'draft';

    ctx.db
      .prepare(
        `UPDATE events SET start_local = ?, end_local = ?, claim_deadline_local = ?, auto_activate = ?, state = ?
         WHERE guild_id = ? AND id = ?`,
      )
      .run(startLocal, endLocal, claimDeadlineLocal, input.autoActivate ? 1 : 0, state, guildId, eventId);
    const after = getEvent(ctx, guildId, eventId)!;
    audit(ctx, {
      guildId,
      actorId,
      action: 'event.schedule',
      eventId,
      before: { start: ev.startLocal, end: ev.endLocal, claimDeadline: ev.claimDeadlineLocal, autoActivate: ev.autoActivate, state: ev.state },
      after: { start: after.startLocal, end: after.endLocal, claimDeadline: after.claimDeadlineLocal, autoActivate: after.autoActivate, state: after.state },
    });
    return after;
  });
}

export function setEventState(ctx: Ctx, ev: SeasonEvent, patch: Record<string, unknown>): void {
  const cols = Object.keys(patch);
  ctx.db
    .prepare(`UPDATE events SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE guild_id = ? AND id = ?`)
    .run(...cols.map((c) => patch[c]), ev.guildId, ev.id);
}

export function markResultsPosted(ctx: Ctx, guildId: string, eventId: string): void {
  ctx.db.prepare('UPDATE events SET results_posted = 1 WHERE guild_id = ? AND id = ?').run(guildId, eventId);
}
