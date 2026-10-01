import { ButtonStyle, type User } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { adjustCandy, candyLeaderboard, getBalance, getTxn, history, reverseTxn, type CandyTxn } from '../../domain/candy.js';
import { getConfig } from '../../domain/config.js';
import { UserError } from '../../domain/errors.js';
import { requireEvent } from '../../domain/events.js';
import { askConfirm, reply, type Button, type ChatInput, type HandlerSet } from '../interaction.js';
import { assertLevel, type Bot } from '../runtime.js';
import { button, cid, COLORS, embed, field, pager, rankLabel, row } from '../ui.js';

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

export function historyView(bot: Bot, guildId: string, userId: string, page: number, eventId: string | null) {
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

export function leaderboardView(bot: Bot, guildId: string, eventId: string | null, page: number) {
  const ev = eventId ? requireEvent(bot.ctx, guildId, eventId) : null;
  const lb = candyLeaderboard(bot.ctx, guildId, ev?.id ?? null, page);
  const lines = lb.items.map((r) => `**${rankLabel(r.rank)}** <@${r.row.userId}> · 🍬 ${r.row.amount}`);
  const e = embed(COLORS.candy, ev ? `🍬 Candy earned in ${ev.name}` : '🍬 Candy leaderboard (all-time balances)', lines.join('\n') || 'No candy yet.');
  return { embeds: [e], components: lb.pages > 1 ? [pager(lb, (n) => cid('candy', 'lb', ev?.id ?? '-', n))] : [] };
}

async function balance(bot: Bot, i: ChatInput) {
  const user = i.options.getUser('member') ?? i.user;
  const own = user.id === i.user.id;
  const buttons = [button(cid('candy', 'rules'), 'How to earn candy', ButtonStyle.Secondary, '❓')];
  if (own) buttons.unshift(button(cid('candy', 'hist', user.id, '-', 1), 'My history', ButtonStyle.Secondary, '📜'));
  await reply(i, {
    embeds: [embed(COLORS.candy, `🍬 ${user.displayName}`, `Balance: **${getBalance(bot.ctx, i.guildId, user.id)} candy**`)],
    components: [row(...buttons)],
  });
}

function rulesEmbed(bot: Bot, guildId: string) {
  const cfg = getConfig(bot.ctx, guildId);
  return embed(COLORS.candy, '🍬 Candy rules').addFields(
    field('🎃 Trick or Treat', `**${cfg.candyPerHalloweenWin} candy** for each visitor you win, including duplicate items. Daily Halloween limit: **${cfg.candyHalloweenDailyLimit}**. Reaching the limit never stops your collection.`),
    field('🎄 Advent Calendar', 'Each door shows its own candy amount (usually 10). Each door pays out once.'),
    field('🛠️ Staff awards', 'Event staff can award candy for community activities.'),
    field('Not rewarded', 'Messages, voice time, reactions and snowball fights earn no candy.'),
    field('Persistence', 'Your balance carries over between events. Candy has no cash value and cannot be bought, sold or transferred.'),
  );
}

/** Shows a give/take candy preview with Confirm/Cancel. */
export async function askGiveCandy(bot: Bot, i: ChatInput, member: User, amount: number, reason: string) {
  if (amount === 0) throw new UserError('The amount must not be zero.');
  const eventId: string | null = null;
  const balance = getBalance(bot.ctx, i.guildId, member.id);
  if (balance + amount < 0) throw new UserError(`That would leave a negative balance. ${member} has ${balance} candy.`);
  const payload = {
    userId: member.id,
    amount,
    label: amount > 0 ? 'Staff award' : 'Staff correction',
    reason,
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
      field('Reason', payload.reason),
    ),
  );
}

export async function askUndoCandy(bot: Bot, i: ChatInput, id: number, reason: string) {
  const t = getTxn(bot.ctx, i.guildId, id);
  if (!t) throw new UserError(`No candy transaction #${id} in this server.`);
  if (t.reversedById) throw new UserError(`Transaction #${id} was already reversed by #${t.reversedById}.`);
  const balance = getBalance(bot.ctx, i.guildId, t.userId);
  if (balance - t.amount < 0) throw new UserError(`Undoing it would leave <@${t.userId}> with a negative balance (${balance} − ${t.amount}).`);
  await askConfirm(
    bot,
    i,
    'candy.reverse',
    { id, reason },
    embed(COLORS.warn, `Undo transaction #${id}?`, txnLine(t)).addFields(
      field('Member balance', `${balance} → ${balance - t.amount}`, true),
      field('Reason', reason),
    ),
  );
}

export const candyHandlers: HandlerSet = {
  chat: {
    candy: balance,
  },
  components: {
    candy: async (bot, i, [action, ...rest]) => {
      if (!i.isButton()) return;
      const btn = i as Button;
      if (action === 'rules') return reply(i, { embeds: [rulesEmbed(bot, i.guildId)] });
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
        return `**<@${t.userId}>'s candy:** ${t.balanceAfter - t.amount} → ${t.balanceAfter} (transaction #${t.id}).`;
      },
    },
    'candy.reverse': {
      level: 'admin',
      run: async (bot, i, p: { id: number; reason: string }) => {
        const t = reverseTxn(bot.ctx, i.guildId, p.id, p.reason, i.user.id);
        return `Undid #${p.id}. **<@${t.userId}>'s candy:** ${t.balanceAfter - t.amount} → ${t.balanceAfter} (transaction #${t.id}).`;
      },
    },
  },
};
