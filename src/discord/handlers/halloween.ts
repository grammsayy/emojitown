import { ButtonStyle, type Guild, type MessageEditOptions } from 'discord.js';
import type { HalloweenItem, HalloweenPack, HalloweenVisitor, Rarity } from '../../content/types.js';
import { audit } from '../../domain/audit.js';
import { getRoleState, refreshAllChampions, resetRoleHolder } from '../../domain/champion.js';
import { addChannel, getChannels, getConfig, getStaffRoles, removeChannel, updateConfig } from '../../domain/config.js';
import { fill, getPack } from '../../domain/content.js';
import { tx } from '../../domain/context.js';
import { UserError } from '../../domain/errors.js';
import { getCurrentEvent, getCurrentOrLatestEvent, windowFor } from '../../domain/events.js';
import {
  cancelEncounter,
  claim,
  collectionSize,
  correctCollection,
  findVisitor,
  getEncounter,
  inventory,
  itemInfo,
  leaderboard,
  markSynced,
  missing,
  packFor,
  previewEncounter,
  uniqueCount,
  visitorsProgress,
  type Encounter,
  type HalloweenAction,
} from '../../domain/halloween.js';
import { storedChampion } from '../../domain/champion.js';
import { isExcluded } from '../../domain/members.js';
import { paginate } from '../../domain/ranking.js';
import { reply, type Button, type ChatInput, type Component, type HandlerSet } from '../interaction.js';
import { assertSafeChampionRole, fetchTextChannel, syncChampionRole, type Bot } from '../runtime.js';
import { button, cid, COLORS, embed, field, mention, pager, rankLabel, row, truncate, when } from '../ui.js';

export const RARITY_LABEL: Record<Rarity, string> = { common: '⚪ Common', uncommon: '🟢 Uncommon', rare: '🟣 Rare' };

function visitorEmbedBase(visitor: HalloweenVisitor) {
  const e = embed(COLORS.halloween, `${visitor.name} is here!`);
  if (visitor.image) e.setThumbnail(visitor.image);
  return e;
}

