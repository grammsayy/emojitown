import { MessageFlags, type APIActionRowComponent, type APIComponentInActionRow } from 'discord.js';
import { doorTimes, getDoor, listDoors, type OpenResult } from '../../domain/advent.js';
import { getClasses } from '../../domain/classes.js';
import { getConfig } from '../../domain/config.js';
import { fill, getPack } from '../../domain/content.js';
import { UserError } from '../../domain/errors.js';
import { getCurrentEvent, getCurrentOrLatestEvent, getTargetEvent, SETUP_ACTION, type Feature, type SeasonEvent } from '../../domain/events.js';
import { currencyFor } from '../../domain/currency.js';
import { packFor as halloweenPack, pickVisitor, rollItem, visitorClass, type Encounter } from '../../domain/halloween.js';
import { packFor as snowballPack, WARMUP_MS, COLLECT_COOLDOWN_MS } from '../../domain/snowball.js';
import { findVisitorByQuery } from '../../domain/visitors.js';
import { discordTime } from '../../util/time.js';
import type { ChatInput } from '../interaction.js';
import { reply } from '../interaction.js';
import { resultsEmbed } from '../results.js';
import type { Bot } from '../runtime.js';
import { COLORS, embed } from '../ui.js';
import { announcementMessage, calendarView, openResultMessage, recoveryMessage } from './advent.js';
import { visitorMessage, winnerReply } from './halloween.js';
import { announcementEmbed } from './season.js';
import { collectMessage, throwMessage } from './snowball.js';

interface Payload {
  content?: string | null;
  embeds?: readonly unknown[];
  files?: readonly unknown[];
  components?: readonly unknown[];
}

interface TestCtx {
  bot: Bot;
  i: ChatInput;
  visitor: string | null;
  day: number | null;
}

interface TestMessage {
  id: string;
  label: string;
  build(t: TestCtx): Payload;
}

/** How error replies look to members (mirrors the router). */
const errorStyle = (text: string): Payload => ({ embeds: [embed(COLORS.warn, undefined, text)] });

function eventFor(t: TestCtx, game: Feature): SeasonEvent {
  const ev = getTargetEvent(t.bot.ctx, t.i.guildId, game) ?? getCurrentOrLatestEvent(t.bot.ctx, t.i.guildId, game);
  if (!ev) throw new UserError(`There is no ${game} season yet, so this message has nothing to show. Run \`/season\` → **${SETUP_ACTION[game]}** first.`);
  return ev;
}

// ── Halloween ────────────────────────────────────────────────────────

function hwSetup(t: TestCtx) {
  const ev = getCurrentEvent(t.bot.ctx, t.i.guildId, 'halloween');
  const pack = ev ? halloweenPack(t.bot.ctx, ev) : getPack(t.bot.ctx, t.i.guildId, 'halloween');
  const visitor = t.visitor ? findVisitorByQuery(pack, t.visitor) : pickVisitor(t.bot.ctx, t.i.guildId, pack);
  const item = rollItem(t.bot.ctx, t.i.guildId, visitor);
  const bonus = getClasses(t.bot.ctx, t.i.guildId)[visitorClass(visitor)].bonusCandy;
  const cfg = getConfig(t.bot.ctx, t.i.guildId);
  const now = t.bot.ctx.now();
  const enc = (patch: Partial<Encounter>): Encounter => ({
    id: 0,
    guildId: t.i.guildId,
    eventId: 'test',
    channelId: t.i.channelId,
    messageId: null,
    visitorId: visitor.id,
    request: 'treat',
    status: 'open',
    openedAt: now,
    expiresAt: now + cfg.hwEncounterS * 1000,
    closedAt: null,
    closeReason: null,
    winnerId: null,
    itemId: null,
    rarity: null,
    duplicate: false,
    candyAwarded: null,
    messageSynced: true,
    ...patch,
  });
  const won = (duplicate: boolean) =>
    enc({ status: 'won', winnerId: t.i.user.id, itemId: item.id, rarity: item.rarity, duplicate, candyAwarded: cfg.candyPerHalloweenWin + bonus });
  return { pack, visitor, item, bonus, cfg, enc, won };
}

const hwMessage = (fn: (h: ReturnType<typeof hwSetup>, t: TestCtx) => Payload) => (t: TestCtx) => fn(hwSetup(t), t);

