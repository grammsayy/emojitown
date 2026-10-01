import { addDays, localToMs, msToLocalDate } from '../util/time.js';
import { audit } from './audit.js';
import { applyCandy } from './candy.js';
import { getConfig, type GuildConfig } from './config.js';
import { tx, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { eventWindow, getCurrentOrLatestEvent, requireActiveEvent, requireEvent, setEventState, type SeasonEvent } from './events.js';
import { isEligible } from './members.js';

export const DEFAULT_DOOR_CANDY = 10;

export interface Door {
  day: number;
  title: string;
  message: string;
  imageUrl: string | null;
  linkUrl: string | null;
  triviaAnswer: string | null;
  candy: number;
  updatedAt: number;
}

function fromRow(r: Record<string, any>): Door {
  return {
    day: r.day,
    title: r.title,
    message: r.message,
    imageUrl: r.image_url,
    linkUrl: r.link_url,
    triviaAnswer: r.trivia_answer,
    candy: r.candy,
    updatedAt: r.updated_at,
  };
}

export function getDoor(ctx: Ctx, guildId: string, eventId: string, day: number): Door | null {
  const r = ctx.db.prepare('SELECT * FROM advent_doors WHERE guild_id = ? AND event_id = ? AND day = ?').get(guildId, eventId, day);
  return r ? fromRow(r as Record<string, any>) : null;
}

export function listDoors(ctx: Ctx, guildId: string, eventId: string): Door[] {
  return (ctx.db.prepare('SELECT * FROM advent_doors WHERE guild_id = ? AND event_id = ? ORDER BY day').all(guildId, eventId) as Record<string, any>[]).map(
    fromRow,
  );
}

export interface DoorTimes {
  date: string;
  unlockAt: number;
  announceAt: number;
  /** Rewards can be claimed until this instant. */
  claimEndsAt: number;
}

export function doorTimes(ev: SeasonEvent, cfg: GuildConfig, day: number): DoorTimes {
  const tz = cfg.timezone;
  const date = addDays(ev.startLocal.slice(0, 10), day - 1);
  const unlockAt = localToMs(`${date}T${cfg.adventUnlockTime}`, tz);
  const announceAt = Math.max(unlockAt, localToMs(`${date}T${cfg.adventAnnounceTime}`, tz));
  const win = eventWindow(ev, tz);
  const deadline = Math.min(win.claimDeadline ?? win.endsAt, win.endsAt);
  const claimEndsAt =
    cfg.adventPolicy === 'same-day' ? Math.min(deadline, localToMs(`${addDays(date, 1)}T00:00`, tz)) : deadline;
  return { date, unlockAt, announceAt, claimEndsAt };
}

export type DoorState = 'locked' | 'available' | 'claimed' | 'expired';

function claimRow(ctx: Ctx, guildId: string, eventId: string, userId: string, day: number) {
  return ctx.db
    .prepare('SELECT claimed_at, candy FROM advent_claims WHERE guild_id = ? AND event_id = ? AND user_id = ? AND day = ?')
    .get(guildId, eventId, userId, day) as { claimed_at: number; candy: number } | undefined;
}

export function doorState(ctx: Ctx, ev: SeasonEvent, cfg: GuildConfig, userId: string, day: number): DoorState {
  const t = doorTimes(ev, cfg, day);
  const now = ctx.now();
  if (claimRow(ctx, ev.guildId, ev.id, userId, day)) return 'claimed';
  if (now < t.unlockAt) return 'locked';
  if (now >= t.claimEndsAt || ev.state === 'ended') return 'expired';
  return 'available';
}

function requirePublished(ev: SeasonEvent): void {
  if (!ev.adventPublishedAt) throw new UserError("This Advent calendar hasn't been published yet. Check back soon!");
}

function resolveAdventEvent(ctx: Ctx, guildId: string, eventId?: string | null): SeasonEvent {
  const ev = eventId ? requireEvent(ctx, guildId, eventId, 'advent') : getCurrentOrLatestEvent(ctx, guildId, 'advent');
  if (!ev) throw new UserError("There's no Advent calendar yet. Check `/events` for what's coming up.");
  if (ev.state === 'draft' || ev.state === 'scheduled') throw new UserError("The Advent calendar hasn't started yet. Check `/events` for dates.");
  requirePublished(ev);
  return ev;
}

/** The door dated today in the server timezone, if any. */
export function todaysDay(ctx: Ctx, ev: SeasonEvent, cfg: GuildConfig): number | null {
  const today = msToLocalDate(ctx.now(), cfg.timezone);
  for (let day = 1; day <= cfg.adventDoorCount; day++) {
    if (addDays(ev.startLocal.slice(0, 10), day - 1) === today) return day;
  }
  return null;
}

export type OpenOutcome = 'claimed' | 'already-claimed' | 'expired' | 'ineligible';

export interface OpenResult {
  event: SeasonEvent;
  door: Door;
  times: DoorTimes;
  outcome: OpenOutcome;
  candy: number;
  policy: GuildConfig['adventPolicy'];
}

/**
 * Opens a released door. The first open within the claim window records the
 * claim and its candy together, exactly once. Later opens show the content only.
 */
export function openDoor(ctx: Ctx, guildId: string, userId: string, day?: number | null, eventId?: string | null): OpenResult {
  const ev = resolveAdventEvent(ctx, guildId, eventId);
  const cfg = getConfig(ctx, guildId);
  if (ev.state === 'paused') requireActiveEvent(ctx, guildId, 'advent');
  const d = day ?? todaysDay(ctx, ev, cfg);
  if (d === null) throw new UserError('There is no door dated today. Use `/advent` to see the calendar.');
  if (!Number.isInteger(d) || d < 1 || d > cfg.adventDoorCount) throw new UserError(`Pick a door from 1 to ${cfg.adventDoorCount}.`);
  const times = doorTimes(ev, cfg, d);
  if (ctx.now() < times.unlockAt) throw new UserError(`Door ${d} is still locked. It opens <t:${Math.floor(times.unlockAt / 1000)}:F>.`);
  const door = getDoor(ctx, guildId, ev.id, d);
  if (!door) throw new UserError(`Door ${d} has no content yet. Please let the event staff know.`);

  return tx(ctx, () => {
    const existing = claimRow(ctx, guildId, ev.id, userId, d);
    const base = { event: ev, door, times, policy: cfg.adventPolicy };
    if (existing) return { ...base, outcome: 'already-claimed', candy: existing.candy };
    if (ev.state === 'ended' || ctx.now() >= times.claimEndsAt) return { ...base, outcome: 'expired', candy: 0 };
    if (!isEligible(ctx, guildId, userId, 'advent')) return { ...base, outcome: 'ineligible', candy: 0 };

    ctx.db
      .prepare('INSERT INTO advent_claims (guild_id, event_id, user_id, day, claimed_at, candy) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guildId, ev.id, userId, d, ctx.now(), door.candy);
    if (door.candy > 0) {
      const { txn } = applyCandy(ctx, {
        guildId,
        userId,
        amount: door.candy,
        source: 'advent',
        eventId: ev.id,
        reason: `Advent door ${d}`,
        idemKey: `advent:${ev.id}:${d}:${userId}`,
      });
      ctx.db
        .prepare('UPDATE advent_claims SET txn_id = ? WHERE guild_id = ? AND event_id = ? AND user_id = ? AND day = ?')
        .run(txn.id, guildId, ev.id, userId, d);
    }
    return { ...base, outcome: 'claimed', candy: door.candy };
  });
}

export function calendar(ctx: Ctx, guildId: string, userId: string, eventId?: string | null) {
  const ev = resolveAdventEvent(ctx, guildId, eventId);
  const cfg = getConfig(ctx, guildId);
  const doors = new Map(listDoors(ctx, guildId, ev.id).map((d) => [d.day, d]));
  const days = [];
  for (let day = 1; day <= cfg.adventDoorCount; day++) {
    const state = doorState(ctx, ev, cfg, userId, day);
    days.push({ day, state, times: doorTimes(ev, cfg, day), title: state === 'locked' ? null : (doors.get(day)?.title ?? null) });
  }
  return { event: ev, policy: cfg.adventPolicy, days, today: todaysDay(ctx, ev, cfg) };
}

export function progress(ctx: Ctx, guildId: string, userId: string, eventId?: string | null) {
  const ev = resolveAdventEvent(ctx, guildId, eventId);
  const cfg = getConfig(ctx, guildId);
  const claims = ctx.db
    .prepare('SELECT day, candy, claimed_at FROM advent_claims WHERE guild_id = ? AND event_id = ? AND user_id = ? ORDER BY day')
    .all(guildId, ev.id, userId) as { day: number; candy: number; claimed_at: number }[];
  return {
    event: ev,
    doorCount: cfg.adventDoorCount,
    claimedDays: claims.map((c) => c.day),
    candy: claims.reduce((n, c) => n + c.candy, 0),
  };
}

export interface DoorInput {
  title: string;
  message: string;
  imageUrl?: string | null;
  linkUrl?: string | null;
  triviaAnswer?: string | null;
  candy?: number | null;
}

function validUrl(v: string | null | undefined): boolean {
  if (!v) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function editDoor(ctx: Ctx, guildId: string, eventId: string, day: number, input: DoorInput, actorId: string, reason?: string | null): Door {
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId, 'advent');
    const cfg = getConfig(ctx, guildId);
    if (ev.state === 'ended') throw new UserError('This Advent event has ended and its content is frozen.');
    if (!Number.isInteger(day) || day < 1 || day > cfg.adventDoorCount) throw new UserError(`Pick a door from 1 to ${cfg.adventDoorCount}.`);
    if (!input.title.trim() || !input.message.trim()) throw new UserError('Every door needs a title and a message.');
    if (!validUrl(input.imageUrl)) throw new UserError('The image must be an http(s) URL.');
    if (!validUrl(input.linkUrl)) throw new UserError('The link must be an http(s) URL.');
    const candy = input.candy ?? DEFAULT_DOOR_CANDY;
    if (!Number.isInteger(candy) || candy < 0) throw new UserError('Candy must be a whole number of zero or more.');
    const before = getDoor(ctx, guildId, ev.id, day);
    const released = ctx.now() >= doorTimes(ev, cfg, day).unlockAt;
    if (ev.adventPublishedAt && !reason?.trim()) {
      throw new UserError('This calendar is published, so changes need a correction reason.');
    }
    ctx.db
      .prepare(
        `INSERT INTO advent_doors (guild_id, event_id, day, title, message, image_url, link_url, trivia_answer, candy, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, event_id, day) DO UPDATE SET title = excluded.title, message = excluded.message,
           image_url = excluded.image_url, link_url = excluded.link_url, trivia_answer = excluded.trivia_answer,
           candy = excluded.candy, updated_at = excluded.updated_at`,
      )
      .run(
        guildId,
        ev.id,
        day,
        input.title.trim(),
        input.message.trim(),
        input.imageUrl?.trim() || null,
        input.linkUrl?.trim() || null,
        input.triviaAnswer?.trim() || null,
        candy,
        ctx.now(),
      );
    const after = getDoor(ctx, guildId, ev.id, day)!;
    audit(ctx, {
      guildId,
      actorId,
      action: ev.adventPublishedAt ? (released ? 'advent.correct-released-door' : 'advent.correct-door') : 'advent.edit-door',
      eventId: ev.id,
      before: before ?? undefined,
      after,
      reason: reason ?? null,
    });
    return after;
  });
}

