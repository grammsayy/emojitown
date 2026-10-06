import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HALLOWEEN_PACK } from '../src/content/defaultHalloween.js';
import { getBalance } from '../src/domain/candy.js';
import { findCustomId, text, World } from './fake-discord.js';

// Discord IDs are numbers; the spreadsheet checks for that, so use real-looking ones.
const VIP = '111111111111111111';
const SECRET = '222222222222222222';
const ITEM = DEFAULT_HALLOWEEN_PACK.visitors[0]!.items[0]!;

async function setup() {
  const w = new World('2026-10-05T12:00:00Z');
  w.role('staff');
  await w.staff('owner', 'settings', { timezone: 'Europe/Berlin', staff_role: 'staff', log_channel: 'logs' });
  await w.staff('owner', 'season halloween', { channel: 'spooky' });
  w.role(VIP, 3);
  w.channel(SECRET);
  return w;
}

const hasRole = (w: World, user: string, role: string) => w.members.get(user)!.roles.cache.has(role);
const canSee = (w: World, user: string, channel: string) => !!w.channels.get(channel)!.permissionOverwrites.cache.get(user)?.allow.has(PermissionFlagsBits.ViewChannel);

describe('item rewards', () => {
  it('an item can give a role and open a channel just for its owner, and both go away with the item', async () => {
    const w = await setup();
    const set = text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP, channel: SECRET }));
    expect(set).toContain(`**Role:** none → <@&${VIP}>`);
    expect(set).toContain(`**Channel access:** none → <#${SECRET}>`);

    const give = text(await w.staff('owner', 'player give-item', { member: 'alice', item: ITEM.id, reason: 'test' }));
    expect(give).toContain('**Rewards given:**');
    expect(hasRole(w, 'alice', VIP)).toBe(true);
    expect(canSee(w, 'alice', SECRET)).toBe(true);
    expect(canSee(w, 'bob', SECRET)).toBe(false);

    const remove = text(await w.staff('owner', 'player remove-item', { member: 'alice', item: ITEM.id, reason: 'test' }));
    expect(remove).toContain('**Rewards taken back:**');
    expect(hasRole(w, 'alice', VIP)).toBe(false);
    expect(w.channels.get(SECRET)!.permissionOverwrites.cache.has('alice')).toBe(false);
  });

  it('never takes away a role the member already had', async () => {
    const w = await setup();
    w.members.get('bob')!.roles.cache.set(VIP, true);
    await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP });
    await w.staff('owner', 'player give-item', { member: 'bob', item: ITEM.id, reason: 'test' });
    await w.staff('owner', 'player remove-item', { member: 'bob', item: ITEM.id, reason: 'test' });
    expect(hasRole(w, 'bob', VIP)).toBe(true);
  });

  it('members who already own the item get it when the reward is added, and lose it when removed', async () => {
    const w = await setup();
    await w.staff('owner', 'player give-item', { member: 'alice', item: ITEM.id, reason: 'test' });
    const set = text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP }));
    expect(set).toContain('1 member');
    await w.tick();
    expect(hasRole(w, 'alice', VIP)).toBe(true);
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, what: 'remove-all' }))).toContain(`**Role:** <@&${VIP}> → none`);
    await w.tick();
    expect(hasRole(w, 'alice', VIP)).toBe(false);
  });

  it('wiping everyone takes the rewards back in the background', async () => {
    const w = await setup();
    await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP, channel: SECRET });
    for (const u of ['alice', 'bob']) await w.staff('owner', 'player give-item', { member: u, item: ITEM.id, reason: 'test' });
    const ask = await w.staff('owner', 'season wipe-items', { reason: 'reset' });
    expect(text(await w.button('owner', findCustomId(ask.at(-1)!.payload, 'cf|')!))).toContain('taken back over the next few minutes');
    await new Promise((r) => setImmediate(r)); // let the background removal finish
    await w.tick();
    for (const u of ['alice', 'bob']) {
      expect(hasRole(w, u, VIP)).toBe(false);
      expect(canSee(w, u, SECRET)).toBe(false);
    }
  });

  it('refuses unsafe roles and unknown items, and keeps candy out of it', async () => {
    const w = await setup();
    w.role('mods', 4, PermissionFlagsBits.BanMembers);
    w.role('above', 200);
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: 'mods' }))).toContain('moderation or admin permissions');
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: 'above' }))).toContain("above (or level with) the bot's own role");
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: 'staff' }))).toContain('Event Manager role');
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: 'no such thing', role: VIP }))).toContain('No item called');
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name }))).toContain('Pick a role and/or a channel');
    expect(text(await w.action('mod', 'visitor', 'rewards', { item: ITEM.name, role: VIP }))).toContain('Only server administrators');
    expect(getBalance(w.ctx, 'g1', 'alice')).toBe(0);
  });

  it('retries a refused grant later and alerts staff once', async () => {
    const w = await setup();
    await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP });
    const role = w.roles.get(VIP);
    w.roles.delete(VIP); // e.g. the role was deleted, or the bot lacks permission
    await w.staff('owner', 'player give-item', { member: 'alice', item: ITEM.id, reason: 'test' });
    await w.tick();
    const alerts = () => w.sent.filter((s) => s.channelId === 'logs' && JSON.stringify(s.payload).includes('Item reward could not be given')).length;
    expect(alerts()).toBe(1);
    expect(hasRole(w, 'alice', VIP)).toBe(false);
    w.roles.set(VIP, role); // fixed
    await w.tick();
    expect(hasRole(w, 'alice', VIP)).toBe(false); // waits for the retry time
    w.ctx.advance(11 * 60_000);
    await w.tick();
    expect(hasRole(w, 'alice', VIP)).toBe(true);
    expect(alerts()).toBe(1);
  });

  it('the winner is told what the item unlocks', async () => {
    const w = await setup();
    await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP, channel: SECRET });
    const { winnerReply } = await import('../src/discord/handlers/halloween.js');
    const r = winnerReply(w.bot, 'g1', { visitor: DEFAULT_HALLOWEEN_PACK.visitors[0]!, item: ITEM, duplicate: false, candy: 5, bonus: 0, capped: false, unique: 1 });
    expect(JSON.stringify(r)).toContain('Unlocked');
    expect(JSON.stringify(r)).toContain(`<#${SECRET}>`);
  });

  it('the spreadsheet exports and imports reward IDs', async () => {
    const w = await setup();
    await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP });
    const exp = await w.staff('owner', 'visitor export', { rarity: 'all' });
    const file = exp.find((c) => c.payload?.files)!.payload.files[0];
    const csv = String(file.attachment ?? file.data?.attachment ?? '');
    expect(csv.split('\n')[0]).toContain('reward_role_id,reward_channel_id');
    expect(csv).toContain(VIP);

    // Change the channel for that item and give another item a bad role ID.
    const lines = csv.trim().split('\n');
    const header = lines[0]!.split(',');
    const roleCol = header.indexOf('reward_role_id');
    const edited = [lines[0], ...lines.slice(1, 3).map((l, n) => {
      const cells = l.split(',');
      if (n === 0) cells[roleCol + 1] = SECRET;
      if (n === 1) cells[roleCol] = 'not-an-id';
      return cells.join(',');
    })].join('\n');
    const { vi } = await import('vitest');
    vi.stubGlobal('fetch', async () => new Response(edited));
    const bad = text(await w.staff('owner', 'visitor import', { file: { url: 'https://cdn.discordapp.com/a/b/items.csv', size: edited.length, name: 'items.csv' } }));
    expect(bad).toContain("isn't a Discord ID");
    const fixed = edited.replace('not-an-id', '');
    vi.stubGlobal('fetch', async () => new Response(fixed));
    const ok = await w.staff('owner', 'visitor import', { file: { url: 'https://cdn.discordapp.com/a/b/items.csv', size: fixed.length, name: 'items.csv' } });
    expect(text(ok)).toContain('1 item reward changed');
    const done = text(await w.button('owner', findCustomId(ok.at(-1)!.payload, 'cf|')!));
    expect(done).toContain('Imported');
    vi.unstubAllGlobals();
    const again = text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP }));
    expect(again).toContain(`<#${SECRET}>`);
  });
});

