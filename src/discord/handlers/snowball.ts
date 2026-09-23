import { ButtonStyle, PermissionFlagsBits, UserSelectMenuBuilder, type GuildMember, type GuildTextBasedChannel, type User } from 'discord.js';
import { addChannel, getChannels, removeChannel } from '../../domain/config.js';
import { fill } from '../../domain/content.js';
import { UserError } from '../../domain/errors.js';
import { getCurrentOrLatestEvent } from '../../domain/events.js';
import { isSnowballOptedOut, setSnowballParticipation } from '../../domain/members.js';
import {
  applyCorrection,
  clearWarmup,
  collect,
  COLLECT_COOLDOWN_MS,
  collectReadyAt,
  HIT_CHANCE,
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
import { audit } from '../../domain/audit.js';
import { tx } from '../../domain/context.js';
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
  const target = i.options.getUser('target') ?? i.user;
  const { event, stats: s } = stats(bot.ctx, i.guildId, target.id, i.options.getString('event'));
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

function leaderboardView(bot: Bot, guildId: string, eventId: string | null, page: number) {
  const { event, page: p } = leaderboard(bot.ctx, guildId, eventId, page);
  const lines = p.items.map((r) => `**${rankLabel(r.rank)}** <@${r.row.userId}> · ${r.row.hits} hit${r.row.hits === 1 ? '' : 's'}`);
  const e = embed(COLORS.snow, `🏆 Snowball leaderboard: ${event.name}`, lines.join('\n') || 'No hits yet. Be the first!');
  return { embeds: [e], components: p.pages > 1 ? [pager(p, (n) => cid('sb', 'lb', event.id, n))] : [] };
}

async function participation(bot: Bot, i: ChatInput): Promise<void> {
  const on = i.options.getString('state', true) === 'on';
  setSnowballParticipation(bot.ctx, i.guildId, i.user.id, on);
  await reply(
    i,
    on
      ? "You're in! Use `/collect` to make a snowball. ❄️"
      : "You've opted out of snowball fights. Nobody can throw at you and you can't throw. Your stats are saved. Use `/snowball participation state:on` to rejoin.",
  );
}

async function setup(bot: Bot, i: ChatInput): Promise<void> {
  const add = i.options.getChannel('add_channel');
  const remove = i.options.getChannel('remove_channel');
  tx(bot.ctx, () => {
    if (add) {
      addChannel(bot.ctx, i.guildId, 'snowball', add.id);
      audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'channel.add', after: { feature: 'snowball', channel: add.id } });
    }
    if (remove) {
      removeChannel(bot.ctx, i.guildId, 'snowball', remove.id);
      audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'channel.remove', before: { feature: 'snowball', channel: remove.id } });
    }
  });
  const ev = getCurrentOrLatestEvent(bot.ctx, i.guildId, 'snowball');
  const pack = ev ? packFor(bot.ctx, ev) : getPack(bot.ctx, i.guildId, 'snowball');
  const channels = getChannels(bot.ctx, i.guildId, 'snowball');
  const e = embed(COLORS.staff, '❄️ Snowball setup').addFields(
    field('Playing channels', channels.map((c) => `<#${c}>`).join(', ') || 'None. Add one with `add_channel`.'),
    field(
      'Fixed gameplay rules',
      `• Collect cooldown: **${COLLECT_COOLDOWN_MS / 1000} seconds**\n• Warm-up after being hit: **${WARMUP_MS / 1000} seconds** (stored snowballs can still be thrown)\n• Hit chance: **${HIT_CHANCE * 100}%**\n• Each throw costs one snowball`,
    ),
    field(
      'Branding',
      `${pack.hit.length} hit and ${pack.miss.length} miss messages · artwork: ${
        ['collect', 'hit', 'miss'].filter((k) => pack.images[k as 'hit']).join(', ') || 'none (text only)'
      }\nReplace with \`/season content feature:snowball action:import\`.`,
    ),
  );
  await reply(i, { embeds: [e] });
}

async function preview(bot: Bot, i: ChatInput): Promise<void> {
  const outcome = i.options.getString('outcome', true);
  const ev = getCurrentOrLatestEvent(bot.ctx, i.guildId, 'snowball');
  const pack = ev ? packFor(bot.ctx, ev) : getPack(bot.ctx, i.guildId, 'snowball');
  const vars = { thrower: `${i.user}`, target: `${i.client.user}`, when: discordTime(bot.ctx.now() + WARMUP_MS, 'R'), count: 3, s: 's' };
  let e;
  if (outcome === 'hit') e = withImage(embed(COLORS.hit, 'Direct hit! 🎯', fill(pack.hit[0]!, vars)), pack.images.hit);
  else if (outcome === 'miss') e = withImage(embed(COLORS.miss, 'Missed! 💨', fill(pack.miss[0]!, vars)), pack.images.miss);
  else if (outcome === 'warmup') e = embed(COLORS.snow, 'Warming up', fill(pack.warmup, vars));
  else e = withImage(embed(COLORS.snow, 'Snowball collected! ❄️', fill(pack.collect, vars)), pack.images.collect);
  await reply(i, { content: '**Preview** (nothing was saved):', embeds: [e] });
}

async function correct(bot: Bot, i: ChatInput): Promise<void> {
  const member = i.options.getUser('member', true);
  const plan = planCorrection(
    bot.ctx,
    i.guildId,
    i.options.getString('event', true),
    member.id,
    i.options.getString('field', true) as CorrectionField,
    i.options.getInteger('value', true),
  );
  const reason = i.options.getString('reason', true);
  const fmt = (s: CorrectionPlan['before']) =>
    `hits ${s.hits} · misses ${s.misses} · KOs received ${s.kosReceived} · collected ${s.collected} · available ${s.snowballs}`;
  await askConfirm(
    bot,
    i,
    'snowball.correct',
    { plan, reason },
    embed(COLORS.warn, `Correct ${member.displayName}'s snowball stats?`, `Event \`${plan.eventId}\``).addFields(
      field('Before', fmt(plan.before)),
      field('After', fmt(plan.after)),
      field('Reason', reason),
    ),
  );
}

async function clearWarm(bot: Bot, i: ChatInput): Promise<void> {
  const member = i.options.getUser('member', true);
  clearWarmup(bot.ctx, i.guildId, member.id, i.options.getString('reason', true), i.user.id);
  await reply(i, `Cleared ${member}'s warm-up. They can collect again now.`);
}

export const snowballHandlers: HandlerSet = {
  chat: {
    collect: (bot, i) => doCollect(bot, i),
    throw: (bot, i) => doThrow(bot, i, i.options.getUser('target', true), i.options.getMember('target')),
    stats: statsCmd,
    leaderboard: async (bot, i) => reply(i, leaderboardView(bot, i.guildId, i.options.getString('event'), i.options.getInteger('page') ?? 1)),
    'snowball participation': participation,
    'snowball setup': setup,
    'snowball preview': preview,
    'snowball correct': correct,
    'snowball clear-warmup': clearWarm,
  },
  components: {
    sb: async (bot, i, [action, ...rest]) => {
      if (action === 'collect') return doCollect(bot, i);
      if (action === 'throw') {
        if (isSnowballOptedOut(bot.ctx, i.guildId, i.user.id)) {
          throw new UserError("You've opted out of snowball fights. Use `/snowball participation state:on` to join in again.");
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
        return `Saved. <@${plan.userId}>'s \`${plan.field}\` is now corrected in \`${plan.eventId}\`.`;
      },
    },
  },
};
