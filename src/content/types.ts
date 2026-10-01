export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';
export const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'legendary'];

export interface SnowballPack {
  /** Artwork URLs. A missing image falls back to text-only messages. */
  images: { collect?: string; hit?: string; miss?: string };
  /** Hit messages. Placeholders: {thrower}, {target}. The hit/miss result is decided before a message is chosen. */
  hit: string[];
  miss: string[];
  collect: string;
  cooldown: string;
  warmup: string;
  noSnowballs: string;
}

export interface HalloweenItem {
  id: string;
  name: string;
  rarity: Rarity;
  description: string;
  image?: string;
}

export interface HalloweenVisitor {
  id: string;
  name: string;
  /** Visitor class: decides how often it appears and its bonus candy. Defaults to common. */
  rarity?: Rarity;
  /** An http(s) URL, or `img:<id>` for a picture stored by the bot. */
  image?: string;
  /** Shown when the visitor arrives, above the trick/treat request. */
  greeting?: string;
  /** Text on the win message, e.g. "As a thank you, they give {winner} one **{item}**". Uses the pack default when empty. */
  winText?: string;
  /** Retired visitors no longer appear; items already collected from them are kept. */
  retired?: boolean;
  /** What the visitor says when asking for a trick. Placeholders: {name}. */
  trickRequest?: string;
  treatRequest?: string;
  items: HalloweenItem[];
}

export interface HalloweenPack {
  visitors: HalloweenVisitor[];
  messages: {
    trickRequest: string;
    treatRequest: string;
    /** Title of the win message. Default: "Happy Halloween!" */
    winTitle?: string;
    win: string;
    duplicate: string;
    wrong: string;
    expired: string;
    cancelled: string;
  };
}

export type ContentFeature = 'snowball' | 'halloween';
export type ContentPack = SnowballPack | HalloweenPack;
