import { ActionRowBuilder, AttachmentBuilder, FileUploadBuilder, LabelBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { exportSheet, planImport, SHEET_FILTERS, type ImportPlan, type SheetFilter } from '../../domain/itemSheet.js';
import { fetchAttachmentText } from './season.js';
import { RARITIES, type HalloweenVisitor, type Rarity } from '../../content/types.js';
import { audit } from '../../domain/audit.js';
import { CLASS_LABEL, getClasses, setClass } from '../../domain/classes.js';
import { consumePending, createPending } from '../../domain/confirmations.js';
import { tx } from '../../domain/context.js';
import { UserError } from '../../domain/errors.js';
import { activeVisitors, visitorClass } from '../../domain/halloween.js';
import { paginate } from '../../domain/ranking.js';
import {
  ALL_PLACEHOLDERS,
  addVisitor,
  currentPack,
  editItem,
  editVisitor,
  findVisitorByQuery,
  isPlaceholder,
  removeVisitors,
  savePack,
  type VisitorInput,
} from '../../domain/visitors.js';
import { resolveImage, storeAttachedImage } from '../images.js';
import { assertSafeRewardRole, assertUsableRewardChannel, syncPendingRewards } from '../rewards.js';
import { getItemReward, itemOwnerCount, listItemRewards, setItemReward } from '../../domain/rewards.js';
import { findItem, searchItem } from '../../domain/content.js';
import type { Guild, GuildBasedChannel, Role } from 'discord.js';
import { askConfirm, reply, type Button, type ChatHandler, type ChatInput, type Component, type HandlerSet, type Modal } from '../interaction.js';
import { assertLevel, type Bot } from '../runtime.js';
import { cid, COLORS, embed, field, pager, truncate } from '../ui.js';
import { halloweenPreview } from './halloween.js';

interface FormPayload {
  mode: 'add' | 'edit';
  visitorId?: string;
  rarity?: Rarity;
  picture?: { url: string; size: number };
  pictureUrl?: string;
  removePicture?: boolean;
  winText?: string;
}

function classLine(bot: Bot, guildId: string, cls: Rarity): string {
  const bonus = getClasses(bot.ctx, guildId)[cls].bonusCandy;
  return `${CLASS_LABEL[cls]}${bonus ? ` (+${bonus} bonus candy)` : ''}`;
}

/** Typing this in the picture link field removes the picture. */
const REMOVE_PICTURE = /^(none|remove|delete|-)$/i;

function pictureOptions(i: ChatInput): Pick<FormPayload, 'picture' | 'pictureUrl'> {
  const att = i.options.getAttachment('picture');
  const raw = i.options.getString('picture_url');
  const url = raw && REMOVE_PICTURE.test(raw.trim()) ? null : raw;
  if (att && url) throw new UserError('Use either `picture` or `picture_url`, not both.');
  if (att && att.contentType && !/^image\/(png|jpe?g|gif|webp)/.test(att.contentType)) throw new UserError('The picture must be PNG, JPG, GIF or WEBP.');
  if (url && !/^https?:\/\/\S+$/.test(url.trim())) throw new UserError('`picture_url` must be a link starting with https://');
  return { picture: att ? { url: att.url, size: att.size } : undefined, pictureUrl: url?.trim() || undefined };
}

async function showForm(bot: Bot, i: ChatInput, payload: FormPayload, existing?: HalloweenVisitor) {
  const token = createPending(bot.ctx, i.guildId, i.user.id, 'visitor.form', payload);
  const input = (id: string, label: string, style: TextInputStyle, value: string | undefined, required: boolean, max: number, placeholder?: string) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (value) t.setValue(value.slice(0, max));
    if (placeholder) t.setPlaceholder(placeholder);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
  };
  const item = existing?.items.length === 1 ? existing.items[0]!.name : undefined;
  const modal = new ModalBuilder()
    .setCustomId(cid('visitorform', token))
    .setTitle(truncate(existing ? `Edit ${existing.name}` : 'New Halloween visitor', 45))
    .addComponents(
      input('name', 'Name', TextInputStyle.Short, existing?.name, true, 80, 'e.g. 🎃 Pumpkin Pete'),
      input('greeting', 'Greeting (shown when it arrives)', TextInputStyle.Paragraph, existing?.greeting, false, 500, 'e.g. Boo! Pete rolls into town…'),
      input('trick', 'Text when it wants a TRICK', TextInputStyle.Paragraph, existing?.trickRequest, false, 500, 'Leave empty for the default. {name} = visitor name'),
      input('treat', 'Text when it wants a TREAT', TextInputStyle.Paragraph, existing?.treatRequest, false, 500, 'Leave empty for the default. {name} = visitor name'),
      ...(existing && existing.items.length !== 1 ? [] : [input('item', 'Collectible it gives', TextInputStyle.Short, item, false, 80, "Default: <name>'s Keepsake")]),
    );
  await i.showModal(modal);
}

