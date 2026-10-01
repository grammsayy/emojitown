import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCsv, toCsv } from '../src/util/csv.js';
import { currentPack } from '../src/domain/visitors.js';
import { findCustomId, text, World } from './fake-discord.js';

afterEach(() => vi.unstubAllGlobals());

describe('csv', () => {
  it('round-trips commas, quotes, newlines and emoji; reads semicolon files and a BOM', () => {
    const csv = toCsv(['a', 'b'], [{ a: 'Hello, "world"', b: 'line1\nline2 🎃' }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(parseCsv(csv).rows[0]!.values).toEqual({ a: 'Hello, "world"', b: 'line1\nline2 🎃' });
    const semi = parseCsv('﻿item_id;item_name\r\nx.1;Pin, shiny\r\n');
    expect(semi.rows[0]!.values).toEqual({ item_id: 'x.1', item_name: 'Pin, shiny' });
    expect(semi.rows[0]!.line).toBe(2);
  });
});

describe('/visitor export and import', () => {
  async function download(w: World, rarity: string) {
    const r = await w.staff('owner', 'visitor export', { rarity });
    const file = r.find((c) => c.payload?.files)!.payload.files[0];
    return { reply: r, csv: Buffer.from(file.attachment).toString('utf8') };
  }

  async function upload(w: World, csv: string) {
    vi.stubGlobal('fetch', async () => new Response(csv));
    return w.staff('owner', 'visitor import', { file: { url: 'https://cdn.discordapp.com/attachments/1/2/items.csv', size: csv.length, name: 'items.csv' } });
  }

  it('mass-edits commons, and uncommon + rare, via a spreadsheet', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await w.staff('owner', 'season halloween', { channel: 'spooky' });

    const commons = await download(w, 'common');
    expect(text(commons.reply)).toContain('40 common items');
    const ur = await download(w, 'uncommon-rare');
    expect(text(ur.reply)).toContain('80 uncommon + rare items');

    // Rename one common item and promote another to uncommon.
    const edited = commons.csv
      .replace('pumpkin-pete.pumpkin-seed,pumpkin-pete,🎃 Pumpkin Pete,common,Pumpkin Seed,common', 'pumpkin-pete.pumpkin-seed,pumpkin-pete,🎃 Pumpkin Pete,common,Lucky Pumpkin Seed,common')
      .replace('ghostly-gus.bedsheet-scrap,ghostly-gus,👻 Ghostly Gus,common,Bedsheet Scrap,common', 'ghostly-gus.bedsheet-scrap,ghostly-gus,👻 Ghostly Gus,common,Bedsheet Scrap,uncommon');
    const preview = await upload(w, edited);
    const t = text(preview);
    expect(t).toContain('Apply these changes? 2 items changed');
    expect(t).toContain('name Pumpkin Seed → Lucky Pumpkin Seed');
    expect(t).toContain('rarity common → uncommon');
    // Nothing is applied until Confirm.
    expect(currentPack(w.ctx, 'g1').visitors[0]!.items[0]!.name).toBe('Pumpkin Seed');
    const done = await w.button('owner', findCustomId(preview.at(-1)!.payload, 'cf|')!);
    expect(text(done)).toContain('Imported: 2 items changed');
    const pack = currentPack(w.ctx, 'g1');
    expect(pack.visitors[0]!.items[0]!.name).toBe('Lucky Pumpkin Seed');
    expect(pack.visitors[1]!.items.find((i) => i.id === 'ghostly-gus.bedsheet-scrap')!.rarity).toBe('uncommon');

    // Uploading the same file again changes nothing.
    expect(text(await upload(w, edited))).toContain('Nothing changed');
  });

  it('adds new visitors from rows with an empty item_id, and reports mistakes by row', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    const header = 'item_id,visitor_id,visitor_name,visitor_class,item_name,item_rarity,item_description,item_picture\n';
    const add = header + ',,Mr Unicorn,rare,Magical Plate,rare,Sparkles a lot,https://example.com/plate.png\n,,Mr Unicorn,rare,Horn Polish,common,,\n';
    const preview = await upload(w, add);
    expect(text(preview)).toContain('1 new visitor · 2 new items');
    await w.button('owner', findCustomId(preview.at(-1)!.payload, 'cf|')!);
    const unicorn = currentPack(w.ctx, 'g1').visitors.find((v) => v.name === 'Mr Unicorn')!;
    expect(unicorn.rarity).toBe('rare');
    expect(unicorn.items.map((i) => i.name)).toEqual(['Magical Plate', 'Horn Polish']);

    const bad = header + 'pumpkin-pete.pumpkin-seed,pumpkin-pete,Pumpkin Pete,common,Seed,shiny,,\nnope.id,,X,common,Y,common,,\n';
    const r = text(await upload(w, bad));
    expect(r).toContain('Import stopped. Nothing changed.');
    expect(r).toContain('Row 2: item_rarity');
    expect(r).toContain('Row 3: no item with item_id');

    expect(text(await upload(w, 'name,thing\na,b\n'))).toContain('missing these columns');
  });

  it('reads files saved by Excel with semicolons', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    expect(text(await w.staff('owner', 'visitor export', { rarity: 'legendary' }))).toContain('There are no legendary items to export');
    const semi = '﻿item_id;visitor_name;item_name;item_rarity\r\npumpkin-pete.golden-gourd;🎃 Pumpkin Pete;Golden Gourd;legendary\r\n';
    const preview = await upload(w, semi);
    expect(text(preview)).toContain('rarity rare → legendary');
  });
});
