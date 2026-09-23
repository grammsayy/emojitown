import type { Ctx } from './context.js';
import { getCurrentEvent, getEvent, type SeasonEvent } from './events.js';
import { eligibleSql } from './members.js';

export interface CollectorStanding {
  userId: string;
  unique: number;
  /** When the member reached their current unique total. Earlier wins ties. */
  reachedAt: number;
}

/** Eligible collectors ranked by unique items, then by who reached the score first. */
export function collectorStandings(ctx: Ctx, guildId: string, eventId: string): CollectorStanding[] {
  return (
    ctx.db
      .prepare(
        `SELECT i.user_id, COUNT(*) unique_count, MAX(i.first_at) reached_at FROM hw_items i
         WHERE i.guild_id = ? AND i.event_id = ? AND ${eligibleSql('i.user_id', 'halloween')}
         GROUP BY i.user_id ORDER BY unique_count DESC, reached_at ASC, user_id ASC`,
      )
      .all(guildId, eventId, guildId, guildId) as { user_id: string; unique_count: number; reached_at: number }[]
  ).map((r) => ({ userId: r.user_id, unique: r.unique_count, reachedAt: r.reached_at }));
}

export function storedChampion(ctx: Ctx, guildId: string, eventId: string): string | null {
  const r = ctx.db.prepare('SELECT champion_id FROM hw_champion WHERE guild_id = ? AND event_id = ?').get(guildId, eventId) as
    | { champion_id: string | null }
    | undefined;
  return r?.champion_id ?? null;
}

/**
 * The leading collector. An eligible incumbent keeps the title during a tie;
 * otherwise the tied member who reached the score first wins.
 */
export function computeChampion(ctx: Ctx, guildId: string, eventId: string, incumbent: string | null): string | null {
  const standings = collectorStandings(ctx, guildId, eventId);
  const top = standings[0];
  if (!top || top.unique === 0) return null;
  const tied = standings.filter((s) => s.unique === top.unique);
  if (incumbent && tied.some((s) => s.userId === incumbent)) return incumbent;
  return top.userId;
}

export interface RoleState {
  holderId: string | null;
  desiredId: string | null;
  pending: boolean;
  lastError: string | null;
  alerted: boolean;
}

export function getRoleState(ctx: Ctx, guildId: string): RoleState {
  ctx.db.prepare('INSERT OR IGNORE INTO champion_role_state (guild_id) VALUES (?)').run(guildId);
  const r = ctx.db.prepare('SELECT * FROM champion_role_state WHERE guild_id = ?').get(guildId) as Record<string, any>;
  return { holderId: r.holder_id, desiredId: r.desired_id, pending: !!r.pending, lastError: r.last_error, alerted: !!r.alerted };
}

/** The member who should hold the Champion role right now, per the current or most recent Halloween event. */
export function desiredRoleHolder(ctx: Ctx, guildId: string): string | null {
  const current = getCurrentEvent(ctx, guildId, 'halloween');
  if (current) return storedChampion(ctx, guildId, current.id);
  const last = ctx.db
    .prepare("SELECT id FROM events WHERE guild_id = ? AND feature = 'halloween' AND state = 'ended' ORDER BY ended_at DESC LIMIT 1")
    .get(guildId) as { id: string } | undefined;
  if (!last) return null;
  const ev = getEvent(ctx, guildId, last.id)!;
  return ev.championKeepRole ? ev.finalChampionId : null;
}

/** Recomputes who should hold the role and flags a pending sync if it differs from the holder. */
export function refreshRoleTarget(ctx: Ctx, guildId: string): RoleState {
  const state = getRoleState(ctx, guildId);
  const desired = desiredRoleHolder(ctx, guildId);
  const pending = desired !== state.holderId || state.pending;
  if (desired !== state.desiredId || pending !== state.pending) {
    ctx.db
      .prepare('UPDATE champion_role_state SET desired_id = ?, pending = ?, alerted = CASE WHEN desired_id IS ? THEN alerted ELSE 0 END WHERE guild_id = ?')
      .run(desired, pending ? 1 : 0, desired, guildId);
  }
  return getRoleState(ctx, guildId);
}

/**
 * Recalculates an event's Champion from standings. For an ended event the
 * frozen final Champion is corrected too. Returns the champion and whether it changed.
 */
export function refreshChampion(ctx: Ctx, ev: SeasonEvent): { championId: string | null; changed: boolean } {
  const before = storedChampion(ctx, ev.guildId, ev.id);
  const incumbent = ev.state === 'ended' ? ev.finalChampionId : before;
  const championId = computeChampion(ctx, ev.guildId, ev.id, incumbent);
  ctx.db
    .prepare(
      `INSERT INTO hw_champion (guild_id, event_id, champion_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, event_id) DO UPDATE SET champion_id = excluded.champion_id, updated_at = excluded.updated_at`,
    )
    .run(ev.guildId, ev.id, championId, ctx.now());
  if (ev.state === 'ended') {
    ctx.db.prepare('UPDATE events SET final_champion_id = ? WHERE guild_id = ? AND id = ?').run(championId, ev.guildId, ev.id);
  }
  refreshRoleTarget(ctx, ev.guildId);
  return { championId, changed: championId !== before };
}

/** Refreshes every Halloween event a member's eligibility change can affect. */
export function refreshAllChampions(ctx: Ctx, guildId: string): void {
  const current = getCurrentEvent(ctx, guildId, 'halloween');
  if (current) refreshChampion(ctx, current);
  else refreshRoleTarget(ctx, guildId);
}

export function markRoleSynced(ctx: Ctx, guildId: string, holderId: string | null): void {
  ctx.db
    .prepare(
      'UPDATE champion_role_state SET holder_id = ?, pending = CASE WHEN desired_id IS ? THEN 0 ELSE 1 END, last_error = NULL, alerted = 0 WHERE guild_id = ?',
    )
    .run(holderId, holderId, guildId);
}

/** Records a failed role change. Returns true the first time, so staff are alerted once per failure. */
export function markRoleFailed(ctx: Ctx, guildId: string, error: string): boolean {
  const state = getRoleState(ctx, guildId);
  ctx.db.prepare('UPDATE champion_role_state SET pending = 1, last_error = ?, alerted = 1 WHERE guild_id = ?').run(error, guildId);
  return !state.alerted;
}

/** After the Champion role changes, nobody is known to hold the new role. */
export function resetRoleHolder(ctx: Ctx, guildId: string): void {
  getRoleState(ctx, guildId);
  ctx.db.prepare('UPDATE champion_role_state SET holder_id = NULL, pending = 1, alerted = 0 WHERE guild_id = ?').run(guildId);
  refreshRoleTarget(ctx, guildId);
}
