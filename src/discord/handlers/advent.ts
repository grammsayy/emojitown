import { ButtonStyle, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, ModalBuilder, ActionRowBuilder, type EmbedBuilder } from 'discord.js';
import {
  calendar,
  doorTimes,
  editDoor,
  getDoor,
  listDoors,
  markPosted,
  openDoor,
  progress,
  requireUnlocked,
  type Door,
  type DoorState,
  type OpenResult,
} from '../../domain/advent.js';
import { getChannel, getConfig, type GuildConfig } from '../../domain/config.js';
import { consumePending, createPending } from '../../domain/confirmations.js';
import { UserError } from '../../domain/errors.js';
import { requireEvent, type SeasonEvent } from '../../domain/events.js';
import { reply, type Button, type ChatInput, type Component, type HandlerSet, type Modal } from '../interaction.js';
import { assertLevel, fetchTextChannel, type Bot } from '../runtime.js';
import { button, cid, COLORS, embed, field, linkButton, row, when } from '../ui.js';

const STATE_ICON: Record<DoorState, string> = { locked: '🔒', available: '🎁', claimed: '✅', expired: '⌛' };

export function policyText(policy: GuildConfig['adventPolicy'], deadline: number | null): string {
  return policy === 'catch-up'
    ? `Missed a day? Earlier doors stay claimable until ${deadline ? when(deadline) : 'the claim deadline'}. After that, their content stays readable.`
    : 'Each door can be claimed on its own day only, until local midnight. After that, its content stays readable.';
}

export function doorEmbed(ev: SeasonEvent, door: Door): EmbedBuilder {
  const e = embed(COLORS.advent, `🎄 Door ${door.day}: ${door.title}`, door.message);
  if (door.imageUrl) e.setImage(door.imageUrl);
  e.setFooter({ text: `emojitown · ${ev.name}` });
  return e;
}

function doorComponents(ev: SeasonEvent, door: Door) {
  const buttons = [];
  if (door.triviaAnswer) buttons.push(button(cid('adv', 'reveal', ev.id, door.day), 'Reveal Answer', ButtonStyle.Secondary, '💡'));
  if (door.linkUrl) buttons.push(linkButton(door.linkUrl, 'Open link'));
  buttons.push(button(cid('adv', 'cal', ev.id), 'View Calendar', ButtonStyle.Secondary, '📅'));
  return [row(...buttons)];
}

export function openResultMessage(r: OpenResult) {
  const e = doorEmbed(r.event, r.door);
  const note: Record<OpenResult['outcome'], string> = {
    claimed: r.candy > 0 ? `🍬 You received **${r.candy} candy**!` : '✨ Door opened! This door has no candy reward.',
    'already-claimed': `You already opened this door${r.candy ? ` and received ${r.candy} candy` : ''}. Enjoy it again!`,
    expired: "This door's claim window has closed, so there's no reward, but you can still enjoy it.",
    ineligible: "You're not eligible for Advent rewards right now, but you can still enjoy the door.",
  };
  e.addFields(field('Reward', note[r.outcome]));
  return { embeds: [e], components: doorComponents(r.event, r.door) };
}

export function calendarView(bot: Bot, guildId: string, userId: string, eventId: string | null) {
  const cal = calendar(bot.ctx, guildId, userId, eventId);
  const prog = progress(bot.ctx, guildId, userId, cal.event.id);
  const lines = cal.days.map(
    (d) => `${STATE_ICON[d.state]} **${d.day}**${d.state === 'locked' ? ` · opens ${when(d.times.unlockAt)}` : d.title ? ` · ${d.title}` : ''}`,
  );
  const deadline = cal.days.length ? cal.days[cal.days.length - 1]!.times.claimEndsAt : null;
  const e = embed(COLORS.advent, `📅 ${cal.event.name}`, lines.join('\n'))
    .addFields(
      field('Your progress', `${prog.claimedDays.length}/${prog.doorCount} doors opened · 🍬 ${prog.candy} candy earned`),
      field('Legend', '🎁 available · ✅ opened · ⌛ missed (still readable, no reward) · 🔒 not yet'),
      field('Missed a day?', policyText(cal.policy, deadline)),
    );
  const released = cal.days.filter((d) => d.state !== 'locked');
  const components = released.length
    ? [
        row(
          new StringSelectMenuBuilder()
            .setCustomId(cid('adv', 'pick', cal.event.id))
            .setPlaceholder('Open a door…')
            .addOptions(
              released.slice(-25).map((d) => ({
                label: `Door ${d.day}${d.title ? `: ${d.title}` : ''}`.slice(0, 100),
                value: String(d.day),
                emoji: STATE_ICON[d.state],
              })),
            ),
        ),
      ]
    : [];
  return { embeds: [e], components };
}

