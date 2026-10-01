import type { HalloweenPack, HalloweenVisitor } from './types.js';

/**
 * Placeholder emojitown Halloween roster: 40 visitors, each with one common,
 * one uncommon and one rare item (120 items total). IDs are stable; names,
 * descriptions and artwork can be replaced by importing a content pack.
 */
const ROSTER: [id: string, name: string, emoji: string, common: string, uncommon: string, rare: string][] = [
  ['pumpkin-pete', 'Pumpkin Pete', '🎃', 'Pumpkin Seed', 'Carved Lantern', 'Golden Gourd'],
  ['ghostly-gus', 'Ghostly Gus', '👻', 'Bedsheet Scrap', 'Rattling Chain', 'Ectoplasm Jar'],
  ['batty-bea', 'Batty Bea', '🦇', 'Tiny Wing', 'Echo Whistle', 'Midnight Cape'],
  ['skelly-sam', 'Skelly Sam', '💀', 'Loose Tooth', 'Dancing Bone', 'Crystal Skull'],
  ['witchy-wendy', 'Witchy Wendy', '🧙', 'Broom Bristle', 'Bubbling Potion', 'Starlight Hat'],
  ['spider-sid', 'Spider Sid', '🕷️', 'Sticky Thread', 'Web Hammock', 'Silver Web'],
  ['mummy-mo', 'Mummy Mo', '🧟', 'Linen Strip', 'Scarab Charm', 'Pharaoh Mask'],
  ['vampy-val', 'Vampy Val', '🧛', 'Plastic Fangs', 'Velvet Collar', 'Ruby Goblet'],
  ['candle-cal', 'Candle Cal', '🕯️', 'Wax Drip', 'Flickering Wick', 'Everlasting Flame'],
  ['owl-olive', 'Owl Olive', '🦉', 'Soft Feather', 'Moon Map', 'Wise Monocle'],
  ['cat-cleo', 'Cat Cleo', '🐈‍⬛', 'Yarn Ball', 'Lucky Bell', 'Nine Lives Locket'],
  ['frankie', 'Frankie', '🧌', 'Stitch Thread', 'Spare Bolt', 'Lightning Jar'],
  ['wolfie', 'Wolfie', '🐺', 'Tuft of Fur', 'Howl Horn', 'Full Moon Pendant'],
  ['cauldron-cora', 'Cauldron Cora', '🫕', 'Newt Sprinkles', 'Stirring Spoon', 'Rainbow Brew'],
  ['raven-rex', 'Raven Rex', '🐦‍⬛', 'Shiny Button', 'Riddle Scroll', 'Obsidian Quill'],
  ['zombie-zed', 'Zombie Zed', '🧟‍♂️', 'Muddy Sock', 'Brain Freeze Pop', 'Heartbeat Drum'],
  ['goblin-gil', 'Goblin Gil', '👺', 'Bent Coin', 'Mischief Map', 'Goblin King Crown'],
  ['fairy-fay', 'Fairy Fay', '🧚', 'Glitter Pinch', 'Dewdrop Vial', 'Wish Wand'],
  ['alien-al', 'Alien Al', '👽', 'Space Pebble', 'Ray Gun Toy', 'Tiny UFO'],
  ['robot-rae', 'Robot Rae', '🤖', 'Loose Screw', 'Beeping Chip', 'Chrome Heart'],
  ['clown-coco', 'Clown Coco', '🤡', 'Red Nose', 'Squeaky Horn', 'Juggling Stars'],
  ['scarecrow-sal', 'Scarecrow Sal', '🌾', 'Straw Bundle', 'Patchwork Hat', 'Harvest Moon Sickle'],
  ['crow-cass', 'Crow Cass', '🐤', 'Corn Kernel', 'Feather Fan', 'Shadow Plume'],
  ['toad-tobi', 'Toad Tobi', '🐸', 'Lily Pad', 'Warty Wart', 'Enchanted Crown'],
  ['snake-suri', 'Snake Suri', '🐍', 'Shed Skin', 'Charmer Flute', 'Emerald Eye'],
  ['imp-ike', 'Imp Ike', '😈', 'Pitchfork Pin', 'Ember Stone', 'Brimstone Bell'],
  ['specter-spe', 'Specter Spe', '🌫️', 'Cold Draft', 'Whisper Shell', 'Phantom Lantern'],
  ['moth-mira', 'Moth Mira', '🦋', 'Dusty Scale', 'Porch Light Bulb', 'Lunar Wings'],
  ['candy-corn-cy', 'Candy Corn Cy', '🍬', 'Candy Corn', 'Taffy Twist', 'Sugar Crystal'],
  ['apple-abby', 'Apple Abby', '🍎', 'Bobbing Apple', 'Caramel Stick', 'Golden Apple'],
  ['mushroom-mick', 'Mushroom Mick', '🍄', 'Spore Puff', 'Fairy Ring Stone', 'Glowing Cap'],
  ['broom-bo', 'Broom Bo', '🧹', 'Twig', 'Racing Stripes', 'Turbo Broom'],
  ['haunted-hal', 'Haunted Hal', '🏚️', 'Creaky Hinge', 'Attic Key', 'Portrait Frame'],
  ['yeti-yuki', 'Yeti Yuki', '🦍', 'Frost Flake', 'Snowshoe', 'Glacier Heart'],
  ['kraken-kit', 'Kraken Kit', '🐙', 'Ink Drop', 'Sea Glass', 'Sunken Treasure'],
  ['dragon-dot', 'Dragon Dot', '🐉', 'Smoky Scale', 'Toasted Marshmallow', 'Dragon Egg'],
  ['wizard-wes', 'Wizard Wes', '🧙‍♂️', 'Star Sticker', 'Spell Book', 'Comet Staff'],
  ['genie-gia', 'Genie Gia', '🧞', 'Brass Polish', 'Magic Carpet Tassel', 'Wishing Lamp'],
  ['yarn-doll-yo', 'Yarn Doll Yo', '🪆', 'Button Eye', 'Patch Heart', 'Porcelain Smile'],
  ['moon-mabel', 'Moon Mabel', '🌕', 'Moon Dust', 'Crescent Pin', 'Eclipse Orb'],
];

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const visitors: HalloweenVisitor[] = ROSTER.map(([id, name, emoji, common, uncommon, rare]) => ({
  id,
  name: `${emoji} ${name}`,
  items: [
    { id: `${id}.${slug(common)}`, name: common, rarity: 'common', description: `A little keepsake from ${name}.` },
    { id: `${id}.${slug(uncommon)}`, name: uncommon, rarity: 'uncommon', description: `${name} doesn't give this one away to just anyone.` },
    { id: `${id}.${slug(rare)}`, name: rare, rarity: 'rare', description: `${name}'s most treasured possession.` },
  ],
}));

export const DEFAULT_HALLOWEEN_PACK: HalloweenPack = {
  visitors,
  messages: {
    trickRequest: '**{name}** is visiting emojitown and wants a **TRICK**! Press **Trick** or use `/trick`.',
    treatRequest: '**{name}** is visiting emojitown and wants a **TREAT**! Press **Treat** or use `/treat`.',
    winTitle: 'Happy Halloween!',
    win: 'As a thank you for the {request}, {name} gives {winner} one **{item}**.',
    duplicate: 'As a thank you for the {request}, {name} gives {winner} one **{item}**.',
    wrong: "That's not what {name} asked for. You've used your attempt for this visitor, but others can still try.",
    expired: '{name} wandered off into the night. Nobody answered in time.',
    cancelled: '{name} was called away by the emojitown staff.',
  },
};
