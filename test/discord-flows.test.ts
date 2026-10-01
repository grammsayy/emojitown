import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HALLOWEEN_PACK } from '../src/content/defaultHalloween.js';
import { getBalance } from '../src/domain/candy.js';
import { getConfig } from '../src/domain/config.js';
import { getCurrentEvent, getEvent, listEvents } from '../src/domain/events.js';
import { recordActivity } from '../src/domain/halloween.js';
import { route } from '../src/discord/router.js';
import { parseDuration } from '../src/util/time.js';
import { findCustomId, text, World } from './fake-discord.js';

async function serverSetup(w: World) {
  w.role('staff');
  const r = await w.command('owner', 'setup server', { timezone: 'Europe/Berlin', staff_role: 'staff', log_channel: 'logs', support: '#help' });
  expect(text(r)).toContain('What changed');
  expect(text(r)).toContain('**Timezone:** Europe/Copenhagen → Europe/Berlin');
  expect(text(r)).toContain('**Staff roles:** added <@&staff>');
  return r;
}

async function confirmLast(w: World, userId: string, calls: { payload: any }[]) {
  const token = findCustomId(calls.at(-1)!.payload, 'cf|');
  expect(token).toBeDefined();
  return w.button(userId, token!);
}

afterEach(() => vi.unstubAllGlobals());

describe('durations', () => {
  it('parses s, m, h, d, w and combinations; bare numbers are minutes', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('10m')).toBe(600);
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration('1d')).toBe(86400);
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('1 h 30 m')).toBe(5400);
    expect(parseDuration('15')).toBe(900);
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('10x')).toBeNull();
    expect(parseDuration('0s')).toBeNull();
  });
});

describe('bot not in the server', () => {
  it('explains the problem and gives a working invite link instead of a vague error', async () => {
    const replies: any[] = [];
    const i: any = {
      guildId: '123',
      applicationId: '999',
      inCachedGuild: () => false,
      isAutocomplete: () => false,
      isRepliable: () => true,
      reply: async (p: any) => replies.push(p),
    };
    const w = new World('2026-10-05T12:00:00Z');
    await route(w.bot, i);
    expect(replies[0].content).toContain("isn't a member of this server");
    expect(replies[0].content).toContain('client_id=999&scope=bot+applications.commands');
    expect(replies[0].content).toContain('guild_id=123');
  });
});

describe('permissions', () => {
  it('members cannot use /setup, /admin or /mod; staff can use /mod but not /admin', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await serverSetup(w);
    expect(text(await w.command('alice', 'setup halloween', { channel: 'spooky' }))).toContain('Only server administrators');
    expect(text(await w.command('alice', 'mod pause', { game: 'halloween', reason: 'x' }))).toContain('Only event staff');
    w.members.get('mod')!.roles.cache.set('staff', true);
    expect(text(await w.command('mod', 'mod candy-history', { member: 'bob' }))).toContain('Candy history');
    expect(text(await w.command('mod', 'admin give-candy', { member: 'bob', amount: 5, reason: 'y' }))).toContain('Only server administrators');
  });

  it('confirmations: only the requester can confirm or cancel; the result says what changed', async () => {
    const w = new World('2026-12-05T12:00:00Z');
    const calls = await w.command('owner', 'admin give-candy', { member: 'bob', amount: 5, reason: 'trivia winner' });
    expect(text(calls)).toContain('0 → 5');
    const token = findCustomId(calls.at(-1)!.payload, 'cf|')!;
    const cancel = findCustomId(calls.at(-1)!.payload, 'cx|')!;
    expect(text(await w.button('alice', token))).toContain('Only the staff member who ran the command');
    expect(text(await w.button('alice', cancel))).toContain('Only the staff member who ran the command');
    expect(getBalance(w.ctx, 'g1', 'bob')).toBe(0);
    expect(text(await w.button('owner', token))).toContain("**<@bob>'s candy:** 0 → 5");
  });
});