/** The public visitor message, for both the open and the closed state. */
export function visitorMessage(pack: HalloweenPack, enc: Encounter): MessageEditOptions & { content?: string } {
  const visitor = findVisitor(pack, enc.visitorId);
  const open = enc.status === 'open';
  const request = enc.request === 'trick' ? visitor.trickRequest ?? pack.messages.trickRequest : visitor.treatRequest ?? pack.messages.treatRequest;
  const e = visitorEmbedBase(visitor).setDescription(fill(request, { name: visitor.name }));
  if (open) {
    e.addFields(field('Leaves', when(enc.expiresAt)));
  } else if (enc.status === 'won' && enc.itemId) {
    const item = visitor.items.find((i) => i.id === enc.itemId)!;
    const tpl = enc.duplicate ? pack.messages.duplicate : pack.messages.win;
    e.setTitle(`${visitor.name} got their ${enc.request}!`)
      .setDescription(fill(tpl, { winner: `<@${enc.winnerId}>`, name: visitor.name, item: item.name, rarity: RARITY_LABEL[item.rarity] }))
      .addFields(field('Reward', `${item.name} · ${RARITY_LABEL[item.rarity]}${enc.candyAwarded ? ` · 🍬 ${enc.candyAwarded} candy` : ''}`));
    if (item.image) e.setImage(item.image);
  } else {
    e.setTitle(`${visitor.name} has left`).setDescription(
      fill(enc.status === 'expired' ? pack.messages.expired : pack.messages.cancelled, { name: visitor.name }),
    );
  }
  const trick = enc.request === 'trick';
  return {
    embeds: [e],
    components: [
      row(
        button(cid('hw', 'trick', enc.id), 'Trick', trick || !open ? ButtonStyle.Primary : ButtonStyle.Secondary, '🎭', !open),
        button(cid('hw', 'treat', enc.id), 'Treat', !trick || !open ? ButtonStyle.Primary : ButtonStyle.Secondary, '🍭', !open),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

/** Updates an encounter's public message. Returns false when it could not be edited (retried later). */
export async function syncEncounterMessage(bot: Bot, guild: Guild, enc: Encounter): Promise<boolean> {
  if (!enc.messageId) return true;
  const ev = getCurrentOrLatestEvent(bot.ctx, guild.id, 'halloween');
  const pack = ev && ev.id === enc.eventId ? packFor(bot.ctx, ev) : getPack(bot.ctx, guild.id, 'halloween');
  const channel = await fetchTextChannel(guild, enc.channelId);
  try {
    if (!channel) throw new Error('channel missing');
    const msg = await channel.messages.fetch(enc.messageId);
    await msg.edit(visitorMessage(pack, enc));
    markSynced(bot.ctx, guild.id, enc.id);
    return true;
  } catch (err) {
    // A deleted message or channel can never be repaired; stop retrying.
    if ((err as { code?: number }).code === 10008 || !channel) markSynced(bot.ctx, guild.id, enc.id);
    return false;
  }
}

function itemLine(item: HalloweenItem, count?: number): string {
  return `${RARITY_LABEL[item.rarity]} **${item.name}**${count && count > 1 ? ` ×${count}` : ''}`;
}

async function answer(bot: Bot, i: ChatInput | Component, action: HalloweenAction, target: { encounterId: number } | { channelId: string }) {
  const r = claim(bot.ctx, i.guildId, i.user.id, action, target);
  if (r.kind === 'wrong') {
    await reply(i, `❌ ${r.message}`);
    return;
  }
  const e = embed(
    COLORS.halloween,
    r.duplicate ? 'Already collected!' : 'New item! 🎃',
    `${r.visitor.name} gave you **${r.item.name}** (${RARITY_LABEL[r.item.rarity]}).\n${r.item.description}`,
  );
  if (r.item.image) e.setThumbnail(r.item.image);
  const candyText = r.candy > 0 ? `🍬 +${r.candy} candy${r.capped ? ' (daily Halloween limit reached)' : ''}` : r.capped ? "🍬 You've reached today's Halloween candy limit. Your item still counts!" : '—';
  e.addFields(
    field('Collection', `${uniqueCount(bot.ctx, i.guildId, r.encounter.eventId, i.user.id)} unique items`, true),
    field('Candy', candyText, true),
  );
  if (r.duplicate) e.addFields(field('Duplicate', "Duplicates don't raise your collection score, but they're recorded in your history."));
  await reply(i, { embeds: [e] });

  if (i.isButton() && i.message.id === r.encounter.messageId) {
    const pack = packFor(bot.ctx, getCurrentEvent(bot.ctx, i.guildId, 'halloween')!);
    await i.message
      .edit(visitorMessage(pack, r.encounter))
      .then(() => markSynced(bot.ctx, i.guildId, r.encounter.id))
      .catch(() => undefined);
  } else {
    await syncEncounterMessage(bot, i.guild, r.encounter);
  }
  if (getRoleState(bot.ctx, i.guildId).pending) void syncChampionRole(bot, i.guildId);
}

function inventoryView(bot: Bot, guildId: string, userId: string, eventId: string | null, rarity: Rarity | null, page: number) {
  const inv = inventory(bot.ctx, guildId, userId, eventId, rarity, page);
  const lines = inv.page.items.map((o) => `${itemLine(o.item, o.count)} · from ${o.visitor.name}`);
  const e = embed(
    COLORS.halloween,
    `🎒 Collection: ${inv.unique}/${inv.total}`,
    `<@${userId}> · **${inv.event.name}**${rarity ? ` · showing ${RARITY_LABEL[rarity]}` : ''}\n\n${lines.join('\n') || 'Nothing here yet.'}`,
  ).addFields(
    ...(['common', 'uncommon', 'rare'] as Rarity[]).map((r) => field(RARITY_LABEL[r], `${inv.byRarity[r].owned}/${inv.byRarity[r].total}`, true)),
  );
  if (inv.duplicates) e.addFields(field('Duplicates received', String(inv.duplicates), true));
  const r = rarity ?? 'all';
  const filters = row(
    ...(['all', 'common', 'uncommon', 'rare'] as const).map((f) =>
      button(cid('hw', 'inv', userId, inv.event.id, f, 1), f === 'all' ? 'All' : f[0]!.toUpperCase() + f.slice(1), f === r ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
  return { embeds: [e], components: [...(inv.page.pages > 1 ? [pager(inv.page, (n) => cid('hw', 'inv', userId, inv.event.id, r, n))] : []), filters] };
}

function missingView(bot: Bot, guildId: string, userId: string, eventId: string | null, page: number) {
  const m = missing(bot.ctx, guildId, userId, eventId);
  const p = paginate(m.groups, page, 8);
  const lines = p.items.map((g) => `**${g.visitor.name}**: ${g.items.map((i) => `${i.name} (${i.rarity})`).join(', ')}`);
  const e = embed(
    COLORS.halloween,
    `🔍 Missing: ${m.missingCount} of ${m.total}`,
    `**${m.event.name}**\n\n${lines.join('\n') || 'You have everything! 🏆'}`,
  );
  return { embeds: [e], components: p.pages > 1 ? [pager(p, (n) => cid('hw', 'miss', m.event.id, n))] : [] };
}

function visitorsView(bot: Bot, guildId: string, userId: string, eventId: string | null, page: number) {
  const v = visitorsProgress(bot.ctx, guildId, userId, eventId);
  const p = paginate(v.visitors, page, 20);
  const lines = p.items.map((x) => `${x.owned === x.total ? '✅' : x.owned > 0 ? '🟡' : '⬜'} ${x.visitor.name} · ${x.owned}/${x.total}`);
  const e = embed(COLORS.halloween, `👻 Visitors (${v.visitors.length})`, `**${v.event.name}**\n\n${lines.join('\n')}`);
  return { embeds: [e], components: p.pages > 1 ? [pager(p, (n) => cid('hw', 'vis', v.event.id, n))] : [] };
}

function leaderboardView(bot: Bot, guildId: string, eventId: string | null, page: number) {
  const lb = leaderboard(bot.ctx, guildId, eventId, page);
  const lines = lb.page.items.map((r) => `**${rankLabel(r.rank)}** <@${r.row.userId}> · ${r.row.unique}/${lb.total}${r.row.userId === lb.championId ? ' 👑' : ''}`);
  const e = embed(COLORS.halloween, `🏆 Halloween leaderboard: ${lb.event.name}`, lines.join('\n') || 'No items collected yet.').addFields(
    field(lb.event.state === 'ended' ? 'Final Champion' : 'Champion', mention(lb.championId)),
  );
  return { embeds: [e], components: lb.page.pages > 1 ? [pager(lb.page, (n) => cid('hw', 'lb', lb.event.id, n))] : [] };
}

async function status(bot: Bot, i: ChatInput) {
  const ev = getCurrentOrLatestEvent(bot.ctx, i.guildId, 'halloween');
  if (!ev) throw new UserError("There hasn't been a Trick or Treat event yet. Check `/season status` for upcoming events.");
  const win = windowFor(bot.ctx, ev);
  const pack = packFor(bot.ctx, ev);
  const champion = ev.state === 'ended' ? ev.finalChampionId : storedChampion(bot.ctx, i.guildId, ev.id);
  const cfg = getConfig(bot.ctx, i.guildId);
  const e = embed(COLORS.halloween, `🎃 ${ev.name}`, `Status: **${ev.state}**${ev.pauseReason ? ` (${ev.pauseReason})` : ''}`).addFields(
    field('Dates', `${when(win.startsAt)} → ${when(win.endsAt)}`),
    field('Channels', getChannels(bot.ctx, i.guildId, 'halloween').map((c) => `<#${c}>`).join(', ') || 'None'),
    field('Collection size', `${collectionSize(pack)} items from ${pack.visitors.length} visitors`, true),
    field('Your progress', `${uniqueCount(bot.ctx, i.guildId, ev.id, i.user.id)}/${collectionSize(pack)}`, true),
    field(ev.state === 'ended' ? 'Final Champion' : 'Champion', mention(champion), true),
    field('Candy', `${cfg.candyPerHalloweenWin} per win · daily limit ${cfg.candyHalloweenDailyLimit}`, true),
  );
  if (isExcluded(bot.ctx, i.guildId, i.user.id, 'halloween')) e.addFields(field('Note', "You're currently not eligible to play."));
  await reply(i, { embeds: [e] });
}

async function setup(bot: Bot, i: ChatInput) {
  const o = i.options;
  const cfg = getConfig(bot.ctx, i.guildId);
  const min = o.getInteger('spawn_min_minutes');
  const max = o.getInteger('spawn_max_minutes');
  const minS = min !== null ? min * 60 : cfg.hwSpawnMinS;
  const maxS = max !== null ? max * 60 : cfg.hwSpawnMaxS;
  if (minS > maxS) throw new UserError('The shortest wait must not be longer than the longest wait.');
  const weights = {
    hwWeightCommon: o.getInteger('common_weight') ?? cfg.hwWeightCommon,
    hwWeightUncommon: o.getInteger('uncommon_weight') ?? cfg.hwWeightUncommon,
    hwWeightRare: o.getInteger('rare_weight') ?? cfg.hwWeightRare,
  };
  if (weights.hwWeightCommon + weights.hwWeightUncommon + weights.hwWeightRare <= 0) throw new UserError('Rarity weights must add up to more than zero.');
  const add = o.getChannel('add_channel');
  const remove = o.getChannel('remove_channel');
  tx(bot.ctx, () => {
    const change = updateConfig(bot.ctx, i.guildId, {
      hwSpawnMinS: minS,
      hwSpawnMaxS: maxS,
      hwEncounterS: o.getInteger('visit_seconds') ?? undefined,
      hwActivityWindowS: o.getInteger('activity_minutes') !== null ? o.getInteger('activity_minutes')! * 60 : undefined,
      ...weights,
      candyHalloweenDailyLimit: o.getInteger('daily_candy_limit') ?? undefined,
    });
    if (add) addChannel(bot.ctx, i.guildId, 'halloween', add.id);
    if (remove) removeChannel(bot.ctx, i.guildId, 'halloween', remove.id);
    if (Object.keys(change.after).length || add || remove) {
      audit(bot.ctx, {
        guildId: i.guildId,
        actorId: i.user.id,
        action: 'halloween.setup',
        before: { ...change.before, ...(remove ? { channel: remove.id } : {}) },
        after: { ...change.after, ...(add ? { channel: add.id } : {}) },
      });
    }
  });
  const c = getConfig(bot.ctx, i.guildId);
  const total = c.hwWeightCommon + c.hwWeightUncommon + c.hwWeightRare;
  const pct = (w: number) => `${((w / total) * 100).toFixed(1)}%`;
  await reply(i, {
    embeds: [
      embed(COLORS.staff, '🎃 Trick or Treat setup').addFields(
        field('Spawn interval', `${c.hwSpawnMinS / 60}–${c.hwSpawnMaxS / 60} minutes after the previous visitor leaves`),
        field('Visit length', `${c.hwEncounterS} seconds`, true),
        field('Activity window', `${c.hwActivityWindowS / 60} minutes`, true),
        field('Channels', getChannels(bot.ctx, i.guildId, 'halloween').map((ch) => `<#${ch}>`).join(', ') || 'None'),
        field('Rarity odds', `Common ${pct(c.hwWeightCommon)} · Uncommon ${pct(c.hwWeightUncommon)} · Rare ${pct(c.hwWeightRare)}`),
        field('Candy', `${c.candyPerHalloweenWin} per win · daily limit ${c.candyHalloweenDailyLimit}`),
      ),
    ],
  });
}

async function champion(bot: Bot, i: ChatInput) {
  const role = i.options.getRole('role', true);
  const policy = i.options.getString('end_policy', true) as 'keep' | 'remove';
  const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
  const warnings: string[] = [];
  if (!me.permissions.has('ManageRoles')) warnings.push('The bot is missing the **Manage Roles** permission.');
  // Load the full member list so the "already held by others" check sees every holder.
  await i.guild.members.fetch().catch(() => undefined);
  assertSafeChampionRole(i.guild, role, getStaffRoles(bot.ctx, i.guildId));
  if (role.position >= me.roles.highest.position) warnings.push(`The bot's highest role must sit above ${role}. Move it up in Server Settings → Roles.`);
  const cfg = getConfig(bot.ctx, i.guildId);
  const previousRole = cfg.championRoleId;
  tx(bot.ctx, () => {
    const change = updateConfig(bot.ctx, i.guildId, { championRoleId: role.id, championEndPolicy: policy });
    audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'halloween.champion-role', before: change.before, after: change.after });
    if (previousRole !== role.id) resetRoleHolder(bot.ctx, i.guildId);
  });
  if (previousRole && previousRole !== role.id) {
    const old = i.guild.roles.cache.get(previousRole);
    for (const m of old?.members.values() ?? []) await m.roles.remove(previousRole, 'Champion role changed').catch(() => undefined);
  }
  const sync = await syncChampionRole(bot, i.guildId);
  await reply(i, {
    embeds: [
      embed(
        warnings.length ? COLORS.warn : COLORS.staff,
        '👑 Champion role saved',
        `Role: ${role}\nAt event end: **${policy === 'keep' ? 'keep until the next Halloween event starts' : 'remove'}**` +
          (warnings.length ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : '') +
          (sync.ok ? '' : `\n\nRole sync failed: ${sync.error}`),
      ),
    ],
  });
}

async function preview(bot: Bot, i: ChatInput) {
  const p = previewEncounter(bot.ctx, i.guildId, i.options.getString('visitor'));
  const fake: Encounter = {
    id: 0,
    guildId: i.guildId,
    eventId: 'preview',
    channelId: i.channelId,
    messageId: null,
    visitorId: p.visitor.id,
    request: p.request,
    status: 'open',
    openedAt: bot.ctx.now(),
    expiresAt: bot.ctx.now() + getConfig(bot.ctx, i.guildId).hwEncounterS * 1000,
    closedAt: null,
    closeReason: null,
    winnerId: null,
    itemId: null,
    rarity: null,
    duplicate: false,
    candyAwarded: null,
    messageSynced: true,
  };
  const open = visitorMessage(p.pack, fake);
  const won = visitorMessage(p.pack, { ...fake, status: 'won', winnerId: i.user.id, itemId: p.item.id, rarity: p.item.rarity, candyAwarded: 5 });
  await reply(i, {
    content: '**Preview** (buttons are inactive and nothing is saved). The visitor arrives:',
    embeds: [...(open.embeds ?? []), ...(won.embeds ?? [])] as never,
  });
}

async function cancel(bot: Bot, i: ChatInput) {
  const enc = cancelEncounter(bot.ctx, i.guildId, i.options.getString('reason', true), i.user.id);
  await syncEncounterMessage(bot, i.guild, enc);
  await reply(i, 'The visitor was sent away without rewards.');
}

async function collection(bot: Bot, i: ChatInput) {
  const member = i.options.getUser('member', true);
  const action = i.options.getString('action', true) as 'grant' | 'revoke';
  const r = correctCollection(
    bot.ctx,
    i.guildId,
    i.options.getString('event', true),
    member.id,
    action,
    i.options.getString('item', true),
    i.options.getString('reason', true),
    i.user.id,
  );
  await syncChampionRole(bot, i.guildId);
  await reply(i, `${action === 'grant' ? 'Granted' : 'Revoked'} **${r.item.name}** for ${member}. Champion: ${mention(r.champion.championId)}. No candy was changed.`);
}

async function reconcile(bot: Bot, i: ChatInput) {
  tx(bot.ctx, () => refreshAllChampions(bot.ctx, i.guildId));
  const before = getRoleState(bot.ctx, i.guildId);
  const r = await syncChampionRole(bot, i.guildId);
  const state = getRoleState(bot.ctx, i.guildId);
  await reply(i, {
    embeds: [
      embed(r.ok ? COLORS.staff : COLORS.warn, '👑 Champion reconcile').addFields(
        field('Should hold the role', mention(state.desiredId), true),
        field('Holds the role', mention(state.holderId), true),
        field('Result', r.ok ? (before.pending ? 'Role updated.' : 'Already up to date.') : `Failed: ${r.error}`),
      ),
    ],
  });
}

async function itemCmd(bot: Bot, i: ChatInput) {
  const r = itemInfo(bot.ctx, i.guildId, i.user.id, i.options.getString('item', true), i.options.getString('event'));
  const e = embed(COLORS.halloween, r.item.name, r.item.description).addFields(
    field('Rarity', RARITY_LABEL[r.item.rarity], true),
    field('Visitor', r.visitor.name, true),
    field('You own it', r.owned ? `Yes${r.owned.count > 1 ? ` (received ×${r.owned.count})` : ''}` : 'Not yet', true),
  );
  if (r.item.image) e.setImage(r.item.image);
  else if (r.visitor.image) e.setThumbnail(r.visitor.image);
  await reply(i, { embeds: [e] });
}

export const halloweenHandlers: HandlerSet = {
  chat: {
    trick: (bot, i) => answer(bot, i, 'trick', { channelId: i.channelId }),
    treat: (bot, i) => answer(bot, i, 'treat', { channelId: i.channelId }),
    'halloween inventory': (bot, i) =>
      reply(
        i,
        inventoryView(
          bot,
          i.guildId,
          (i.options.getUser('member') ?? i.user).id,
          i.options.getString('event'),
          i.options.getString('rarity') as Rarity | null,
          1,
        ),
      ),
    'halloween missing': (bot, i) => reply(i, missingView(bot, i.guildId, i.user.id, i.options.getString('event'), 1)),
    'halloween item': itemCmd,
    'halloween visitors': (bot, i) => reply(i, visitorsView(bot, i.guildId, i.user.id, i.options.getString('event'), 1)),
    'halloween leaderboard': (bot, i) => reply(i, leaderboardView(bot, i.guildId, i.options.getString('event'), i.options.getInteger('page') ?? 1)),
    'halloween status': status,
    'admin halloween setup': setup,
    'admin halloween champion': champion,
    'staff halloween preview': preview,
    'staff halloween cancel': cancel,
    'admin halloween collection': collection,
    'staff halloween reconcile': reconcile,
  },
  components: {
    hw: async (bot, i, [action, ...rest]) => {
      if (!i.isButton()) return;
      const b = i as Button;
      if (action === 'trick' || action === 'treat') {
        const enc = getEncounter(bot.ctx, i.guildId, Number(rest[0]));
        if (!enc) throw new UserError('This visitor has already left.');
        return answer(bot, b, action, { encounterId: enc.id });
      }
      if (action === 'inv') {
        const [userId, eventId, rarity, page] = rest;
        return void (await b.update(inventoryView(bot, i.guildId, userId!, eventId!, rarity === 'all' ? null : (rarity as Rarity), Number(page))));
      }
      if (action === 'miss') return void (await b.update(missingView(bot, i.guildId, i.user.id, rest[0]!, Number(rest[1]))));
      if (action === 'vis') return void (await b.update(visitorsView(bot, i.guildId, i.user.id, rest[0]!, Number(rest[1]))));
      if (action === 'lb') return void (await b.update(leaderboardView(bot, i.guildId, rest[0]!, Number(rest[1]))));
    },
  },
};

/** Item names for autocomplete. */
export function itemChoices(bot: Bot, guildId: string, query: string): { name: string; value: string }[] {
  const ev = getCurrentOrLatestEvent(bot.ctx, guildId, 'halloween');
  const pack = ev ? packFor(bot.ctx, ev) : getPack(bot.ctx, guildId, 'halloween');
  const q = query.toLowerCase();
  return pack.visitors
    .flatMap((v) => v.items.map((it) => ({ name: truncate(`${it.name} (${it.rarity}, ${v.name})`, 100), value: it.id })))
    .filter((c) => c.name.toLowerCase().includes(q) || c.value.includes(q))
    .slice(0, 25);
}

export function visitorChoices(bot: Bot, guildId: string, query: string): { name: string; value: string }[] {
  const ev = getCurrentOrLatestEvent(bot.ctx, guildId, 'halloween');
  const pack = ev ? packFor(bot.ctx, ev) : getPack(bot.ctx, guildId, 'halloween');
  const q = query.toLowerCase();
  return pack.visitors
    .filter((v) => v.name.toLowerCase().includes(q) || v.id.includes(q))
    .slice(0, 25)
    .map((v) => ({ name: truncate(v.name, 100), value: v.id }));
}
