import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { UserError } from './errors.js';
import { getCurrentEvent, type Feature } from './events.js';

// What "candy" is called. Staff can give it a seasonal name and emoji per game
// (e.g. "🎃 candy corn" for Halloween, "🍪 cookies" for Advent). It is always the
// same balance; only the wording changes.

export type CurrencyScope = 'default' | Feature;
export const CURRENCY_SCOPES: CurrencyScope[] = ['default', 'halloween', 'snowball', 'advent'];

export interface Currency {
  /** Used as written after a number, e.g. "5 candy", "5 cookies". */
  name: string;
  emoji: string;
}

export const DEFAULT_CURRENCY: Currency = { name: 'candy', emoji: '🍬' };

/** Which game's name general messages (balance, leaderboard, help) use while games are live. */
const LIVE_ORDER: Feature[] = ['halloween', 'advent', 'snowball'];

function stored(ctx: Ctx, guildId: string): Partial<Record<CurrencyScope, Currency>> {
  const rows = ctx.db.prepare('SELECT scope, name, emoji FROM currency_names WHERE guild_id = ?').all(guildId) as {
    scope: CurrencyScope;
    name: string;
    emoji: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.scope, { name: r.name, emoji: r.emoji }]));
}

/** Every scope's own setting (null = not set, so it falls back to the default). */
export function getCurrencySettings(ctx: Ctx, guildId: string): Record<CurrencyScope, Currency | null> {
  const s = stored(ctx, guildId);
  return Object.fromEntries(CURRENCY_SCOPES.map((k) => [k, s[k] ?? null])) as Record<CurrencyScope, Currency | null>;
}

/**
 * The name to show. With a game: that game's name (or the default). Without
 * one: the name of the game that's live right now, or the default.
 */
export function currencyFor(ctx: Ctx, guildId: string, game?: Feature | null): Currency {
  const s = stored(ctx, guildId);
  const fallback = s.default ?? DEFAULT_CURRENCY;
  if (game) return s[game] ?? fallback;
  const live = LIVE_ORDER.find((g) => getCurrentEvent(ctx, guildId, g));
  return (live && s[live]) || fallback;
}

/** "🍬 5 candy" */
export function amountText(c: Currency, n: number): string {
  return `${c.emoji} ${n} ${c.name}`;
}

/** "Candy" (for titles and labels). */
export function currencyTitle(c: Currency): string {
  return c.name.charAt(0).toUpperCase() + c.name.slice(1);
}

const EMOJI = /^(<a?:\w{2,32}:\d{17,20}>|(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})*)\s*/u;

/**
 * Parses "🎃 candy corn" (emoji, then the name). The emoji is optional and keeps
 * the current one when left out. Custom server emoji like <:pumpkin:123…> work too.
 */
export function parseCurrency(input: string, keepEmoji: string): Currency {
  const text = input.trim();
  const m = EMOJI.exec(text);
  const emoji = m ? m[1]! : keepEmoji;
  const name = (m ? text.slice(m[0].length) : text).trim().replace(/\s+/g, ' ');
  if (!name) throw new UserError(`"${input}" needs a name after the emoji, e.g. "🎃 candy corn".`);
  if (name.length > 30) throw new UserError(`"${name}" is too long. Keep names to 30 characters.`);
  if (/[`*_~|<>@#]/.test(name)) throw new UserError(`"${name}" can't contain formatting characters like * _ ~ \` | < > @ #.`);
  return { name, emoji };
}

/** Saves one scope. null clears it (back to the default; for 'default', back to 🍬 candy). */
export function setCurrency(ctx: Ctx, guildId: string, scope: CurrencyScope, value: Currency | null, actorId: string): boolean {
  const before = stored(ctx, guildId)[scope] ?? null;
  if (JSON.stringify(before) === JSON.stringify(value)) return false;
  if (value) {
    ctx.db
      .prepare(
        `INSERT INTO currency_names (guild_id, scope, name, emoji) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, scope) DO UPDATE SET name = excluded.name, emoji = excluded.emoji`,
      )
      .run(guildId, scope, value.name, value.emoji);
  } else {
    ctx.db.prepare('DELETE FROM currency_names WHERE guild_id = ? AND scope = ?').run(guildId, scope);
  }
  audit(ctx, { guildId, actorId, action: 'currency.rename', before: { [scope]: before }, after: { [scope]: value } });
  return true;
}
