import { describe, expect, it } from 'vitest';
import { UserError } from '../src/domain/errors.js';
import { endEvent, pauseEvent } from '../src/domain/lifecycle.js';
import { exclude, markDeparted, setSnowballParticipation } from '../src/domain/members.js';
import {
  applyCorrection,
  collect,
  COLLECT_COOLDOWN_MS,
  getPlayer,
  leaderboard,
  planCorrection,
  stats,
  throwSnowball,
  WARMUP_MS,
} from '../src/domain/snowball.js';
import { openDatabase } from '../src/db/database.js';
import { ADMIN, GUILD, makeCtx, startFeature } from './helpers.js';

const HIT = 0.1;
const MISS = 0.9;

function setup() {
  const ctx = makeCtx();
  const eventId = startFeature(ctx, 'snowball', 'Winter 2026', { start: '2026-12-01', end: '2026-12-31' });
  return { ctx, eventId };
}

describe('snowball collection', () => {
  it('adds one snowball and enforces the 30-second wait', () => {
    const { ctx } = setup();
    expect(collect(ctx, GUILD, 'a').stats.snowballs).toBe(1);
    expect(() => collect(ctx, GUILD, 'a')).toThrow(UserError);
    ctx.advance(COLLECT_COOLDOWN_MS - 1);
    expect(() => collect(ctx, GUILD, 'a')).toThrow(UserError);
    ctx.advance(1);
    const r = collect(ctx, GUILD, 'a');
    expect(r.stats.snowballs).toBe(2);
    expect(r.stats.collected).toBe(2);
  });
});

describe('throwing', () => {
  it('hits block collection for 120 seconds but stored snowballs can still be thrown', () => {
    const { ctx } = setup();
    collect(ctx, GUILD, 'b');
    ctx.advance(COLLECT_COOLDOWN_MS);
    collect(ctx, GUILD, 'b');
    collect(ctx, GUILD, 'a');
    ctx.rolls = [HIT, 0];
    expect(throwSnowball(ctx, GUILD, 'a', 'b').hit).toBe(true);

    ctx.advance(COLLECT_COOLDOWN_MS);
    expect(() => collect(ctx, GUILD, 'b')).toThrow(/warming up/);
    ctx.rolls = [MISS, 0];
    expect(throwSnowball(ctx, GUILD, 'b', 'a').hit).toBe(false);
    expect(getPlayer(ctx, GUILD, 'winter-2026', 'b')!.snowballs).toBe(1);

    ctx.advance(WARMUP_MS - COLLECT_COOLDOWN_MS);
    expect(collect(ctx, GUILD, 'b').stats.snowballs).toBe(2);
  });

  it('a further hit restarts the warm-up', () => {
    const { ctx, eventId } = setup();
    collect(ctx, GUILD, 'a');
    ctx.advance(COLLECT_COOLDOWN_MS);
    collect(ctx, GUILD, 'a');
    ctx.rolls = [HIT, 0];
    throwSnowball(ctx, GUILD, 'a', 'b');
    ctx.advance(60_000);
    ctx.rolls = [HIT, 0];
    throwSnowball(ctx, GUILD, 'a', 'b');
    expect(getPlayer(ctx, GUILD, eventId, 'b')!.warmUntil).toBe(ctx.now() + WARMUP_MS);
  });

  it('invalid targets consume nothing and change no statistics', () => {
    const { ctx, eventId } = setup();
    collect(ctx, GUILD, 'a');
    const before = getPlayer(ctx, GUILD, eventId, 'a');
    markDeparted(ctx, GUILD, 'gone');
    exclude(ctx, GUILD, 'banned', 'snowball', 'spam', ADMIN);
    setSnowballParticipation(ctx, GUILD, 'shy', false);
    for (const target of ['a', 'gone', 'banned', 'shy']) {
      ctx.rolls = [HIT, 0];
      expect(() => throwSnowball(ctx, GUILD, 'a', target)).toThrow(UserError);
    }
    expect(getPlayer(ctx, GUILD, eventId, 'a')).toEqual(before);
    expect(getPlayer(ctx, GUILD, eventId, 'banned')).toBeNull();
  });

  it('opted-out members cannot throw', () => {
    const { ctx } = setup();
    collect(ctx, GUILD, 'a');
    setSnowballParticipation(ctx, GUILD, 'a', false);
    expect(() => throwSnowball(ctx, GUILD, 'a', 'b')).toThrow(/opted out/);
    expect(() => collect(ctx, GUILD, 'a')).toThrow(/opted out/);
  });

  it('a hit credits the thrower and the correct target', () => {
    const { ctx, eventId } = setup();
    collect(ctx, GUILD, 'a');
    ctx.advance(COLLECT_COOLDOWN_MS);
    collect(ctx, GUILD, 'a');
    ctx.rolls = [HIT, 0];
    throwSnowball(ctx, GUILD, 'a', 'b');
    ctx.rolls = [HIT, 0];
    throwSnowball(ctx, GUILD, 'a', 'c');
    const a = getPlayer(ctx, GUILD, eventId, 'a')!;
    expect(a).toMatchObject({ hits: 2, misses: 0, kosReceived: 0, snowballs: 0, collected: 2 });
    expect(getPlayer(ctx, GUILD, eventId, 'b')!.kosReceived).toBe(1);
    expect(getPlayer(ctx, GUILD, eventId, 'c')!.kosReceived).toBe(1);
  });

  it('with no snowballs a throw is rejected and nothing changes', () => {
    const { ctx, eventId } = setup();
    expect(() => throwSnowball(ctx, GUILD, 'a', 'b')).toThrow(/don't have any snowballs/);
    expect(getPlayer(ctx, GUILD, eventId, 'b')).toBeNull();
  });

  it('decides hit or miss before choosing message text (50% threshold)', () => {
    const { ctx } = setup();
    collect(ctx, GUILD, 'a');
    ctx.rolls = [0.4999, 0.99];
    const r = throwSnowball(ctx, GUILD, 'a', 'b');
    expect(r.hit).toBe(true);
    expect(r.message).toContain('<@a>');
  });
});

describe('persistence and concurrency', () => {
  it('cooldowns survive a restart', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'emojitown-')), 'bot.db');
    const ctx = makeCtx();
    ctx.db = openDatabase(path);
    const { updateConfig } = await import('../src/domain/config.js');
    updateConfig(ctx, GUILD, { timezone: 'Europe/Copenhagen' });
    startFeature(ctx, 'snowball', 'Winter 2026', { start: '2026-12-01', end: '2026-12-31' });
    collect(ctx, GUILD, 'a');
    ctx.db.close();

    ctx.db = openDatabase(path);
    ctx.advance(10_000);
    expect(() => collect(ctx, GUILD, 'a')).toThrow(/cold/);
    ctx.advance(COLLECT_COOLDOWN_MS);
    expect(collect(ctx, GUILD, 'a').stats.snowballs).toBe(2);
  });

  it('racing throws never create negative inventory or lose scoring', () => {
    const { ctx, eventId } = setup();
    collect(ctx, GUILD, 'a');
    let ok = 0;
    for (let i = 0; i < 5; i++) {
      ctx.rolls = [HIT, 0];
      try {
        throwSnowball(ctx, GUILD, 'a', `t${i}`);
        ok++;
      } catch (e) {
        expect(e).toBeInstanceOf(UserError);
      }
    }
    expect(ok).toBe(1);
    const a = getPlayer(ctx, GUILD, eventId, 'a')!;
    expect(a.snowballs).toBe(0);
    expect(a.hits + a.misses).toBe(1);
  });
});

