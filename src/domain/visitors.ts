import { DEFAULT_HALLOWEEN_PACK } from '../content/defaultHalloween.js';
import type { HalloweenPack, HalloweenVisitor, Rarity } from '../content/types.js';
import { audit } from './audit.js';
import { getPack, latestVersion, validateHalloweenPack } from './content.js';
import { tx, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { getCurrentEvent, setEventState } from './events.js';

const PLACEHOLDER_IDS = new Set(DEFAULT_HALLOWEEN_PACK.visitors.map((v) => v.id));

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'visitor'
  );
}

/** The current Halloween pack, as an editable copy. */
export function currentPack(ctx: Ctx, guildId: string): HalloweenPack {
  return structuredClone(getPack(ctx, guildId, 'halloween'));
}

/**
 * Saves an edited pack as a new version and switches the running Halloween
 * season to it, so changes show up right away. Returns the new version.
 */
export function savePack(ctx: Ctx, guildId: string, pack: HalloweenPack, actorId: string, action: string, detail: unknown): number {
  const result = validateHalloweenPack(pack);
  if (result.errors.length) throw new UserError(`That change isn't valid:\n• ${result.errors.slice(0, 10).join('\n• ')}`);
  return tx(ctx, () => {
    const version = latestVersion(ctx, guildId, 'halloween') + 1;
    ctx.db
      .prepare('INSERT INTO content_packs (guild_id, feature, version, data, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guildId, 'halloween', version, JSON.stringify(pack), actorId, ctx.now());
    const running = getCurrentEvent(ctx, guildId, 'halloween');
    if (running) setEventState(ctx, running, { content_version: version });
    audit(ctx, { guildId, actorId, action, eventId: running?.id ?? null, after: { version, ...(detail as object) } });
    return version;
  });
}

export interface VisitorInput {
  name: string;
  rarity: Rarity;
  image?: string | null;
  greeting?: string | null;
  trickRequest?: string | null;
  treatRequest?: string | null;
  itemName?: string | null;
}

function clean(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function findVisitorByQuery(pack: HalloweenPack, query: string): HalloweenVisitor {
  const q = query.trim().toLowerCase();
  const v = pack.visitors.find((x) => x.id === q) ?? pack.visitors.find((x) => x.name.toLowerCase() === q);
  if (!v) throw new UserError(`No visitor called "${query}". Pick one from the list.`);
  return v;
}

/** Adds a visitor with one collectible. Returns the new visitor. */
export function addVisitor(ctx: Ctx, guildId: string, input: VisitorInput, actorId: string): HalloweenVisitor {
  const name = input.name.trim();
  if (!name) throw new UserError('The visitor needs a name.');
  const pack = currentPack(ctx, guildId);
  if (pack.visitors.some((v) => !v.retired && v.name.toLowerCase() === name.toLowerCase())) {
    throw new UserError(`There is already a visitor called "${name}". Use \`/visitor edit\` to change it.`);
  }
  let id = slug(name);
  for (let n = 2; pack.visitors.some((v) => v.id === id); n++) id = `${slug(name)}-${n}`;
  const visitor: HalloweenVisitor = {
    id,
    name,
    rarity: input.rarity,
    image: clean(input.image),
    greeting: clean(input.greeting),
    trickRequest: clean(input.trickRequest),
    treatRequest: clean(input.treatRequest),
    items: [
      {
        id: `${id}.keepsake`,
        name: clean(input.itemName) ?? `${name}'s Keepsake`,
        rarity: input.rarity,
        description: `A keepsake from ${name}.`,
        image: clean(input.image),
      },
    ],
  };
  pack.visitors.push(visitor);
  savePack(ctx, guildId, pack, actorId, 'visitor.add', { visitor: id });
  return visitor;
}

/** Applies changes to a visitor. Returns before/after copies for the change report. */
export function editVisitor(
  ctx: Ctx,
  guildId: string,
  query: string,
  patch: Partial<VisitorInput>,
  actorId: string,
): { before: HalloweenVisitor; after: HalloweenVisitor } {
  const pack = currentPack(ctx, guildId);
  const v = findVisitorByQuery(pack, query);
  const before = structuredClone(v);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new UserError('The visitor needs a name.');
    v.name = name;
  }
  if (patch.rarity) v.rarity = patch.rarity;
  if (patch.image !== undefined) v.image = clean(patch.image);
  if (patch.greeting !== undefined) v.greeting = clean(patch.greeting);
  if (patch.trickRequest !== undefined) v.trickRequest = clean(patch.trickRequest);
  if (patch.treatRequest !== undefined) v.treatRequest = clean(patch.treatRequest);
  // Visitors created with /visitor add have one keepsake that follows the visitor's name, class and picture.
  if (v.items.length === 1) {
    const item = v.items[0]!;
    if (patch.itemName !== undefined) item.name = clean(patch.itemName) ?? item.name;
    if (patch.rarity) item.rarity = patch.rarity;
    if (patch.image !== undefined) item.image = clean(patch.image);
  }
  v.retired = false;
  savePack(ctx, guildId, pack, actorId, 'visitor.edit', { visitor: v.id });
  return { before, after: structuredClone(v) };
}

function isCollected(ctx: Ctx, guildId: string, v: HalloweenVisitor): boolean {
  const ids = v.items.map((i) => i.id);
  const placeholders = ids.map(() => '?').join(',');
  return !!ctx.db.prepare(`SELECT 1 FROM hw_items WHERE guild_id = ? AND item_id IN (${placeholders}) LIMIT 1`).get(guildId, ...ids);
}

export const ALL_PLACEHOLDERS = '__placeholders__';

/**
 * Removes visitors. Ones nobody has collected from are deleted; others are
 * retired so members keep what they earned. Returns names per outcome.
 */
export function removeVisitors(ctx: Ctx, guildId: string, query: string, actorId: string): { deleted: string[]; retired: string[] } {
  const pack = currentPack(ctx, guildId);
  const targets = query === ALL_PLACEHOLDERS ? pack.visitors.filter((v) => PLACEHOLDER_IDS.has(v.id) && !v.retired) : [findVisitorByQuery(pack, query)];
  if (targets.length === 0) throw new UserError('There are no placeholder visitors left to remove.');
  const open = ctx.db.prepare("SELECT visitor_id FROM hw_encounters WHERE guild_id = ? AND status = 'open'").all(guildId) as { visitor_id: string }[];
  const deleted: string[] = [];
  const retired: string[] = [];
  for (const v of targets) {
    if (open.some((o) => o.visitor_id === v.id) || isCollected(ctx, guildId, v)) {
      v.retired = true;
      retired.push(v.name);
    } else {
      pack.visitors.splice(pack.visitors.indexOf(v), 1);
      deleted.push(v.name);
    }
  }
  if (!pack.visitors.some((v) => !v.retired)) {
    throw new UserError('That would leave no visitors. Add your own first with `/visitor add`, then remove the placeholders.');
  }
  savePack(ctx, guildId, pack, actorId, 'visitor.remove', { deleted, retired });
  return { deleted, retired };
}

export function isPlaceholder(v: HalloweenVisitor): boolean {
  return PLACEHOLDER_IDS.has(v.id);
}
