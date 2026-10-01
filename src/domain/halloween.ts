import { RARITIES, type HalloweenItem, type HalloweenPack, type HalloweenVisitor, type Rarity } from '../content/types.js';
import { MINUTE } from '../util/time.js';
import { audit } from './audit.js';
import { creditHalloweenWin } from './candy.js';
import { collectorStandings, refreshChampion, storedChampion } from './champion.js';
import { getClasses } from './classes.js';
import { getChannels, getConfig, type GuildConfig } from './config.js';
import { fill, findItem, getPack, searchItem } from './content.js';
import { pick, randomInt, tx, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { getCurrentEvent, requireActiveEvent, requireEvent, resolveViewEvent, type SeasonEvent } from './events.js';
import { assertNotExcluded } from './members.js';
import { paginate, rankRows, type Page, type Ranked } from './ranking.js';

export type HalloweenAction = 'trick' | 'treat';
export type EncounterStatus = 'open' | 'won' | 'expired' | 'cancelled' | 'failed';

export interface Encounter {
  id: number;
  guildId: string;
  eventId: string;
  channelId: string;
  messageId: string | null;
  visitorId: string;
  request: HalloweenAction;
  status: EncounterStatus;
  openedAt: number;
  expiresAt: number;
  closedAt: number | null;
  closeReason: string | null;
  winnerId: string | null;
  itemId: string | null;
  rarity: Rarity | null;
  duplicate: boolean;
  candyAwarded: number | null;
  messageSynced: boolean;
}

function fromRow(r: Record<string, any>): Encounter {
  return {
    id: r.id,
    guildId: r.guild_id,
    eventId: r.event_id,
    channelId: r.channel_id,
    messageId: r.message_id,
    visitorId: r.visitor_id,
    request: r.request,
    status: r.status,
    openedAt: r.opened_at,
    expiresAt: r.expires_at,
    closedAt: r.closed_at,
    closeReason: r.close_reason,
    winnerId: r.winner_id,
    itemId: r.item_id,
    rarity: r.rarity,
    duplicate: !!r.duplicate,
    candyAwarded: r.candy_awarded,
    messageSynced: !!r.message_synced,
  };
}

export function getEncounter(ctx: Ctx, guildId: string, id: number): Encounter | null {
  const r = ctx.db.prepare('SELECT * FROM hw_encounters WHERE guild_id = ? AND id = ?').get(guildId, id);
  return r ? fromRow(r as Record<string, any>) : null;
}

export function getOpenEncounter(ctx: Ctx, guildId: string): Encounter | null {
  const r = ctx.db.prepare("SELECT * FROM hw_encounters WHERE guild_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(guildId);
  return r ? fromRow(r as Record<string, any>) : null;
}

export function packFor(ctx: Ctx, ev: SeasonEvent): HalloweenPack {
  return getPack(ctx, ev.guildId, 'halloween', ev.contentVersion);
}

export function findVisitor(pack: HalloweenPack, visitorId: string): HalloweenVisitor {
  const v = pack.visitors.find((x) => x.id === visitorId);
  if (!v) throw new Error(`visitor ${visitorId} missing from content pack`);
  return v;
}

/** Visitors that can still appear. Retired visitors stay in the pack so collected items keep resolving. */
export function activeVisitors(pack: HalloweenPack): HalloweenVisitor[] {
  return pack.visitors.filter((v) => !v.retired);
}

export function visitorClass(v: HalloweenVisitor): Rarity {
  return v.rarity ?? 'common';
}

export function collectionSize(pack: HalloweenPack): number {
  return activeVisitors(pack).reduce((n, v) => n + v.items.length, 0);
}

function weightedPick<T>(ctx: Ctx, options: [T, number][]): T {
  const usable = options.filter(([, w]) => w > 0);
  if (usable.length <= 1) return (usable[0] ?? options[0]!)[0];
  const total = usable.reduce((n, [, w]) => n + w, 0);
  let roll = ctx.random() * total;
  for (const [value, w] of usable) {
    if (roll < w) return value;
    roll -= w;
  }
  return usable[usable.length - 1]![0];
}

/**
 * Picks the next visitor: first a class by its chance (only classes that have
 * active visitors count), then a visitor of that class with equal odds.
 */
export function pickVisitor(ctx: Ctx, guildId: string, pack: HalloweenPack): HalloweenVisitor {
  const active = activeVisitors(pack);
  const classes = getClasses(ctx, guildId);
  const present = RARITIES.filter((r) => active.some((v) => visitorClass(v) === r));
  const cls = weightedPick(ctx, present.map((r) => [r, classes[r].weight] as [Rarity, number]));
  return pick(ctx, active.filter((v) => visitorClass(v) === cls));
}

/** Picks which of a visitor's items drops. A visitor with one item always gives it. */
export function rollItem(ctx: Ctx, guildId: string, visitor: HalloweenVisitor): HalloweenItem {
  if (visitor.items.length === 1) return visitor.items[0]!;
  const cfg = getConfig(ctx, guildId);
  const weights: Record<Rarity, number> = {
    common: cfg.hwWeightCommon,
    uncommon: cfg.hwWeightUncommon,
    rare: cfg.hwWeightRare,
    legendary: getClasses(ctx, guildId).legendary.weight,
  };
  const present = RARITIES.filter((r) => visitor.items.some((i) => i.rarity === r));
  const rarity = weightedPick(ctx, present.map((r) => [r, weights[r]] as [Rarity, number]));
  return pick(ctx, visitor.items.filter((i) => i.rarity === rarity));
}

function spawnInterval(ctx: Ctx, cfg: GuildConfig): number {
  return randomInt(ctx, cfg.hwSpawnMinS, cfg.hwSpawnMaxS) * 1000;
}

function setNextSpawn(ctx: Ctx, guildId: string, eventId: string, at: number): void {
  ctx.db
    .prepare(
      `INSERT INTO hw_state (guild_id, event_id, next_spawn_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET event_id = excluded.event_id, next_spawn_at = excluded.next_spawn_at`,
    )
    .run(guildId, eventId, at);
}

export function getNextSpawn(ctx: Ctx, guildId: string): { eventId: string | null; nextSpawnAt: number | null } {
  const r = ctx.db.prepare('SELECT event_id, next_spawn_at FROM hw_state WHERE guild_id = ?').get(guildId) as
    | { event_id: string | null; next_spawn_at: number | null }
    | undefined;
  return { eventId: r?.event_id ?? null, nextSpawnAt: r?.next_spawn_at ?? null };
}

/** Schedules the next visitor a random interval from now. Used on start, resume and after each encounter. */
export function scheduleNextSpawn(ctx: Ctx, guildId: string, eventId: string): number {
  const at = ctx.now() + spawnInterval(ctx, getConfig(ctx, guildId));
  setNextSpawn(ctx, guildId, eventId, at);
  return at;
}

/**
 * After the wait settings change, pull the already-booked next visitor forward
 * if the new settings would bring one sooner. Never pushes it later.
 */
export function rescheduleSpawnIfSooner(ctx: Ctx, guildId: string): number | null {
  const ev = getCurrentEvent(ctx, guildId, 'halloween');
  if (!ev || ev.state !== 'active' || getOpenEncounter(ctx, guildId)) return null;
  const state = getNextSpawn(ctx, guildId);
  const candidate = ctx.now() + spawnInterval(ctx, getConfig(ctx, guildId));
  if (state.eventId === ev.id && state.nextSpawnAt !== null && state.nextSpawnAt <= candidate) return null;
  setNextSpawn(ctx, guildId, ev.id, candidate);
  return candidate;
}

export type VisitorStatus =
  | { kind: 'not-live' }
  | { kind: 'visiting'; channelId: string; expiresAt: number }
  | { kind: 'waiting-timer'; at: number; activeChannels: string[] }
  | { kind: 'waiting-chat'; channels: string[]; windowS: number };

/** Why a visitor is or isn't showing up right now, for staff. */
export function visitorStatus(ctx: Ctx, guildId: string): VisitorStatus {
  const ev = getCurrentEvent(ctx, guildId, 'halloween');
  if (!ev || ev.state !== 'active') return { kind: 'not-live' };
  const open = getOpenEncounter(ctx, guildId);
  if (open) return { kind: 'visiting', channelId: open.channelId, expiresAt: open.expiresAt };
  const cfg = getConfig(ctx, guildId);
  const since = ctx.now() - cfg.hwActivityWindowS * 1000;
  const channels = getChannels(ctx, guildId, 'halloween');
  const active = channels.filter((channelId) => {
    const r = ctx.db.prepare('SELECT last_human_at FROM channel_activity WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId) as
      | { last_human_at: number }
      | undefined;
    return r !== undefined && r.last_human_at >= since;
  });
  if (active.length === 0) return { kind: 'waiting-chat', channels, windowS: cfg.hwActivityWindowS };
  const next = getNextSpawn(ctx, guildId);
  const at = next.eventId === ev.id && next.nextSpawnAt !== null && next.nextSpawnAt < Number.MAX_SAFE_INTEGER ? next.nextSpawnAt : ctx.now();
  return { kind: 'waiting-timer', at: Math.max(at, ctx.now()), activeChannels: active };
}

/** Records that a human spoke in a channel. Only timing is stored, never message text. */
export function recordActivity(ctx: Ctx, guildId: string, channelId: string): void {
  ctx.db
    .prepare(
      `INSERT INTO channel_activity (guild_id, channel_id, last_human_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET last_human_at = excluded.last_human_at`,
    )
    .run(guildId, channelId, ctx.now());
}

function closeEncounter(ctx: Ctx, enc: Encounter, status: EncounterStatus, reason: string | null): Encounter {
  ctx.db
    .prepare(
      "UPDATE hw_encounters SET status = ?, closed_at = ?, close_reason = ?, message_synced = CASE WHEN message_id IS NULL THEN 1 ELSE 0 END WHERE id = ? AND status = 'open'",
    )
    .run(status, ctx.now(), reason, enc.id);
  return getEncounter(ctx, enc.guildId, enc.id)!;
}

/** Closes every open encounter without a winner, e.g. on pause, end, or when an event is no longer active. */
export function closeOpenEncounters(ctx: Ctx, guildId: string, status: 'cancelled' | 'expired', reason: string): Encounter[] {
  return tx(ctx, () =>
    (ctx.db.prepare("SELECT * FROM hw_encounters WHERE guild_id = ? AND status = 'open'").all(guildId) as Record<string, any>[])
      .map(fromRow)
      .map((e) => closeEncounter(ctx, e, status, reason)),
  );
}

export interface HalloweenTick {
  closed: Encounter[];
  spawned: Encounter | null;
}

/**
 * Advances the encounter loop: expires stale visitors, then spawns a new one
 * when the interval has passed and an enabled channel had recent human
 * activity. Missed spawns during downtime are skipped, never replayed.
 */
export function tickHalloween(ctx: Ctx, guildId: string): HalloweenTick {
  return tx(ctx, () => {
    const now = ctx.now();
    const ev = getCurrentEvent(ctx, guildId, 'halloween');
    const cfg = getConfig(ctx, guildId);
    const closed: Encounter[] = [];

    for (const r of ctx.db
      .prepare("SELECT * FROM hw_encounters WHERE guild_id = ? AND status = 'open' AND (expires_at <= ? OR event_id IS NOT ?)")
      .all(guildId, now, ev?.state === 'active' ? ev.id : null) as Record<string, any>[]) {
      const enc = fromRow(r);
      closed.push(closeEncounter(ctx, enc, 'expired', enc.expiresAt <= now ? 'expired' : 'event not active'));
    }
    if (!ev || ev.state !== 'active') return { closed, spawned: null };
    if (closed.length > 0) scheduleNextSpawn(ctx, guildId, ev.id);
    if (getOpenEncounter(ctx, guildId)) return { closed, spawned: null };

    const state = getNextSpawn(ctx, guildId);
    if (state.eventId !== ev.id || state.nextSpawnAt === null) {
      scheduleNextSpawn(ctx, guildId, ev.id);
      return { closed, spawned: null };
    }
    if (now < state.nextSpawnAt) return { closed, spawned: null };

    const enabled = getChannels(ctx, guildId, 'halloween');
    const since = now - cfg.hwActivityWindowS * 1000;
    const active = enabled.filter((channelId) => {
      const r = ctx.db
        .prepare('SELECT last_human_at FROM channel_activity WHERE guild_id = ? AND channel_id = ?')
        .get(guildId, channelId) as { last_human_at: number } | undefined;
      return r !== undefined && r.last_human_at >= since;
    });
    if (active.length === 0) {
      // Check again in a minute, or sooner when visitors are configured to come faster than that.
      setNextSpawn(ctx, guildId, ev.id, now + Math.min(MINUTE, cfg.hwSpawnMinS * 1000));
      return { closed, spawned: null };
    }

    const pack = packFor(ctx, ev);
    const channelId = pick(ctx, active);
    const visitor = pickVisitor(ctx, guildId, pack);
    const request: HalloweenAction = ctx.random() < 0.5 ? 'trick' : 'treat';
    const info = ctx.db
      .prepare(
        `INSERT INTO hw_encounters (guild_id, event_id, channel_id, visitor_id, request, status, opened_at, expires_at, message_synced)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0)`,
      )
      .run(guildId, ev.id, channelId, visitor.id, request, now, now + cfg.hwEncounterS * 1000);
    setNextSpawn(ctx, guildId, ev.id, Number.MAX_SAFE_INTEGER);
    return { closed, spawned: getEncounter(ctx, guildId, Number(info.lastInsertRowid)) };
  });
}

export function attachMessage(ctx: Ctx, guildId: string, encounterId: number, messageId: string): void {
  ctx.db
    .prepare('UPDATE hw_encounters SET message_id = ?, message_synced = CASE WHEN status = ? THEN 1 ELSE 0 END WHERE guild_id = ? AND id = ?')
    .run(messageId, 'open', guildId, encounterId);
}

/** The visitor message could not be posted. Closes it without rewards and schedules the next visitor. */
export function abortEncounter(ctx: Ctx, guildId: string, encounterId: number, reason: string): void {
  tx(ctx, () => {
    const enc = getEncounter(ctx, guildId, encounterId);
    if (!enc || enc.status !== 'open') return;
    ctx.db
      .prepare("UPDATE hw_encounters SET status = 'failed', closed_at = ?, close_reason = ?, message_synced = 1 WHERE id = ?")
      .run(ctx.now(), reason, enc.id);
    scheduleNextSpawn(ctx, guildId, enc.eventId);
  });
}

export function markSynced(ctx: Ctx, guildId: string, encounterId: number): void {
  ctx.db.prepare('UPDATE hw_encounters SET message_synced = 1 WHERE guild_id = ? AND id = ?').run(guildId, encounterId);
}

/** Closed encounters whose public message still shows them as open. */
export function unsyncedEncounters(ctx: Ctx, guildId: string): Encounter[] {
  return (
    ctx.db
      .prepare("SELECT * FROM hw_encounters WHERE guild_id = ? AND status != 'open' AND message_synced = 0 AND message_id IS NOT NULL")
      .all(guildId) as Record<string, any>[]
  ).map(fromRow);
}

export type ClaimResult =
  | { kind: 'wrong'; encounter: Encounter; visitor: HalloweenVisitor; message: string }
  | {
      kind: 'win';
      encounter: Encounter;
      visitor: HalloweenVisitor;
      item: HalloweenItem;
      duplicate: boolean;
      candy: number;
      /** The visitor class's extra candy included in `candy` (before any daily cap). */
      bonus: number;
      capped: boolean;
      championChanged: boolean;
      championId: string | null;
    };

/**
 * Answers a visitor. Each member gets one attempt per encounter; the first
 * correct answer wins, enforced by a conditional update so simultaneous
 * answers can never produce two winners.
 */
export function claim(
  ctx: Ctx,
  guildId: string,
  userId: string,
  action: HalloweenAction,
  target: { encounterId: number } | { channelId: string },
): ClaimResult {
  const ev = requireActiveEvent(ctx, guildId, 'halloween');
  const enc =
    'encounterId' in target
      ? getEncounter(ctx, guildId, target.encounterId)
      : (() => {
          const open = getOpenEncounter(ctx, guildId);
          return open && open.channelId === target.channelId ? open : null;
        })();
  if (!enc) {
    throw new UserError('There is no visitor in this channel right now. Keep chatting in the Halloween channels and one will appear!');
  }
  const pack = packFor(ctx, ev);
  const visitor = findVisitor(pack, enc.visitorId);
  const now = ctx.now();
  if (enc.status === 'won') throw new UserError(`${visitor.name} already got what they wanted. Watch for the next visitor!`);
  if (enc.status !== 'open' || now >= enc.expiresAt) throw new UserError(`${visitor.name} has already left. Watch for the next visitor!`);
  if (enc.eventId !== ev.id) throw new UserError(`${visitor.name} has already left. Watch for the next visitor!`);
  assertNotExcluded(ctx, guildId, userId, 'halloween');

  return tx(ctx, () => {
    const prior = ctx.db.prepare('SELECT correct FROM hw_attempts WHERE encounter_id = ? AND user_id = ?').get(enc.id, userId);
    if (prior) throw new UserError(`You've already answered ${visitor.name}. Wait for the next visitor!`);
    const correct = action === enc.request;
    ctx.db
      .prepare('INSERT INTO hw_attempts (encounter_id, user_id, action, correct, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(enc.id, userId, action, correct ? 1 : 0, now);
    if (!correct) {
      return { kind: 'wrong', encounter: enc, visitor, message: fill(pack.messages.wrong, { name: visitor.name }) };
    }

    const won = ctx.db
      .prepare("UPDATE hw_encounters SET status = 'won', winner_id = ?, closed_at = ? WHERE id = ? AND status = 'open' AND expires_at > ?")
      .run(userId, now, enc.id, now);
    if (won.changes === 0) throw new UserError(`Someone else answered ${visitor.name} first. Watch for the next visitor!`);

    const item = rollItem(ctx, guildId, visitor);
    const owned = ctx.db
      .prepare('UPDATE hw_items SET count = count + 1 WHERE guild_id = ? AND event_id = ? AND user_id = ? AND item_id = ?')
      .run(guildId, ev.id, userId, item.id);
    const duplicate = owned.changes > 0;
    if (!duplicate) {
      ctx.db
        .prepare('INSERT INTO hw_items (guild_id, event_id, user_id, item_id, first_at) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, ev.id, userId, item.id, now);
    }
    const bonus = getClasses(ctx, guildId)[visitorClass(visitor)].bonusCandy;
    const candy = creditHalloweenWin(ctx, guildId, userId, ev.id, enc.id, bonus);
    ctx.db
      .prepare('UPDATE hw_encounters SET item_id = ?, rarity = ?, duplicate = ?, candy_awarded = ?, message_synced = 0 WHERE id = ?')
      .run(item.id, item.rarity, duplicate ? 1 : 0, candy.amount, enc.id);
    scheduleNextSpawn(ctx, guildId, ev.id);
    const champion = duplicate ? { championId: storedChampion(ctx, guildId, ev.id), changed: false } : refreshChampion(ctx, ev);
    return {
      kind: 'win',
      encounter: getEncounter(ctx, guildId, enc.id)!,
      visitor,
      item,
      duplicate,
      candy: candy.amount,
      bonus,
      capped: candy.capped,
      championChanged: champion.changed,
      championId: champion.championId,
    };
  });
}

export function cancelEncounter(ctx: Ctx, guildId: string, reason: string, actorId: string): Encounter {
  if (!reason.trim()) throw new UserError('A reason is required.');
  return tx(ctx, () => {
    const enc = getOpenEncounter(ctx, guildId);
    if (!enc) throw new UserError('There is no open visitor right now.');
    const closed = closeEncounter(ctx, enc, 'cancelled', reason);
    scheduleNextSpawn(ctx, guildId, enc.eventId);
    audit(ctx, { guildId, actorId, action: 'halloween.cancel', eventId: enc.eventId, before: { encounter: enc.id, status: 'open' }, after: { status: 'cancelled' }, reason });
    return closed;
  });
}

/** A staff-only sample encounter. Saves nothing. */
export function previewEncounter(ctx: Ctx, guildId: string, visitorQuery?: string | null) {
  const ev = getCurrentEvent(ctx, guildId, 'halloween');
  const pack = ev ? packFor(ctx, ev) : getPack(ctx, guildId, 'halloween');
  let visitor: HalloweenVisitor;
  if (visitorQuery) {
    const q = visitorQuery.trim().toLowerCase();
    const found = pack.visitors.find((v) => v.id === q || v.name.toLowerCase().includes(q));
    if (!found) throw new UserError(`No visitor matches "${visitorQuery}".`);
    visitor = found;
  } else visitor = pickVisitor(ctx, guildId, pack);
  const request: HalloweenAction = ctx.random() < 0.5 ? 'trick' : 'treat';
  const item = rollItem(ctx, guildId, visitor);
  return { pack, visitor, request, item };
}

export interface OwnedItem {
  item: HalloweenItem;
  visitor: HalloweenVisitor;
  count: number;
  firstAt: number;
}

function ownedRows(ctx: Ctx, guildId: string, eventId: string, userId: string) {
  return ctx.db
    .prepare('SELECT item_id, count, first_at FROM hw_items WHERE guild_id = ? AND event_id = ? AND user_id = ?')
    .all(guildId, eventId, userId) as { item_id: string; count: number; first_at: number }[];
}

export function inventory(ctx: Ctx, guildId: string, userId: string, eventId: string | null | undefined, rarity: Rarity | null, page: number) {
  const ev = resolveViewEvent(ctx, guildId, 'halloween', eventId);
  const pack = packFor(ctx, ev);
  const owned: OwnedItem[] = [];
  for (const r of ownedRows(ctx, guildId, ev.id, userId)) {
    const found = findItem(pack, r.item_id);
    if (found) owned.push({ ...found, count: r.count, firstAt: r.first_at });
  }
  const order = (x: OwnedItem) => pack.visitors.indexOf(x.visitor) * 100 + RARITIES.indexOf(x.item.rarity);
  owned.sort((a, b) => order(a) - order(b));
  const filtered = rarity ? owned.filter((o) => o.item.rarity === rarity) : owned;
  const byRarity = Object.fromEntries(
    RARITIES.map((r) => [
      r,
      { owned: owned.filter((o) => o.item.rarity === r).length, total: activeVisitors(pack).flatMap((v) => v.items).filter((i) => i.rarity === r).length },
    ]),
  ) as Record<Rarity, { owned: number; total: number }>;
  return {
    event: ev,
    unique: owned.length,
    total: collectionSize(pack),
    duplicates: owned.reduce((n, o) => n + o.count - 1, 0),
    byRarity,
    page: paginate(filtered, page),
  };
}

export function missing(ctx: Ctx, guildId: string, userId: string, eventId?: string | null) {
  const ev = resolveViewEvent(ctx, guildId, 'halloween', eventId);
  const pack = packFor(ctx, ev);
  const have = new Set(ownedRows(ctx, guildId, ev.id, userId).map((r) => r.item_id));
  const groups = activeVisitors(pack)
    .map((visitor) => ({ visitor, items: visitor.items.filter((i) => !have.has(i.id)) }))
    .filter((g) => g.items.length > 0);
  return { event: ev, groups, missingCount: groups.reduce((n, g) => n + g.items.length, 0), total: collectionSize(pack) };
}

export function itemInfo(ctx: Ctx, guildId: string, userId: string, query: string, eventId?: string | null) {
  const ev = resolveViewEvent(ctx, guildId, 'halloween', eventId);
  const pack = packFor(ctx, ev);
  const found = searchItem(pack, query);
  if (!found) throw new UserError(`No item matches "${query}". Use \`/inventory\` and its Missing items button to browse.`);
  const r = ctx.db
    .prepare('SELECT count, first_at FROM hw_items WHERE guild_id = ? AND event_id = ? AND user_id = ? AND item_id = ?')
    .get(guildId, ev.id, userId, found.item.id) as { count: number; first_at: number } | undefined;
  return { event: ev, ...found, owned: r ? { count: r.count, firstAt: r.first_at } : null };
}

export function visitorsProgress(ctx: Ctx, guildId: string, userId: string, eventId?: string | null) {
  const ev = resolveViewEvent(ctx, guildId, 'halloween', eventId);
  const pack = packFor(ctx, ev);
  const have = new Set(ownedRows(ctx, guildId, ev.id, userId).map((r) => r.item_id));
  return {
    event: ev,
    visitors: activeVisitors(pack).map((visitor) => ({ visitor, owned: visitor.items.filter((i) => have.has(i.id)).length, total: visitor.items.length })),
  };
}

export function leaderboard(ctx: Ctx, guildId: string, eventId: string | null | undefined, page: number) {
  const ev = resolveViewEvent(ctx, guildId, 'halloween', eventId);
  const standings = collectorStandings(ctx, guildId, ev.id);
  const championId = ev.state === 'ended' ? ev.finalChampionId : storedChampion(ctx, guildId, ev.id);
  const ranked = rankRows(standings, (s) => s.unique);
  return { event: ev, championId, total: collectionSize(packFor(ctx, ev)), page: paginate(ranked, page) as Page<Ranked<(typeof standings)[number]>> };
}

export function uniqueCount(ctx: Ctx, guildId: string, eventId: string, userId: string): number {
  return ownedRows(ctx, guildId, eventId, userId).length;
}

/** Staff correction of collection ownership. Recalculates the Champion; never awards candy. */
export function correctCollection(
  ctx: Ctx,
  guildId: string,
  eventId: string,
  userId: string,
  action: 'grant' | 'revoke',
  itemQuery: string,
  reason: string,
  actorId: string,
) {
  if (!reason.trim()) throw new UserError('A reason is required.');
  return tx(ctx, () => {
    const ev = requireEvent(ctx, guildId, eventId, 'halloween');
    const pack = packFor(ctx, ev);
    const found = searchItem(pack, itemQuery);
    if (!found) throw new UserError(`No item matches "${itemQuery}" in \`${ev.id}\`.`);
    const beforeCount = uniqueCount(ctx, guildId, ev.id, userId);
    if (action === 'grant') {
      const info = ctx.db
        .prepare('INSERT OR IGNORE INTO hw_items (guild_id, event_id, user_id, item_id, first_at) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, ev.id, userId, found.item.id, ctx.now());
      if (info.changes === 0) throw new UserError('That member already owns this item.');
    } else {
      const info = ctx.db
        .prepare('DELETE FROM hw_items WHERE guild_id = ? AND event_id = ? AND user_id = ? AND item_id = ?')
        .run(guildId, ev.id, userId, found.item.id);
      if (info.changes === 0) throw new UserError("That member doesn't own this item.");
    }
    const champion = refreshChampion(ctx, ev);
    audit(ctx, {
      guildId,
      actorId,
      action: `halloween.collection.${action}`,
      eventId: ev.id,
      targetId: userId,
      before: { unique: beforeCount, item: found.item.id },
      after: { unique: uniqueCount(ctx, guildId, ev.id, userId), champion: champion.championId },
      reason,
    });
    return { ...found, champion };
  });
}
