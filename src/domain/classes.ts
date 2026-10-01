import { RARITIES, type Rarity } from '../content/types.js';
import type { Ctx } from './context.js';

export interface VisitorClass {
  /** Relative chance a visitor of this class is picked (only classes with visitors count). */
  weight: number;
  /** Extra candy on top of the normal per-win candy. */
  bonusCandy: number;
  /** The rarity line under the item picture on the win message. */
  description: string;
}

export const CLASS_LABEL: Record<Rarity, string> = {
  common: '⚪ Common',
  uncommon: '🟢 Uncommon',
  rare: '🟣 Rare',
  legendary: '🟡 Legendary',
};

export const DEFAULT_CLASSES: Record<Rarity, VisitorClass> = {
  common: { weight: 60, bonusCandy: 0, description: "This item is common. There's nothing special about it. It has been added to your inventory." },
  uncommon: { weight: 25, bonusCandy: 2, description: "This item is uncommon. Not everyone in emojitown has one! It has been added to your inventory." },
  rare: { weight: 12, bonusCandy: 5, description: 'This item is rare! Hold on to it tight. It has been added to your inventory.' },
  legendary: { weight: 3, bonusCandy: 10, description: 'This item is LEGENDARY! Almost nobody in emojitown has one. It has been added to your inventory.' },
};

/** Footer on the win message when the winner already had the item. */
export const DUPLICATE_NOTE = "You already had this one, so your collection didn't grow, but the candy is yours!";

export function getClasses(ctx: Ctx, guildId: string): Record<Rarity, VisitorClass> {
  const out = structuredClone(DEFAULT_CLASSES);
  for (const r of ctx.db.prepare('SELECT class, weight, bonus_candy, description FROM hw_classes WHERE guild_id = ?').all(guildId) as {
    class: Rarity;
    weight: number;
    bonus_candy: number;
    description: string | null;
  }[]) {
    if (RARITIES.includes(r.class)) out[r.class] = { weight: r.weight, bonusCandy: r.bonus_candy, description: r.description ?? DEFAULT_CLASSES[r.class].description };
  }
  return out;
}

export function setClass(ctx: Ctx, guildId: string, cls: Rarity, patch: Partial<VisitorClass>): { before: VisitorClass; after: VisitorClass } {
  const before = getClasses(ctx, guildId)[cls];
  const after = {
    weight: patch.weight ?? before.weight,
    bonusCandy: patch.bonusCandy ?? before.bonusCandy,
    description: patch.description?.trim() || before.description,
  };
  ctx.db
    .prepare(
      `INSERT INTO hw_classes (guild_id, class, weight, bonus_candy, description) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, class) DO UPDATE SET weight = excluded.weight, bonus_candy = excluded.bonus_candy, description = excluded.description`,
    )
    .run(guildId, cls, after.weight, after.bonusCandy, after.description);
  return { before, after };
}
