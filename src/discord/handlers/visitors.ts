import { ActionRowBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
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
  editVisitor,
  findVisitorByQuery,
  isPlaceholder,
  removeVisitors,
  savePack,
  type VisitorInput,
} from '../../domain/visitors.js';
import { storeAttachedImage } from '../images.js';
import { askConfirm, reply, type Button, type ChatInput, type Component, type HandlerSet, type Modal } from '../interaction.js';
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

function pictureOptions(i: ChatInput): Pick<FormPayload, 'picture' | 'pictureUrl'> {
  const att = i.options.getAttachment('picture');
  const url = i.options.getString('picture_url');
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
  const removePicture = i.options.getBoolean('remove_picture') ?? false;
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
  const pack = currentPack(bot.ctx, m.guildId);
  const placeholders = activeVisitors(pack).filter(isPlaceholder).length;
  const tail =
    `\n**Active visitors:** ${activeVisitors(pack).length}` +
    (placeholders ? ` (${placeholders} are built-in placeholders: remove them with \`/visitor remove visitor:All placeholder visitors\`)` : '');
  const preview = halloweenPreview(bot, m.guildId, m.channelId ?? '', m.user.id, visitor.id);
  await reply(m, {
    content: `${changes.length ? `**What changed**\n${changes.join('\n')}` : '**Nothing changed.**'}${tail}\nThis is how it looks to members:`,
    embeds: preview.embeds,
    files: preview.files,
  });
}

async function remove(bot: Bot, i: ChatInput) {
  const { deleted, retired } = removeVisitors(bot.ctx, i.guildId, i.options.getString('visitor', true), i.user.id);
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
  const e = embed(COLORS.halloween, `👻 Visitors (${active.length})`, lines.join('\n') || 'No visitors. Add one with `/visitor add`.').addFields(
    field('Classes (`/visitor class` to change)', summary),
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

/** Visitor names for `/visitor edit|remove` autocomplete, from the latest content. */
export function visitorAdminChoices(bot: Bot, guildId: string, query: string, forRemove: boolean) {
  const active = activeVisitors(currentPack(bot.ctx, guildId));
  const q = query.toLowerCase();
  const choices = active
    .filter((v) => v.name.toLowerCase().includes(q) || v.id.includes(q))
    .map((v) => ({ name: truncate(`${v.name} (${visitorClass(v)})`, 100), value: v.id }));
  const placeholders = active.filter(isPlaceholder).length;
  if (forRemove && placeholders) choices.unshift({ name: `All placeholder visitors (${placeholders})`, value: ALL_PLACEHOLDERS });
  return choices.slice(0, 25);
}

const FILTER_LABEL: Record<SheetFilter, string> = Object.fromEntries(SHEET_FILTERS.map((f) => [f.value, f.name])) as Record<SheetFilter, string>;

async function exportItems(bot: Bot, i: ChatInput) {
  const filter = (i.options.getString('rarity') ?? 'all') as SheetFilter;
  const { csv, count } = exportSheet(currentPack(bot.ctx, i.guildId), filter);
  if (count === 0) throw new UserError(`There are no ${FILTER_LABEL[filter].toLowerCase()} items to export.`);
  await reply(i, {
    content:
      `**${count} ${FILTER_LABEL[filter].toLowerCase()} item${count === 1 ? '' : 's'}**, one per row. Nothing changed.\n` +
      '**How to edit:** open the file in Google Sheets (File → Import → Upload) or Excel (Data → From Text/CSV, UTF-8). ' +
      'Change names, rarities, descriptions, picture links or texts. **Don\'t change `item_id` or `visitor_id`.** ' +
      'To add an item or visitor, add a row with `item_id` empty. Save as CSV (in Excel: **CSV UTF-8**) and upload it with `/visitor import`.',
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

export const visitorHandlers: HandlerSet = {
  chat: {
    'visitor add': add,
    'visitor edit': edit,
    'visitor remove': remove,
    'visitor list': (bot, i) => reply(i, listView(bot, i.guildId, 1)),
    'visitor class': setupClass,
    'visitor export': exportItems,
    'visitor import': importItems,
  },
  confirms: {
    'visitor.import': {
      level: 'admin',
      run: async (bot, i, { csvText }: { csvText: string }) => {
        // Re-check against the latest content in case something changed since the preview.
        const plan = planImport(bot.ctx, i.guildId, currentPack(bot.ctx, i.guildId), csvText);
        if (plan.errors.length) throw new UserError(`The spreadsheet no longer applies cleanly: ${plan.errors[0]}`);
        if (!plan.changes.length) return '**Nothing changed.**';
        savePack(bot.ctx, i.guildId, plan.pack, i.user.id, 'visitor.import', { counts: plan.counts });
        return embed(COLORS.hit, `Imported: ${summary(plan)}`, `**What changed**\n${changeList(plan)}`);
      },
    },
  },
  components: {
    visitorform: submitForm,
    vlist: async (bot, i, [page]) => {
      if (i.isButton()) await (i as Button).update(listView(bot, i.guildId, Number(page)));
    },
  },
};
