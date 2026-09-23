import { DEFAULT_HALLOWEEN_PACK } from '../content/defaultHalloween.js';
import { DEFAULT_SNOWBALL_PACK } from '../content/defaultSnowball.js';
import {
  RARITIES,
  type ContentFeature,
  type HalloweenItem,
  type HalloweenPack,
  type HalloweenVisitor,
  type SnowballPack,
} from '../content/types.js';
import type { Ctx } from './context.js';
import { UserError } from './errors.js';

/** Version 0 is the built-in placeholder pack; imports create versions 1, 2, ... */
export const DEFAULT_VERSION = 0;

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateSnowballPack(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = data as Partial<SnowballPack> | null;
  if (!p || typeof p !== 'object') return { errors: ['Pack must be a JSON object.'], warnings };
  for (const key of ['hit', 'miss'] as const) {
    const list = p[key];
    if (!Array.isArray(list) || list.length < 4) errors.push(`\`${key}\` must list at least four messages.`);
    else list.forEach((m, i) => !nonEmptyString(m) && errors.push(`\`${key}[${i}]\` must be non-empty text.`));
  }
  for (const key of ['collect', 'cooldown', 'warmup', 'noSnowballs'] as const) {
    if (!nonEmptyString(p[key])) errors.push(`\`${key}\` message is required.`);
  }
  if (!p.images || typeof p.images !== 'object') errors.push('`images` object is required (it may be empty).');
  else {
    for (const key of ['collect', 'hit', 'miss'] as const) {
      const v = p.images[key];
      if (v === undefined) warnings.push(`No \`images.${key}\` artwork; text-only messages will be used.`);
      else if (!isUrl(v)) errors.push(`\`images.${key}\` must be an http(s) URL.`);
    }
  }
  return { errors, warnings };
}

export function validateHalloweenPack(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = data as Partial<HalloweenPack> | null;
  if (!p || typeof p !== 'object') return { errors: ['Pack must be a JSON object.'], warnings };
  if (!Array.isArray(p.visitors) || p.visitors.length === 0) {
    errors.push('`visitors` must be a non-empty list.');
  } else {
    const visitorIds = new Set<string>();
    const itemIds = new Set<string>();
    p.visitors.forEach((v: Partial<HalloweenVisitor>, vi) => {
      const where = `visitors[${vi}]`;
      if (!nonEmptyString(v.id) || !ID_RE.test(v.id)) errors.push(`${where}.id must be a lowercase stable ID.`);
      else if (visitorIds.has(v.id)) errors.push(`Duplicate visitor ID \`${v.id}\`.`);
      else visitorIds.add(v.id);
      if (!nonEmptyString(v.name)) errors.push(`${where}.name is required.`);
      if (v.image !== undefined && !isUrl(v.image)) errors.push(`${where}.image must be an http(s) URL.`);
      if (!Array.isArray(v.items)) {
        errors.push(`${where}.items must be a list.`);
        return;
      }
      const rarities = v.items.map((it: Partial<HalloweenItem>) => it.rarity);
      for (const r of RARITIES) {
        const n = rarities.filter((x) => x === r).length;
        if (n !== 1) errors.push(`${where} must have exactly one ${r} item (found ${n}).`);
      }
      if (v.items.length !== 3) errors.push(`${where} must have exactly three items.`);
      v.items.forEach((it: Partial<HalloweenItem>, ii) => {
        const iw = `${where}.items[${ii}]`;
        if (!nonEmptyString(it.id) || !ID_RE.test(it.id)) errors.push(`${iw}.id must be a lowercase stable ID.`);
        else if (itemIds.has(it.id)) errors.push(`Duplicate item ID \`${it.id}\`.`);
        else itemIds.add(it.id);
        if (!nonEmptyString(it.name)) errors.push(`${iw}.name is required.`);
        if (!nonEmptyString(it.description)) errors.push(`${iw}.description is required.`);
        if (!RARITIES.includes(it.rarity as never)) errors.push(`${iw}.rarity must be common, uncommon or rare.`);
        if (it.image !== undefined && !isUrl(it.image)) errors.push(`${iw}.image must be an http(s) URL.`);
      });
      if (v.image === undefined) warnings.push(`Visitor \`${v.id}\` has no artwork; a text message will be used.`);
    });
    if (p.visitors.length !== 40) warnings.push(`The full event is designed for 40 visitors; this pack has ${p.visitors.length}.`);
  }
  const msgKeys = ['trickRequest', 'treatRequest', 'win', 'duplicate', 'wrong', 'expired', 'cancelled'] as const;
  if (!p.messages || typeof p.messages !== 'object') errors.push('`messages` object is required.');
  else for (const k of msgKeys) if (!nonEmptyString(p.messages[k])) errors.push(`\`messages.${k}\` is required.`);
  return { errors, warnings };
}

