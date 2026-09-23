import { openDatabase } from '../src/db/database.js';
import { addChannel, updateConfig } from '../src/domain/config.js';
import type { Ctx } from '../src/domain/context.js';
import { createEvent, scheduleEvent, type Feature } from '../src/domain/events.js';
import { startEvent } from '../src/domain/lifecycle.js';

export const GUILD = 'g1';
export const ADMIN = 'admin';

export interface TestCtx extends Ctx {
  time: number;
  /** Values returned by random() in order; falls back to 0.99 when empty. */
  rolls: number[];
  advance(ms: number): void;
  set(iso: string): void;
}

export function makeCtx(startIso = '2026-12-05T12:00:00Z'): TestCtx {
  const db = openDatabase(':memory:');
  const ctx: TestCtx = {
    db,
    time: Date.parse(startIso),
    rolls: [],
    now() {
      return this.time;
    },
    random() {
      return this.rolls.length ? this.rolls.shift()! : 0.99;
    },
    advance(ms: number) {
      this.time += ms;
    },
    set(iso: string) {
      this.time = Date.parse(iso);
    },
  };
  updateConfig(ctx, GUILD, { timezone: 'Europe/Copenhagen' });
  return ctx;
}

/** Creates and starts an event with default dates and channels configured. */
export function startFeature(ctx: TestCtx, feature: Feature, name: string, dates?: { start: string; end: string; claimDeadline?: string }): string {
  if (feature !== 'advent') {
    try {
      addChannel(ctx, GUILD, feature, `${feature}-channel`);
    } catch {
      // already configured
    }
  }
  const ev = createEvent(ctx, GUILD, feature, name, ADMIN);
  if (dates) scheduleEvent(ctx, GUILD, ev.id, { startDate: dates.start, endDate: dates.end, autoActivate: false, claimDeadline: dates.claimDeadline }, ADMIN);
  if (feature !== 'advent') startEvent(ctx, GUILD, ev.id, ADMIN);
  return ev.id;
}