export function validateCalendar(ctx: Ctx, guildId: string, eventId: string): string[] {
  const ev = requireEvent(ctx, guildId, eventId, 'advent');
  const cfg = getConfig(ctx, guildId);
  const issues: string[] = [];
  const doors = new Map(listDoors(ctx, guildId, ev.id).map((d) => [d.day, d]));
  const win = eventWindow(ev, cfg.timezone);
  if (cfg.adventAnnounceTime < cfg.adventUnlockTime) issues.push('The announcement time is earlier than the unlock time.');
  for (let day = 1; day <= cfg.adventDoorCount; day++) {
    const door = doors.get(day);
    if (!door) {
      issues.push(`Door ${day} is missing.`);
      continue;
    }
    const t = doorTimes(ev, cfg, day);
    if (t.unlockAt < win.startsAt || t.unlockAt >= win.endsAt) issues.push(`Door ${day} (${t.date}) falls outside the event dates.`);
    if (t.unlockAt >= t.claimEndsAt) issues.push(`Door ${day} (${t.date}) unlocks after the claim deadline.`);
    if (!door.title.trim() || !door.message.trim()) issues.push(`Door ${day} is missing its title or message.`);
    if (!Number.isInteger(door.candy) || door.candy < 0) issues.push(`Door ${day} has an invalid candy amount.`);
    if (!validUrl(door.imageUrl) || !validUrl(door.linkUrl)) issues.push(`Door ${day} has an invalid URL.`);
  }
  for (const day of doors.keys()) if (day > cfg.adventDoorCount) issues.push(`Door ${day} exceeds the configured ${cfg.adventDoorCount} doors.`);
  return issues;
}

