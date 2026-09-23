import { describe, expect, it } from 'vitest';
import { calendar, dueAnnouncements, editDoor, markPosted, openDoor, publishCalendar, validateCalendar } from '../src/domain/advent.js';
import { getBalance } from '../src/domain/candy.js';
import { addChannel, updateConfig } from '../src/domain/config.js';
import { openDatabase } from '../src/db/database.js';
import { startEvent } from '../src/domain/lifecycle.js';
import { UserError } from '../src/domain/errors.js';
import { ADMIN, GUILD, makeCtx, startFeature, type TestCtx } from './helpers.js';

function setup(policy: 'catch-up' | 'same-day' = 'catch-up') {
  const ctx = makeCtx('2026-11-20T12:00:00Z');
  addChannel(ctx, GUILD, 'advent', 'advent-channel');
  updateConfig(ctx, GUILD, { adventPolicy: policy });
  const eventId = startFeature(ctx, 'advent', 'Advent 2026');
  for (let day = 1; day <= 24; day++) {
    editDoor(ctx, GUILD, eventId, day, { title: `Door ${day}`, message: `Hello ${day}`, candy: day === 3 ? 0 : null }, ADMIN);
  }
  expect(validateCalendar(ctx, GUILD, eventId)).toEqual([]);
  publishCalendar(ctx, GUILD, eventId, ADMIN);
  startEvent(ctx, GUILD, eventId, ADMIN);
  return { ctx, eventId };
}

// Copenhagen is UTC+1 in December: 09:00 local = 08:00Z.
describe('unlocking', () => {
  it('respects timezone and the 09:00 release time', () => {
    const { ctx } = setup();
    ctx.set('2026-12-01T07:59:00Z');
    expect(() => openDoor(ctx, GUILD, 'a')).toThrow(/still locked/);
    ctx.set('2026-12-01T08:00:00Z');
    const r = openDoor(ctx, GUILD, 'a');
    expect(r).toMatchObject({ outcome: 'claimed', candy: 10 });
    expect(r.door.day).toBe(1);
    expect(() => openDoor(ctx, GUILD, 'a', 2)).toThrow(/still locked/);
  });

  it('awards each door once, including across restarts', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'emojitown-')), 'bot.db');
    const { ctx } = setup();
    // move the fully set up in-memory database to disk to simulate a restart
    await ctx.db.backup(path);
    ctx.db = openDatabase(path);
    ctx.set('2026-12-01T10:00:00Z');
    expect(openDoor(ctx, GUILD, 'a').outcome).toBe('claimed');
    ctx.db.close();
    ctx.db = openDatabase(path);
    expect(openDoor(ctx, GUILD, 'a').outcome).toBe('already-claimed');
    expect(getBalance(ctx, GUILD, 'a')).toBe(10);
  });

  it('catch-up keeps previous doors claimable until Dec 25 00:00, then read-only', () => {
    const { ctx } = setup();
    ctx.set('2026-12-10T12:00:00Z');
    expect(openDoor(ctx, GUILD, 'a', 2).outcome).toBe('claimed');
    expect(openDoor(ctx, GUILD, 'a', 3)).toMatchObject({ outcome: 'claimed', candy: 0 });
    expect(() => openDoor(ctx, GUILD, 'a', 11)).toThrow(/locked/);
    ctx.set('2026-12-24T22:59:00Z');
    expect(openDoor(ctx, GUILD, 'b', 1).outcome).toBe('claimed');
    ctx.set('2026-12-24T23:00:00Z');
    expect(openDoor(ctx, GUILD, 'b', 2).outcome).toBe('expired');
    expect(getBalance(ctx, GUILD, 'b')).toBe(10);
  });

  it('same-day policy expires each door at local midnight', () => {
    const { ctx } = setup('same-day');
    ctx.set('2026-12-05T22:59:00Z');
    expect(openDoor(ctx, GUILD, 'a', 5).outcome).toBe('claimed');
    expect(openDoor(ctx, GUILD, 'a', 4).outcome).toBe('expired');
    ctx.set('2026-12-05T23:00:00Z');
    expect(openDoor(ctx, GUILD, 'b', 5).outcome).toBe('expired');
    const cal = calendar(ctx, GUILD, 'a');
    expect(cal.days[4]!.state).toBe('claimed');
    expect(cal.days[3]!.state).toBe('expired');
    expect(cal.days[6]!.state).toBe('locked');
  });
});

describe('announcements', () => {
  it('posts the daily door and combines missed doors into one recovery post', () => {
    const { ctx, eventId } = setup();
    ctx.set('2026-12-01T08:00:00Z');
    expect(dueAnnouncements(ctx, GUILD)).toMatchObject({ kind: 'daily', day: 1 });
    markPosted(ctx, GUILD, eventId, [1], 'c', 'm', false);
    expect(dueAnnouncements(ctx, GUILD)).toBeNull();
    ctx.set('2026-12-04T09:00:00Z');
    expect(dueAnnouncements(ctx, GUILD)).toMatchObject({ kind: 'recovery', days: [2, 3, 4] });
  });
});

describe('content', () => {
  it('requires a reason for published changes and never re-awards claims', () => {
    const { ctx, eventId } = setup();
    ctx.set('2026-12-01T10:00:00Z');
    openDoor(ctx, GUILD, 'a', 1);
    expect(() => editDoor(ctx, GUILD, eventId, 1, { title: 'New', message: 'New', candy: 50 }, ADMIN)).toThrow(UserError);
    editDoor(ctx, GUILD, eventId, 1, { title: 'New', message: 'New', candy: 50 }, ADMIN, 'typo');
    expect(openDoor(ctx, GUILD, 'a', 1)).toMatchObject({ outcome: 'already-claimed', candy: 10 });
    expect(getBalance(ctx, GUILD, 'a')).toBe(10);
  });

  it('validation lists missing doors', () => {
    const ctx: TestCtx = makeCtx('2026-11-20T12:00:00Z');
    const eventId = startFeature(ctx, 'advent', 'Advent 2026');
    editDoor(ctx, GUILD, eventId, 1, { title: 't', message: 'm' }, ADMIN);
    const issues = validateCalendar(ctx, GUILD, eventId);
    expect(issues).toHaveLength(23);
    expect(() => publishCalendar(ctx, GUILD, eventId, ADMIN)).toThrow(/Fix these first/);
  });
});
