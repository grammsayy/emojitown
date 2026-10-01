import { randomBytes } from 'node:crypto';
import type { Ctx } from './context.js';
import { UserError } from './errors.js';

export const IMAGE_REF = /^img:([a-f0-9]{16})$/;
const MAX_BYTES = 8 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * Stores a picture in the database and returns a stable `img:<id>` reference.
 * Discord attachment links expire, so pictures are kept by the bot itself.
 */
export function saveImage(ctx: Ctx, guildId: string, data: Uint8Array, mime: string): string {
  if (!EXT[mime]) throw new UserError('Pictures must be PNG, JPG, GIF or WEBP.');
  if (data.byteLength > MAX_BYTES) throw new UserError('Pictures must be 8 MB or smaller.');
  const id = randomBytes(8).toString('hex');
  ctx.db.prepare('INSERT INTO images (guild_id, id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)').run(guildId, id, mime, data, ctx.now());
  return `img:${id}`;
}

export function getImage(ctx: Ctx, guildId: string, ref: string): { data: Buffer; mime: string; fileName: string } | null {
  const m = IMAGE_REF.exec(ref);
  if (!m) return null;
  const r = ctx.db.prepare('SELECT mime, data FROM images WHERE guild_id = ? AND id = ?').get(guildId, m[1]) as { mime: string; data: Uint8Array } | undefined;
  if (!r) return null;
  return { data: Buffer.from(r.data), mime: r.mime, fileName: `${m[1]}.${EXT[r.mime] ?? 'png'}` };
}