async function add(bot: Bot, i: ChatInput) {
  const rarity = i.options.getString('class', true) as Rarity;
  await showForm(bot, i, { mode: 'add', rarity, ...pictureOptions(i), winText: i.options.getString('win_text') ?? undefined });
}

async function edit(bot: Bot, i: ChatInput) {
  const v = findVisitorByQuery(currentPack(bot.ctx, i.guildId), i.options.getString('visitor', true));
  const pics = pictureOptions(i);
  const raw = i.options.getString('picture_url');
  const removePicture = (i.options.getBoolean('remove_picture') ?? false) || (!!raw && REMOVE_PICTURE.test(raw.trim()));
  if (removePicture && (pics.picture || pics.pictureUrl)) throw new UserError('Either give a new picture or remove it, not both.');
  await showForm(
    bot,
    i,
    { mode: 'edit', visitorId: v.id, rarity: (i.options.getString('class') as Rarity | null) ?? undefined, ...pics, removePicture, winText: i.options.getString('win_text') ?? undefined },
    v,
  );
}

function textChange(label: string, a: string | undefined, b: string | undefined): string | null {
  if ((a ?? '') === (b ?? '')) return null;
  if (!a) return `**${label}:** default → custom`;
  if (!b) return `**${label}:** custom → default`;
  return `**${label}:** updated`;
}

async function submitForm(bot: Bot, i: Component, [token]: string[]) {
  if (!i.isModalSubmit()) return;
  const m = i as Modal;
  assertLevel(bot, m.member, 'admin');
  const { payload } = consumePending<FormPayload>(bot.ctx, m.guildId, m.user.id, token!);
  const f = (id: string) => {
    try {
      return m.fields.getTextInputValue(id);
    } catch {
      return undefined;
    }
  };
  let image: string | null | undefined;
  if (payload.picture) image = await storeAttachedImage(bot, m.guildId, payload.picture.url, payload.picture.size);
  else if (payload.pictureUrl) image = payload.pictureUrl;
  else if (payload.removePicture) image = null;

  const fields: Partial<VisitorInput> = {
    name: f('name') ?? '',
    greeting: f('greeting') ?? null,
    trickRequest: f('trick') ?? null,
    treatRequest: f('treat') ?? null,
    itemName: f('item') ?? null,
    ...(payload.winText !== undefined ? { winText: payload.winText } : {}),
  };
  const changes: string[] = [];
  let visitor: HalloweenVisitor;
  if (payload.mode === 'add') {
    visitor = addVisitor(bot.ctx, m.guildId, { ...(fields as VisitorInput), rarity: payload.rarity!, image }, m.user.id);
    changes.push(`**Visitor:** none → ${visitor.name}`, `**Class:** ${classLine(bot, m.guildId, payload.rarity!)}`);
    changes.push(`**Picture:** ${visitor.image ? 'added' : 'none (text only)'}`, `**Collectible:** ${visitor.items[0]!.name}`);
    if (visitor.winText) changes.push('**Win text:** custom');
  } else {
    const { before, after } = editVisitor(bot.ctx, m.guildId, payload.visitorId!, { ...fields, rarity: payload.rarity, image }, m.user.id);
    visitor = after;
    if (before.name !== after.name) changes.push(`**Name:** ${before.name} → ${after.name}`);
    if (visitorClass(before) !== visitorClass(after)) changes.push(`**Class:** ${CLASS_LABEL[visitorClass(before)]} → ${classLine(bot, m.guildId, visitorClass(after))}`);
    if (before.image !== after.image) changes.push(`**Picture:** ${!before.image ? 'none → added' : !after.image ? 'removed' : 'replaced'}`);
    for (const c of [
      textChange('Greeting', before.greeting, after.greeting),
      textChange('Trick text', before.trickRequest, after.trickRequest),
      textChange('Treat text', before.treatRequest, after.treatRequest),
      textChange('Win text', before.winText, after.winText),
    ])
      if (c) changes.push(c);
    if (before.items.length === 1 && before.items[0]!.name !== after.items[0]!.name) changes.push(`**Collectible:** ${before.items[0]!.name} → ${after.items[0]!.name}`);
    if (before.retired) changes.push('**Status:** retired → appearing again');
  }
  if (visitor.items.length > 1) changes.push(`*${visitor.name} gives ${visitor.items.length} items. Edit them one by one with \`/visitor\` → **Edit an item**.*`);
  const pack = currentPack(bot.ctx, m.guildId);
  const placeholders = activeVisitors(pack).filter(isPlaceholder).length;
  const tail =
    `\n**Active visitors:** ${activeVisitors(pack).length}` +
    (placeholders ? ` (${placeholders} are built-in placeholders: remove them with \`/visitor\` → Remove a visitor → type \`placeholders\`)` : '');
  const preview = halloweenPreview(bot, m.guildId, m.channelId ?? '', m.user.id, visitor.id);
  await reply(m, {
    content: `${changes.length ? `**What changed**\n${changes.join('\n')}` : '**Nothing changed.**'}${tail}\nThis is how it looks to members:`,
    embeds: preview.embeds,
    files: preview.files,
  });
}