describe('/setup server', () => {
  it('reports exactly what changed, and "Nothing changed" on a repeat', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await serverSetup(w);
    const again = await w.command('owner', 'setup server', { timezone: 'Europe/Berlin', staff_role: 'staff', log_channel: 'logs' });
    expect(text(again)).toContain('Nothing changed');
    const tz = await w.command('owner', 'setup server', { timezone: 'America/New_York' });
    expect(text(tz)).toContain('**Timezone:** Europe/Berlin → America/New_York');
    w.role('g1');
    expect(text(await w.command('owner', 'setup server', { staff_role: 'g1' }))).toContain('every member staff access');
  });
});

describe('Halloween, set up with one command', () => {
  it('goes live immediately, spawns visitors on the configured timer, and every staff action reports the change', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await serverSetup(w);
    w.role('champ');
    const setup = await w.command('owner', 'setup halloween', { channel: 'spooky', champion_role: 'champ', wait_min: '30s', wait_max: '1m', visit_length: '2m' });
    const t = text(setup);
    expect(t).toContain('**Season:** none → Halloween 2026');
    expect(t).toContain('**Channels:** none → <#spooky>');
    expect(t).toContain('**Shortest wait between visitors:** 10m → 30s');
    expect(t).toContain('**Longest wait between visitors:** 20m → 1m');
    expect(t).toContain('**Visit length:** 1m 30s → 2m');
    expect(t).toContain('**Champion role:** none → <@&champ>');
    expect(t).toContain('🟢 live now');
    expect(getCurrentEvent(w.ctx, 'g1', 'halloween')!.state).toBe('active');

    // Same command again: nothing changes.
    expect(text(await w.command('owner', 'setup halloween', { channel: 'spooky', wait_min: '30s' }))).toContain('Nothing changed');

    // A visitor appears within the 30s–1m window once someone has chatted.
    recordActivity(w.ctx, 'g1', 'spooky');
    w.ctx.advance(61_000);
    w.ctx.rolls = [0, 0, 0.1];
    await w.tick();
    const post = w.sent.find((s) => s.channelId === 'spooky')!;
    expect(post).toBeDefined();
    expect(JSON.stringify(post.payload)).toContain('TRICK');
    const enc = post.message;
    w.ctx.rolls = [0.99, 0];
    expect(text(await w.button('alice', findCustomId(post.payload, 'hw|trick|')!, enc))).toContain('+5 candy');
    const card = JSON.stringify(enc.payload);
    expect(card).toContain('Happy Halloween!');
    expect(card).toContain('As a thank you for the trick');
    expect(card).toContain('<@alice>');
    expect(card).toContain('It has been added to your inventory.');
    expect(card).toContain('+5 candy');
    expect(w.members.get('alice')!.roles.cache.has('champ')).toBe(true);

    // Member views.
    const inv = await w.command('alice', 'inventory');
    expect(text(inv)).toContain('1/120');
    const missing = await w.button('alice', findCustomId(inv[0]!.payload, 'hw|miss|')!);
    expect(text(missing)).toContain('Missing: 119');
    expect(text(await w.button('alice', findCustomId(missing[0]!.payload, 'hw|inv|')!))).toContain('1/120');
    expect(text(await w.command('bob', 'leaderboard'))).toContain('Halloween leaderboard');
    expect(text(await w.command('bob', 'events'))).toContain('live now');

    // Staff actions say what changed.
    expect(text(await w.command('owner', 'mod preview', { game: 'halloween' }))).toContain('Preview');
    expect(text(await w.command('owner', 'mod pause', { game: 'halloween', reason: 'break' }))).toContain('🟢 live → ⏸️ paused');
    expect(text(await w.command('owner', 'mod pause', { game: 'halloween', reason: 'break' }))).toContain('already paused. Nothing changed');
    expect(text(await w.command('owner', 'mod resume', { game: 'halloween' }))).toContain('⏸️ paused → 🟢 live');
    expect(text(await w.command('owner', 'mod exclude', { member: 'bob', game: 'all', reason: 'test' }))).toContain('playing → excluded');
    expect(text(await w.command('owner', 'mod include', { member: 'bob', game: 'all', reason: 'test' }))).toContain('excluded → playing');
    expect(text(await w.command('owner', 'admin fix-item', { member: 'bob', action: 'grant', item: 'pumpkin-pete.golden-gourd', reason: 'bug' }))).toContain(
      '**Collection:** 0 → 1',
    );

    const end = await w.command('owner', 'admin end', { game: 'halloween', champion_role: 'remove' });
    expect(text(end)).toContain('Champion role is removed');
    expect(text(await confirmLast(w, 'owner', end))).toContain('→ 🏁 ended');
    const ev = listEvents(w.ctx, 'g1', 'halloween')[0]!;
    expect(ev.state).toBe('ended');
    expect(ev.championKeepRole).toBe(false);
  });

  it('rejects bad durations before changing anything', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    expect(text(await w.command('owner', 'setup halloween', { channel: 'spooky', wait_min: 'soon' }))).toContain("isn't a duration");
    expect(text(await w.command('owner', 'setup halloween', { channel: 'spooky', wait_min: '5m', wait_max: '1m' }))).toContain("can't be longer");
    expect(listEvents(w.ctx, 'g1', 'halloween')).toHaveLength(0);
    expect(getConfig(w.ctx, 'g1').hwSpawnMinS).toBe(600);
  });

  it('refuses unsafe Champion roles', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    const { PermissionFlagsBits } = await import('discord.js');
    w.role('mods', 5, PermissionFlagsBits.ManageMessages);
    expect(text(await w.command('owner', 'setup halloween', { champion_role: 'mods' }))).toContain('must not carry moderation permissions');
    const shared = w.role('regulars');
    shared.members.set('alice', w.members.get('alice'));
    shared.members.set('bob', w.members.get('bob'));
    expect(text(await w.command('owner', 'setup halloween', { champion_role: 'regulars' }))).toContain('dedicated role');
  });

  it('uploading content while live switches the running season and says so', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await w.command('owner', 'setup halloween', { channel: 'spooky' });
    const pack = structuredClone(DEFAULT_HALLOWEEN_PACK);
    pack.visitors[0]!.name = 'Pumpkin Pete the Great';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(pack)));
    const r = await w.command('owner', 'setup content', { game: 'halloween', file: { url: 'https://cdn.discordapp.com/x.json', size: 1000, name: 'x.json' } });
    expect(text(r)).toContain('v0 (built-in placeholder) → v1');
    expect(text(r)).toContain('now uses v1 (live)');
    expect(getCurrentEvent(w.ctx, 'g1', 'halloween')!.contentVersion).toBe(1);
    const download = await w.command('owner', 'setup content', { game: 'halloween' });
    expect(download[0]!.payload.files).toHaveLength(1);
    expect(text(download)).toContain('Nothing changed');
  });

  it('pauses the game and alerts staff when its channel disappears', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await serverSetup(w);
    await w.command('owner', 'setup halloween', { channel: 'spooky' });
    w.channels.delete('spooky');
    await w.tick();
    expect(getCurrentEvent(w.ctx, 'g1', 'halloween')!.state).toBe('paused');
    expect(w.sent.some((s) => s.channelId === 'logs' && JSON.stringify(s.payload).includes('/mod resume game:halloween'))).toBe(true);
  });
});