describe('item rewards under load', () => {
  it('two syncs at once for the same member still record the grant as the bot\'s own', async () => {
    const w = await setup();
    await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, role: VIP });
    w.ctx.db.prepare('INSERT INTO hw_items (guild_id, event_id, user_id, item_id, first_at) VALUES (?, ?, ?, ?, ?)').run('g1', 'halloween-2026', 'alice', ITEM.id, 0);
    const { syncMemberRewards } = await import('../src/discord/rewards.js');
    await Promise.all([syncMemberRewards(w.bot, w.guild, 'alice'), syncMemberRewards(w.bot, w.guild, 'alice')]);
    expect(hasRole(w, 'alice', VIP)).toBe(true);
    await w.staff('owner', 'player remove-item', { member: 'alice', item: ITEM.id, reason: 'test' });
    expect(hasRole(w, 'alice', VIP)).toBe(false);
  });
});

describe('item rewards: channel typed by ID or name', () => {
  it('accepts a pasted channel ID, #mention or exact name when the picker does not list it', async () => {
    const w = await setup();
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, channel_id: SECRET }))).toContain(`**Channel access:** none → <#${SECRET}>`);
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, what: 'remove-channel' }))).toContain('→ none');
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, channel_id: `<#${SECRET}>` }))).toContain(`<#${SECRET}>`);
    await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, what: 'remove-channel' });
    w.channel('secret-room');
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, channel_id: '#secret-room' }))).toContain('<#secret-room>');
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, channel_id: 'nope' }))).toContain('found. Paste its ID');
    expect(text(await w.action('owner', 'visitor', 'rewards', { item: ITEM.name, channel: SECRET, channel_id: SECRET }))).toContain('not both');
  });
});
