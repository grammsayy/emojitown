import { AttachmentBuilder } from 'discord.js';
import { getImage, saveImage } from '../domain/images.js';
import { UserError } from '../domain/errors.js';
import type { Bot } from './runtime.js';

export interface ResolvedImage {
  /** What to put in an embed: an http(s) URL or `attachment://file`. */
  url: string;
  /** Present when the picture is stored by the bot and must be sent with the message. */
  file?: AttachmentBuilder;
}

/** Turns a stored `img:<id>` reference or URL into something an embed can show. */
export function resolveImage(bot: Bot, guildId: string, ref: string | undefined | null): ResolvedImage | null {
  if (!ref) return null;
  if (/^https?:\/\//.test(ref)) return { url: ref };
  const img = getImage(bot.ctx, guildId, ref);
  if (!img) return null;
  return { url: `attachment://${img.fileName}`, file: new AttachmentBuilder(img.data, { name: img.fileName }) };
}

const CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

/** Downloads an image attached to a command and stores it. Returns its `img:<id>` reference. */
export async function storeAttachedImage(bot: Bot, guildId: string, url: string, size: number): Promise<string> {
  if (size > 8 * 1024 * 1024) throw new UserError('Pictures must be 8 MB or smaller.');
  const u = new URL(url);
  if (u.protocol !== 'https:' || !CDN_HOSTS.includes(u.hostname)) throw new UserError('Attach the picture directly to the command.');
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!res.ok) throw new UserError(`Could not download the picture (HTTP ${res.status}). Try attaching it again.`);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  return saveImage(bot.ctx, guildId, new Uint8Array(await res.arrayBuffer()), mime);
}