describe('Snowball Fights, set up with one command', () => {
  it('collect, throw, stats, join/leave and staff fixes', async () => {
    const w = new World('2026-12-05T12:00:00Z');
    expect(text(await w.command('owner', 'setup snowball', { channel: 'snow' }))).toContain('🟢 live now');

    expect(text(await w.command('alice', 'collect', {}, 'general'))).toContain('Snowball fights happen in');
    const c = await w.command('alice', 'collect', {}, 'snow');
    expect(text(c)).toContain('Snowball collected');
    expect(text(await w.command('alice', 'throw', { target: 'bot' }, 'snow'))).toContain("Bots don't play");
    w.ctx.rolls = [0.1, 0];
    const t = await w.command('alice', 'throw', { target: 'bob' }, 'snow');
    expect(t[0]!.payload.flags).toBeUndefined();
    expect(text(t)).toContain('Direct hit');
    w.ctx.advance(30_000);
    await w.button('alice', 'sb|collect', undefined, 'snow');
    expect(findCustomId((await w.button('alice', 'sb|throw', undefined, 'snow'))[0]!.payload, 'sb|target')).toBe('sb|target');
    w.ctx.rolls = [0.9, 0];
    expect(text(await w.select('alice', 'sb|target', ['carol'], 'snow'))).toContain('Missed');
    expect(text(await w.command('alice', 'stats'))).toContain('Hits');
    expect(text(await w.command('bob', 'leaderboard', { game: 'snowball' }))).toContain('<@alice>');

    expect(text(await w.command('bob', 'snowball leave'))).toContain('playing → left');
    expect(text(await w.command('bob', 'snowball leave'))).toContain('Nothing changed');
    expect(text(await w.command('alice', 'throw', { target: 'bob' }, 'snow'))).toContain("isn't playing");
    expect(text(await w.command('bob', 'snowball join'))).toContain('left → playing');

    const fix = await w.command('owner', 'admin fix-stats', { member: 'alice', stat: 'collected', value: 10, reason: 'lost' });
    expect(text(fix)).toContain('Before');
    expect(text(await confirmLast(w, 'owner', fix))).toContain('collected 10');
    expect(text(await w.command('owner', 'admin clear-warmup', { member: 'bob', reason: 'bug' }))).toContain('→ cleared');
    expect(text(await w.command('owner', 'mod preview', { game: 'snowball' }))).toContain('Direct hit');
  });
});

