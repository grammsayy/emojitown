import { randomUUID } from 'node:crypto';
import { audit } from '../../domain/audit.js';
import { adjustCandy, candyLeaderboard, eventTotal, getBalance, getTxn, history, reverseTxn, type CandyTxn } from '../../domain/candy.js';
import { getConfig, updateConfig } from '../../domain/config.js';
import { tx } from '../../domain/context.js';
import { UserError } from '../../domain/errors.js';
import { requireEvent } from '../../domain/events.js';
import { askConfirm, reply, type Button, type ChatInput, type HandlerSet } from '../interaction.js';
import { assertLevel, type Bot } from '../runtime.js';
import { cid, COLORS, embed, field, pager, rankLabel } from '../ui.js';

const SOURCE_LABEL: Record<CandyTxn['source'], string> = {
  halloween: '🎃 Halloween',
  advent: '🎄 Advent',
  staff: '🛠️ Staff',
  reversal: '↩️ Reversal',
};

function txnLine(t: CandyTxn): string {
  const sign = t.amount > 0 ? '+' : '';
  return `\`#${t.id}\` <t:${Math.floor(t.createdAt / 1000)}:d> **${sign}${t.amount}** ${SOURCE_LABEL[t.source]}${t.reason ? ` · ${t.reason}` : ''} → ${t.balanceAfter}${
    t.reversedById ? ` *(reversed by #${t.reversedById})*` : ''
  }`;
}

function historyView(bot: Bot, guildId: string, userId: string, page: number, eventId: string | null) {
  const h = history(bot.ctx, guildId, userId, page, eventId);
  const e = embed(
    COLORS.candy,
    '🍬 Candy history',
    `<@${userId}> · balance **${getBalance(bot.ctx, guildId, userId)}**${eventId ? ` · event \`${eventId}\`` : ''}\n\n${h.items.map(txnLine).join('\n') || 'No candy activity yet.'}`,
  );
  return {
    embeds: [e],
    components: h.pages > 1 ? [pager(h, (n) => cid('candy', 'hist', userId, eventId ?? '-', n))] : [],
  };
}

function leaderboardView(bot: Bot, guildId: string, eventId: string | null, page: number) {
  const ev = eventId ? requireEvent(bot.ctx, guildId, eventId) : null;
  const lb = candyLeaderboard(bot.ctx, guildId, ev?.id ?? null, page);
  const lines = lb.items.map((r) => `**${rankLabel(r.rank)}** <@${r.row.userId}> · 🍬 ${r.row.amount}`);
  const e = embed(COLORS.candy, ev ? `🍬 Candy earned in ${ev.name}` : '🍬 Candy leaderboard (all-time balances)', lines.join('\n') || 'No candy yet.');
  return { embeds: [e], components: lb.pages > 1 ? [pager(lb, (n) => cid('candy', 'lb', ev?.id ?? '-', n))] : [] };
}

async function balance(bot: Bot, i: ChatInput) {
  const user = i.options.getUser('member') ?? i.user;
  await reply(i, { embeds: [embed(COLORS.candy, `🍬 ${user.displayName}`, `Balance: **${getBalance(bot.ctx, i.guildId, user.id)} candy**`)] });
}

async function rules(bot: Bot, i: ChatInput) {
  const cfg = getConfig(bot.ctx, i.guildId);
  const e = embed(COLORS.candy, '🍬 Candy rules').addFields(
    field('🎃 Trick or Treat', `**${cfg.candyPerHalloweenWin} candy** for each visitor you win, including duplicate items. Daily Halloween limit: **${cfg.candyHalloweenDailyLimit}**. Reaching the limit never stops your collection.`),
    field('🎄 Advent Calendar', 'Each door shows its own candy amount (usually 10). Each door pays out once.'),
    field('🛠️ Staff awards', 'Event staff can award candy for community activities.'),
    field('Not rewarded', 'Messages, voice time, reactions and snowball fights earn no candy.'),
    field('Persistence', 'Your balance carries over between events. Candy has no cash value and cannot be bought, sold or transferred.'),
  );
  await reply(i, { embeds: [e] });
}

async function setup(bot: Bot, i: ChatInput) {
  tx(bot.ctx, () => {
    const change = updateConfig(bot.ctx, i.guildId, {
      candyPerHalloweenWin: i.options.getInteger('halloween_per_win') ?? undefined,
      candyHalloweenDailyLimit: i.options.getInteger('halloween_daily_limit') ?? undefined,
    });
    if (Object.keys(change.after).length) audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'candy.setup', ...change });
  });
  const cfg = getConfig(bot.ctx, i.guildId);
  await reply(
    i,
    `🍬 Halloween: **${cfg.candyPerHalloweenWin}** per win, daily limit **${cfg.candyHalloweenDailyLimit}**. Changes apply to future rewards. Advent candy is set per door with \`/admin advent edit\`.`,
  );
}

