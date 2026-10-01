import { getConfig } from '../../domain/config.js';
import { COLLECT_COOLDOWN_MS, WARMUP_MS } from '../../domain/snowball.js';
import { formatSeconds } from '../../util/time.js';
import { reply, type HandlerSet } from '../interaction.js';
import { COLORS, embed, field } from '../ui.js';

export const helpHandlers: HandlerSet = {
  chat: {
    help: async (bot, i) => {
      const game = i.options.getString('game');
      const cfg = getConfig(bot.ctx, i.guildId);
      const support = field('Need help?', cfg.supportDestination ? `Ask in ${cfg.supportDestination}.` : 'Ask the event staff.');
      if (game === 'snowball') {
        return reply(i, {
          embeds: [
            embed(COLORS.snow, '❄️ Snowball Fights').addFields(
              field('/collect', `Make one snowball. You can collect every ${COLLECT_COOLDOWN_MS / 1000} seconds.`),
              field('/throw', 'Spend one snowball on someone. Half of all throws hit, and everyone sees the result.'),
              field('Getting hit', `You can't collect for ${WARMUP_MS / 1000} seconds, but you can still throw snowballs you already have.`),
              field('/stats · /leaderboard', 'Your hits, misses and snowballs. The leaderboard ranks by hits.'),
              field('/snowball leave · /snowball join', "Don't want to play? Leave, and nobody can throw at you. Your stats are kept."),
              support,
            ),
          ],
        });
      }
      if (game === 'halloween') {
        return reply(i, {
          embeds: [
            embed(COLORS.halloween, '🎃 Trick or Treat').addFields(
              field('Visitors', `Keep chatting and visitors drop by every ${formatSeconds(cfg.hwSpawnMinS)}–${formatSeconds(cfg.hwSpawnMaxS)}. Each asks for a **Trick** or a **Treat**.`),
              field('Answering', 'Press the button (or `/trick` / `/treat`). The first right answer wins. A wrong answer uses up your try for that visitor.'),
              field('Items', 'Each win gives an item: common, uncommon or rare. Duplicates don\'t raise your score.'),
              field('Candy', `${cfg.candyPerHalloweenWin} candy per win, up to ${cfg.candyHalloweenDailyLimit} a day.`),
              field('Champion', 'Whoever owns the most different items holds the Champion role. Ties keep the current Champion.'),
              field('/inventory · /leaderboard', 'See your collection (with Missing items and Visitors buttons) and the standings.'),
              support,
            ),
          ],
        });
      }
      if (game === 'advent') {
        return reply(i, {
          embeds: [
            embed(COLORS.advent, '🎄 Advent Calendar').addFields(
              field('Doors', `A new door opens every day at ${cfg.adventUnlockTime} (${cfg.timezone}).`),
              field('/advent', "Opens today's door. Add `day:` to open an earlier one. Each door gives its candy once."),
              field(
                'Missed a day?',
                cfg.adventPolicy === 'catch-up' ? 'Earlier doors can still be claimed until the calendar ends.' : 'Each door can only be claimed on its own day.',
              ),
              support,
            ),
          ],
        });
      }
      if (game === 'candy') {
        return reply(i, {
          embeds: [
            embed(COLORS.candy, '🍬 Candy').addFields(
              field('Earning', 'Win Halloween visitors, open Advent doors, and take part in staff events.'),
              field('/candy · /leaderboard game:Candy', 'Your balance and history, and the standings.'),
              field('Good to know', 'Your balance carries over between seasons. Candy has no shop, trading or cash value.'),
              support,
            ),
          ],
        });
      }
      return reply(i, {
        embeds: [
          embed(COLORS.brand, '✨ emojitown games', 'Use `/help game:` for details on one game.').addFields(
            field('❄️ Snowball Fights', '`/collect` · `/throw` · `/stats` · `/snowball leave|join`'),
            field('🎃 Trick or Treat', '`/trick` · `/treat` · `/inventory`'),
            field('🎄 Advent Calendar', '`/advent`'),
            field('🍬 Candy', '`/candy`'),
            field('For everything', "`/leaderboard` · `/events` (what's running)"),
            support,
          ),
        ],
      });
    },
  },
};
