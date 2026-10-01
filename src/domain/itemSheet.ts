import { RARITIES, type HalloweenItem, type HalloweenPack, type HalloweenVisitor, type Rarity } from '../content/types.js';
import { parseCsv, toCsv } from '../util/csv.js';
import { validateHalloweenPack } from './content.js';
import type { Ctx } from './context.js';
import { getImage, IMAGE_REF } from './images.js';
import { visitorClass } from './halloween.js';

/**
 * Spreadsheet round-trip for Halloween visitors and items: one row per item,
 * visitor fields repeated on each of its rows. Export a rarity, edit it in a
 * spreadsheet, import it back. Rows with an empty item_id add new items.
 */

export const SHEET_HEADERS = [
  'item_id',
  'visitor_id',
  'visitor_name',
  'visitor_class',
  'item_name',
  'item_rarity',
  'item_description',
  'item_picture',
  'visitor_picture',
  'greeting',
  'trick_text',
  'treat_text',
  'win_text',
  'retired',
] as const;

export type SheetFilter = 'all' | Rarity | 'uncommon-rare';

export const SHEET_FILTERS: { name: string; value: SheetFilter }[] = [
  { name: 'All items', value: 'all' },
  { name: 'Common', value: 'common' },
  { name: 'Uncommon + Rare', value: 'uncommon-rare' },
  { name: 'Uncommon', value: 'uncommon' },
  { name: 'Rare', value: 'rare' },
  { name: 'Legendary', value: 'legendary' },
];

function matches(filter: SheetFilter, r: Rarity): boolean {
  if (filter === 'all') return true;
  if (filter === 'uncommon-rare') return r === 'uncommon' || r === 'rare';
  return r === filter;
}

export function exportSheet(pack: HalloweenPack, filter: SheetFilter): { csv: string; count: number } {
  const rows: Record<string, string>[] = [];
  for (const v of pack.visitors) {
    for (const it of v.items) {
      if (!matches(filter, it.rarity)) continue;
      rows.push({
        item_id: it.id,
        visitor_id: v.id,
        visitor_name: v.name,
        visitor_class: visitorClass(v),
        item_name: it.name,
        item_rarity: it.rarity,
        item_description: it.description,
        item_picture: it.image ?? '',
        visitor_picture: v.image ?? '',
        greeting: v.greeting ?? '',
        trick_text: v.trickRequest ?? '',
        treat_text: v.treatRequest ?? '',
        win_text: v.winText ?? '',
        retired: v.retired ? 'yes' : 'no',
      });
    }
  }
  return { csv: toCsv([...SHEET_HEADERS], rows), count: rows.length };
}

export interface ImportPlan {
  pack: HalloweenPack;
  errors: string[];
  changes: string[];
  counts: { itemsChanged: number; visitorsChanged: number; itemsAdded: number; visitorsAdded: number };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'item'
  );
}

