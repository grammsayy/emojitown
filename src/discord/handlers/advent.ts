import { ButtonStyle, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, ModalBuilder, ActionRowBuilder, type EmbedBuilder } from 'discord.js';
import {
  calendar,
  doorTimes,
  editDoor,
  getDoor,
  markPosted,
  openDoor,
  progress,
  publishCalendar,
  requireUnlocked,
  setClaimDeadline,
  validateCalendar,
  type Door,
  type DoorState,
  type OpenResult,
} from '../../domain/advent.js';
import { audit } from '../../domain/audit.js';
import { addChannel, getChannel, getConfig, updateConfig, type GuildConfig } from '../../domain/config.js';
import { consumePending, createPending } from '../../domain/confirmations.js';
import { tx } from '../../domain/context.js';
import { UserError } from '../../domain/errors.js';
import { requireEvent, type SeasonEvent } from '../../domain/events.js';
import { parseTime } from '../../util/time.js';
import { reply, type Button, type ChatInput, type Component, type HandlerSet, type Modal } from '../interaction.js';
import { assertLevel, fetchTextChannel, type Bot } from '../runtime.js';
import { button, cid, COLORS, embed, field, linkButton, row, when } from '../ui.js';

const STATE_ICON: Record<DoorState, string> = { locked: '🔒', available: '🎁', claimed: '✅', expired: '⌛' };

export function policyText(policy: GuildConfig['adventPolicy'], deadline: number | null): string {
  return policy === 'catch-up'
    ? `Missed a day? Earlier doors stay claimable until ${deadline ? when(deadline) : 'the claim deadline'}. After that, their content stays readable.`
    : 'Each door can be claimed on its own day only, until local midnight. After that, its content stays readable.';
}