async function adjust(bot: Bot, i: ChatInput) {
  const member = i.options.getUser('member', true);
  const amount = i.options.getInteger('amount', true);
  if (amount === 0) throw new UserError('The amount must not be zero.');
  const eventId = i.options.getString('event');
  if (eventId) requireEvent(bot.ctx, i.guildId, eventId);
  const balance = getBalance(bot.ctx, i.guildId, member.id);
  if (balance + amount < 0) throw new UserError(`That would leave a negative balance. ${member} has ${balance} candy.`);
  const payload = {
    userId: member.id,
    amount,
    label: i.options.getString('source', true),
    reason: i.options.getString('reason', true),
    eventId,
    nonce: randomUUID(),
  };
  await askConfirm(
    bot,
    i,
    'candy.adjust',
    payload,
    embed(COLORS.warn, `${amount > 0 ? 'Add' : 'Remove'} ${Math.abs(amount)} candy ${amount > 0 ? 'to' : 'from'} ${member.displayName}?`).addFields(
      field('Balance', `${balance} → ${balance + amount}`, true),
      field('Source', payload.label, true),
      field('Event', eventId ? `\`${eventId}\`` : 'none', true),
      field('Reason', payload.reason),
    ),
  );
}

async function reverse(bot: Bot, i: ChatInput) {
  const id = i.options.getInteger('transaction', true);
  const t = getTxn(bot.ctx, i.guildId, id);
  if (!t) throw new UserError(`No candy transaction #${id} in this server.`);
  if (t.reversedById) throw new UserError(`Transaction #${id} was already reversed by #${t.reversedById}.`);
  const balance = getBalance(bot.ctx, i.guildId, t.userId);
  if (balance - t.amount < 0) throw new UserError(`Reversing would leave <@${t.userId}> with a negative balance (${balance} − ${t.amount}).`);
  const reason = i.options.getString('reason', true);
  await askConfirm(
    bot,
    i,
    'candy.reverse',
    { id, reason },
    embed(COLORS.warn, `Reverse transaction #${id}?`, txnLine(t)).addFields(
      field('Member balance', `${balance} → ${balance - t.amount}`, true),
      field('Reason', reason),
    ),
  );
}

async function inspect(bot: Bot, i: ChatInput) {
  const member = i.options.getUser('member', true);
  const eventId = i.options.getString('event');
  const view = historyView(bot, i.guildId, member.id, 1, eventId);
  if (eventId) view.embeds[0]!.addFields(field('Net candy in this event', String(eventTotal(bot.ctx, i.guildId, member.id, eventId))));
  await reply(i, view);
}

export const candyHandlers: HandlerSet = {
  chat: {
    'candy balance': balance,
    'candy leaderboard': (bot, i) => reply(i, leaderboardView(bot, i.guildId, i.options.getString('event'), i.options.getInteger('page') ?? 1)),
    'candy history': (bot, i) => reply(i, historyView(bot, i.guildId, i.user.id, i.options.getInteger('page') ?? 1, null)),
    'candy rules': rules,
    'admin candy setup': setup,
    'admin candy adjust': adjust,
    'admin candy reverse': reverse,
    'staff candy inspect': inspect,
  },
  components: {
    candy: async (bot, i, [action, ...rest]) => {
      if (!i.isButton()) return;
      const btn = i as Button;
      if (action === 'lb') {
        const [eventId, page] = rest;
        return void (await btn.update(leaderboardView(bot, i.guildId, eventId === '-' ? null : eventId!, Number(page))));
      }
      if (action === 'hist') {
        const [userId, eventId, page] = rest;
        if (userId !== i.user.id) assertLevel(bot, i.member, 'moderator');
        return void (await btn.update(historyView(bot, i.guildId, userId!, Number(page), eventId === '-' ? null : eventId!)));
      }
    },
  },
  confirms: {
    'candy.adjust': {
      level: 'admin',
      run: async (bot, i, p) => {
        const t = adjustCandy(bot.ctx, { guildId: i.guildId, actorId: i.user.id, ...p });
        return `Saved as transaction #${t.id}. <@${t.userId}> now has **${t.balanceAfter}** candy.`;
      },
    },
    'candy.reverse': {
      level: 'admin',
      run: async (bot, i, p: { id: number; reason: string }) => {
        const t = reverseTxn(bot.ctx, i.guildId, p.id, p.reason, i.user.id);
        return `Reversed #${p.id} with transaction #${t.id}. <@${t.userId}> now has **${t.balanceAfter}** candy.`;
      },
    },
  },
};
