import { describe, expect, it } from 'vitest';
import { getBalance } from '../src/domain/candy.js';
import { getEvent } from '../src/domain/events.js';
import { recordActivity } from '../src/domain/halloween.js';
import { findCustomId, text, World } from './fake-discord.js';

async function adminSetup(w: World) {
  w.role('managers');
  const r = await w.command('owner', 'season setup', { timezone: 'Europe/Copenhagen', support: '#help', log_channel: 'logs', event_manager_role: 'managers' });
  expect(text(r)).toContain('setup saved');
  await w.command('owner', 'season channel', { feature: 'snowball', action: 'add', channel: 'snow' });
  await w.command('owner', 'season channel', { feature: 'halloween', action: 'add', channel: 'spooky' });
  await w.command('owner', 'season channel', { feature: 'advent', action: 'add', channel: 'advent' });
  expect(text(await w.command('owner', 'season config'))).toContain('All basic setup is done');
}

async function confirmLast(w: World, userId: string, calls: { payload: any }[]) {
  const token = findCustomId(calls.at(-1)!.payload, 'cf|');
  expect(token).toBeDefined();
  return w.button(userId, token!);
}

describe('permissions', () => {
  it('rejects staff commands from members, including at confirmation time', async () => {
    const w = new World('2026-12-05T12:00:00Z');
    expect(text(await w.command('alice', 'season setup', { timezone: 'UTC' }))).toContain('Only server administrators');
    expect(text(await w.command('alice', 'candy inspect', { member: 'bob' }))).toContain('Only event staff');
    w.members.get('mod')!.roles.cache.set('managers', true);
    w.role('managers');
    await w.command('owner', 'season staff', { role: 'managers', action: 'grant' });
    expect(text(await w.command('mod', 'candy inspect', { member: 'bob' }))).toContain('Candy history');
    expect(text(await w.command('mod', 'candy adjust', { member: 'bob', amount: 5, source: 'x', reason: 'y' }))).toContain('Only server administrators');
    // Someone else can't press the owner's Confirm button.
    const calls = await w.command('owner', 'candy adjust', { member: 'bob', amount: 5, source: 'trivia', reason: 'won' });
    const token = findCustomId(calls.at(-1)!.payload, 'cf|')!;
    expect(text(await w.button('alice', token))).toContain('Only the staff member who ran the command');
    expect(getBalance(w.ctx, 'g1', 'bob')).toBe(0);
    expect(text(await w.button('owner', token))).toContain('now has **5** candy');
  });
});

describe('snowball flow', () => {
  it('collect, throw via command and via button + user select', async () => {
    const w = new World('2026-12-05T12:00:00Z');
    await adminSetup(w);
    await w.command('owner', 'season event create', { feature: 'snowball', name: 'Winter 2026' });
    expect(text(await w.command('owner', 'season event start', { event: 'winter-2026' }))).toContain('is now active');

    expect(text(await w.command('alice', 'collect', {}, 'general'))).toContain('Snowball fights happen in');
    const c = await w.command('alice', 'collect', {}, 'snow');
    expect(text(c)).toContain('Snowball collected');
    expect(findCustomId(c[0]!.payload, 'sb|throw')).toBe('sb|throw');

    expect(text(await w.command('alice', 'throw', { target: 'bot' }, 'snow'))).toContain("Bots don't play");
    expect(text(await w.command('alice', 'throw', { target: 'alice' }, 'snow'))).toContain('yourself');
    w.user('ghost');
    expect(text(await w.command('alice', 'throw', { target: 'ghost' }, 'snow'))).toContain("isn't in the server");

    w.ctx.rolls = [0.1, 0];
    const t = await w.command('alice', 'throw', { target: 'bob' }, 'snow');
    expect(t[0]!.type).toBe('reply');
    expect(t[0]!.payload.flags).toBeUndefined(); // public
    expect(text(t)).toContain('Direct hit');

    w.ctx.advance(30_000);
    await w.button('alice', 'sb|collect', undefined, 'snow');
    const sel = await w.button('alice', 'sb|throw', undefined, 'snow');
    expect(findCustomId(sel[0]!.payload, 'sb|target')).toBe('sb|target');
    w.ctx.rolls = [0.9, 0];
    expect(text(await w.select('alice', 'sb|target', ['carol'], 'snow'))).toContain('Missed');

    const stats = await w.command('alice', 'stats');
    expect(text(stats)).toContain('Hits');
    expect(text(await w.command('bob', 'leaderboard'))).toContain('<@alice>');
    expect(text(await w.command('bob', 'snowball participation', { state: 'off' }))).toContain('opted out');
    expect(text(await w.command('alice', 'throw', { target: 'bob' }, 'snow'))).toContain("isn't playing");

    const corr = await w.command('owner', 'snowball correct', { member: 'alice', event: 'winter-2026', field: 'collected', value: 10, reason: 'lost' });
    expect(text(await confirmLast(w, 'owner', corr))).toContain('Saved');
    for (const outcome of ['hit', 'miss', 'warmup', 'collect']) expect(text(await w.command('owner', 'snowball preview', { outcome }))).toContain('Preview');
    expect(text(await w.command('owner', 'snowball setup'))).toContain('Fixed gameplay rules');
  });
});

