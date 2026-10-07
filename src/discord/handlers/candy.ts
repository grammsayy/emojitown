import { ButtonStyle, type User } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { adjustCandy, candyLeaderboard, getBalance, getTxn, history, reverseTxn, type CandyTxn } from '../../domain/candy.js';
import { getConfig } from '../../domain/config.js';
import { UserError } from '../../domain/errors.js';
import { requireEvent } from '../../domain/events.js';
import { currencyFor, currencyTitle } from '../../domain/currency.js';
import { askConfirm, reply, type Button, type ChatInput, type HandlerSet } from '../interaction.js';
import { assertLevel, memberName, type Bot } from '../runtime.js';
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
  const c = currencyFor(bot.ctx, guildId);
  const e = embed(
    COLORS.candy,
    `${c.emoji} ${currencyTitle(c)} history`,
    `${memberName(bot, guildId, userId)} · balance **${getBalance(bot.ctx, guildId, userId)}**${eventId ? ` · event \`${eventId}\`` : ''}\n\n${h.items.map(txnLine).join('\n') || `No ${c.name} activity yet.`}`,
  );
  return {
    embeds: [e],
    components: h.pages > 1 ? [pager(h, (n) => cid('candy', 'hist', userId, eventId ?? '-', n))] : [],
  };
}

export function leaderboardView(bot: Bot, guildId: string, eventId: string | null, page: number) {
  const ev = eventId ? requireEvent(bot.ctx, guildId, eventId) : null;
  const lb = candyLeaderboard(bot.ctx, guildId, ev?.id ?? null, page);
  const c = currencyFor(bot.ctx, guildId, ev?.feature);
  const lines = lb.items.map((r) => `**${rankLabel(r.rank)}** ${memberName(bot, guildId, r.row.userId)} · ${c.emoji} ${r.row.amount}`);
  const e = embed(
    COLORS.candy,
    ev ? `${c.emoji} ${currencyTitle(c)} earned in ${ev.name}` : `${c.emoji} ${currencyTitle(c)} leaderboard (all-time balances)`,
    lines.join('\n') || `No ${c.name} yet.`,
  );
  return { embeds: [e], components: lb.pages > 1 ? [pager(lb, (n) => cid('candy', 'lb', ev?.id ?? '-', n))] : [] };
}

async function balance(bot: Bot, i: ChatInput) {
  const user = i.options.getUser('member') ?? i.user;
  const own = user.id === i.user.id;
  const c = currencyFor(bot.ctx, i.guildId);
  const buttons = [button(cid('candy', 'rules'), `How to earn ${c.name}`.slice(0, 80), ButtonStyle.Secondary, '❓')];
  if (own) buttons.unshift(button(cid('candy', 'hist', user.id, '-', 1), 'My history', ButtonStyle.Secondary, '📜'));
  await reply(i, {
    embeds: [embed(COLORS.candy, `${c.emoji} ${user.displayName}`, `Balance: **${getBalance(bot.ctx, i.guildId, user.id)} ${c.name}**`)],
    components: [row(...buttons)],
  });
}

function rulesEmbed(bot: Bot, guildId: string) {
  const cfg = getConfig(bot.ctx, guildId);
  const c = currencyFor(bot.ctx, guildId);
  const hw = currencyFor(bot.ctx, guildId, 'halloween');
  const adv = currencyFor(bot.ctx, guildId, 'advent');
  return embed(COLORS.candy, `${c.emoji} ${currencyTitle(c)} rules`).addFields(
    field('🎃 Trick or Treat', `**${cfg.candyPerHalloweenWin} ${hw.name}** for each visitor you win, including duplicate items. Daily Halloween limit: **${cfg.candyHalloweenDailyLimit}**. Reaching the limit never stops your collection.`),
    field('🎄 Advent Calendar', `Each door shows its own ${adv.name} amount (usually 10). Each door pays out once.`),
    field('🛠️ Staff awards', `Event staff can award ${c.name} for community activities.`),
    field('Not rewarded', `Messages, voice time, reactions and snowball fights earn no ${c.name}.`),
    field('Persistence', `Your balance carries over between events.${sameBalance(bot, guildId)} It has no cash value and cannot be bought, sold or transferred.`),
  );
}

/** " Candy, candy corn and cookies are all the same balance." when seasonal names are set; otherwise nothing. */
function sameBalance(bot: Bot, guildId: string): string {
  const names = [...new Set([null, 'halloween', 'snowball', 'advent'].map((g) => currencyFor(bot.ctx, guildId, g as never).name))];
  if (names.length < 2) return '';
  const list = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return ` ${list.charAt(0).toUpperCase()}${list.slice(1)} are all the same balance under seasonal names.`;
}

/** Shows a give/take candy preview with Confirm/Cancel. */
export async function askGiveCandy(bot: Bot, i: ChatInput, member: User, amount: number, reason: string) {
  if (amount === 0) throw new UserError('The amount must not be zero.');
  const eventId: string | null = null;
  const balance = getBalance(bot.ctx, i.guildId, member.id);
  const c = currencyFor(bot.ctx, i.guildId);
  if (balance + amount < 0) throw new UserError(`That would leave a negative balance. ${member} has ${balance} ${c.name}.`);
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
    embed(COLORS.warn, `${amount > 0 ? 'Add' : 'Remove'} ${Math.abs(amount)} ${c.name} ${amount > 0 ? 'to' : 'from'} ${member.displayName}?`).addFields(
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
        return `**<@${t.userId}>'s ${currencyFor(bot.ctx, i.guildId).name}:** ${t.balanceAfter - t.amount} → ${t.balanceAfter} (transaction #${t.id}).`;
      },
    },
    'candy.reverse': {
      level: 'admin',
      run: async (bot, i, p: { id: number; reason: string }) => {
        const t = reverseTxn(bot.ctx, i.guildId, p.id, p.reason, i.user.id);
        return `Undid #${p.id}. **<@${t.userId}>'s ${currencyFor(bot.ctx, i.guildId).name}:** ${t.balanceAfter - t.amount} → ${t.balanceAfter} (transaction #${t.id}).`;
      },
    },
  },
};