describe('Advent Calendar', () => {
  it('setup → write doors → starts itself on Dec 1 → open doors', async () => {
    const w = new World('2026-11-20T12:00:00Z');
    await serverSetup(w);
    const setup = await w.command('owner', 'setup advent', { channel: 'advent' });
    expect(text(setup)).toContain('**Status:** not scheduled → starts automatically');
    expect(text(setup)).toContain('Door 1 is missing');

    for (let day = 1; day <= 24; day++) {
      const calls = await w.command('owner', 'setup door', { day, candy: day === 2 ? 0 : null });
      expect(calls[0]!.type).toBe('modal');
      const res = await w.modal('owner', calls[0]!.payload.custom_id, {
        title: `Door ${day}`,
        message: day === 3 ? 'Which snowman is tallest?' : `Surprise ${day}`,
        answer: day === 3 ? 'Frosty' : '',
      });
      expect(text(res)).toContain(`**Door ${day}:** empty → written`);
      expect(text(res)).toContain(`**Doors written:** ${day}/24`);
    }
    const edit = await w.command('owner', 'setup door', { day: 5, candy: 15 });
    expect(text(await w.modal('owner', edit[0]!.payload.custom_id, { title: 'Door 5', message: 'Surprise 5' }))).toContain('**Candy:** 10 → 15');
    expect(text(await w.command('owner', 'setup status'))).toContain('✅ Ready');

    // Before unlock: /advent shows when today's door opens.
    w.ctx.set('2026-12-01T07:00:00Z');
    await w.tick();
    expect(getCurrentEvent(w.ctx, 'g1', 'advent')!.state).toBe('active');
    expect(text(await w.command('alice', 'advent'))).toContain("Today's door opens");

    w.ctx.set('2026-12-01T08:00:30Z');
    await w.tick();
    const post = w.sent.find((s) => s.channelId === 'advent')!;
    expect(JSON.stringify(post.payload)).toContain('Door 1 is open');
    expect(text(await w.button('alice', findCustomId(post.payload, 'adv|open|')!, post.message))).toContain('10 candy');
    expect(text(await w.command('alice', 'advent'))).toContain('already opened');

    // Edits to a live calendar need a reason.
    expect(text(await w.command('owner', 'setup door', { day: 6 }))).toContain('Add a `reason`');

    w.ctx.set('2026-12-04T10:00:00Z');
    await w.tick();
    expect(JSON.stringify(w.sent.filter((s) => s.channelId === 'advent')[1]!.payload)).toContain('3 Advent doors are open');
    expect(text(await w.select('bob', `adv|pick|${getCurrentEvent(w.ctx, 'g1', 'advent')!.id}`, ['3']))).toContain('Reveal Answer');
    expect(text(await w.command('bob', 'advent', { day: 4 }))).toContain('10 candy');

    const candy = await w.command('bob', 'candy');
    expect(text(candy)).toContain('Balance: **20 candy**');
    expect(text(await w.button('bob', findCustomId(candy[0]!.payload, 'candy|hist|')!))).toContain('Advent door 4');
    expect(text(await w.command('bob', 'leaderboard', { game: 'candy' }))).toContain('<@alice>');
    expect(text(await w.command('owner', 'mod repost-door', { day: 4 }))).toContain('posted again');
  });
});