const HALLOWEEN: TestMessage[] = [
  { id: 'visitor-trick', label: 'Visitor arrives (wants a Trick)', build: hwMessage((h, t) => visitorMessage(t.bot, t.i.guildId, h.pack, h.enc({ request: 'trick' }))) },
  { id: 'visitor-treat', label: 'Visitor arrives (wants a Treat)', build: hwMessage((h, t) => visitorMessage(t.bot, t.i.guildId, h.pack, h.enc({ request: 'treat' }))) },
  { id: 'win', label: 'Win card (new item)', build: hwMessage((h, t) => visitorMessage(t.bot, t.i.guildId, h.pack, h.won(false))) },
  { id: 'win-duplicate', label: 'Win card (already collected)', build: hwMessage((h, t) => visitorMessage(t.bot, t.i.guildId, h.pack, h.won(true))) },
  {
    id: 'winner-reply',
    label: 'Private reply to the winner',
    build: hwMessage((h, t) =>
      winnerReply(t.bot, t.i.guildId, { visitor: h.visitor, item: h.item, duplicate: false, candy: h.cfg.candyPerHalloweenWin + h.bonus, bonus: h.bonus, capped: false, unique: 12 }),
    ),
  },
  {
    id: 'winner-reply-capped',
    label: 'Private reply to the winner (daily candy limit reached)',
    build: hwMessage((h, t) => winnerReply(t.bot, t.i.guildId, { visitor: h.visitor, item: h.item, duplicate: false, candy: 0, bonus: h.bonus, capped: true, unique: 12 })),
  },
  { id: 'wrong', label: 'Wrong answer (private)', build: hwMessage((h) => ({ content: `❌ ${fill(h.pack.messages.wrong, { name: h.visitor.name })}` })) },
  {
    id: 'already-answered',
    label: 'Second try on the same visitor (private)',
    build: hwMessage((h) => errorStyle(`You've already answered ${h.visitor.name}. Wait for the next visitor!`)),
  },
  { id: 'too-late', label: 'Someone else won first (private)', build: hwMessage((h) => errorStyle(`${h.visitor.name} already got what they wanted. Watch for the next visitor!`)) },
  { id: 'expired', label: 'Visitor left (nobody answered)', build: hwMessage((h, t) => visitorMessage(t.bot, t.i.guildId, h.pack, h.enc({ status: 'expired' }))) },
  { id: 'cancelled', label: 'Visitor sent away by staff', build: hwMessage((h, t) => visitorMessage(t.bot, t.i.guildId, h.pack, h.enc({ status: 'cancelled' }))) },
  { id: 'results', label: 'End-of-event results (current numbers)', build: (t) => ({ embeds: [resultsEmbed(t.bot, eventFor(t, 'halloween'))] }) },
  { id: 'announcement', label: 'How-to-play announcement', build: (t) => ({ embeds: [announcementEmbed(t.bot, eventFor(t, 'halloween'))] }) },
];

// ── Snowball Fights ──────────────────────────────────────────────────

function sbPack(t: TestCtx) {
  const ev = getCurrentOrLatestEvent(t.bot.ctx, t.i.guildId, 'snowball');
  return ev ? snowballPack(t.bot.ctx, ev) : getPack(t.bot.ctx, t.i.guildId, 'snowball');
}

const throwVars = (t: TestCtx) => ({ thrower: `${t.i.user}`, target: `${t.i.client.user}` });

const SNOWBALL: TestMessage[] = [
  {
    id: 'collect',
    label: 'Collected a snowball (private)',
    build: (t) => {
      const p = sbPack(t);
      return collectMessage(p, fill(p.collect, { count: 3, s: 's' }), 3, t.bot.ctx.now() + COLLECT_COOLDOWN_MS);
    },
  },
  {
    id: 'hit',
    label: 'Throw: direct hit (public)',
    build: (t) => {
      const p = sbPack(t);
      return throwMessage(true, fill(p.hit[0]!, throwVars(t)), p.images.hit, t.i.user.displayName, 2, `${t.i.client.user}`, t.bot.ctx.now() + WARMUP_MS);
    },
  },
  {
    id: 'miss',
    label: 'Throw: miss (public)',
    build: (t) => {
      const p = sbPack(t);
      return throwMessage(false, fill(p.miss[0]!, throwVars(t)), p.images.miss, t.i.user.displayName, 2, `${t.i.client.user}`, 0);
    },
  },
  { id: 'cooldown', label: 'Collecting too soon (private)', build: (t) => errorStyle(fill(sbPack(t).cooldown, { when: discordTime(t.bot.ctx.now() + 20_000, 'R') })) },
  { id: 'warmup', label: 'Collecting while warming up after a hit (private)', build: (t) => errorStyle(fill(sbPack(t).warmup, { when: discordTime(t.bot.ctx.now() + WARMUP_MS, 'R') })) },
  { id: 'no-snowballs', label: 'Throwing with no snowballs (private)', build: (t) => errorStyle(sbPack(t).noSnowballs) },
  { id: 'results', label: 'End-of-event results (current numbers)', build: (t) => ({ embeds: [resultsEmbed(t.bot, eventFor(t, 'snowball'))] }) },
  { id: 'announcement', label: 'How-to-play announcement', build: (t) => ({ embeds: [announcementEmbed(t.bot, eventFor(t, 'snowball'))] }) },
];

// ── Advent Calendar ──────────────────────────────────────────────────