/** The public daily announcement. */
export function announcementMessage(ev: SeasonEvent, door: Door, claimEndsAt: number, policy: GuildConfig['adventPolicy']) {
  const e = embed(COLORS.advent, `🎁 Door ${door.day} is open!`, `**${door.title}**\n\nPress **Open Door** or use \`/advent\` to see today's surprise${door.candy ? ` and collect **${door.candy} candy**` : ''}.`)
    .addFields(field('Claim by', when(claimEndsAt)), field('Catch-up', policyText(policy, claimEndsAt)));
  return {
    embeds: [e],
    components: [
      row(
        button(cid('adv', 'open', ev.id, door.day), 'Open Door', ButtonStyle.Success, '🎁'),
        button(cid('adv', 'cal', ev.id), 'View Calendar', ButtonStyle.Secondary, '📅'),
      ),
    ],
  };
}

/** One post covering doors whose announcements were missed during downtime. */
export function recoveryMessage(ev: SeasonEvent, doors: Door[]) {
  const e = embed(
    COLORS.advent,
    `🎁 ${doors.length} Advent doors are open!`,
    `Catch up on the doors you might have missed:\n${doors.map((d) => `• **Door ${d.day}**: ${d.title}`).join('\n')}\n\nPress **View Calendar** to pick a door.`,
  );
  const latest = doors[doors.length - 1]!;
  return {
    embeds: [e],
    components: [
      row(
        button(cid('adv', 'open', ev.id, latest.day), `Open Door ${latest.day}`, ButtonStyle.Success, '🎁'),
        button(cid('adv', 'cal', ev.id), 'View Calendar', ButtonStyle.Secondary, '📅'),
      ),
    ],
  };
}

/** Opens the form for writing one door. */
export async function showDoorForm(bot: Bot, i: ChatInput, ev: SeasonEvent, day: number, candy: number | null, reason: string | null) {
  if (ev.state === 'ended') throw new UserError('This Advent calendar has ended and its doors are frozen.');
  const cfg = getConfig(bot.ctx, i.guildId);
  if (day > cfg.adventDoorCount) throw new UserError(`The calendar has ${cfg.adventDoorCount} doors. Change that with \`/season\` → **Set up the Advent Calendar**.`);
  if (ev.adventPublishedAt && !reason) throw new UserError('This calendar is already live. Fill in **Reason** so the change is logged.');
  const existing = getDoor(bot.ctx, i.guildId, ev.id, day);
  const token = createPending(bot.ctx, i.guildId, i.user.id, 'advent.edit', {
    eventId: ev.id,
    day,
    candy: candy ?? existing?.candy ?? null,
    reason,
  });
  const input = (id: string, label: string, style: TextInputStyle, value: string | null | undefined, required: boolean, max: number) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (value) t.setValue(value.slice(0, max));
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
  };
  const modal = new ModalBuilder()
    .setCustomId(cid('advedit', token))
    .setTitle(`Door ${day}: ${ev.name}`.slice(0, 45))
    .addComponents(
      input('title', 'Title', TextInputStyle.Short, existing?.title, true, 100),
      input('message', 'Message (trivia question goes here too)', TextInputStyle.Paragraph, existing?.message, true, 3500),
      input('image', 'Image URL (optional)', TextInputStyle.Short, existing?.imageUrl, false, 500),
      input('link', 'Link URL (optional)', TextInputStyle.Short, existing?.linkUrl, false, 500),
      input('answer', 'Trivia answer (optional, adds Reveal Answer)', TextInputStyle.Paragraph, existing?.triviaAnswer, false, 1000),
    );
  await i.showModal(modal);
}

