import { CLASS_LABEL, DUPLICATE_NOTE, getClasses } from '../../domain/classes.js';
import { resolveImage } from '../images.js';
import { discordTime, formatSeconds } from '../../util/time.js';
import { ButtonStyle, type AttachmentBuilder, type Guild, type MessageEditOptions, type Role, type User } from 'discord.js';
import { RARITIES, type HalloweenItem, type HalloweenPack, type HalloweenVisitor, type Rarity } from '../../content/types.js';
import { audit } from '../../domain/audit.js';
import { getRoleState, refreshAllChampions, resetRoleHolder } from '../../domain/champion.js';
import { getConfig, getStaffRoles, updateConfig } from '../../domain/config.js';
import { fill, getPack } from '../../domain/content.js';
import { tx } from '../../domain/context.js';
import { UserError } from '../../domain/errors.js';
import { getCurrentEvent, getCurrentOrLatestEvent } from '../../domain/events.js';
import {
  cancelEncounter,
  claim,
  correctCollection,
  findVisitor,
  getEncounter,
  inventory,
  leaderboard,
  markSynced,
  missing,
  packFor,
  previewEncounter,
  uniqueCount,
  visitorsProgress,
  visitorClass,
  visitorStatus,
  type Encounter,
  type HalloweenAction,
} from '../../domain/halloween.js';
import { paginate } from '../../domain/ranking.js';
import { reply, type Button, type ChatInput, type Component, type HandlerSet } from '../interaction.js';
import { assertSafeChampionRole, fetchTextChannel, syncChampionRole, type Bot } from '../runtime.js';
import { button, cid, COLORS, embed, field, mention, pager, rankLabel, row, truncate, when } from '../ui.js';

export const RARITY_LABEL: Record<Rarity, string> = CLASS_LABEL;
const RARITY_COLOR: Record<Rarity, number> = { common: 0x9e9e9e, uncommon: 0x4caf50, rare: 0x9c27b0, legendary: 0xffc107 };