describe('halloween flow', () => {
  it('spawns a visitor, resolves one winner through the button, and updates the message', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await adminSetup(w);
    w.role('champ');
    expect(text(await w.command('owner', 'halloween champion', { role: 'champ', end_policy: 'keep' }))).toContain('Champion role saved');
    await w.command('owner', 'season event create', { feature: 'halloween', name: 'Halloween 2026' });
    expect(text(await w.command('owner', 'season event start', { event: 'halloween-2026' }))).toContain('is now active');

    w.ctx.advance(21 * 60_000);
    recordActivity(w.ctx, 'g1', 'spooky');
    w.ctx.rolls = [0, 0, 0.1]; // channel, visitor, trick
    await w.tick();
    const post = w.sent.find((s) => s.channelId === 'spooky');
    expect(post).toBeDefined();
    const trickId = findCustomId(post!.payload, 'hw|trick|')!;
    const treatId = findCustomId(post!.payload, 'hw|treat|')!;

    expect(text(await w.button('bob', treatId, post!.message))).toContain("not what");
    w.ctx.rolls = [0.99, 0];
    const win = await w.button('alice', trickId, post!.message);
    expect(text(win)).toContain('New item');
    expect(text(win)).toContain('+5 candy');
    expect(JSON.stringify(post!.message.payload)).toContain('got their trick');
    expect(text(await w.button('carol', trickId, post!.message))).toContain('already got what they wanted');
    expect(w.members.get('alice')!.roles.cache.has('champ')).toBe(true);

    expect(text(await w.command('alice', 'halloween inventory'))).toContain('1/120');
    expect(text(await w.command('alice', 'halloween missing'))).toContain('Missing: 119');
    expect(text(await w.command('alice', 'halloween item', { item: 'pumpkin-pete.golden-gourd' }))).toContain('Golden Gourd');
    expect(text(await w.command('alice', 'halloween visitors'))).toContain('Pumpkin Pete');
    expect(text(await w.command('alice', 'halloween leaderboard'))).toContain('<@alice>');
    expect(text(await w.command('alice', 'halloween status'))).toContain('Champion');
    expect(text(await w.command('owner', 'halloween preview'))).toContain('Preview');
    expect(text(await w.command('owner', 'halloween setup', { spawn_min_minutes: 5, spawn_max_minutes: 8 }))).toContain('5–8 minutes');

    const end = await w.command('owner', 'season event end', { event: 'halloween-2026' });
    expect(text(end)).toContain('keeps the role');
    expect(text(await confirmLast(w, 'owner', end))).toContain('has ended');
    expect(getEvent(w.ctx, 'g1', 'halloween-2026')!.finalChampionId).toBe('alice');
    expect(w.sent.some((s) => JSON.stringify(s.payload).includes('has ended'))).toBe(true);
    expect(w.members.get('alice')!.roles.cache.has('champ')).toBe(true);
  });

  it('pauses the feature and alerts staff when the channel disappears', async () => {
    const w = new World('2026-10-05T12:00:00Z');
    await adminSetup(w);
    await w.command('owner', 'season event create', { feature: 'halloween', name: 'Halloween 2026' });
    await w.command('owner', 'season event start', { event: 'halloween-2026' });
    w.channels.delete('spooky');
    await w.tick();
    expect(getEvent(w.ctx, 'g1', 'halloween-2026')!.state).toBe('paused');
    expect(w.sent.some((s) => s.channelId === 'logs' && JSON.stringify(s.payload).includes('paused'))).toBe(true);
  });
});