describe('help and export', () => {
  it('help covers every game and includes the support link; export returns a file', async () => {
    const w = new World('2026-12-05T12:00:00Z');
    await serverSetup(w);
    for (const game of [null, 'snowball', 'halloween', 'advent', 'candy']) {
      expect(text(await w.command('alice', 'help', { game }))).toContain('#help');
    }
    await w.command('owner', 'setup snowball', { channel: 'snow' });
    expect((await w.command('owner', 'admin export', { game: 'snowball' }))[0]!.payload.files).toHaveLength(1);
    expect(text(await w.command('owner', 'admin audit'))).toContain('setup.snowball');
    expect(getEvent(w.ctx, 'g1', 'snowball-fights-2026')).not.toBeNull();
  });
});

describe('command visibility follows which games are live', () => {
  it('shows only the live game’s commands, and reports when they appear or disappear', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await w.tick();
    expect(w.registered).toEqual(['admin', 'candy', 'events', 'help', 'leaderboard', 'mod', 'setup', 'visitor']);

    const setup = await w.command('owner', 'setup halloween', { channel: 'spooky' });
    expect(text(setup)).toContain('**Member commands:** now showing /inventory, /treat, /trick');
    expect(w.registered).toContain('trick');
    expect(w.registered).not.toContain('collect');
    expect(w.registered).not.toContain('advent');

    // Nothing changed, so the scheduler doesn't touch Discord again.
    const syncs = w.commandSyncs;
    await w.tick();
    expect(w.commandSyncs).toBe(syncs);

    // Pausing keeps the commands (they explain the pause); ending hides them.
    await w.command('owner', 'mod pause', { game: 'halloween', reason: 'x' });
    await w.tick();
    expect(w.registered).toContain('trick');
    const end = await w.command('owner', 'admin end', { game: 'halloween' });
    expect(text(await confirmLast(w, 'owner', end))).toContain('hidden /inventory, /treat, /trick');
    expect(w.registered).not.toContain('trick');
  });

  it('a scheduled game’s commands appear by themselves when it starts', async () => {
    const w = new World('2026-11-28T12:00:00Z');
    await w.command('owner', 'setup snowball', { channel: 'snow' });
    await w.tick();
    expect(w.registered).not.toContain('collect');
    w.ctx.set('2026-12-01T00:00:30Z');
    await w.tick();
    expect(w.registered).toEqual(expect.arrayContaining(['collect', 'throw', 'stats', 'snowball']));
    expect(w.registered).not.toContain('trick');
  });
});

describe('changing visitor waits on a live Halloween', () => {
  it('moves the already-booked visitor up and explains what it is waiting for', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await w.command('owner', 'setup halloween', { channel: 'spooky' }); // default 10–20 minute waits
    const r = await w.command('owner', 'setup halloween', { wait_min: '10s', wait_max: '20s' });
    expect(text(r)).toContain('**Shortest wait between visitors:** 10m → 10s');
    expect(text(r)).toContain('**Next visitor:** moved up');

    // Nobody has chatted: status says so instead of silently waiting.
    w.ctx.advance(21_000);
    await w.tick();
    expect(w.sent.some((s) => s.channelId === 'spooky')).toBe(false);
    expect(text(await w.command('owner', 'setup status'))).toContain('Post a message in <#spooky>');

    // Someone chats: a visitor arrives within the 10s re-check (not a whole minute).
    recordActivity(w.ctx, 'g1', 'spooky');
    expect(text(await w.command('owner', 'setup status'))).toContain('Next visitor');
    w.ctx.advance(10_000);
    w.ctx.rolls = [0, 0, 0.1];
    await w.tick();
    expect(w.sent.some((s) => s.channelId === 'spooky')).toBe(true);
    expect(text(await w.command('owner', 'setup status'))).toContain('A visitor is in <#spooky> right now');
  });
});

