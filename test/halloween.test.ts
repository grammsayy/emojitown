import { describe, expect, it } from 'vitest';
import { getBalance, reconcileBalances } from '../src/domain/candy.js';
import { getRoleState, markRoleFailed, markRoleSynced } from '../src/domain/champion.js';
import { updateConfig } from '../src/domain/config.js';
import { UserError } from '../src/domain/errors.js';
import { getEvent } from '../src/domain/events.js';
import {
  claim,
  correctCollection,
  getEncounter,
  inventory,
  leaderboard,
  recordActivity,
  tickHalloween,
  type Encounter,
} from '../src/domain/halloween.js';
import { endEvent, pauseEvent, resumeEvent } from '../src/domain/lifecycle.js';
import { exclude, include } from '../src/domain/members.js';
import { ADMIN, GUILD, makeCtx, startFeature, type TestCtx } from './helpers.js';

const CHANNEL = 'halloween-channel';

function setup() {
  const ctx = makeCtx('2026-10-10T12:00:00Z');
  const eventId = startFeature(ctx, 'halloween', 'Halloween 2026', { start: '2026-10-01', end: '2026-10-31' });
  return { ctx, eventId };
}

/** Forces a visitor to appear. `visitorRoll` picks the visitor; request is trick when `trick`. */
function spawn(ctx: TestCtx, opts: { visitorRoll?: number; trick?: boolean } = {}): Encounter {
  recordActivity(ctx, GUILD, CHANNEL);
  ctx.advance(21 * 60_000);
  recordActivity(ctx, GUILD, CHANNEL);
  ctx.rolls = [0, opts.visitorRoll ?? 0, opts.trick === false ? 0.9 : 0.1];
  const t = tickHalloween(ctx, GUILD);
  if (!t.spawned) throw new Error('no spawn');
  return t.spawned;
}

/** Answers correctly with a rarity roll (0 = common, 0.8 = uncommon, 0.99 = rare). */
function win(ctx: TestCtx, enc: Encounter, user: string, rarityRoll = 0) {
  ctx.rolls = [rarityRoll, 0];
  const r = claim(ctx, GUILD, user, enc.request, { encounterId: enc.id });
  if (r.kind !== 'win') throw new Error('expected a win');
  return r;
}

describe('spawning', () => {
  it('only spawns in channels with recent human activity, and one at a time', () => {
    const { ctx } = setup();
    ctx.rolls = [0];
    tickHalloween(ctx, GUILD); // schedules the first spawn
    ctx.advance(21 * 60_000);
    expect(tickHalloween(ctx, GUILD).spawned).toBeNull(); // no activity yet
    recordActivity(ctx, GUILD, CHANNEL);
    ctx.advance(60_000);
    const enc = tickHalloween(ctx, GUILD).spawned!;
    expect(enc.channelId).toBe(CHANNEL);
    expect(enc.expiresAt - enc.openedAt).toBe(90_000);
    expect(tickHalloween(ctx, GUILD).spawned).toBeNull();
  });

  it('expired encounters close without rewards and reject claims', () => {
    const { ctx } = setup();
    const enc = spawn(ctx);
    ctx.advance(90_000);
    expect(() => claim(ctx, GUILD, 'a', enc.request, { encounterId: enc.id })).toThrow(/already left/);
    const t = tickHalloween(ctx, GUILD);
    expect(t.closed.map((e) => e.status)).toEqual(['expired']);
    expect(getBalance(ctx, GUILD, 'a')).toBe(0);
  });
});