describe('advent flow', () => {
  it('edits doors through the form, publishes, announces and opens', async () => {
    const w = new World('2026-11-20T12:00:00Z');
    await adminSetup(w);
    await w.command('owner', 'season event create', { feature: 'advent', name: 'Advent 2026' });
    for (let day = 1; day <= 24; day++) {
      const calls = await w.command('owner', 'advent edit', { day, event: 'advent-2026', candy: day === 2 ? 0 : null });
      expect(calls[0]!.type).toBe('modal');
      const res = await w.modal('owner', calls[0]!.payload.custom_id, {
        title: `Door ${day}`,
        message: day === 3 ? 'Which snowman is tallest?' : `Surprise ${day}`,
        answer: day === 3 ? 'Frosty' : '',
      });
      expect(text(res)).toContain(`Saved door ${day}`);
    }
    expect(text(await w.command('owner', 'advent validate', { event: 'advent-2026' }))).toContain('Calendar looks good');
    await w.command('owner', 'advent publish', { event: 'advent-2026' });
    expect(text(await w.command('owner', 'season check', { event: 'advent-2026' }))).toContain('Ready');
    await w.command('owner', 'season event start', { event: 'advent-2026' });

    w.ctx.set('2026-12-01T08:00:30Z');
    await w.tick();
    const post = w.sent.find((s) => s.channelId === 'advent')!;
    expect(JSON.stringify(post.payload)).toContain('Door 1 is open');
    const open = await w.button('alice', findCustomId(post.payload, 'adv|open|')!, post.message);
    expect(text(open)).toContain('10 candy');
    expect(text(await w.button('alice', findCustomId(post.payload, 'adv|open|')!, post.message))).toContain('already opened');

    // Downtime: three days pass without ticks, then one recovery post.
    w.ctx.set('2026-12-04T10:00:00Z');
    await w.tick();
    const recovery = w.sent.filter((s) => s.channelId === 'advent');
    expect(recovery).toHaveLength(2);
    expect(JSON.stringify(recovery[1]!.payload)).toContain('3 Advent doors are open');

    expect(text(await w.select('bob', 'adv|pick|advent-2026', ['3']))).toContain('Reveal Answer');
    expect(text(await w.button('bob', 'adv|reveal|advent-2026|3'))).toContain('Frosty');
    expect(text(await w.command('bob', 'advent calendar'))).toContain('locked');
    expect(text(await w.command('bob', 'advent progress'))).toContain('1/24');
    expect(getBalance(w.ctx, 'g1', 'bob')).toBe(10);
    expect(text(await w.command('bob', 'candy history'))).toContain('Advent door 3');
    expect(text(await w.command('bob', 'candy leaderboard'))).toContain('<@alice>');
  });
});

describe('shared commands', () => {
  it('help, support, status, audit and export respond', async () => {
    const w = new World('2026-12-05T12:00:00Z');
    await adminSetup(w);
    for (const topic of [null, 'snowball', 'halloween', 'advent', 'candy']) {
      expect((await w.command('alice', 'help', { topic }))[0]!.type).toBe('reply');
    }
    expect(text(await w.command('alice', 'support'))).toContain('#help');
    expect(text(await w.command('alice', 'season status'))).toContain('Europe/Copenhagen');
    expect(text(await w.command('alice', 'candy rules'))).toContain('Halloween limit');
    await w.command('owner', 'season event create', { feature: 'snowball', name: 'Winter 2026' });
    expect(text(await w.command('owner', 'season audit'))).toContain('event.create');
    expect((await w.command('owner', 'season export', { event: 'winter-2026' }))[0]!.payload.files).toHaveLength(1);
    const tz = await w.command('owner', 'season timezone', { zone: 'America/New_York' });
    expect(text(tz)).toContain('Schedule changes');
    expect(text(await confirmLast(w, 'owner', tz))).toContain('America/New_York');
    expect(text(await w.command('owner', 'season exclude', { member: 'bob', feature: 'all', reason: 'test' }))).toContain('excluded');
    expect(text(await w.command('owner', 'season include', { member: 'bob', feature: 'all', reason: 'test' }))).toContain('again');
  });
});