describe('custom Halloween visitors and classes', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const picture = { url: 'https://cdn.discordapp.com/attachments/1/2/ghost.png', size: PNG.length, contentType: 'image/png' };

  async function addVisitor(w: World, cls: string, fields: Record<string, string>, withPicture = false) {
    const calls = await w.command('owner', 'visitor add', { class: cls, ...(withPicture ? { picture } : {}) });
    expect(calls[0]!.type).toBe('modal');
    return w.modal('owner', calls[0]!.payload.custom_id, fields);
  }

  it('creates visitors with pictures and texts, and rarer classes pay bonus candy', async () => {
    vi.stubGlobal('fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const w = new World('2026-10-05T12:00:00Z');

    const calls = await w.command('owner', 'visitor add', { class: 'rare', picture, win_text: 'Ghosty swirls happily and gives {winner} one **{item}**!' });
    const added = await w.modal('owner', calls[0]!.payload.custom_id, { name: 'Ghosty', greeting: 'Boo! Ghosty floats in.', trick: '{name} wants a spooky TRICK!', item: 'Ghost Pin' });
    const t = text(added);
    expect(t).toContain('**Visitor:** none → Ghosty');
    expect(t).toContain('**Class:** 🟣 Rare (+5 bonus candy)');
    expect(t).toContain('**Picture:** added');
    expect(t).toContain('**Collectible:** Ghost Pin');
    expect(t).toContain('40 are built-in placeholders');
    expect(added[0]!.payload.files.length).toBeGreaterThan(0);

    const removed = await w.command('owner', 'visitor remove', { visitor: '__placeholders__' });
    expect(text(removed)).toContain('**Active visitors now:** 1');

    // Ghosty is the only visitor, so it is the one that appears, with its picture and texts.
    await w.command('owner', 'setup halloween', { channel: 'spooky', wait_min: '10s', wait_max: '10s' });
    recordActivity(w.ctx, 'g1', 'spooky');
    w.ctx.advance(11_000);
    w.ctx.rolls = [0, 0, 0.1];
    await w.tick();
    const post = w.sent.find((s) => s.channelId === 'spooky')!;
    const payload = JSON.stringify(post.payload);
    expect(payload).toContain('Rare visitor');
    expect(payload).toContain('Boo! Ghosty floats in.');
    expect(payload).toContain('Ghosty wants a spooky TRICK!');
    expect(payload).toContain('attachment://');
    expect(post.payload.files).toHaveLength(1);

    const win = await w.button('alice', findCustomId(post.payload, 'hw|trick|')!, post.message);
    expect(text(win)).toContain('+10 candy (includes +5 🟣 Rare bonus)');
    const card = JSON.stringify(post.message.payload);
    expect(card).toContain('Ghosty swirls happily and gives <@alice> one **Ghost Pin**!');
    expect(card).toContain('This item is rare! Hold on to it tight.');
    expect(card).toContain('"image":{"url":"attachment://');
    expect(getBalance(w.ctx, 'g1', 'alice')).toBe(10);
    expect(text(await w.command('alice', 'inventory'))).toContain('Ghost Pin');

    // Editing reports the change; classes can be tuned.
    const edit = await w.command('owner', 'visitor edit', { visitor: 'ghosty', class: 'legendary' });
    expect(text(await w.modal('owner', edit[0]!.payload.custom_id, { name: 'Ghosty', greeting: 'Boo! Ghosty floats in.', trick: '{name} wants a spooky TRICK!', item: 'Ghost Pin' }))).toContain(
      '**Class:** 🟣 Rare → 🟡 Legendary (+10 bonus candy)',
    );
    expect(text(await w.command('owner', 'setup class', { class: 'legendary', chance: 5, bonus_candy: 25 }))).toContain('+10 → +25');
    expect(text(await w.command('owner', 'setup class', { class: 'legendary', chance: 5, bonus_candy: 25 }))).toContain('Nothing changed');
    expect(text(await w.command('owner', 'setup class', { class: 'legendary', rarity_text: 'WOW. A legendary find!' }))).toContain('Legendary rarity text:');

    // Removing the last visitor is refused; with a second one, Ghosty is retired (Alice keeps her pin).
    expect(text(await w.command('owner', 'visitor remove', { visitor: 'ghosty' }))).toContain('leave no visitors');
    await addVisitor(w, 'common', { name: 'Batsy' });
    expect(text(await w.command('owner', 'visitor remove', { visitor: 'ghosty' }))).toContain('**Retired:** Ghosty');
    expect(text(await w.command('alice', 'inventory'))).toContain('Ghost Pin');
    expect(text(await w.command('owner', 'visitor list'))).toContain('Batsy');
    expect(text(await w.command('owner', 'visitor list'))).not.toContain('Ghosty');
  });

  it('refuses non-image files and duplicate names', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    expect(text(await w.command('owner', 'visitor add', { class: 'rare', picture: { ...picture, contentType: 'application/pdf' } }))).toContain('PNG, JPG, GIF or WEBP');
    await addVisitor(w, 'rare', { name: 'Ghosty' });
    expect(text(await addVisitor(w, 'rare', { name: 'ghosty' }))).toContain('already a visitor called');
  });
});