export function publishCalendar(ctx: Ctx, guildId: string, eventId: string, actorId: string): SeasonEvent {
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId, 'advent');
    if (ev.state === 'ended') throw new UserError('This Advent event has ended.');
    if (ev.adventPublishedAt) throw new UserError('This calendar is already published. Use `/season door` with a reason for corrections.');
    const issues = validateCalendar(ctx, guildId, eventId);
    if (issues.length) throw new UserError(`Fix these first:\n• ${issues.slice(0, 15).join('\n• ')}`);
    setEventState(ctx, ev, { advent_published_at: ctx.now() });
    audit(ctx, { guildId, actorId, action: 'advent.publish', eventId, after: { doors: listDoors(ctx, guildId, eventId).length } });
    return requireEvent(ctx, guildId, eventId);
  });
}

export type AdventPostPlan = { kind: 'daily'; event: SeasonEvent; day: number } | { kind: 'recovery'; event: SeasonEvent; days: number[] };

/**
 * Doors whose announcement is due. A single due door gets its daily post; if
 * several were missed (downtime), they are combined into one recovery post.
 */
export function dueAnnouncements(ctx: Ctx, guildId: string): AdventPostPlan | null {
  const ev = getCurrentOrLatestEvent(ctx, guildId, 'advent');
  if (!ev || ev.state !== 'active' || !ev.adventPublishedAt) return null;
  const cfg = getConfig(ctx, guildId);
  const now = ctx.now();
  const posted = new Set(
    (ctx.db.prepare('SELECT day FROM advent_posts WHERE guild_id = ? AND event_id = ?').all(guildId, ev.id) as { day: number }[]).map((r) => r.day),
  );
  const due: number[] = [];
  for (let day = 1; day <= cfg.adventDoorCount; day++) {
    if (posted.has(day)) continue;
    const t = doorTimes(ev, cfg, day);
    if (now < t.announceAt) continue;
    if (now >= t.claimEndsAt) {
      // Nothing left to announce for a door that can no longer be claimed.
      markPosted(ctx, guildId, ev.id, [day], null, null, true);
      continue;
    }
    due.push(day);
  }
  if (due.length === 0) return null;
  return due.length === 1 ? { kind: 'daily', event: ev, day: due[0]! } : { kind: 'recovery', event: ev, days: due };
}