async function editSubmit(bot: Bot, i: Component, [token]: string[]) {
  if (!i.isModalSubmit()) return;
  const m = i as Modal;
  assertLevel(bot, m.member, 'admin');
  const { payload } = consumePending<{ eventId: string; day: number; candy: number | null; reason: string | null }>(bot.ctx, m.guildId, m.user.id, token!);
  const f = (id: string) => m.fields.getTextInputValue(id);
  const before = getDoor(bot.ctx, m.guildId, payload.eventId, payload.day);
  const door = editDoor(
    bot.ctx,
    m.guildId,
    payload.eventId,
    payload.day,
    { title: f('title'), message: f('message'), imageUrl: f('image') || null, linkUrl: f('link') || null, triviaAnswer: f('answer') || null, candy: payload.candy },
    m.user.id,
    payload.reason,
  );
  const ev = requireEvent(bot.ctx, m.guildId, payload.eventId);
  const changes: string[] = [];
  if (!before) changes.push(`**Door ${door.day}:** empty → written`);
  else {
    const cmp: [string, unknown, unknown][] = [
      ['Title', before.title, door.title],
      ['Message', before.message, door.message],
      ['Image', before.imageUrl, door.imageUrl],
      ['Link', before.linkUrl, door.linkUrl],
      ['Trivia answer', before.triviaAnswer, door.triviaAnswer],
      ['Candy', before.candy, door.candy],
    ];
    for (const [label, a, b] of cmp) {
      if (a === b) continue;
      changes.push(label === 'Message' ? '**Message:** updated' : `**${label}:** ${a ?? 'none'} → ${b ?? 'none'}`);
    }
  }
  const filled = listDoors(bot.ctx, m.guildId, ev.id).length;
  const total = getConfig(bot.ctx, m.guildId).adventDoorCount;
  await reply(m, {
    content: `${changes.length ? changes.join('\n') : `Door ${door.day}: nothing changed.`}\n**Doors written:** ${filled}/${total}. This is how members will see it:`,
    embeds: [doorEmbed(ev, door)],
  });
}

/** A door exactly as members will see it, plus its schedule. Nothing is saved. */
export function doorPreview(bot: Bot, guildId: string, ev: SeasonEvent, day: number) {
  const door = getDoor(bot.ctx, guildId, ev.id, day);
  if (!door) throw new UserError(`Door ${day} is empty. Write it with \`/season\` → **Write an Advent door**.`);
  const cfg = getConfig(bot.ctx, guildId);
  const t = doorTimes(ev, cfg, day);
  const e = doorEmbed(ev, door).addFields(
    field('Reward', door.candy ? `🍬 ${door.candy} candy` : 'No candy'),
    field('Unlocks', when(t.unlockAt), true),
    field('Claim by', when(t.claimEndsAt), true),
  );
  if (door.triviaAnswer) e.addFields(field('Trivia answer (hidden behind Reveal Answer)', `||${door.triviaAnswer}||`));
  return { content: '**Preview** (no claim or reward saved):', embeds: [e] };
}

/** Posts (or re-posts) the announcement for an unlocked door. Existing claims are untouched. */
export async function postDoor(bot: Bot, guildId: string, ev: SeasonEvent, day: number): Promise<string> {
  const guild = bot.client.guilds.cache.get(guildId)!;
  const channel = await fetchTextChannel(guild, getChannel(bot.ctx, guildId, 'advent'));
  if (!channel) throw new UserError('The Advent channel is missing or the bot cannot see it.');
  const { door, times } = requireUnlocked(bot.ctx, guildId, ev.id, day);
  const msg = await channel.send(announcementMessage(ev, door, times.claimEndsAt, getConfig(bot.ctx, guildId).adventPolicy));
  markPosted(bot.ctx, guildId, ev.id, [day], channel.id, msg.id, false);
  return msg.url;
}

/** `/advent`: opens today's door (or the chosen day); on days without a door it shows the calendar. */
async function adventCmd(bot: Bot, i: ChatInput) {
  const day = i.options.getInteger('day');
  if (day === null) {
    const cal = calendar(bot.ctx, i.guildId, i.user.id);
    if (cal.today === null) return reply(i, { content: 'There is no door for today. Here is the calendar:', ...calendarView(bot, i.guildId, i.user.id, cal.event.id) });
    const t = cal.days[cal.today - 1]!;
    if (t.state === 'locked') {
      return reply(i, { content: `Today's door opens ${when(t.times.unlockAt)}. Here is the calendar:`, ...calendarView(bot, i.guildId, i.user.id, cal.event.id) });
    }
  }
  return reply(i, openResultMessage(openDoor(bot.ctx, i.guildId, i.user.id, day)));
}

export const adventHandlers: HandlerSet = {
  chat: {
    advent: adventCmd,
  },
  components: {
    advedit: editSubmit,
    adv: async (bot, i, [action, eventId, day]) => {
      if (action === 'open') return reply(i, openResultMessage(openDoor(bot.ctx, i.guildId, i.user.id, Number(day), eventId)));
      if (action === 'cal') return reply(i, calendarView(bot, i.guildId, i.user.id, eventId!));
      if (action === 'pick' && i.isStringSelectMenu()) {
        return reply(i, openResultMessage(openDoor(bot.ctx, i.guildId, i.user.id, Number(i.values[0]), eventId)));
      }
      if (action === 'reveal') {
        const { door } = requireUnlocked(bot.ctx, i.guildId, eventId!, Number(day));
        return reply(i, door.triviaAnswer ? `💡 **Answer:** ${door.triviaAnswer}` : 'This door has no trivia answer.');
      }
    },
  },
};

export type { Button };
