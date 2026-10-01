import { ButtonStyle, PermissionFlagsBits, UserSelectMenuBuilder, type GuildMember, type GuildTextBasedChannel, type User } from 'discord.js';
import { getChannels } from '../../domain/config.js';
import { fill } from '../../domain/content.js';
import { UserError } from '../../domain/errors.js';
import { getCurrentOrLatestEvent } from '../../domain/events.js';
import { isSnowballOptedOut, setSnowballParticipation } from '../../domain/members.js';
import {
  applyCorrection,
  collect,
  collectReadyAt,
  getPlayer,
  leaderboard,
  packFor,
  planCorrection,
  stats,
  throwSnowball,
  WARMUP_MS,
  type CorrectionField,
  type CorrectionPlan,
} from '../../domain/snowball.js';
import { getPack } from '../../domain/content.js';
import { discordTime } from '../../util/time.js';
import { askConfirm, publicReply, reply, type Button, type ChatInput, type Component, type HandlerSet } from '../interaction.js';
import type { Bot } from '../runtime.js';
import { button, cid, COLORS, embed, field, pager, rankLabel, row, withImage } from '../ui.js';

function assertSnowballChannel(bot: Bot, guildId: string, channelId: string): void {
  const channels = getChannels(bot.ctx, guildId, 'snowball');
  if (!channels.includes(channelId)) {
    throw new UserError(
      channels.length ? `Snowball fights happen in ${channels.map((c) => `<#${c}>`).join(', ')}. Head over there to play!` : 'No snowball channel is set up yet.',
    );
  }
}

/** Rejects bots, departed members and members who can't see the playing channel, before anything is spent. */
function validateTarget(user: User, member: GuildMember | null, channel: GuildTextBasedChannel | null): GuildMember {
  if (user.bot) throw new UserError("Bots don't play in the snow. Pick a member instead!");
  if (!member) throw new UserError("That member isn't in the server. Pick someone else.");
  if (channel && !member.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel)) {
    throw new UserError("That member can't see this channel, so they can't dodge! Pick someone who's here.");
  }
  return member;
}

const throwButton = () => button(cid('sb', 'throw'), 'Throw', ButtonStyle.Primary, '❄️');
const collectButton = () => button(cid('sb', 'collect'), 'Collect', ButtonStyle.Secondary, '🧤');

async function doCollect(bot: Bot, i: ChatInput | Component): Promise<void> {
  assertSnowballChannel(bot, i.guildId, i.channelId!);
  const r = collect(bot.ctx, i.guildId, i.user.id);
  const pack = packFor(bot.ctx, r.event);
  const e = withImage(embed(COLORS.snow, 'Snowball collected! ❄️', r.message), pack.images.collect).addFields(
    field('Snowballs', String(r.stats.snowballs), true),
    field('Next collect', discordTime(r.stats.nextCollectAt, 'R'), true),
  );
  await reply(i, { embeds: [e], components: [row(throwButton())] });
}

async function doThrow(bot: Bot, i: ChatInput | Component, target: User, member: GuildMember | null): Promise<void> {
  assertSnowballChannel(bot, i.guildId, i.channelId!);
  validateTarget(target, member, i.channel);
  const r = throwSnowball(bot.ctx, i.guildId, i.user.id, target.id);
  const e = withImage(embed(r.hit ? COLORS.hit : COLORS.miss, r.hit ? 'Direct hit! 🎯' : 'Missed! 💨', r.message), r.image).addFields(
    field(`${i.user.displayName} has`, `${r.thrower.snowballs} snowball${r.thrower.snowballs === 1 ? '' : 's'} left`, true),
  );
  if (r.hit) e.addFields(field('Warming up', `${target} can collect again ${discordTime(r.target.warmUntil, 'R')}`, true));
  await publicReply(i, { embeds: [e], components: [row(collectButton())] }, r.hit ? [target.id] : []);
}

async function statsCmd(bot: Bot, i: ChatInput): Promise<void> {
  const target = i.options.getUser('member') ?? i.user;
  const { event, stats: s } = stats(bot.ctx, i.guildId, target.id, i.options.getString('season'));
  const readyAt = collectReadyAt(s);
  const now = bot.ctx.now();
  const availability =
    event.state !== 'active' ? `Not available (${event.state})` : readyAt <= now ? 'Ready now' : `${discordTime(readyAt, 'R')}${s.warmUntil > now ? ' (warming up)' : ''}`;
  const e = embed(COLORS.snow, `❄️ Snowball stats: ${target.displayName}`, `Event: **${event.name}** (\`${event.id}\`)`).addFields(
    field('Hits', String(s.hits), true),
    field('Misses', String(s.misses), true),
    field('KOs received', String(s.kosReceived), true),
    field('Snowballs available', String(s.snowballs), true),
    field('Total collected', String(s.collected), true),
    field('Collect', availability, true),
  );
  await reply(i, { embeds: [e] });
}