export function markPosted(ctx: Ctx, guildId: string, eventId: string, days: number[], channelId: string | null, messageId: string | null, recovery: boolean): void {
  const stmt = ctx.db.prepare(
    `INSERT INTO advent_posts (guild_id, event_id, day, channel_id, message_id, recovery, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, event_id, day) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id,
       recovery = excluded.recovery, posted_at = excluded.posted_at`,
  );
  tx(ctx, () => {
    for (const day of days) stmt.run(guildId, eventId, day, channelId, messageId, recovery ? 1 : 0, ctx.now());
  });
}

/** For staff repair posts: the door must already be unlocked. */
export function requireUnlocked(ctx: Ctx, guildId: string, eventId: string, day: number): { event: SeasonEvent; door: Door; times: DoorTimes } {
  const ev = requireEvent(ctx, guildId, eventId, 'advent');
  requirePublished(ev);
  const cfg = getConfig(ctx, guildId);
  if (day < 1 || day > cfg.adventDoorCount) throw new UserError(`Pick a door from 1 to ${cfg.adventDoorCount}.`);
  const times = doorTimes(ev, cfg, day);
  if (ctx.now() < times.unlockAt) throw new UserError(`Door ${day} hasn't unlocked yet.`);
  const door = getDoor(ctx, guildId, ev.id, day);
  if (!door) throw new UserError(`Door ${day} has no content.`);
  return { event: ev, door, times };
}

/** Sets an Advent event's claim deadline (local `YYYY-MM-DD HH:mm`). */
export function setClaimDeadline(ctx: Ctx, guildId: string, eventId: string, value: string, actorId: string): SeasonEvent {
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId, 'advent');
    if (ev.state === 'ended') throw new UserError('This Advent event has ended.');
    const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?$/.exec(value.trim());
    if (!m) throw new UserError('The claim deadline must look like 2026-12-25 00:00.');
    const local = `${m[1]}T${(m[2] ?? '00:00').padStart(5, '0')}`;
    const tz = getConfig(ctx, guildId).timezone;
    let at: number;
    try {
      at = localToMs(local, tz);
    } catch {
      throw new UserError('The claim deadline must look like 2026-12-25 00:00.');
    }
    const win = eventWindow(ev, tz);
    if (at <= win.startsAt || at > win.endsAt) throw new UserError('The claim deadline must fall after the start and no later than the end of the event.');
    setEventState(ctx, ev, { claim_deadline_local: local });
    audit(ctx, { guildId, actorId, action: 'advent.claim-deadline', eventId, before: { claimDeadline: ev.claimDeadlineLocal }, after: { claimDeadline: local } });
    return requireEvent(ctx, guildId, eventId);
  });
}