/** The public visitor message, for both the open and the closed state. Stored pictures are attached as files. */
export function visitorMessage(bot: Bot, guildId: string, pack: HalloweenPack, enc: Encounter): MessageEditOptions & { files: AttachmentBuilder[] } {
  const visitor = findVisitor(pack, enc.visitorId);
  const open = enc.status === 'open';
  const files = new Map<string, AttachmentBuilder>();
  const show = (ref: string | undefined) => {
    const img = resolveImage(bot, guildId, ref);
    if (img?.file) files.set(img.url, img.file);
    return img?.url;
  };
  const cls = visitorClass(visitor);
  const request = enc.request === 'trick' ? (visitor.trickRequest ?? pack.messages.trickRequest) : (visitor.treatRequest ?? pack.messages.treatRequest);
  const e = embed(COLORS.halloween, `${visitor.name} is here!`, [visitor.greeting, fill(request, { name: visitor.name })].filter(Boolean).join('\n\n'));
  const thumb = show(visitor.image);
  if (thumb) e.setThumbnail(thumb);
  e.setAuthor({ name: `${RARITY_LABEL[cls]} visitor` });
  if (open) {
    e.addFields(field('Leaves', when(enc.expiresAt)));
  } else if (enc.status === 'won' && enc.itemId) {
    // Win card: custom text up top, the item's picture large, the rarity line below.
    const item = visitor.items.find((i) => i.id === enc.itemId)!;
    const cls = getClasses(bot.ctx, guildId)[item.rarity];
    const tpl = visitor.winText ?? (enc.duplicate ? pack.messages.duplicate : pack.messages.win);
    const vars = { winner: `<@${enc.winnerId}>`, name: visitor.name, item: item.name, rarity: RARITY_LABEL[item.rarity], request: enc.request };
    e.setTitle(pack.messages.winTitle ?? 'Happy Halloween!')
      .setDescription(fill(tpl, vars))
      .setColor(RARITY_COLOR[item.rarity])
      .setAuthor({ name: `${visitor.name} · ${RARITY_LABEL[visitorClass(visitor)]} visitor` })
      .setThumbnail(null);
    const big = show(item.image ?? visitor.image);
    if (big) e.setImage(big);
    const candy = enc.candyAwarded ? `\n🍬 +${enc.candyAwarded} candy` : '';
    e.setFooter({ text: `${enc.duplicate ? DUPLICATE_NOTE : cls.description}${candy}` });
  } else {
    e.setTitle(`${visitor.name} has left`).setDescription(
      fill(enc.status === 'expired' ? pack.messages.expired : pack.messages.cancelled, { name: visitor.name }),
    );
  }
  const trick = enc.request === 'trick';
  return {
    embeds: [e],
    files: [...files.values()],
    components: [
      row(
        button(cid('hw', 'trick', enc.id), 'Trick', trick || !open ? ButtonStyle.Primary : ButtonStyle.Secondary, '🎭', !open),
        button(cid('hw', 'treat', enc.id), 'Treat', !trick || !open ? ButtonStyle.Primary : ButtonStyle.Secondary, '🍭', !open),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

/** Message edits replace the attachments, so the pictures are sent again with each update. */
function asEdit(m: ReturnType<typeof visitorMessage>): MessageEditOptions {
  return { ...m, attachments: [] };
}

/** Deletes a finished visitor message after the server's `delete_after` delay (0 keeps it). */
export function scheduleCleanup(bot: Bot, guildId: string, enc: Encounter, msg: { delete(): Promise<unknown> }): void {
  if (enc.status === 'open') return;
  const seconds = getConfig(bot.ctx, guildId).hwCleanupS;
  if (seconds <= 0) return;
  setTimeout(() => void msg.delete().catch(() => undefined), seconds * 1000).unref?.();
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
    await msg.edit(asEdit(visitorMessage(bot, guild.id, pack, enc)));
    markSynced(bot.ctx, guild.id, enc.id);
    scheduleCleanup(bot, guild.id, enc, msg);
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
  await reply(
    i,
    winnerReply(bot, i.guildId, { ...r, unique: uniqueCount(bot.ctx, i.guildId, r.encounter.eventId, i.user.id) }),
  );

  if (i.isButton() && i.message.id === r.encounter.messageId) {
    const pack = packFor(bot.ctx, getCurrentEvent(bot.ctx, i.guildId, 'halloween')!);
    const msg = i.message;
    await msg
      .edit(asEdit(visitorMessage(bot, i.guildId, pack, r.encounter)))
      .then(() => {
        markSynced(bot.ctx, i.guildId, r.encounter.id);
        scheduleCleanup(bot, i.guildId, r.encounter, msg);
      })
      .catch(() => undefined);
  } else {
    await syncEncounterMessage(bot, i.guild, r.encounter);
  }
  if (getRoleState(bot.ctx, i.guildId).pending) void syncChampionRole(bot, i.guildId);
}

/** The private reply a winner gets. */
export function winnerReply(
  bot: Bot,
  guildId: string,
  r: { visitor: HalloweenVisitor; item: HalloweenItem; duplicate: boolean; candy: number; bonus: number; capped: boolean; unique: number },
) {
  const e = embed(
    COLORS.halloween,
    r.duplicate ? 'Already collected!' : 'New item! 🎃',
    `${r.visitor.name} gave you **${r.item.name}** (${RARITY_LABEL[r.item.rarity]}).\n${r.item.description}`,
  );
  const itemImg = resolveImage(bot, guildId, r.item.image);
  if (itemImg) e.setThumbnail(itemImg.url);
  const bonusText = r.bonus > 0 ? ` (includes +${r.bonus} ${RARITY_LABEL[visitorClass(r.visitor)]} bonus)` : '';
  const candyText =
    r.candy > 0
      ? `🍬 +${r.candy} candy${bonusText}${r.capped ? ' (daily Halloween limit reached)' : ''}`
      : r.capped
        ? "🍬 You've reached today's Halloween candy limit. Your item still counts!"
        : '—';
  e.addFields(field('Collection', `${r.unique} unique items`, true), field('Candy', candyText, true));
  if (r.duplicate) e.addFields(field('Duplicate', "Duplicates don't raise your collection score, but they're recorded in your history."));
  return { embeds: [e], files: itemImg?.file ? [itemImg.file] : [] };
}

function inventoryView(bot: Bot, guildId: string, userId: string, eventId: string | null, rarity: Rarity | null, page: number) {
  const inv = inventory(bot.ctx, guildId, userId, eventId, rarity, page);
  const lines = inv.page.items.map((o) => `${itemLine(o.item, o.count)} · from ${o.visitor.name}`);
  const e = embed(
    COLORS.halloween,
    `🎒 Collection: ${inv.unique}/${inv.total}`,
    `<@${userId}> · **${inv.event.name}**${rarity ? ` · showing ${RARITY_LABEL[rarity]}` : ''}\n\n${lines.join('\n') || 'Nothing here yet.'}`,
  ).addFields(
    ...RARITIES.filter((r) => inv.byRarity[r].total > 0 || inv.byRarity[r].owned > 0).map((r) =>
      field(RARITY_LABEL[r], `${inv.byRarity[r].owned}/${inv.byRarity[r].total}`, true),
    ),
  );
  if (inv.duplicates) e.addFields(field('Duplicates received', String(inv.duplicates), true));
  const r = rarity ?? 'all';
  const filters = row(
    ...(['all', ...RARITIES] as const).map((f) =>
      button(cid('hw', 'inv', userId, inv.event.id, f, 1), f === 'all' ? 'All' : f[0]!.toUpperCase() + f.slice(1), f === r ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
  const nav = row(
    button(cid('hw', 'miss', userId, inv.event.id, 1), 'Missing items', ButtonStyle.Secondary, '🔍'),
    button(cid('hw', 'vis', userId, inv.event.id, 1), 'Visitors', ButtonStyle.Secondary, '👻'),
  );
  return { embeds: [e], components: [...(inv.page.pages > 1 ? [pager(inv.page, (n) => cid('hw', 'inv', userId, inv.event.id, r, n))] : []), filters, nav] };
}

const backButton = (userId: string, eventId: string) => row(button(cid('hw', 'inv', userId, eventId, 'all', 1), 'Back to collection', ButtonStyle.Secondary, '🎒'));

function missingView(bot: Bot, guildId: string, userId: string, eventId: string | null, page: number) {
  const m = missing(bot.ctx, guildId, userId, eventId);
  const p = paginate(m.groups, page, 8);
  const lines = p.items.map((g) => `**${g.visitor.name}**: ${g.items.map((i) => `${i.name} (${i.rarity})`).join(', ')}`);
  const e = embed(
    COLORS.halloween,
    `🔍 Missing: ${m.missingCount} of ${m.total}`,
    `<@${userId}> · **${m.event.name}**\n\n${lines.join('\n') || 'Everything collected! 🏆'}`,
  );
  return { embeds: [e], components: [...(p.pages > 1 ? [pager(p, (n) => cid('hw', 'miss', userId, m.event.id, n))] : []), backButton(userId, m.event.id)] };
}

function visitorsView(bot: Bot, guildId: string, userId: string, eventId: string | null, page: number) {
  const v = visitorsProgress(bot.ctx, guildId, userId, eventId);
  const p = paginate(v.visitors, page, 20);
  const lines = p.items.map((x) => `${x.owned === x.total ? '✅' : x.owned > 0 ? '🟡' : '⬜'} ${x.visitor.name} · ${x.owned}/${x.total}`);
  const e = embed(COLORS.halloween, `👻 Visitors (${v.visitors.length})`, `<@${userId}> · **${v.event.name}**\n\n${lines.join('\n')}`);
  return { embeds: [e], components: [...(p.pages > 1 ? [pager(p, (n) => cid('hw', 'vis', userId, v.event.id, n))] : []), backButton(userId, v.event.id)] };
}

export function leaderboardView(bot: Bot, guildId: string, eventId: string | null, page: number) {
  const lb = leaderboard(bot.ctx, guildId, eventId, page);
  const lines = lb.page.items.map((r) => `**${rankLabel(r.rank)}** <@${r.row.userId}> · ${r.row.unique}/${lb.total}${r.row.userId === lb.championId ? ' 👑' : ''}`);
  const e = embed(COLORS.halloween, `🏆 Halloween leaderboard: ${lb.event.name}`, lines.join('\n') || 'No items collected yet.').addFields(
    field(lb.event.state === 'ended' ? 'Final Champion' : 'Champion', mention(lb.championId)),
  );
  return { embeds: [e], components: lb.page.pages > 1 ? [pager(lb.page, (n) => cid('hw', 'lb', lb.event.id, n))] : [] };
}

/** Points the Champion role at `role`. Returns lines describing what changed, plus warnings. */
export async function setChampionRole(bot: Bot, i: ChatInput, role: Role): Promise<{ changes: string[]; warnings: string[] }> {
  const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
  const warnings: string[] = [];
  // Load the full member list so the "already held by others" check sees every holder.
  await i.guild.members.fetch().catch(() => undefined);
  assertSafeChampionRole(i.guild, role, getStaffRoles(bot.ctx, i.guildId));
  if (!me.permissions.has('ManageRoles')) warnings.push('The bot is missing the **Manage Roles** permission, so it cannot hand out the Champion role.');
  if (role.position >= me.roles.highest.position) warnings.push(`Drag the bot's role above ${role} in Server Settings → Roles, or it cannot hand it out.`);
  const previousRole = getConfig(bot.ctx, i.guildId).championRoleId;
  if (previousRole === role.id) return { changes: [], warnings };
  tx(bot.ctx, () => {
    const change = updateConfig(bot.ctx, i.guildId, { championRoleId: role.id });
    audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'halloween.champion-role', before: change.before, after: change.after });
    resetRoleHolder(bot.ctx, i.guildId);
  });
  if (previousRole) {
    const old = i.guild.roles.cache.get(previousRole);
    for (const m of old?.members.values() ?? []) await m.roles.remove(previousRole, 'Champion role changed').catch(() => undefined);
  }
  const sync = await syncChampionRole(bot, i.guildId);
  if (!sync.ok) warnings.push(`Could not update the role yet: ${sync.error}`);
  return { changes: [`**Champion role:** ${previousRole ? `<@&${previousRole}>` : 'none'} → ${role}`], warnings };
}

/** A staff-only sample encounter. Nothing is saved. */
export function halloweenPreview(bot: Bot, guildId: string, channelId: string, userId: string, visitorQuery: string | null) {
  const p = previewEncounter(bot.ctx, guildId, visitorQuery);
  const fake: Encounter = {
    id: 0,
    guildId,
    eventId: 'preview',
    channelId,
    messageId: null,
    visitorId: p.visitor.id,
    request: p.request,
    status: 'open',
    openedAt: bot.ctx.now(),
    expiresAt: bot.ctx.now() + getConfig(bot.ctx, guildId).hwEncounterS * 1000,
    closedAt: null,
    closeReason: null,
    winnerId: null,
    itemId: null,
    rarity: null,
    duplicate: false,
    candyAwarded: null,
    messageSynced: true,
  };
  const open = visitorMessage(bot, guildId, p.pack, fake);
  const bonus = getClasses(bot.ctx, guildId)[visitorClass(p.visitor)].bonusCandy;
  const won = visitorMessage(bot, guildId, p.pack, {
    ...fake,
    status: 'won',
    winnerId: userId,
    itemId: p.item.id,
    rarity: p.item.rarity,
    candyAwarded: getConfig(bot.ctx, guildId).candyPerHalloweenWin + bonus,
  });
  const files = new Map([...open.files, ...won.files].map((f) => [f.name, f]));
  return {
    content: '**Preview** (nothing is saved). First the visitor arrives, then it shows the winner:',
    embeds: [...(open.embeds ?? []), ...(won.embeds ?? [])] as never,
    files: [...files.values()],
  };
}

export async function cancelVisitor(bot: Bot, i: ChatInput, reason: string): Promise<string> {
  const enc = cancelEncounter(bot.ctx, i.guildId, reason, i.user.id);
  await syncEncounterMessage(bot, i.guild, enc);
  return `**Visitor:** in <#${enc.channelId}> → sent away. Nobody got a reward, and the next visitor comes after the normal wait.`;
}

export async function fixItem(bot: Bot, i: ChatInput, eventId: string, member: User, action: 'grant' | 'revoke', item: string, reason: string): Promise<string> {
  const before = uniqueCount(bot.ctx, i.guildId, eventId, member.id);
  const r = correctCollection(bot.ctx, i.guildId, eventId, member.id, action, item, reason, i.user.id);
  await syncChampionRole(bot, i.guildId);
  const after = uniqueCount(bot.ctx, i.guildId, eventId, member.id);
  return (
    `**${r.item.name}** ${action === 'grant' ? 'given to' : 'removed from'} ${member}.\n` +
    `**Collection:** ${before} → ${after} unique items\n**Champion:** ${mention(r.champion.championId)}\nNo candy was changed.`
  );
}

export async function fixRole(bot: Bot, i: ChatInput) {
  tx(bot.ctx, () => refreshAllChampions(bot.ctx, i.guildId));
  const before = getRoleState(bot.ctx, i.guildId);
  const r = await syncChampionRole(bot, i.guildId);
  const state = getRoleState(bot.ctx, i.guildId);
  return embed(r.ok ? COLORS.staff : COLORS.warn, '👑 Champion role check').addFields(
    field('Should have the role', mention(state.desiredId), true),
    field('Has the role', mention(state.holderId), true),
    field('Result', r.ok ? (before.pending ? `Changed: ${mention(before.holderId)} → ${mention(state.holderId)}` : 'Already correct. Nothing changed.') : `Failed: ${r.error}`),
  );
}

export const halloweenHandlers: HandlerSet = {
  chat: {
    trick: (bot, i) => answer(bot, i, 'trick', { channelId: i.channelId }),
    treat: (bot, i) => answer(bot, i, 'treat', { channelId: i.channelId }),
    inventory: (bot, i) =>
      reply(
        i,
        inventoryView(bot, i.guildId, (i.options.getUser('member') ?? i.user).id, i.options.getString('season'), i.options.getString('rarity') as Rarity | null, 1),
      ),
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
      if (action === 'miss') return void (await b.update(missingView(bot, i.guildId, rest[0]!, rest[1]!, Number(rest[2]))));
      if (action === 'vis') return void (await b.update(visitorsView(bot, i.guildId, rest[0]!, rest[1]!, Number(rest[2]))));
      if (action === 'lb') return void (await b.update(leaderboardView(bot, i.guildId, rest[0]!, Number(rest[1]))));
    },
  },
};

/** Plain-language answer to "why isn't a visitor showing up?", for staff. */
export function visitorStatusText(bot: Bot, guildId: string): string {
  const st = visitorStatus(bot.ctx, guildId);
  switch (st.kind) {
    case 'not-live':
      return 'Halloween is not live, so no visitors come.';
    case 'visiting':
      return `👻 A visitor is in <#${st.channelId}> right now (leaves ${discordTime(st.expiresAt, 'R')}).`;
    case 'waiting-timer':
      return `⏳ Next visitor ${discordTime(st.at, 'R')} in ${st.activeChannels.map((c) => `<#${c}>`).join(' or ')}.`;
    case 'waiting-chat':
      return `💬 Waiting for chat: visitors only come where someone has posted in the last ${formatSeconds(st.windowS)}. Post a message in ${st.channels.map((c) => `<#${c}>`).join(' or ') || 'the Halloween channel'}.`;
  }
}

/** Item names for autocomplete. */
/** Item suggestions. With `ownerId`, only items that member owns this season. */
export function itemChoices(bot: Bot, guildId: string, query: string, ownerId?: string): { name: string; value: string }[] {
  const ev = getCurrentOrLatestEvent(bot.ctx, guildId, 'halloween');
  const pack = ev ? packFor(bot.ctx, ev) : getPack(bot.ctx, guildId, 'halloween');
  const q = query.toLowerCase();
  const owned =
    ownerId && ev
      ? new Set(
          (bot.ctx.db.prepare('SELECT item_id FROM hw_items WHERE guild_id = ? AND event_id = ? AND user_id = ?').all(guildId, ev.id, ownerId) as { item_id: string }[]).map(
            (r) => r.item_id,
          ),
        )
      : null;
  return pack.visitors
    .flatMap((v) => v.items.filter((it) => !owned || owned.has(it.id)).map((it) => ({ name: truncate(`${it.name} (${it.rarity}, ${v.name})`, 100), value: it.id })))
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
