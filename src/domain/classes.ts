import { RARITIES, type Rarity } from '../content/types.js';
import type { Ctx } from './context.js';

export interface VisitorClass {
  /** Relative chance a visitor of this class is picked (only classes with visitors count). */
  weight: number;
  /** Extra candy on top of the normal per-win candy. */
  bonusCandy: number;
}

export const CLASS_LABEL: Record<Rarity, string> = {
  common: '⚪ Common',
  uncommon: '🟢 Uncommon',
  rare: '🟣 Rare',
  legendary: '🟡 Legendary',
};

export const DEFAULT_CLASSES: Record<Rarity, VisitorClass> = {
  common: { weight: 60, bonusCandy: 0 },
  uncommon: { weight: 25, bonusCandy: 2 },
  rare: { weight: 12, bonusCandy: 5 },
  legendary: { weight: 3, bonusCandy: 10 },
};

export function getClasses(ctx: Ctx, guildId: string): Record<Rarity, VisitorClass> {
  const out = structuredClone(DEFAULT_CLASSES);
  for (const r of ctx.db.prepare('SELECT class, weight, bonus_candy FROM hw_classes WHERE guild_id = ?').all(guildId) as {
    class: Rarity;
    weight: number;
    bonus_candy: number;
  }[]) {
    if (RARITIES.includes(r.class)) out[r.class] = { weight: r.weight, bonusCandy: r.bonus_candy };
  }
  return out;
}

export function setClass(ctx: Ctx, guildId: string, cls: Rarity, patch: Partial<VisitorClass>): { before: VisitorClass; after: VisitorClass } {
  const before = getClasses(ctx, guildId)[cls];
  const after = { weight: patch.weight ?? before.weight, bonusCandy: patch.bonusCandy ?? before.bonusCandy };
  ctx.db
    .prepare(
      `INSERT INTO hw_classes (guild_id, class, weight, bonus_candy) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, class) DO UPDATE SET weight = excluded.weight, bonus_candy = excluded.bonus_candy`,
    )
    .run(guildId, cls, after.weight, after.bonusCandy);
  return { before, after };
}
