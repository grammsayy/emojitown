import { describe, expect, it } from 'vitest';
import { DEFAULT_HALLOWEEN_PACK } from '../src/content/defaultHalloween.js';
import { currencyFor, parseCurrency } from '../src/domain/currency.js';
import { text, World } from './fake-discord.js';

describe('renaming candy', () => {
  it('parses an emoji and a name, keeping the old emoji when none is given', () => {
    expect(parseCurrency('🎃 candy corn', '🍬')).toEqual({ emoji: '🎃', name: 'candy corn' });
    expect(parseCurrency('cookies', '🍪')).toEqual({ emoji: '🍪', name: 'cookies' });
    expect(parseCurrency('<:pumpkin:123456789012345678> seeds', '🍬')).toEqual({ emoji: '<:pumpkin:123456789012345678>', name: 'seeds' });
    expect(parseCurrency('❄️  snow   flakes', '🍬')).toEqual({ emoji: '❄️', name: 'snow flakes' });
    expect(() => parseCurrency('🎃', '🍬')).toThrow('needs a name');
    expect(() => parseCurrency('**bold**', '🍬')).toThrow("can't contain");
  });

  it('staff set seasonal names; members see them; the balance stays the same', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    w.role('staff');
    await w.staff('owner', 'settings', { timezone: 'Europe/Berlin', staff_role: 'staff' });
    w.members.get('mod')!.roles.cache.set('staff', true);
    await w.staff('owner', 'season halloween', { channel: 'spooky' });

    // Event staff (not just admins) can rename.
    const r = text(await w.action('mod', 'season', 'currency', { halloween: '🎃 candy corn', advent: '🍪 cookies' }));
    expect(r).toContain('**Halloween:** same as default → 🎃 candy corn');
    expect(r).toContain('**Advent Calendar:** same as default → 🍪 cookies');
    expect(text(await w.action('mod', 'season', 'currency', { halloween: '🎃 candy corn', advent: '🍪 cookies' }))).toContain('Nothing changed');

    // Halloween is live, so general messages use its name.
    await w.staff('owner', 'adjust candy', { member: 'alice', amount: 12, reason: 'test' }).then((c) => w.button('owner', c.at(-1)!.payload.components[0].components[0].data.custom_id));
    const bal = text(await w.command('alice', 'candy'));
    expect(bal).toContain('12 candy corn');
    expect(text(await w.command('alice', 'help', { game: 'candy' }))).toContain('🎃 Candy corn');
    expect(text(await w.command('alice', 'help', { game: 'advent' }))).toContain('gives its cookies once');

    const { winnerReply } = await import('../src/discord/handlers/halloween.js');
    const v = DEFAULT_HALLOWEEN_PACK.visitors[0]!;
    const win = JSON.stringify(winnerReply(w.bot, 'g1', { visitor: v, item: v.items[0]!, duplicate: false, candy: 5, bonus: 0, capped: false, unique: 1 }));
    expect(win).toContain('🎃 +5 candy corn');
    expect(win).toContain('"name":"Candy corn"');

    // Clearing a game's name goes back to the default; the default can be renamed too.
    await w.action('mod', 'season', 'currency', { default: '💎 gems', halloween: null, advent: '🍪 cookies' });
    expect(currencyFor(w.ctx, 'g1', 'halloween')).toEqual({ emoji: '💎', name: 'gems' });
    expect(currencyFor(w.ctx, 'g1', 'advent')).toEqual({ emoji: '🍪', name: 'cookies' });
    expect(text(await w.command('alice', 'candy'))).toContain('12 gems');

    // Members can't rename.
    expect(text(await w.action('alice', 'season', 'currency', { default: '🪙 coins' }))).toContain('Only event staff');
  });
});