describe('claims', () => {
  it('a wrong answer uses the attempt but leaves the encounter open', () => {
    const { ctx } = setup();
    const enc = spawn(ctx, { trick: true });
    const wrong = claim(ctx, GUILD, 'a', 'treat', { encounterId: enc.id });
    expect(wrong.kind).toBe('wrong');
    expect(() => claim(ctx, GUILD, 'a', 'trick', { encounterId: enc.id })).toThrow(/already answered/);
    expect(getEncounter(ctx, GUILD, enc.id)!.status).toBe('open');
    expect(win(ctx, enc, 'b').kind).toBe('win');
    expect(getBalance(ctx, GUILD, 'a')).toBe(0);
    expect(getBalance(ctx, GUILD, 'b')).toBe(5);
  });

  it('simultaneous correct answers produce exactly one winner', () => {
    const { ctx } = setup();
    const enc = spawn(ctx);
    const results = ['a', 'b', 'c'].map((u) => {
      try {
        return win(ctx, enc, u).kind;
      } catch (e) {
        expect(e).toBeInstanceOf(UserError);
        return 'rejected';
      }
    });
    expect(results).toEqual(['win', 'rejected', 'rejected']);
    expect(getEncounter(ctx, GUILD, enc.id)!.winnerId).toBe('a');
  });

  it('repeated clicks and paused events issue no rewards', () => {
    const { ctx, eventId } = setup();
    const enc = spawn(ctx);
    win(ctx, enc, 'a');
    expect(() => win(ctx, enc, 'a')).toThrow(UserError);
    expect(getBalance(ctx, GUILD, 'a')).toBe(5);

    const enc2 = spawn(ctx);
    const { closed } = pauseEvent(ctx, GUILD, eventId, 'break', ADMIN);
    expect(closed.map((e) => e.id)).toEqual([enc2.id]);
    expect(() => win(ctx, enc2, 'b')).toThrow(/paused/);
    resumeEvent(ctx, GUILD, eventId, ADMIN);
    expect(() => win(ctx, enc2, 'b')).toThrow(/already left/);
    expect(getBalance(ctx, GUILD, 'b')).toBe(0);
  });

  it('duplicates do not increase collection rank but still award candy', () => {
    const { ctx, eventId } = setup();
    win(ctx, spawn(ctx), 'a');
    const dup = win(ctx, spawn(ctx), 'a');
    expect(dup.duplicate).toBe(true);
    win(ctx, spawn(ctx), 'b', 0.99);
    const inv = inventory(ctx, GUILD, 'a', eventId, null, 1);
    expect(inv.unique).toBe(1);
    expect(inv.duplicates).toBe(1);
    expect(inv.total).toBe(120);
    expect(getBalance(ctx, GUILD, 'a')).toBe(10);
    // a reached 1 unique first, so a leads the tie
    expect(leaderboard(ctx, GUILD, eventId, 1).page.items.map((r) => [r.row.userId, r.rank])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
  });

  it('caps Halloween candy at the daily limit without stopping collection', () => {
    const { ctx, eventId } = setup();
    updateConfig(ctx, GUILD, { candyHalloweenDailyLimit: 12 });
    const wins = [0, 0.8, 0.99].map((roll, i) => win(ctx, spawn(ctx, { visitorRoll: i / 40 }), 'a', roll));
    expect(wins.map((w) => w.candy)).toEqual([5, 5, 2]);
    expect(wins[2]!.capped).toBe(true);
    expect(inventory(ctx, GUILD, 'a', eventId, null, 1).unique).toBe(3);
    expect(reconcileBalances(ctx, GUILD)).toEqual([]);
  });
});

describe('champion', () => {
  it('the incumbent keeps the title during a tie', () => {
    const { ctx, eventId } = setup();
    expect(win(ctx, spawn(ctx, { visitorRoll: 0 }), 'a').championId).toBe('a');
    win(ctx, spawn(ctx, { visitorRoll: 0.5 }), 'b');
    win(ctx, spawn(ctx, { visitorRoll: 0.6 }), 'b');
    expect(leaderboard(ctx, GUILD, eventId, 1).championId).toBe('b');
    const tie = win(ctx, spawn(ctx, { visitorRoll: 0.1 }), 'a');
    expect(tie.championId).toBe('b');
  });

  it('without an eligible incumbent, the earliest to reach the tied score wins', () => {
    const { ctx, eventId } = setup();
    win(ctx, spawn(ctx, { visitorRoll: 0 }), 'a');
    win(ctx, spawn(ctx, { visitorRoll: 0.5 }), 'b');
    win(ctx, spawn(ctx, { visitorRoll: 0.6 }), 'c');
    win(ctx, spawn(ctx, { visitorRoll: 0.7 }), 'c');
    expect(leaderboard(ctx, GUILD, eventId, 1).championId).toBe('c');
    win(ctx, spawn(ctx, { visitorRoll: 0.1 }), 'b');
    win(ctx, spawn(ctx, { visitorRoll: 0.2 }), 'a');
    exclude(ctx, GUILD, 'c', 'halloween', 'testing', ADMIN);
    // a and b tie at 2 with no eligible incumbent; b reached 2 first
    expect(leaderboard(ctx, GUILD, eventId, 1).championId).toBe('b');
    correctCollection(ctx, GUILD, eventId, 'a', 'grant', 'pumpkin-pete.golden-gourd', 'restore', ADMIN);
    expect(leaderboard(ctx, GUILD, eventId, 1).championId).toBe('a');
    correctCollection(ctx, GUILD, eventId, 'a', 'revoke', 'pumpkin-pete.golden-gourd', 'undo', ADMIN);
    // back to a 2-2 tie: the incumbent (a) keeps the title
    expect(leaderboard(ctx, GUILD, eventId, 1).championId).toBe('a');
    include(ctx, GUILD, 'c', 'halloween', 'done', ADMIN);
    // c is eligible again, but a three-way tie at 2 still keeps the incumbent
    expect(leaderboard(ctx, GUILD, eventId, 1).championId).toBe('a');
  });

  it('role failures keep standings and retry without new rewards; the final winner is frozen at end', () => {
    const { ctx, eventId } = setup();
    win(ctx, spawn(ctx), 'a');
    expect(getRoleState(ctx, GUILD)).toMatchObject({ desiredId: 'a', pending: true });
    expect(markRoleFailed(ctx, GUILD, 'Missing Permissions')).toBe(true);
    expect(markRoleFailed(ctx, GUILD, 'Missing Permissions')).toBe(false);
    expect(getBalance(ctx, GUILD, 'a')).toBe(5);
    markRoleSynced(ctx, GUILD, 'a');
    expect(getRoleState(ctx, GUILD).pending).toBe(false);

    endEvent(ctx, GUILD, eventId, ADMIN);
    expect(getEvent(ctx, GUILD, eventId)!.finalChampionId).toBe('a');
    expect(getRoleState(ctx, GUILD)).toMatchObject({ desiredId: 'a', pending: false });

    // The next Halloween event starting clears the role.
    ctx.set('2027-10-02T12:00:00Z');
    startFeature(ctx, 'halloween', 'Halloween 2027', { start: '2027-10-01', end: '2027-10-31' });
    expect(getRoleState(ctx, GUILD)).toMatchObject({ desiredId: null, pending: true });
  });

  it('removal policy at event end clears the role', () => {
    const { ctx, eventId } = setup();
    win(ctx, spawn(ctx), 'a');
    markRoleSynced(ctx, GUILD, 'a');
    updateConfig(ctx, GUILD, { championEndPolicy: 'remove' });
    endEvent(ctx, GUILD, eventId, ADMIN);
    expect(getRoleState(ctx, GUILD)).toMatchObject({ desiredId: null, pending: true });
  });
});
