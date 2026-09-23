import { describe, expect, it } from 'vitest';
import { listAudit } from '../src/domain/audit.js';
import { adjustCandy, applyCandy, candyLeaderboard, getBalance, history, reconcileBalances, reverseTxn } from '../src/domain/candy.js';
import { consumePending, createPending } from '../src/domain/confirmations.js';
import { importPack } from '../src/domain/content.js';
import { DEFAULT_HALLOWEEN_PACK } from '../src/content/defaultHalloween.js';
import { UserError } from '../src/domain/errors.js';
import { createEvent, getEvent, scheduleEvent } from '../src/domain/events.js';
import { startEvent, tickEvents } from '../src/domain/lifecycle.js';
import { addChannel } from '../src/domain/config.js';
import { ADMIN, GUILD, makeCtx } from './helpers.js';

describe('candy', () => {
  it('never credits the same reward twice and never goes negative', () => {
    const ctx = makeCtx();
    const input = { guildId: GUILD, userId: 'a', amount: 10, source: 'advent' as const, idemKey: 'advent:x:1:a' };
    applyCandy(ctx, input);
    expect(applyCandy(ctx, input).duplicate).toBe(true);
    expect(getBalance(ctx, GUILD, 'a')).toBe(10);
    expect(() => adjustCandy(ctx, { guildId: GUILD, userId: 'a', amount: -11, label: 'fix', reason: 'oops', actorId: ADMIN, nonce: 'n1' })).toThrow(
      /negative/,
    );
    expect(getBalance(ctx, GUILD, 'a')).toBe(10);
  });

  it('reversals apply once and reconcile with history', () => {
    const ctx = makeCtx();
    const txn = adjustCandy(ctx, { guildId: GUILD, userId: 'a', amount: 25, label: 'trivia night', reason: 'winner', actorId: ADMIN, nonce: 'n2' });
    reverseTxn(ctx, GUILD, txn.id, 'wrong member', ADMIN);
    expect(() => reverseTxn(ctx, GUILD, txn.id, 'again', ADMIN)).toThrow(/already reversed/);
    expect(getBalance(ctx, GUILD, 'a')).toBe(0);
    expect(history(ctx, GUILD, 'a', 1).items.map((t) => t.amount)).toEqual([-25, 25]);
    expect(reconcileBalances(ctx, GUILD)).toEqual([]);
    expect(listAudit(ctx, GUILD).map((a) => a.action)).toEqual(['candy.reverse', 'candy.adjust']);
  });

  it('rejects a reversal that would go negative', () => {
    const ctx = makeCtx();
    const txn = adjustCandy(ctx, { guildId: GUILD, userId: 'a', amount: 25, label: 'l', reason: 'r', actorId: ADMIN, nonce: 'n3' });
    adjustCandy(ctx, { guildId: GUILD, userId: 'a', amount: -20, label: 'l', reason: 'r', actorId: ADMIN, nonce: 'n4' });
    expect(() => reverseTxn(ctx, GUILD, txn.id, 'r', ADMIN)).toThrow(/negative/);
  });

  it('ranks all-time balances and per-event net totals', () => {
    const ctx = makeCtx();
    const add = (u: string, n: number, ev: string | null, k: string) =>
      adjustCandy(ctx, { guildId: GUILD, userId: u, amount: n, label: 'l', reason: 'r', actorId: ADMIN, nonce: k, eventId: ev });
    add('a', 30, 'e1', '1');
    add('b', 30, 'e2', '2');
    add('c', 10, 'e1', '3');
    expect(candyLeaderboard(ctx, GUILD, null, 1).items.map((r) => [r.row.userId, r.rank])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 3],
    ]);
    expect(candyLeaderboard(ctx, GUILD, 'e1', 1).items.map((r) => r.row.userId)).toEqual(['a', 'c']);
  });
});

describe('event lifecycle', () => {
  it('rejects overlapping events for the same feature', () => {
    const ctx = makeCtx('2026-09-01T00:00:00Z');
    createEvent(ctx, GUILD, 'halloween', 'Halloween 2026', ADMIN);
    const b = createEvent(ctx, GUILD, 'halloween', 'Halloween 2026', ADMIN);
    expect(b.id).toBe('halloween-2026-2');
    expect(() => scheduleEvent(ctx, GUILD, b.id, { startDate: '2026-10-15', endDate: '2026-11-05', autoActivate: true }, ADMIN)).toThrow(/overlap/);
  });

  it('auto-activates scheduled events and finalizes once after downtime', () => {
    const ctx = makeCtx('2026-09-01T00:00:00Z');
    addChannel(ctx, GUILD, 'snowball', 'c');
    const ev = createEvent(ctx, GUILD, 'snowball', 'Winter 2026', ADMIN);
    scheduleEvent(ctx, GUILD, ev.id, { startDate: '2026-12-01', endDate: '2026-12-31', autoActivate: true }, ADMIN);
    expect(tickEvents(ctx, GUILD)).toEqual([]);
    ctx.set('2026-12-01T00:00:00Z');
    expect(tickEvents(ctx, GUILD).map((t) => t.kind)).toEqual(['started']);
    ctx.set('2027-01-05T00:00:00Z');
    expect(tickEvents(ctx, GUILD).map((t) => t.kind)).toEqual(['ended']);
    expect(tickEvents(ctx, GUILD)).toEqual([]);
    expect(getEvent(ctx, GUILD, ev.id)!.state).toBe('ended');
  });

  it('will not start an event missing its setup', () => {
    const ctx = makeCtx('2026-10-05T00:00:00Z');
    const ev = createEvent(ctx, GUILD, 'halloween', 'Halloween 2026', ADMIN);
    expect(() => startEvent(ctx, GUILD, ev.id, ADMIN)).toThrow(/No halloween channels/);
  });
});

describe('content packs', () => {
  it('rejects imports that drop stable IDs and accepts renames', () => {
    const ctx = makeCtx();
    const dropped = { ...DEFAULT_HALLOWEEN_PACK, visitors: DEFAULT_HALLOWEEN_PACK.visitors.slice(1) };
    expect(importPack(ctx, GUILD, 'halloween', dropped, ADMIN).version).toBeNull();
    const renamed = structuredClone(DEFAULT_HALLOWEEN_PACK);
    renamed.visitors[0]!.name = 'Pumpkin Pete the Great';
    expect(importPack(ctx, GUILD, 'halloween', renamed, ADMIN).version).toBe(1);
  });
});

describe('confirmations', () => {
  it('can only be confirmed once by the requester', () => {
    const ctx = makeCtx();
    const token = createPending(ctx, GUILD, ADMIN, 'test', { x: 1 });
    expect(() => consumePending(ctx, GUILD, 'someone', token)).toThrow(UserError);
    expect(consumePending(ctx, GUILD, ADMIN, token).payload).toEqual({ x: 1 });
    expect(() => consumePending(ctx, GUILD, ADMIN, token)).toThrow(/already been used/);
  });
});