function adventDoor(t: TestCtx) {
  const ev = eventFor(t, 'advent');
  const doors = listDoors(t.bot.ctx, t.i.guildId, ev.id);
  const day = t.day ?? doors[0]?.day;
  const door = day ? getDoor(t.bot.ctx, t.i.guildId, ev.id, day) : null;
  if (!door) throw new UserError(day ? `Door ${day} is empty. Write it with \`/season\` → **Write an Advent door**.` : 'No doors are written yet. Start with `/season` → **Write an Advent door**.');
  const cfg = getConfig(t.bot.ctx, t.i.guildId);
  return { ev, door, doors, cfg, times: doorTimes(ev, cfg, door.day) };
}

const opened = (outcome: OpenResult['outcome']) => (t: TestCtx) => {
  const a = adventDoor(t);
  return openResultMessage({ event: a.ev, door: a.door, times: a.times, outcome, candy: outcome === 'expired' || outcome === 'ineligible' ? 0 : a.door.candy, policy: a.cfg.adventPolicy }, currencyFor(t.bot.ctx, t.i.guildId, 'advent'));
};

const ADVENT: TestMessage[] = [
  {
    id: 'door-post',
    label: 'Daily door announcement (public)',
    build: (t) => {
      const a = adventDoor(t);
      return announcementMessage(a.ev, a.door, a.times.claimEndsAt, a.cfg.adventPolicy, currencyFor(t.bot.ctx, t.i.guildId, 'advent'));
    },
  },
  {
    id: 'recovery-post',
    label: 'Catch-up post after downtime (public)',
    build: (t) => {
      const a = adventDoor(t);
      return recoveryMessage(a.ev, a.doors.slice(0, 3));
    },
  },
  { id: 'door-claimed', label: 'Opening a door (with candy)', build: opened('claimed') },
  { id: 'door-already', label: 'Opening a door again', build: opened('already-claimed') },
  { id: 'door-expired', label: 'Opening a missed door after its deadline', build: opened('expired') },
  { id: 'calendar', label: 'Calendar (your own progress)', build: (t) => calendarView(t.bot, t.i.guildId, t.i.user.id, eventFor(t, 'advent').id) },
  { id: 'results', label: 'End-of-event results (current numbers)', build: (t) => ({ embeds: [resultsEmbed(t.bot, eventFor(t, 'advent'))] }) },
  { id: 'announcement', label: 'How-to-play announcement', build: (t) => ({ embeds: [announcementEmbed(t.bot, eventFor(t, 'advent'))] }) },
];

export const TEST_MESSAGES: Record<Feature, TestMessage[]> = { halloween: HALLOWEEN, snowball: SNOWBALL, advent: ADVENT };
export const ALL_MESSAGES = 'all';

/** Buttons and menus in a test are shown but switched off, so nothing can be clicked by accident. */
function disabled(components: readonly unknown[] | undefined): APIActionRowComponent<APIComponentInActionRow>[] {
  return (components ?? []).map((r) => {
    const rowJson = (typeof (r as { toJSON?: () => unknown }).toJSON === 'function' ? (r as { toJSON: () => unknown }).toJSON() : r) as APIActionRowComponent<APIComponentInActionRow>;
    return { ...rowJson, components: rowJson.components.map((c) => ({ ...c, disabled: true })) } as APIActionRowComponent<APIComponentInActionRow>;
  });
}

/** `/season` → Preview messages: shows any member-facing message with real content. Nothing is saved. */
export async function messageTest(bot: Bot, i: ChatInput) {
  const game = i.options.getString('game', true) as Feature;
  const which = i.options.getString('message', true);
  const isPublic = i.options.getBoolean('public') ?? false;
  const list = TEST_MESSAGES[game];
  const chosen = which === ALL_MESSAGES ? list : list.filter((m) => m.id === which);
  if (chosen.length === 0) throw new UserError(`"${which}" isn't a ${game} message. Pick one from the list.`);
  const t: TestCtx = { bot, i, visitor: i.options.getString('visitor'), day: i.options.getInteger('day') };

  let first = true;
  for (const [n, m] of chosen.entries()) {
    let payload: Payload;
    try {
      payload = m.build(t);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      payload = { content: `⚠️ ${err.message}` };
    }
    const header = `🧪 **Test${chosen.length > 1 ? ` ${n + 1}/${chosen.length}` : ''}: ${m.label}**. Nothing is saved; buttons are disabled.`;
    const message = {
      ...payload,
      content: [header, payload.content].filter(Boolean).join('\n'),
      components: disabled(payload.components),
      allowedMentions: { parse: [] as [] },
    };
    if (first && !isPublic) await reply(i, message as never);
    else if (first) await (i.replied || i.deferred ? i.followUp(message as never) : i.reply(message as never));
    else await i.followUp({ ...message, ...(isPublic ? {} : { flags: MessageFlags.Ephemeral }) } as never);
    first = false;
  }
}