function doorEmbed(ev: SeasonEvent, door: Door): EmbedBuilder {
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

function openResultMessage(r: OpenResult) {
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

function calendarView(bot: Bot, guildId: string, userId: string, eventId: string | null) {
  const cal = calendar(bot.ctx, guildId, userId, eventId);
  const lines = cal.days.map(
    (d) => `${STATE_ICON[d.state]} **${d.day}**${d.state === 'locked' ? ` · opens ${when(d.times.unlockAt)}` : d.title ? ` · ${d.title}` : ''}`,
  );
  const deadline = cal.days.length ? cal.days[cal.days.length - 1]!.times.claimEndsAt : null;
  const e = embed(COLORS.advent, `📅 ${cal.event.name}`, lines.join('\n'))
    .addFields(field('Legend', '🎁 available · ✅ claimed · ⌛ expired (readable, no reward) · 🔒 locked'), field('Catch-up policy', policyText(cal.policy, deadline)));
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
  const e = embed(COLORS.advent, `🎁 Door ${door.day} is open!`, `**${door.title}**\n\nPress **Open Door** or use \`/advent open\` to see today's surprise${door.candy ? ` and collect **${door.candy} candy**` : ''}.`)
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

async function setup(bot: Bot, i: ChatInput) {
  const o = i.options;
  const unlock = o.getString('unlock_time');
  const announce = o.getString('announce_time');
  const unlockTime = unlock !== null ? parseTime(unlock) : undefined;
  const announceTime = announce !== null ? parseTime(announce) : undefined;
  if (unlockTime === null || announceTime === null) throw new UserError('Times must look like 09:00.');
  const cfg = getConfig(bot.ctx, i.guildId);
  if ((announceTime ?? cfg.adventAnnounceTime) < (unlockTime ?? cfg.adventUnlockTime)) {
    throw new UserError('The announcement time must be at or after the unlock time, so the posted door is already open.');
  }
  const channel = o.getChannel('channel');
  const eventId = o.getString('event');
  const deadline = o.getString('claim_deadline');
  if (deadline && !eventId) throw new UserError('Pick the `event` whose claim deadline you want to set.');
  tx(bot.ctx, () => {
    const change = updateConfig(bot.ctx, i.guildId, {
      adventDoorCount: o.getInteger('doors') ?? undefined,
      adventUnlockTime: unlockTime,
      adventAnnounceTime: announceTime,
      adventPolicy: (o.getString('policy') as GuildConfig['adventPolicy'] | null) ?? undefined,
    });
    let previous: string[] = [];
    if (channel) previous = addChannel(bot.ctx, i.guildId, 'advent', channel.id);
    if (Object.keys(change.after).length || channel) {
      audit(bot.ctx, {
        guildId: i.guildId,
        actorId: i.user.id,
        action: 'advent.setup',
        before: { ...change.before, ...(channel ? { channel: previous[0] ?? null } : {}) },
        after: { ...change.after, ...(channel ? { channel: channel.id } : {}) },
      });
    }
    if (eventId && deadline) setClaimDeadline(bot.ctx, i.guildId, eventId, deadline, i.user.id);
  });
  const c = getConfig(bot.ctx, i.guildId);
  const ch = getChannel(bot.ctx, i.guildId, 'advent');
  const e = embed(COLORS.staff, '🎄 Advent setup').addFields(
    field('Channel', ch ? `<#${ch}>` : 'Not set', true),
    field('Doors', String(c.adventDoorCount), true),
    field('Unlock / announce', `${c.adventUnlockTime} / ${c.adventAnnounceTime} (${c.timezone})`, true),
    field('Policy', policyText(c.adventPolicy, null)),
  );
  if (eventId) {
    const ev = requireEvent(bot.ctx, i.guildId, eventId, 'advent');
    e.addFields(field('Claim deadline', `\`${ev.id}\`: ${ev.claimDeadlineLocal?.replace('T', ' ') ?? 'end of event'} (${c.timezone})`));
  }
  await reply(i, { embeds: [e] });
}

async function edit(bot: Bot, i: ChatInput) {
  const day = i.options.getInteger('day', true);
  const ev = requireEvent(bot.ctx, i.guildId, i.options.getString('event', true), 'advent');
  if (ev.state === 'ended') throw new UserError('This Advent event has ended and its content is frozen.');
  const reason = i.options.getString('reason');
  if (ev.adventPublishedAt && !reason) throw new UserError('This calendar is published. Add a `reason` to record this correction.');
  const existing = getDoor(bot.ctx, i.guildId, ev.id, day);
  const token = createPending(bot.ctx, i.guildId, i.user.id, 'advent.edit', {
    eventId: ev.id,
    day,
    candy: i.options.getInteger('candy') ?? existing?.candy ?? null,
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
  await reply(m, { content: `Saved door ${door.day} (🍬 ${door.candy} candy). Preview:`, embeds: [doorEmbed(ev, door)] });
}

async function previewCmd(bot: Bot, i: ChatInput) {
  const ev = requireEvent(bot.ctx, i.guildId, i.options.getString('event', true), 'advent');
  const day = i.options.getInteger('day', true);
  const door = getDoor(bot.ctx, i.guildId, ev.id, day);
  if (!door) throw new UserError(`Door ${day} has no content yet. Use \`/admin advent edit\`.`);
  const cfg = getConfig(bot.ctx, i.guildId);
  const t = doorTimes(ev, cfg, day);
  const e = doorEmbed(ev, door).addFields(
    field('Reward', door.candy ? `🍬 ${door.candy} candy` : 'No candy'),
    field('Unlocks', when(t.unlockAt), true),
    field('Claim by', when(t.claimEndsAt), true),
  );
  if (door.triviaAnswer) e.addFields(field('Trivia answer (hidden behind Reveal Answer)', `||${door.triviaAnswer}||`));
  await reply(i, { content: '**Preview** (no claim or reward saved):', embeds: [e] });
}

async function validateCmd(bot: Bot, i: ChatInput) {
  const eventId = i.options.getString('event', true);
  const issues = validateCalendar(bot.ctx, i.guildId, eventId);
  const ev = requireEvent(bot.ctx, i.guildId, eventId, 'advent');
  if (!getChannel(bot.ctx, i.guildId, 'advent')) issues.unshift('No Advent channel is configured.');
  await reply(i, {
    embeds: [
      embed(
        issues.length ? COLORS.warn : COLORS.hit,
        issues.length ? `${issues.length} problem${issues.length === 1 ? '' : 's'} found` : 'Calendar looks good ✅',
        issues.length
          ? `• ${issues.slice(0, 40).join('\n• ')}`
          : ev.adventPublishedAt
            ? 'This calendar is published.'
            : 'Run `/admin advent publish` to freeze it for release.',
      ),
    ],
  });
}

async function publish(bot: Bot, i: ChatInput) {
  const ev = publishCalendar(bot.ctx, i.guildId, i.options.getString('event', true), i.user.id);
  await reply(i, `📅 Published **${ev.name}**. Later changes need a reason and never re-award earlier claims.`);
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

async function postCmd(bot: Bot, i: ChatInput) {
  const ev = requireEvent(bot.ctx, i.guildId, i.options.getString('event', true), 'advent');
  const url = await postDoor(bot, i.guildId, ev, i.options.getInteger('day', true));
  audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'advent.post', eventId: ev.id, after: { day: i.options.getInteger('day', true), url } });
  await reply(i, `Posted: ${url}`);
}

async function progressCmd(bot: Bot, i: ChatInput) {
  const p = progress(bot.ctx, i.guildId, i.user.id, i.options.getString('event'));
  const e = embed(COLORS.advent, `🎄 Your Advent progress: ${p.event.name}`).addFields(
    field('Doors opened', `${p.claimedDays.length}/${p.doorCount}`, true),
    field('Advent candy earned', `🍬 ${p.candy}`, true),
    field('Claimed days', p.claimedDays.join(', ') || 'None yet'),
  );
  await reply(i, { embeds: [e] });
}

export const adventHandlers: HandlerSet = {
  chat: {
    'advent calendar': (bot, i) => reply(i, calendarView(bot, i.guildId, i.user.id, i.options.getString('event'))),
    'advent open': (bot, i) => reply(i, openResultMessage(openDoor(bot.ctx, i.guildId, i.user.id, i.options.getInteger('day'), i.options.getString('event')))),
    'advent progress': progressCmd,
    'admin advent setup': setup,
    'admin advent edit': edit,
    'staff advent preview': previewCmd,
    'staff advent validate': validateCmd,
    'admin advent publish': publish,
    'staff advent post': postCmd,
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