describe('/admin message-test', () => {
  it('previews every message for each game with real content, privately, with buttons disabled', async () => {
    const { TEST_MESSAGES, messageChoices } = await import('../src/discord/handlers/messageTest.js');
    const w = new World('2026-10-05T12:00:00Z');
    await w.command('owner', 'setup halloween', { channel: 'spooky' });

    expect(messageChoices('halloween', '')[0]!.name).toBe(`All ${TEST_MESSAGES.halloween.length} messages`);
    expect(messageChoices('halloween', 'win card').map((c) => c.value)).toEqual(['win', 'win-duplicate']);

    const all = await w.command('owner', 'admin message-test', { game: 'halloween', message: 'all', visitor: 'pumpkin-pete' });
    expect(all).toHaveLength(TEST_MESSAGES.halloween.length);
    expect(all[0]!.type).toBe('reply');
    expect(all.slice(1).every((c) => c.type === 'followUp' && c.payload.flags !== undefined)).toBe(true);
    const t = text(all);
    expect(t).toContain('Test 1/13: Visitor arrives (wants a Trick)');
    expect(t).toContain('Pumpkin Pete');
    expect(t).toContain('Happy Halloween!');
    expect(t).toContain("You already had this one");
    expect(t).not.toContain('⚠️');
    for (const c of all) for (const r of c.payload.components ?? []) for (const b of r.components) expect(b.disabled).toBe(true);
    // Nothing was saved.
    expect(w.ctx.db.prepare('SELECT COUNT(*) n FROM hw_encounters').get()).toEqual({ n: 0 });
    expect(getBalance(w.ctx, 'g1', 'owner')).toBe(0);

    const pub = await w.command('owner', 'admin message-test', { game: 'snowball', message: 'hit', public: true });
    expect(pub[0]!.payload.flags).toBeUndefined();
    expect(text(pub)).toContain('Direct hit');

    // Advent without doors explains what's missing instead of failing.
    await w.command('owner', 'setup advent', { channel: 'advent' });
    expect(text(await w.command('owner', 'admin message-test', { game: 'advent', message: 'door-post' }))).toContain('No doors are written yet');
    expect(text(await w.command('owner', 'admin message-test', { game: 'snowball', message: 'results' }))).toContain('Run `/setup snowball` first');
    await w.command('owner', 'setup snowball', { channel: 'snow' });
    const snow = await w.command('owner', 'admin message-test', { game: 'snowball', message: 'all' });
    expect(snow).toHaveLength(TEST_MESSAGES.snowball.length);
    expect(text(snow)).not.toContain('⚠️');
  });
});
