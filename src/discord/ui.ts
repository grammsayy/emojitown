import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { Page } from '../domain/ranking.js';
import { discordTime } from '../util/time.js';

/** emojitown palette. Color never carries meaning on its own; every result also has text. */
export const COLORS = {
  brand: 0xffb347,
  snow: 0x8ecae6,
  hit: 0x4caf50,
  miss: 0x90a4ae,
  halloween: 0xff7518,
  advent: 0xc0392b,
  candy: 0xff69b4,
  staff: 0x5865f2,
  warn: 0xf1c40f,
  error: 0xe74c3c,
} as const;

export const BRAND = 'emojitown';

export function embed(color: number, title?: string, description?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(color).setFooter({ text: BRAND });
  if (title) e.setTitle(title.slice(0, 256));
  if (description) e.setDescription(description.slice(0, 4096));
  return e;
}

/** Sets an image only when a URL is configured; messages stay readable without artwork. */
export function withImage(e: EmbedBuilder, url: string | undefined | null): EmbedBuilder {
  if (url) e.setImage(url);
  return e;
}

export function row(...components: MessageActionRowComponentBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...components);
}

export function button(customId: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string, disabled = false): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function linkButton(url: string, label: string): ButtonBuilder {
  return new ButtonBuilder().setURL(url).setLabel(label).setStyle(ButtonStyle.Link);
}

/**
 * Custom IDs use `|` separated parts: `<prefix>|<arg>|...`. The router dispatches
 * on the prefix; handlers read the remaining parts.
 */
export function cid(...parts: (string | number)[]): string {
  const id = parts.join('|');
  if (id.length > 100) throw new Error(`custom id too long: ${id}`);
  return id;
}

/**
 * Previous/next buttons. `make(page)` builds the custom ID for a page. The
 * `|prev`/`|next` ending keeps the IDs unique: Discord rejects a whole message
 * if two buttons share an ID, e.g. "Previous" and an "All" filter that both
 * point at page 1. Handlers ignore the extra part.
 */
export function pager(page: Page<unknown>, make: (page: number) => string) {
  return row(
    button(`${make(page.page - 1)}|prev`, 'Previous', ButtonStyle.Secondary, '◀️', page.page <= 1),
    button(`noop|${page.page}`, `Page ${page.page} of ${page.pages}`, ButtonStyle.Secondary, undefined, true),
    button(`${make(page.page + 1)}|next`, 'Next', ButtonStyle.Secondary, '▶️', page.page >= page.pages),
  );
}

export function mention(userId: string | null | undefined): string {
  return userId ? `<@${userId}>` : 'nobody yet';
}

export function rankLabel(rank: number): string {
  return rank === 1 ? '🥇 1' : rank === 2 ? '🥈 2' : rank === 3 ? '🥉 3' : `#${rank}`;
}

export function field(name: string, value: string, inline = false): APIEmbedField {
  return { name: name.slice(0, 256), value: (value || '—').slice(0, 1024), inline };
}

export function when(ms: number): string {
  return `${discordTime(ms, 'f')} (${discordTime(ms, 'R')})`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function json(v: unknown, n = 900): string {
  return truncate(JSON.stringify(v), n);
}