describe('stats and leaderboard', () => {
  it('ranks by hits with shared ranks for ties and excludes departed/excluded players', () => {
    const { ctx, eventId } = setup();
    const give = (u: string, n: number) => {
      for (let i = 0; i < n; i++) {
        collect(ctx, GUILD, u);
        ctx.rolls = [HIT, 0];
        throwSnowball(ctx, GUILD, u, 'target');
        ctx.advance(COLLECT_COOLDOWN_MS);
      }
    };
    give('x', 2);
    give('y', 2);
    give('z', 1);
    give('w', 3);
    markDeparted(ctx, GUILD, 'w');
    const lb = leaderboard(ctx, GUILD, eventId, 1).page.items;
    expect(lb.map((r) => [r.row.userId, r.rank])).toEqual([
      ['x', 1],
      ['y', 1],
      ['z', 3],
    ]);
    expect(stats(ctx, GUILD, 'w').stats.hits).toBe(3);
  });

  it('paused and ended events reject gameplay; archives stay viewable', () => {
    const { ctx, eventId } = setup();
    collect(ctx, GUILD, 'a');
    pauseEvent(ctx, GUILD, eventId, 'maintenance', ADMIN);
    expect(() => collect(ctx, GUILD, 'b')).toThrow(/paused/);
    endEvent(ctx, GUILD, eventId, ADMIN);
    expect(() => collect(ctx, GUILD, 'b')).toThrow(/isn't running/);
    expect(stats(ctx, GUILD, 'a', eventId).stats.collected).toBe(1);

    const next = startFeature(ctx, 'snowball', 'Winter 2027', { start: '2026-12-06', end: '2026-12-31' });
    expect(stats(ctx, GUILD, 'a').event.id).toBe(next);
    expect(stats(ctx, GUILD, 'a').stats.collected).toBe(0);
    expect(stats(ctx, GUILD, 'a', eventId).stats.collected).toBe(1);
  });
});

describe('staff corrections', () => {
  it('keeps totals nonnegative and internally consistent', () => {
    const { ctx, eventId } = setup();
    collect(ctx, GUILD, 'a');
    expect(() => planCorrection(ctx, GUILD, eventId, 'a', 'hits', 5)).toThrow(/exceed/);
    const plan = planCorrection(ctx, GUILD, eventId, 'a', 'collected', 6);
    expect(plan.after.snowballs).toBe(6);
    applyCorrection(ctx, GUILD, plan, 'lost snowballs', ADMIN);
    applyCorrection(ctx, GUILD, planCorrection(ctx, GUILD, eventId, 'a', 'hits', 4), 'fix', ADMIN);
    expect(getPlayer(ctx, GUILD, eventId, 'a')).toMatchObject({ collected: 6, hits: 4, snowballs: 2 });
  });
});