export function validatePack(feature: ContentFeature, data: unknown): ValidationResult {
  return feature === 'snowball' ? validateSnowballPack(data) : validateHalloweenPack(data);
}

/** Enforces that an import keeps every stable ID used by an earlier version of the pack. */
function checkIdContinuity(feature: ContentFeature, prev: unknown, next: unknown): string[] {
  if (feature !== 'halloween') return [];
  const prevPack = prev as HalloweenPack;
  const nextPack = next as HalloweenPack;
  const nextItems = new Set(nextPack.visitors.flatMap((v) => v.items.map((i) => i.id)));
  const nextVisitors = new Set(nextPack.visitors.map((v) => v.id));
  const errors: string[] = [];
  for (const v of prevPack.visitors) {
    if (!nextVisitors.has(v.id)) errors.push(`Visitor \`${v.id}\` from the current pack is missing. Stable IDs cannot be removed.`);
    for (const i of v.items) if (!nextItems.has(i.id)) errors.push(`Item \`${i.id}\` from the current pack is missing. Stable IDs cannot be removed.`);
  }
  return errors;
}

export function latestVersion(ctx: Ctx, guildId: string, feature: ContentFeature): number {
  const r = ctx.db
    .prepare('SELECT MAX(version) v FROM content_packs WHERE guild_id = ? AND feature = ?')
    .get(guildId, feature) as { v: number | null };
  return r.v ?? DEFAULT_VERSION;
}

export function getPack(ctx: Ctx, guildId: string, feature: 'snowball', version?: number | null): SnowballPack;
export function getPack(ctx: Ctx, guildId: string, feature: 'halloween', version?: number | null): HalloweenPack;
export function getPack(ctx: Ctx, guildId: string, feature: ContentFeature, version?: number | null): SnowballPack | HalloweenPack;
export function getPack(ctx: Ctx, guildId: string, feature: ContentFeature, version?: number | null) {
  const v = version ?? latestVersion(ctx, guildId, feature);
  if (v === DEFAULT_VERSION) return feature === 'snowball' ? DEFAULT_SNOWBALL_PACK : DEFAULT_HALLOWEEN_PACK;
  const r = ctx.db
    .prepare('SELECT data FROM content_packs WHERE guild_id = ? AND feature = ? AND version = ?')
    .get(guildId, feature, v) as { data: string } | undefined;
  if (!r) throw new Error(`content pack ${feature} v${v} missing`);
  return JSON.parse(r.data);
}

/** Validates and stores a new pack version. Active events keep their pinned version. */
export function importPack(ctx: Ctx, guildId: string, feature: ContentFeature, data: unknown, actorId: string) {
  const result = validatePack(feature, data);
  if (result.errors.length === 0) {
    result.errors.push(...checkIdContinuity(feature, getPack(ctx, guildId, feature), data));
  }
  if (result.errors.length > 0) return { version: null, ...result };
  const version = latestVersion(ctx, guildId, feature) + 1;
  ctx.db
    .prepare('INSERT INTO content_packs (guild_id, feature, version, data, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, feature, version, JSON.stringify(data), actorId, ctx.now());
  return { version, ...result };
}

export function parsePackJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UserError(`The file is not valid JSON: ${(err as Error).message}`);
  }
}

export function findItem(pack: HalloweenPack, itemId: string): { item: HalloweenItem; visitor: HalloweenVisitor } | null {
  for (const visitor of pack.visitors) {
    const item = visitor.items.find((i) => i.id === itemId);
    if (item) return { item, visitor };
  }
  return null;
}

/** Finds an item by ID or case-insensitive name. */
export function searchItem(pack: HalloweenPack, query: string): { item: HalloweenItem; visitor: HalloweenVisitor } | null {
  const exact = findItem(pack, query);
  if (exact) return exact;
  const q = query.trim().toLowerCase();
  for (const visitor of pack.visitors) {
    const item = visitor.items.find((i) => i.name.toLowerCase() === q);
    if (item) return { item, visitor };
  }
  return null;
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
