import type { SnowballPack } from './types.js';

/**
 * Placeholder emojitown snowball content. Replace it through
 * `/admin season content feature:snowball action:import` with final artwork and wording.
 */
export const DEFAULT_SNOWBALL_PACK: SnowballPack = {
  images: {},
  hit: [
    '{thrower} lobbed a perfectly packed snowball and it landed right on {target}! ❄️',
    '{thrower} wound up, let fly, and {target} is now wearing a snow hat. ☃️',
    'SPLAT! {thrower} caught {target} mid-wave. Right in the emojitown scarf!',
    '{thrower} bounced a snowball off a lamppost and it still hit {target}. Legendary.',
  ],
  miss: [
    '{thrower} threw at {target} but the snowball veered into a passing penguin. 🐧',
    '{target} ducked behind a snowman just in time. {thrower} missed!',
    "{thrower}'s snowball crumbled mid-air. {target} didn't even notice.",
    'A gust of wind carried {thrower}\'s snowball right past {target}. So close!',
  ],
  collect: 'You scooped up a fresh snowball! You now have **{count}** snowball{s}.',
  cooldown: 'Your hands are still cold! You can collect another snowball {when}.',
  warmup: "You're warming up after being hit. You can collect again {when}, but you can still throw snowballs you already have.",
  noSnowballs: "You don't have any snowballs. Use `/collect` to make one first.",
};
