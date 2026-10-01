import { ApplicationCommandOptionType, PermissionFlagsBits, type APIApplicationCommandOption, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { commands, levelFor } from '../src/discord/commands.js';
import { adventHandlers } from '../src/discord/handlers/advent.js';
import { candyHandlers } from '../src/discord/handlers/candy.js';
import { halloweenHandlers } from '../src/discord/handlers/halloween.js';
import { helpHandlers } from '../src/discord/handlers/help.js';
import { seasonHandlers } from '../src/discord/handlers/season.js';
import { snowballHandlers } from '../src/discord/handlers/snowball.js';

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
  const handlerKeys = [snowballHandlers, halloweenHandlers, adventHandlers, candyHandlers, seasonHandlers, helpHandlers].flatMap((h) => Object.keys(h.chat ?? {}));

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
      if (c.name === 'admin' || c.name === 'staff') expect(c.default_member_permissions).toBe(manageGuild);
      else expect(c.default_member_permissions ?? null).toBeNull();
    }
  });

  it('every staff subcommand lives under /admin or /staff', () => {
    const staffish = /(setup|config|timezone|channel|support|announce|check|export|audit|content|create|schedule|start|end|pause|resume|exclude|include|correct|clear-warmup|champion|collection|preview|cancel|reconcile|edit|publish|validate|post|adjust|reverse|inspect)$/;
    for (const k of commandKeys) {
      if (k === 'season status' || k === 'support') continue;
      if (staffish.test(k)) expect(levelFor(k), k).not.toBe('member');
    }
    expect(levelFor('admin season setup')).toBe('admin');
    expect(levelFor('staff event pause')).toBe('moderator');
  });

  it('includes the full member command set from the specification', () => {
    for (const k of [
      'collect',
      'throw',
      'stats',
      'leaderboard',
      'snowball participation',
      'trick',
      'treat',
      'halloween inventory',
      'halloween missing',
      'halloween item',
      'halloween visitors',
      'halloween leaderboard',
      'halloween status',
      'advent calendar',
      'advent open',
      'advent progress',
      'candy balance',
      'candy leaderboard',
      'candy history',
      'candy rules',
      'help',
      'season status',
      'support',
    ]) {
      expect(commandKeys).toContain(k);
      expect(levelFor(k)).toBe('member');
    }
  });
});
