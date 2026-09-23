import { getConfig } from '../../domain/config.js';
import { COLLECT_COOLDOWN_MS, WARMUP_MS } from '../../domain/snowball.js';
import { reply, type HandlerSet } from '../interaction.js';
import { COLORS, embed, field } from '../ui.js';

export const helpHandlers: HandlerSet = {
  chat: {
    help: async (bot, i) => {
      const topic = i.options.getString('topic');
      const cfg = getConfig(bot.ctx, i.guildId);
      if (topic === 'snowball') {
        return reply(i, {
          embeds: [
            embed(COLORS.snow, '❄️ Snowball Fights').addFields(
              field('/collect', `Make one snowball. You can collect every ${COLLECT_COOLDOWN_MS / 1000} seconds.`),
              field('/throw target:@member', 'Spend one snowball. Half of all throws hit. The result is posted for everyone.'),
              field('Getting hit', `You can't collect for ${WARMUP_MS / 1000} seconds, but you can still throw snowballs you already have. Another hit restarts the timer.`),
              field('/stats · /leaderboard', 'Your hits, misses, KOs received and snowballs. Standings are ranked by hits.'),
              field('/snowball participation', 'Opt out (or back in). Opted-out members can neither throw nor be targeted; stats are kept.'),
              field('Buttons', '**Throw** on your collection reply opens a target picker. **Collect** on a throw result collects a snowball.'),
            ),
          ],
        });
      }
      if (topic === 'halloween') {
        return reply(i, {
          embeds: [
            embed(COLORS.halloween, '🎃 Trick or Treat').addFields(
              field('Visitors', 'emojitown visitors drop by in active Halloween channels. Each one asks for a **Trick** or a **Treat**.'),
              field('Answering', 'Press the button or use `/trick` / `/treat` in that channel. The first correct answer wins. A wrong answer uses your try for that visitor.'),
              field('Collecting', 'Each win gives one item: common, uncommon or rare. Duplicates show as "Already collected" and don\'t raise your score.'),
              field('Candy', `${cfg.candyPerHalloweenWin} candy per win, up to ${cfg.candyHalloweenDailyLimit} a day.`),
              field('Champion', 'The member with the most unique items holds the Halloween Champion role. Ties keep the current Champion.'),
              field('Commands', '`/halloween inventory` · `missing` · `item` · `visitors` · `leaderboard` · `status`'),
            ),
          ],
        });
      }
      if (topic === 'advent') {
        return reply(i, {
          embeds: [
            embed(COLORS.advent, '🎄 Advent Calendar').addFields(
              field('Doors', `A new door opens every day at ${cfg.adventUnlockTime} (${cfg.timezone}).`),
              field('Opening', 'Press **Open Door** on the daily post or use `/advent open`. Each door rewards you once; reopening shows it again.'),
              field(
                'Catch-up',
                cfg.adventPolicy === 'catch-up'
                  ? 'Missed a day? Earlier doors stay claimable until the claim deadline.'
                  : 'Each door can only be claimed on its own day, until local midnight.',
              ),
              field('Commands', '`/advent calendar` · `/advent open [day]` · `/advent progress`'),
            ),
          ],
        });
      }
      if (topic === 'candy') {
        return reply(i, {
          embeds: [
            embed(COLORS.candy, '🍬 Candy Counter').addFields(
              field('Earning', 'Win Halloween visitors, open Advent doors, and take part in staff-run community activities.'),
              field('Commands', '`/candy balance` · `/candy leaderboard` · `/candy history` · `/candy rules`'),
              field('Good to know', 'Balances carry over between events. Candy has no shop, transfers or cash value.'),
            ),
          ],
        });
      }
      return reply(i, {
        embeds: [
          embed(COLORS.brand, '✨ emojitown seasonal games', 'Pick a topic with `/help topic:` for details.').addFields(
            field('❄️ Snowball Fights (December)', '`/collect`, `/throw`, `/stats`, `/leaderboard`'),
            field('🎃 Trick or Treat (October)', 'Answer visitors with **Trick** or **Treat** and build your collection.'),
            field('🎄 Advent Calendar (Dec 1–24)', 'Open a door every day with `/advent open`.'),
            field('🍬 Candy Counter', 'Rewards from Halloween and Advent. `/candy balance`'),
            field('More', '`/season status` shows what\'s running. `/support` shows where to get help.'),
          ),
        ],
      });
    },
    support: async (bot, i) => {
      const dest = getConfig(bot.ctx, i.guildId).supportDestination;
      await reply(i, dest ? `Need help with the emojitown seasonal games? Head to ${dest}.` : 'Ask a member of the event staff for help.');
    },
  },
};