async function remove(bot: Bot, i: ChatInput) {
  const query = i.options.getString('visitor', true);
  const which = /^all( placeholder( visitors)?)?$|^placeholders$/i.test(query.trim()) ? ALL_PLACEHOLDERS : query;
  const { deleted, retired } = removeVisitors(bot.ctx, i.guildId, which, i.user.id);
  const lines: string[] = [];
  if (deleted.length) lines.push(`**Removed:** ${truncate(deleted.join(', '), 900)}`);
  if (retired.length) lines.push(`**Retired:** ${truncate(retired.join(', '), 900)} (no longer appear; members keep what they collected)`);
  lines.push(`**Active visitors now:** ${activeVisitors(currentPack(bot.ctx, i.guildId)).length}`);
  await reply(i, lines.join('\n'));
}

function listView(bot: Bot, guildId: string, page: number) {
  const pack = currentPack(bot.ctx, guildId);
  const active = activeVisitors(pack);
  const classes = getClasses(bot.ctx, guildId);
  const present = RARITIES.filter((r) => active.some((v) => visitorClass(v) === r));
  const totalWeight = present.reduce((n, r) => n + classes[r].weight, 0);
  const summary = RARITIES.map((r) => {
    const count = active.filter((v) => visitorClass(v) === r).length;
    const pct = count && totalWeight ? `${((classes[r].weight / totalWeight) * 100).toFixed(0)}% of visits` : 'no visitors';
    return `${CLASS_LABEL[r]}: ${count} visitor${count === 1 ? '' : 's'} · ${pct} · +${classes[r].bonusCandy} candy`;
  }).join('\n');
  const p = paginate(active, page, 20);
  const lines = p.items.map((v) => `${CLASS_LABEL[visitorClass(v)].split(' ')[0]} **${v.name}**${v.image ? ' 🖼️' : ''}${isPlaceholder(v) ? ' *(placeholder)*' : ''}`);
  const e = embed(COLORS.halloween, `👻 Visitors (${active.length})`, lines.join('\n') || 'No visitors yet. Add one with `/visitor` → Add a visitor.').addFields(
    field('Classes (`/visitor` → Visitor classes to change)', summary),
  );
  return { embeds: [e], components: p.pages > 1 ? [pager(p, (n) => cid('vlist', n))] : [] };
}

