import { ApplicationCommandOptionType, PermissionFlagsBits, type APIApplicationCommandOption, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { commands, levelFor } from '../src/discord/commands.js';
import { adventHandlers } from '../src/discord/handlers/advent.js';
import { candyHandlers } from '../src/discord/handlers/candy.js';
import { halloweenHandlers } from '../src/discord/handlers/halloween.js';
import { helpHandlers } from '../src/discord/handlers/help.js';
import { seasonHandlers } from '../src/discord/handlers/season.js';
import { snowballHandlers } from '../src/discord/handlers/snowball.js';
import { manageHandlers } from '../src/discord/handlers/manage.js';
import { visitorHandlers } from '../src/discord/handlers/visitors.js';

function keys(cmd: RESTPostAPIChatInputApplicationCommandsJSONBody): string[] {
  const subs = (cmd.options ?? []).filter(
    (o) => o.type === ApplicationCommandOptionType.Subcommand || o.type === ApplicationCommandOptionType.SubcommandGroup,
  );
  if (subs.length === 0) return [cmd.name];
  return subs.flatMap((s) =>
    s.type === ApplicationCommandOptionType.SubcommandGroup
      ? (s.options ?? []).map((x: APIApplicationCommandOption) => `${cmd.name} ${s.name} ${x.name}`)
      : [`${cmd.name} ${s.name}`],
  );
}

describe('slash commands', () => {
  const json = commands.map((c) => c.toJSON());
  const commandKeys = json.flatMap(keys);
  const handlerKeys = [snowballHandlers, halloweenHandlers, adventHandlers, candyHandlers, seasonHandlers, helpHandlers, manageHandlers, visitorHandlers].flatMap((h) => Object.keys(h.chat ?? {}));

  it('build, pass discord.js validation and fit Discord\'s 8000-character limit', () => {
    // Discord counts names, descriptions and choice names/values across the whole command tree.
    const size = (o: any): number =>
      (o.name?.length ?? 0) +
      (o.description?.length ?? 0) +
      (o.choices ?? []).reduce((n: number, c: any) => n + c.name.length + String(c.value).length, 0) +
      (o.options ?? []).reduce((n: number, x: any) => n + size(x), 0);
    expect(json.length).toBeGreaterThan(10);
    for (const c of json) expect(size(c), c.name).toBeLessThanOrEqual(8000);
  });

  it('every command has exactly one handler', () => {
    expect([...handlerKeys].sort()).toEqual([...commandKeys].sort());
  });

  it('locks staff commands on Discord and leaves member commands open', () => {
    const manageGuild = PermissionFlagsBits.ManageGuild.toString();
    for (const c of json) {
      if (['settings', 'season', 'visitor', 'adjust', 'game', 'player'].includes(c.name)) expect(c.default_member_permissions, c.name).toBe(manageGuild);
      else expect(c.default_member_permissions ?? null, c.name).toBeNull();
    }
    expect(levelFor('season halloween')).toBe('admin');
    expect(levelFor('season end')).toBe('admin');
    expect(levelFor('settings')).toBe('admin');
    expect(levelFor('adjust candy')).toBe('admin');
    expect(levelFor('game pause')).toBe('moderator');
    expect(levelFor('player wipe-items')).toBe('moderator');
  });

  it('keeps commands flat: no subcommand groups anywhere', () => {
    expect(commandKeys.every((k) => k.split(' ').length <= 2)).toBe(true);
  });

  it('has the simplified member command set, open to everyone', () => {
    const member = commandKeys.filter((k) => levelFor(k) === 'member');
    expect([...member].sort()).toEqual(
      ['advent', 'candy', 'collect', 'events', 'help', 'inventory', 'leaderboard', 'snowball join', 'snowball leave', 'stats', 'throw', 'treat', 'trick'].sort(),
    );
  });
});