/** Works out what an uploaded sheet would change. Pure: nothing is saved. */
export function planImport(ctx: Ctx, guildId: string, current: HalloweenPack, csvText: string): ImportPlan {
  const pack: HalloweenPack = structuredClone(current);
  const errors: string[] = [];
  const changes: string[] = [];
  const counts = { itemsChanged: 0, visitorsChanged: 0, itemsAdded: 0, visitorsAdded: 0 };
  const { headers, rows } = parseCsv(csvText);

  const required = ['item_id', 'visitor_name', 'item_name', 'item_rarity'];
  const missing = required.filter((h) => !headers.includes(h));
  if (missing.length) {
    errors.push(`The sheet is missing these columns: ${missing.join(', ')}. Start from a file made by \`/visitor\` → **Export items**.`);
    return { pack, errors, changes, counts };
  }
  if (rows.length === 0) errors.push('The sheet has no rows.');
  const has = (h: string) => headers.includes(h);

  const rarity = (row: number, col: string, v: string): Rarity | null => {
    const r = v.toLowerCase() as Rarity;
    if (RARITIES.includes(r)) return r;
    errors.push(`Row ${row}: ${col} "${v}" must be common, uncommon, rare or legendary.`);
    return null;
  };
  const picture = (row: number, col: string, v: string): string | undefined | null => {
    if (!v) return undefined;
    if (/^https?:\/\/\S+$/.test(v)) return v;
    if (IMAGE_REF.test(v) && getImage(ctx, guildId, v)) return v;
    errors.push(`Row ${row}: ${col} must be a link starting with https:// (or the img: value the export gave you).`);
    return null;
  };
  const bool = (row: number, v: string): boolean | null => {
    const s = v.toLowerCase();
    if (['', 'no', 'false', '0', 'n'].includes(s)) return false;
    if (['yes', 'true', '1', 'y'].includes(s)) return true;
    errors.push(`Row ${row}: retired must be yes or no.`);
    return null;
  };

  const itemOwner = new Map<string, { v: HalloweenVisitor; it: HalloweenItem }>();
  for (const v of pack.visitors) for (const it of v.items) itemOwner.set(it.id, { v, it });
  const visitorSeen = new Map<HalloweenVisitor, { line: number; snapshot: string }>();
  const newVisitors = new Map<string, HalloweenVisitor>();
  const changedVisitors = new Set<HalloweenVisitor>();
  const seenItems = new Set<string>();

  for (const { line, values } of rows) {
    const g = (h: string) => values[h] ?? '';
    const itemName = g('item_name');
    const visitorName = g('visitor_name');
    if (!itemName) errors.push(`Row ${line}: item_name is empty.`);
    if (!visitorName) errors.push(`Row ${line}: visitor_name is empty.`);
    const itemRarity = rarity(line, 'item_rarity', g('item_rarity'));
    const cls = has('visitor_class') && g('visitor_class') ? rarity(line, 'visitor_class', g('visitor_class')) : undefined;
    const itemPic = has('item_picture') ? picture(line, 'item_picture', g('item_picture')) : undefined;
    const visitorPic = has('visitor_picture') ? picture(line, 'visitor_picture', g('visitor_picture')) : undefined;
    const retired = has('retired') ? bool(line, g('retired')) : undefined;
    if (!itemName || !visitorName || !itemRarity || itemPic === null || visitorPic === null || retired === null || cls === null) continue;

    // Find or create the visitor and item for this row.
    let visitor: HalloweenVisitor;
    let item: HalloweenItem;
    let isNewItem = false;
    const itemId = g('item_id');
    if (itemId) {
      const found = itemOwner.get(itemId);
      if (!found) {
        errors.push(`Row ${line}: no item with item_id "${itemId}". Leave item_id empty to add a new item.`);
        continue;
      }
      if (seenItems.has(itemId)) {
        errors.push(`Row ${line}: item_id "${itemId}" appears more than once.`);
        continue;
      }
      if (has('visitor_id') && g('visitor_id') && g('visitor_id') !== found.v.id) {
        errors.push(`Row ${line}: items can't move to another visitor (item_id "${itemId}" belongs to ${found.v.id}).`);
        continue;
      }
      seenItems.add(itemId);
      ({ v: visitor, it: item } = found);
    } else {
      const vid = has('visitor_id') ? g('visitor_id') : '';
      const existing = vid ? pack.visitors.find((v) => v.id === vid) : undefined;
      if (vid && !existing) {
        errors.push(`Row ${line}: no visitor with visitor_id "${vid}". Leave visitor_id empty to create a new visitor.`);
        continue;
      }
      if (existing) visitor = existing;
      else {
        const key = visitorName.toLowerCase();
        let v = newVisitors.get(key);
        if (!v) {
          if (pack.visitors.some((x) => x.name.toLowerCase() === key && !newVisitors.has(key))) {
            errors.push(`Row ${line}: a visitor called "${visitorName}" already exists. Put its visitor_id in the row to add an item to it.`);
            continue;
          }
          let id = slug(visitorName);
          for (let n = 2; pack.visitors.some((x) => x.id === id); n++) id = `${slug(visitorName)}-${n}`;
          v = { id, name: visitorName, rarity: cls ?? itemRarity, items: [] };
          pack.visitors.push(v);
          newVisitors.set(key, v);
          counts.visitorsAdded++;
          changes.push(`Row ${line}: **new visitor** ${visitorName} (${v.rarity})`);
        }
        visitor = v;
      }
      let iid = `${visitor.id}.${slug(itemName)}`;
      for (let n = 2; itemOwner.has(iid); n++) iid = `${visitor.id}.${slug(itemName)}-${n}`;
      item = { id: iid, name: itemName, rarity: itemRarity, description: g('item_description') || `A keepsake from ${visitorName}.` };
      visitor.items.push(item);
      itemOwner.set(iid, { v: visitor, it: item });
      isNewItem = true;
      counts.itemsAdded++;
      changes.push(`Row ${line}: **new item** ${itemName} (${itemRarity}) from ${visitorName}`);
    }

    // Item fields.
    const itemDiffs: string[] = [];
    const setItem = <K extends keyof HalloweenItem>(key: K, value: HalloweenItem[K], label: string) => {
      if (item[key] === value) return;
      if (!isNewItem) itemDiffs.push(label === 'picture' ? `picture ${value ? 'changed' : 'removed'}` : `${label} ${String(item[key] ?? '—')} → ${String(value ?? '—')}`);
      item[key] = value;
    };
    setItem('name', itemName, 'name');
    setItem('rarity', itemRarity, 'rarity');
    if (has('item_description') && g('item_description')) setItem('description', g('item_description'), 'description');
    if (has('item_picture')) setItem('image', itemPic ?? undefined, 'picture');
    if (itemDiffs.length) {
      counts.itemsChanged++;
      changes.push(`Row ${line} · ${item.name}: ${itemDiffs.join(', ')}`);
    }

    // Visitor fields (repeated on each of the visitor's rows; they must agree).
    const desired: Partial<HalloweenVisitor> = { name: visitorName };
    if (cls) desired.rarity = cls;
    if (has('visitor_picture')) desired.image = visitorPic ?? undefined;
    if (has('greeting')) desired.greeting = g('greeting') || undefined;
    if (has('trick_text')) desired.trickRequest = g('trick_text') || undefined;
    if (has('treat_text')) desired.treatRequest = g('treat_text') || undefined;
    if (has('win_text')) desired.winText = g('win_text') || undefined;
    if (has('retired')) desired.retired = retired || undefined;
    const snapshot = JSON.stringify(desired);
    const prev = visitorSeen.get(visitor);
    if (prev && prev.snapshot !== snapshot) {
      errors.push(`Row ${line}: visitor "${visitor.name}" has different values than in row ${prev.line}. Make its columns match on every row.`);
      continue;
    }
    if (prev) continue;
    visitorSeen.set(visitor, { line, snapshot });
    const vDiffs: string[] = [];
    const LABELS: Record<string, string> = {
      name: 'name',
      rarity: 'class',
      image: 'picture',
      greeting: 'greeting',
      trickRequest: 'trick text',
      treatRequest: 'treat text',
      winText: 'win text',
      retired: 'retired',
    };
    for (const [k, value] of Object.entries(desired) as [keyof HalloweenVisitor, unknown][]) {
      const before = k === 'rarity' ? visitorClass(visitor) : (visitor[k] as unknown);
      if ((before ?? undefined) === (value ?? undefined) || (k === 'retired' && !before && !value)) continue;
      const label = LABELS[k]!;
      if (k === 'name' || k === 'rarity') vDiffs.push(`${label} ${String(before ?? '—')} → ${String(value)}`);
      else if (k === 'retired') vDiffs.push(value ? 'retired' : 'brought back');
      else vDiffs.push(`${label} ${value ? 'updated' : 'cleared'}`);
      (visitor as unknown as Record<string, unknown>)[k] = value;
    }
    if (vDiffs.length && ![...newVisitors.values()].includes(visitor)) {
      changedVisitors.add(visitor);
      changes.push(`Row ${line} · visitor ${visitor.name}: ${vDiffs.join(', ')}`);
    }
  }

  counts.visitorsChanged = changedVisitors.size;
  if (!errors.length) {
    // Tidy undefined keys so the saved pack stays clean.
    for (const v of pack.visitors) for (const k of Object.keys(v) as (keyof HalloweenVisitor)[]) if (v[k] === undefined) delete v[k];
    const result = validateHalloweenPack(pack);
    errors.push(...result.errors);
  }
  return { pack, errors, changes, counts };
}