export function leaderboardView(bot: Bot, guildId: string, eventId: string | null, page: number) {
  const { event, page: p } = leaderboard(bot.ctx, guildId, eventId, page);
  const lines = p.items.map((r) => `**${rankLabel(r.rank)}** <@${r.row.userId}> · ${r.row.hits} hit${r.row.hits === 1 ? '' : 's'}`);
  const e = embed(COLORS.snow, `🏆 Snowball leaderboard: ${event.name}`, lines.join('\n') || 'No hits yet. Be the first!');
  return { embeds: [e], components: p.pages > 1 ? [pager(p, (n) => cid('sb', 'lb', event.id, n))] : [] };
}

async function participation(bot: Bot, i: ChatInput, join: boolean): Promise<void> {
  const wasIn = !isSnowballOptedOut(bot.ctx, i.guildId, i.user.id);
  setSnowballParticipation(bot.ctx, i.guildId, i.user.id, join);
  if (wasIn === join) {
    await reply(i, join ? "You're already playing snowball fights. Nothing changed. Use `/collect` to make a snowball! ❄️" : "You'd already left snowball fights. Nothing changed. Use `/snowball join` to play again.");
    return;
  }
  await reply(
    i,
    join
      ? "**Snowball fights: left → playing.** You're back in! Use `/collect` to make a snowball. ❄️"
      : "**Snowball fights: playing → left.** Nobody can throw at you and you can't throw. Your stats are saved. Use `/snowball join` to come back.",
  );
}

/** Every snowball message with the current branding, for staff previews. */
export function snowballPreview(bot: Bot, guildId: string, userMention: string, botMention: string) {
  const ev = getCurrentOrLatestEvent(bot.ctx, guildId, 'snowball');
  const pack = ev ? packFor(bot.ctx, ev) : getPack(bot.ctx, guildId, 'snowball');
  const vars = { thrower: userMention, target: botMention, when: discordTime(bot.ctx.now() + WARMUP_MS, 'R'), count: 3, s: 's' };
  return [
    withImage(embed(COLORS.snow, 'Snowball collected! ❄️', fill(pack.collect, vars)), pack.images.collect),
    withImage(embed(COLORS.hit, 'Direct hit! 🎯', fill(pack.hit[0]!, vars)), pack.images.hit),
    withImage(embed(COLORS.miss, 'Missed! 💨', fill(pack.miss[0]!, vars)), pack.images.miss),
    embed(COLORS.snow, 'Warming up', fill(pack.warmup, vars)),
  ];
}

/** Shows a before/after preview of a snowball stat correction with Confirm/Cancel. */
export async function askStatsFix(bot: Bot, i: ChatInput, eventId: string, member: User, statField: CorrectionField, value: number, reason: string): Promise<void> {
  const plan = planCorrection(bot.ctx, i.guildId, eventId, member.id, statField, value);
  const fmt = (s: CorrectionPlan['before']) =>
    `hits ${s.hits} · misses ${s.misses} · KOs received ${s.kosReceived} · collected ${s.collected} · available ${s.snowballs}`;
  await askConfirm(
    bot,
    i,
    'snowball.correct',
    { plan, reason },
    embed(COLORS.warn, `Change ${member.displayName}'s snowball stats?`, `Season \`${plan.eventId}\``).addFields(
      field('Before', fmt(plan.before)),
      field('After', fmt(plan.after)),
      field('Reason', reason),
    ),
  );
}

export const snowballHandlers: HandlerSet = {
  chat: {
    collect: (bot, i) => doCollect(bot, i),
    throw: (bot, i) => doThrow(bot, i, i.options.getUser('target', true), i.options.getMember('target')),
    stats: statsCmd,
    'snowball join': (bot, i) => participation(bot, i, true),
    'snowball leave': (bot, i) => participation(bot, i, false),
  },
  components: {
    sb: async (bot, i, [action, ...rest]) => {
      if (action === 'collect') return doCollect(bot, i);
      if (action === 'throw') {
        if (isSnowballOptedOut(bot.ctx, i.guildId, i.user.id)) {
          throw new UserError("You've opted out of snowball fights. Use `/snowball join` to play again.");
        }
        return reply(i, {
          content: 'Who do you want to throw at?',
          components: [row(new UserSelectMenuBuilder().setCustomId(cid('sb', 'target')).setPlaceholder('Pick a target').setMaxValues(1))],
        });
      }
      if (action === 'target' && i.isUserSelectMenu()) {
        const user = i.users.first()!;
        return doThrow(bot, i, user, await i.guild.members.fetch(user.id).catch(() => null));
      }
      if (action === 'lb' && i.isButton()) {
        const [eventId, page] = rest;
        return void (await (i as Button).update(leaderboardView(bot, i.guildId, eventId!, Number(page))));
      }
    },
  },
  confirms: {
    'snowball.correct': {
      level: 'admin',
      run: async (bot, i, { plan, reason }: { plan: CorrectionPlan; reason: string }) => {
        applyCorrection(bot.ctx, i.guildId, plan, reason, i.user.id);
        const after = getPlayer(bot.ctx, i.guildId, plan.eventId, plan.userId)!;
        return `Saved. <@${plan.userId}>'s snowball stats are now: hits ${after.hits} · misses ${after.misses} · KOs received ${after.kosReceived} · collected ${after.collected} · available ${after.snowballs}.`;
      },
    },
  },
};