async function setupClass(bot: Bot, i: ChatInput) {
  const cls = i.options.getString('class', true) as Rarity;
  const chance = i.options.getInteger('chance');
  const bonus = i.options.getInteger('bonus_candy');
  const text = i.options.getString('rarity_text');
  const changes: string[] = [];
  tx(bot.ctx, () => {
    const { before, after } = setClass(bot.ctx, i.guildId, cls, { weight: chance ?? undefined, bonusCandy: bonus ?? undefined, description: text ?? undefined });
    if (before.description !== after.description) changes.push(`**${CLASS_LABEL[cls]} rarity text:** "${before.description}" → "${after.description}"`);
    if (before.weight !== after.weight) changes.push(`**${CLASS_LABEL[cls]} chance:** ${before.weight} → ${after.weight}`);
    if (before.bonusCandy !== after.bonusCandy) changes.push(`**${CLASS_LABEL[cls]} bonus candy:** +${before.bonusCandy} → +${after.bonusCandy}`);
    if (changes.length) audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'setup.class', before: { [cls]: before }, after: { [cls]: after } });
  });
  const view = listView(bot, i.guildId, 1);
  await reply(i, {
    content: changes.length ? `**What changed**\n${changes.join('\n')}` : '**Nothing changed.** Here are the current classes.',
    embeds: [embed(COLORS.staff, '🎃 Visitor classes').addFields(view.embeds[0]!.toJSON().fields!.at(-1)!)],
  });
}

const FILTER_LABEL: Record<SheetFilter, string> = Object.fromEntries(SHEET_FILTERS.map((f) => [f.value, f.name])) as Record<SheetFilter, string>;

async function exportItems(bot: Bot, i: ChatInput) {
  const filter = (i.options.getString('rarity') ?? 'all') as SheetFilter;
  const rewards = new Map(listItemRewards(bot.ctx, i.guildId).map((r) => [r.itemId, r]));
  const { csv, count } = exportSheet(currentPack(bot.ctx, i.guildId), filter, rewards);
  if (count === 0) throw new UserError(`There are no ${FILTER_LABEL[filter].toLowerCase()} items to export.`);
  await reply(i, {
    content:
      `**${count} ${FILTER_LABEL[filter].toLowerCase()} item${count === 1 ? '' : 's'}**, one per row. Nothing changed.\n` +
      '**How to edit:** open the file in Google Sheets (File → Import → Upload) or Excel (Data → From Text/CSV, UTF-8). ' +
      'Change names, rarities, descriptions, picture links or texts. **Don\'t change `item_id` or `visitor_id`.** ' +
      'To add an item or visitor, add a row with `item_id` empty. ' +
      '**Rewards:** put a role ID in `reward_role_id` and/or a channel ID in `reward_channel_id` (right-click → Copy ID; needs Developer Mode on). Save as CSV (in Excel: **CSV UTF-8**) and upload it with `/visitor` → Import items.',
    files: [new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `halloween-items-${filter}.csv` })],
  });
}

