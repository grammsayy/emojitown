import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from 'discord.js';
import type { Level } from './runtime.js';

const GAMES = [
  { name: 'Halloween (Trick or Treat)', value: 'halloween' },
  { name: 'Snowball Fights', value: 'snowball' },
  { name: 'Advent Calendar', value: 'advent' },
];

const CLASS_CHOICES = [
  { name: 'Common', value: 'common' },
  { name: 'Uncommon', value: 'uncommon' },
  { name: 'Rare', value: 'rare' },
  { name: 'Legendary', value: 'legendary' },
];

const seasonOpt = (o: SlashCommandStringOption) =>
  o.setName('season').setDescription('A past season (defaults to the current one)').setAutocomplete(true);

function command(name: string, description: string) {
  return new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
}

// ── Member commands ──────────────────────────────────────────────────
// Game commands are only registered in a server while that game is live
// (see commandsFor); shared commands are always there.

const snowballCommands = [
  command('collect', 'Snowball Fights: make a snowball'),
  command('throw', 'Snowball Fights: throw a snowball at someone').addUserOption((o) =>
    o.setName('target').setDescription('Who to throw at').setRequired(true),
  ),
  command('stats', 'Snowball Fights: hits, misses and snowballs')
    .addUserOption((o) => o.setName('member').setDescription('Whose stats (default: you)'))
    .addStringOption(seasonOpt),
  command('snowball', 'Snowball Fights: join or leave')
    .addSubcommand((s) => s.setName('join').setDescription('Play snowball fights (you are in by default)'))
    .addSubcommand((s) => s.setName('leave').setDescription("Stop playing: nobody can throw at you and you can't throw")),
];

const halloweenCommands = [
  command('trick', 'Halloween: answer the visitor in this channel with a Trick'),
  command('treat', 'Halloween: answer the visitor in this channel with a Treat'),
  command('inventory', 'Halloween: your collected items')
    .addUserOption((o) => o.setName('member').setDescription('Whose collection (default: you)'))
    .addStringOption((o) =>
      o
        .setName('rarity')
        .setDescription('Only show one rarity')
        .addChoices(...CLASS_CHOICES),
    )
    .addStringOption(seasonOpt),
];

const adventCommands = [
  command('advent', "Advent Calendar: open today's door, or pick a day").addIntegerOption((o) =>
    o.setName('day').setDescription('Door number (default: today)').setMinValue(1).setMaxValue(31),
  ),
];

const sharedCommands = [
  command('candy', 'Your candy balance and history').addUserOption((o) => o.setName('member').setDescription('Whose balance (default: you)')),
  command('leaderboard', 'Standings for a game or for candy')
    .addStringOption((o) =>
      o
        .setName('game')
        .setDescription('Which leaderboard (default: the game running now)')
        .addChoices(...GAMES.filter((g) => g.value !== 'advent'), { name: 'Candy', value: 'candy' }),
    )
    .addStringOption(seasonOpt)
    .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)),
  command('events', "What's running, when, and where"),
  command('help', 'How the emojitown games work').addStringOption((o) =>
    o
      .setName('game')
      .setDescription('Pick a game for details')
      .addChoices(...GAMES, { name: 'Candy', value: 'candy' }),
  ),
];

// Staff commands are menus (see panels.ts): one command per topic, each
// opening a list of actions with a form for the details. The menu only lists
// what the person may do.
//   Admins (Manage Server): /settings /visitor
//   Event staff (staff role) and admins: /season /player

const settingsCommand = command('settings', 'Server settings and setup checklist (admins)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
const seasonCommand = command('season', 'Set up and run the games: start, pause, end, preview, announce…').setDefaultMemberPermissions(
  PermissionFlagsBits.ManageGuild,
);
const visitorCommand = command('visitor', 'Halloween visitors: add, edit, classes, spreadsheet (admins)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
const playerCommand = command('player', "One member's items, candy, history and access").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const ADMIN_COMMANDS = ['settings', 'visitor'];
export const STAFF_COMMANDS = ['season', 'player'];

const staffCommands = [settingsCommand, seasonCommand, visitorCommand, playerCommand];

export const GAME_COMMANDS: Record<'snowball' | 'halloween' | 'advent', SlashCommandBuilder[]> = {
  snowball: snowballCommands as SlashCommandBuilder[],
  halloween: halloweenCommands as SlashCommandBuilder[],
  advent: adventCommands as SlashCommandBuilder[],
};

/** Every command the bot handles. */
export const commands = [...snowballCommands, ...halloweenCommands, ...adventCommands, ...sharedCommands, ...staffCommands];

/**
 * The commands to register in one server: shared and staff commands always,
 * plus each live game's commands. Members never see commands for games that
 * aren't running.
 */
export function commandsFor(liveGames: Iterable<'snowball' | 'halloween' | 'advent'>) {
  const live = new Set(liveGames);
  return [
    ...(['halloween', 'snowball', 'advent'] as const).flatMap((g) => (live.has(g) ? GAME_COMMANDS[g] : [])),
    ...sharedCommands,
    ...staffCommands,
  ];
}

/**
 * Required level for a command key (`command` or `command sub`). Discord hides
 * staff commands from members by default; this is the bot's own check, which
 * also holds if a server changes those defaults.
 */
export function levelFor(key: string): Level {
  const top = key.split(' ')[0]!;
  if (ADMIN_COMMANDS.includes(top)) return 'admin';
  if (STAFF_COMMANDS.includes(top)) return 'moderator';
  return 'member';
}
