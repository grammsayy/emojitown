import { ApplicationCommandOptionType, type APIApplicationCommandOption, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { commands, LEVELS } from '../src/discord/commands.js';
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

  it('build and pass discord.js validation', () => {
    expect(json.length).toBeGreaterThan(10);
    for (const c of json) expect(JSON.stringify(c).length).toBeLessThan(8000);
  });

  it('every command has exactly one handler', () => {
    expect([...handlerKeys].sort()).toEqual([...commandKeys].sort());
  });

  it('every staff level refers to a real command', () => {
    for (const k of Object.keys(LEVELS)) expect(commandKeys).toContain(k);
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
      expect(LEVELS[k]).toBeUndefined();
    }
  });
});