function summary(plan: ImportPlan): string {
  const c = plan.counts;
  const parts = [
    c.itemsChanged && `${c.itemsChanged} item${c.itemsChanged === 1 ? '' : 's'} changed`,
    c.visitorsChanged && `${c.visitorsChanged} visitor${c.visitorsChanged === 1 ? '' : 's'} changed`,
    c.visitorsAdded && `${c.visitorsAdded} new visitor${c.visitorsAdded === 1 ? '' : 's'}`,
    c.itemsAdded && `${c.itemsAdded} new item${c.itemsAdded === 1 ? '' : 's'}`,
    c.rewardsChanged && `${c.rewardsChanged} item reward${c.rewardsChanged === 1 ? '' : 's'} changed`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function changeList(plan: ImportPlan, max = 25): string {
  const shown = plan.changes.slice(0, max).map((c) => `• ${c}`);
  if (plan.changes.length > max) shown.push(`…and ${plan.changes.length - max} more`);
  return truncate(shown.join('\n'), 3800);
}

async function importItems(bot: Bot, i: ChatInput) {
  const file = i.options.getAttachment('file', true);
  if (file.size > 2_000_000) throw new UserError('The file must be 2 MB or smaller.');
  if (!/\.(csv|txt)$/i.test(file.name)) throw new UserError('Upload the spreadsheet saved as a .csv file.');
  const csvText = await fetchAttachmentText(file.url);
  const plan = planImport(bot.ctx, i.guildId, currentPack(bot.ctx, i.guildId), csvText);
  plan.errors.push(...rewardErrors(bot, i.guild, plan));
  if (plan.errors.length) {
    const errs = plan.errors.slice(0, 20).map((e) => `• ${e}`);
    if (plan.errors.length > 20) errs.push(`…and ${plan.errors.length - 20} more`);
    await reply(i, { embeds: [embed(COLORS.error, 'Import stopped. Nothing changed.', `Fix these in the spreadsheet and upload it again:\n${truncate(errs.join('\n'), 3900)}`)] });
    return;
  }
  if (!plan.changes.length) {
    await reply(i, '**Nothing changed.** The spreadsheet matches the current visitors and items.');
    return;
  }
  await askConfirm(bot, i, 'visitor.import', { csvText }, embed(COLORS.warn, `Apply these changes? ${summary(plan)}`, changeList(plan)));
}

/** Finds an item by ID, exact name, or a part of the name that matches only one item. */
function findItemLoose(pack: ReturnType<typeof currentPack>, query: string) {
  const exact = searchItem(pack, query);
  if (exact) return exact;
  const q = query.trim().toLowerCase();
  const hits = pack.visitors.flatMap((visitor) => visitor.items.filter((item) => item.name.toLowerCase().includes(q)).map((item) => ({ item, visitor })));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new UserError(`"${query}" matches ${hits.length} items: ${truncate(hits.slice(0, 8).map((h) => h.item.name).join(', '), 300)}. Type more of the name.`);
  throw new UserError(`No item called "${query}". Use the item's name as shown in /inventory or the spreadsheet (its item_id works too).`);
}

const roleRef = (id: string | null) => (id ? `<@&${id}>` : 'none');
const channelRef = (id: string | null) => (id ? `<#${id}>` : 'none');

/** Checks spreadsheet rewards against the server: the roles and channels must exist and be safe to hand out. */
function rewardErrors(bot: Bot, guild: Guild, plan: ImportPlan): string[] {
  const errors: string[] = [];
  for (const r of plan.rewards) {
    try {
      if (r.roleId) {
        const role = guild.roles.cache.get(r.roleId);
        if (!role) throw new UserError(`reward_role_id ${r.roleId} isn't a role in this server.`);
        assertSafeRewardRole(bot, guild, role);
      }
      if (r.channelId) {
        const ch = guild.channels.cache.get(r.channelId);
        if (!ch) throw new UserError(`reward_channel_id ${r.channelId} isn't a channel in this server.`);
        assertUsableRewardChannel(guild, ch);
      }
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      errors.push(`Row ${r.line} (${r.itemName}): ${err.message}`);
    }
  }
  return errors;
}

/** All item rewards, for the reply after a change. */
function rewardList(bot: Bot, guildId: string): string {
  const pack = currentPack(bot.ctx, guildId);
  const lines = listItemRewards(bot.ctx, guildId).map((r) => {
    const name = findItem(pack, r.itemId)?.item.name ?? r.itemId;
    return `• **${name}** → ${[r.roleId && roleRef(r.roleId), r.channelId && channelRef(r.channelId)].filter(Boolean).join(' + ')}`;
  });
  return truncate(lines.join('\n') || 'No items unlock anything yet.', 1024);
}

/** A channel by ID, <#mention> or exact name, for when the picker doesn't list it. */
function findChannel(guild: Guild, query: string): GuildBasedChannel {
  const q = query.trim().replace(/^<#(\d+)>$/, '$1').replace(/^#/, '');
  const byId = guild.channels.cache.get(q);
  if (byId) return byId;
  const byName = [...guild.channels.cache.values()].filter((c) => c.name.toLowerCase() === q.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new UserError(`${byName.length} channels are called "${q}". Paste the channel ID instead (right-click the channel → Copy Channel ID).`);
  throw new UserError(`No channel "${q}" found. Paste its ID: right-click the channel → Copy Channel ID (turn on Developer Mode in Discord's Advanced settings).`);
}

/** `/visitor` → Item rewards: an item unlocks a role and/or a personal channel override. */
async function itemRewards(bot: Bot, i: ChatInput) {
  const found = findItemLoose(currentPack(bot.ctx, i.guildId), i.options.getString('item', true));
  const what = i.options.getString('what') ?? 'set';
  const role = i.options.getRole('role');
  const typed = i.options.getString('channel_id');
  if (typed && i.options.getChannel('channel')) throw new UserError('Pick the channel from the list **or** type its ID/name, not both.');
  const channel = i.options.getChannel('channel') ?? (typed ? findChannel(i.guild, typed) : null);
  const before = getItemReward(bot.ctx, i.guildId, found.item.id);
  let next = { roleId: before?.roleId ?? null, channelId: before?.channelId ?? null };
  if (what === 'set') {
    if (!role && !channel) throw new UserError('Pick a role and/or a channel, or choose one of the Remove options.');
    if (role) {
      assertSafeRewardRole(bot, i.guild, role as Role);
      next.roleId = role.id;
    }
    if (channel) {
      assertUsableRewardChannel(i.guild, channel as GuildBasedChannel);
      next.channelId = channel.id;
    }
  } else if (what === 'remove-role') next.roleId = null;
  else if (what === 'remove-channel') next.channelId = null;
  else next = { roleId: null, channelId: null };

  const { after } = setItemReward(bot.ctx, i.guildId, found.item.id, next, i.user.id);
  const changes: string[] = [];
  if ((before?.roleId ?? null) !== (after?.roleId ?? null)) changes.push(`**Role:** ${roleRef(before?.roleId ?? null)} → ${roleRef(after?.roleId ?? null)}`);
  if ((before?.channelId ?? null) !== (after?.channelId ?? null)) changes.push(`**Channel access:** ${channelRef(before?.channelId ?? null)} → ${channelRef(after?.channelId ?? null)}`);
  const owners = itemOwnerCount(bot.ctx, i.guildId, found.item.id);
  // Members who already own the item get (or lose) the reward now; the scheduler finishes any rest.
  if (changes.length && owners) void syncPendingRewards(bot, i.guild, 50);
  const e = embed(
    COLORS.staff,
    `🔓 Rewards for ${truncate(found.item.name, 200)}`,
    changes.length ? `**What changed**\n${changes.join('\n')}` : '**Nothing changed.**',
  ).addFields(
    field('Who gets it', `Anyone who wins this item (from ${found.visitor.name}). The role is given and/or the channel opens just for them.`),
    field('Already own it', owners ? `${owners} member${owners === 1 ? '' : 's'}: updated within a minute.` : 'Nobody yet.'),
    field('All item rewards', rewardList(bot, i.guildId)),
  );
  await reply(i, { embeds: [e] });
}

/** `/visitor` → Edit an item, step 1: find the item, then open its form (behind a Continue button). */
async function editItemStart(bot: Bot, i: ChatInput) {
  const found = findItemLoose(currentPack(bot.ctx, i.guildId), i.options.getString('item', true));
  const { item, visitor } = found;
  const token = createPending(bot.ctx, i.guildId, i.user.id, 'item.form', { itemId: item.id });
  const text = (id: string, label: string, value: string | undefined, opts: { required?: boolean; long?: boolean; max: number; description?: string }) => {
    const t = new TextInputBuilder()
      .setCustomId(id)
      .setStyle(opts.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(!!opts.required)
      .setMaxLength(opts.max);
    if (value) t.setValue(value.slice(0, opts.max));
    const l = new LabelBuilder().setLabel(label).setTextInputComponent(t);
    if (opts.description) l.setDescription(opts.description);
    return l;
  };
  const link = item.image && /^https?:\/\//.test(item.image) ? item.image : undefined;
  const modal = new ModalBuilder()
    .setCustomId(cid('itemform', token))
    .setTitle(truncate(`Item from ${visitor.name}`, 45))
    .addLabelComponents(
      text('name', 'Name', item.name, { required: true, max: 80 }),
      new LabelBuilder()
        .setLabel('Rarity')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('rarity')
            .setRequired(true)
            .addOptions(RARITIES.map((r) => ({ label: CLASS_LABEL[r], value: r, default: r === item.rarity }))),
        ),
      text('description', 'Description', item.description, { long: true, max: 300, description: 'Shown in the winner\'s private message' }),
      new LabelBuilder()
        .setLabel('New picture (optional)')
        .setDescription(item.image ? 'Leave empty to keep the current picture' : 'PNG, JPG, GIF or WEBP, e.g. 512 × 512')
        .setFileUploadComponent(new FileUploadBuilder().setCustomId('picture').setRequired(false).setMinValues(0).setMaxValues(1)),
      text('picture_url', '…or a picture link (optional)', link, { max: 500, description: 'Type "none" to remove the picture' }),
    );
  await i.showModal(modal);
}

/** `/visitor` → Edit an item, step 2: save the form. */
async function submitItemForm(bot: Bot, i: Component, [token]: string[]) {
  if (!i.isModalSubmit()) return;
  const m = i as Modal;
  assertLevel(bot, m.member, 'admin');
  const { payload } = consumePending<{ itemId: string }>(bot.ctx, m.guildId, m.user.id, token!);
  const read = <T,>(fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const rarity = read(() => m.fields.getStringSelectValues('rarity'))?.[0] as Rarity | undefined;
  const upload = read(() => m.fields.getUploadedFiles('picture', false))?.first();
  const linkRaw = read(() => m.fields.getTextInputValue('picture_url'))?.trim() ?? '';
  let image: string | null | undefined;
  if (upload) {
    if (upload.contentType && !/^image\/(png|jpe?g|gif|webp)/.test(upload.contentType)) throw new UserError('The picture must be PNG, JPG, GIF or WEBP.');
    image = await storeAttachedImage(bot, m.guildId, upload.url, upload.size);
  } else if (REMOVE_PICTURE.test(linkRaw)) image = null;
  else if (linkRaw) {
    if (!/^https?:\/\/\S+$/.test(linkRaw)) throw new UserError('The picture link must start with https://');
    image = linkRaw;
  }
  const { before, after, visitor } = editItem(
    bot.ctx,
    m.guildId,
    payload.itemId,
    { name: read(() => m.fields.getTextInputValue('name')) ?? undefined, rarity, description: read(() => m.fields.getTextInputValue('description')) ?? undefined, image },
    m.user.id,
  );
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`**Name:** ${before.name} → ${after.name}`);
  if (before.rarity !== after.rarity) changes.push(`**Rarity:** ${CLASS_LABEL[before.rarity]} → ${CLASS_LABEL[after.rarity]}`);
  if (before.description !== after.description) changes.push('**Description:** updated');
  if ((before.image ?? null) !== (after.image ?? null)) changes.push(`**Picture:** ${!before.image ? 'none → added' : !after.image ? 'removed' : 'replaced'}`);
  const e = embed(COLORS.halloween, `${after.name}`, after.description).setAuthor({ name: `${CLASS_LABEL[after.rarity]} · from ${visitor.name}` });
  const img = resolveImage(bot, m.guildId, after.image);
  if (img) e.setImage(img.url);
  await reply(m, {
    content: `${changes.length ? `**What changed**\n${changes.join('\n')}` : '**Nothing changed.**'}\nMembers who own it keep it. This is how it looks:`,
    embeds: [e],
    files: img?.file ? [img.file] : [],
  });
}

/** Visitor actions, run from the /visitor menu (see panels.ts). */
export const visitorActions: Record<string, ChatHandler> = {
  'visitor add': add,
  'visitor edit': edit,
  'visitor remove': remove,
  'visitor list': (bot, i) => reply(i, listView(bot, i.guildId, 1)),
  'visitor class': setupClass,
  'visitor export': exportItems,
  'visitor import': importItems,
  'visitor rewards': itemRewards,
  'visitor item': editItemStart,
};

export const visitorHandlers: HandlerSet = {
  confirms: {
    'visitor.import': {
      level: 'admin',
      run: async (bot, i, { csvText }: { csvText: string }) => {
        // Re-check against the latest content in case something changed since the preview.
        const plan = planImport(bot.ctx, i.guildId, currentPack(bot.ctx, i.guildId), csvText);
        plan.errors.push(...rewardErrors(bot, i.guild, plan));
        if (plan.errors.length) throw new UserError(`The spreadsheet no longer applies cleanly: ${plan.errors[0]}`);
        if (!plan.changes.length) return '**Nothing changed.**';
        if (plan.counts.itemsChanged || plan.counts.itemsAdded || plan.counts.visitorsChanged || plan.counts.visitorsAdded) {
          savePack(bot.ctx, i.guildId, plan.pack, i.user.id, 'visitor.import', { counts: plan.counts });
        }
        for (const r of plan.rewards) setItemReward(bot.ctx, i.guildId, r.itemId, { roleId: r.roleId, channelId: r.channelId }, i.user.id, 'reward.import');
        if (plan.rewards.length) void syncPendingRewards(bot, i.guild, 50);
        return embed(COLORS.hit, `Imported: ${summary(plan)}`, `**What changed**\n${changeList(plan)}`);
      },
    },
  },
  components: {
    visitorform: submitForm,
    itemform: submitItemForm,
    vlist: async (bot, i, [page]) => {
      if (i.isButton()) await (i as Button).update(listView(bot, i.guildId, Number(page)));
    },
  },
};
