import {
  ChannelType,
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

const gameOpt = (o: SlashCommandStringOption) => o.setName('game').setDescription('Which game').setRequired(true).addChoices(...GAMES);
const reasonOpt = (o: SlashCommandStringOption) => o.setName('reason').setDescription('Why (saved in the staff log)').setRequired(true).setMaxLength(300);
const seasonOpt = (o: SlashCommandStringOption) =>
  o.setName('season').setDescription('A past season (defaults to the current one)').setAutocomplete(true);
const dateOpt = (name: string, description: string) => (o: SlashCommandStringOption) =>
  o.setName(name).setDescription(description).setMinLength(10).setMaxLength(10);
const durationOpt = (name: string, description: string) => (o: SlashCommandStringOption) =>
  o.setName(name).setDescription(description).setMaxLength(12);

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

// ── /setup: everything needed to go live (Manage Server) ─────────────

const setupCommand = command('setup', 'Set up the emojitown games (admins)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('server')
      .setDescription('Step 1: timezone, staff role, log channel, support link')
      .addStringOption((o) => o.setName('timezone').setDescription('e.g. Europe/Copenhagen').setAutocomplete(true))
      .addRoleOption((o) => o.setName('staff_role').setDescription('Role for event staff (Event Managers)'))
      .addChannelOption((o) => o.setName('log_channel').setDescription('Private channel for staff logs and alerts').addChannelTypes(ChannelType.GuildText))
      .addStringOption((o) => o.setName('support').setDescription('Where members get help, e.g. #help').setMaxLength(200))
      .addRoleOption((o) => o.setName('remove_staff_role').setDescription('Take Event Manager access away from a role')),
  )
  .addSubcommand((s) =>
    s
      .setName('halloween')
      .setDescription('Step 2: set up and start Trick or Treat')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel where visitors appear').addChannelTypes(ChannelType.GuildText))
      .addRoleOption((o) => o.setName('champion_role').setDescription('Empty role given to the top collector'))
      .addStringOption(dateOpt('start', 'First day, YYYY-MM-DD (default Oct 1)'))
      .addStringOption(dateOpt('end', 'Last day, YYYY-MM-DD (default Oct 31)'))
      .addStringOption(durationOpt('wait_min', 'Shortest wait between visitors, e.g. 30s, 10m, 1h (default 10m)'))
      .addStringOption(durationOpt('wait_max', 'Longest wait between visitors, e.g. 20m, 2h (default 20m)'))
      .addStringOption(durationOpt('visit_length', 'How long a visitor stays, e.g. 90s, 2m (default 90s)'))
      .addIntegerOption((o) => o.setName('candy_per_win').setDescription('Candy per win (default 5)').setMinValue(0).setMaxValue(10000))
      .addIntegerOption((o) => o.setName('daily_candy_limit').setDescription('Max Halloween candy per member per day (default 100)').setMinValue(0).setMaxValue(100000))
      .addChannelOption((o) => o.setName('remove_channel').setDescription('Stop visitors in a channel').addChannelTypes(ChannelType.GuildText)),
  )
  .addSubcommand((s) =>
    s
      .setName('snowball')
      .setDescription('Step 2: set up and start Snowball Fights')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel where snowball fights happen').addChannelTypes(ChannelType.GuildText))
      .addStringOption(dateOpt('start', 'First day, YYYY-MM-DD (default Dec 1)'))
      .addStringOption(dateOpt('end', 'Last day, YYYY-MM-DD (default Dec 31)'))
      .addChannelOption((o) => o.setName('remove_channel').setDescription('Stop snowball fights in a channel').addChannelTypes(ChannelType.GuildText)),
  )
  .addSubcommand((s) =>
    s
      .setName('advent')
      .setDescription('Step 2: set up the Advent Calendar (then fill doors with /setup door)')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Channel for daily door posts').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addStringOption(dateOpt('start', 'Day of door 1, YYYY-MM-DD (default Dec 1)'))
      .addIntegerOption((o) => o.setName('doors').setDescription('Number of doors (default 24)').setMinValue(1).setMaxValue(31))
      .addStringOption((o) => o.setName('unlock_time').setDescription('Time doors open each day, HH:MM (default 09:00)').setMaxLength(5))
      .addBooleanOption((o) => o.setName('catch_up').setDescription('Can members claim missed doors later? (default yes)')),
  )
  .addSubcommand((s) =>
    s
      .setName('door')
      .setDescription('Write or edit one Advent door (opens a form)')
      .addIntegerOption((o) => o.setName('day').setDescription('Door number').setRequired(true).setMinValue(1).setMaxValue(31))
      .addIntegerOption((o) => o.setName('candy').setDescription('Candy for opening it (default 10, 0 for none)').setMinValue(0).setMaxValue(10000))
      .addStringOption((o) => o.setName('reason').setDescription('Needed when changing a door that is already live').setMaxLength(300)),
  )
  .addSubcommand((s) =>
    s
      .setName('content')
      .setDescription('Upload names, messages and artwork (JSON), or download the current file')
      .addStringOption((o) =>
        o
          .setName('game')
          .setDescription('Which content')
          .setRequired(true)
          .addChoices({ name: 'Halloween (visitors and items)', value: 'halloween' }, { name: 'Snowball Fights (messages and art)', value: 'snowball' }),
      )
      .addAttachmentOption((o) => o.setName('file').setDescription('JSON file to upload. Leave empty to download the current one.')),
  )
  .addSubcommand((s) =>
    s
      .setName('class')
      .setDescription('Halloween visitor classes: how often each appears and its bonus candy')
      .addStringOption((o) => o.setName('class').setDescription('Which class').setRequired(true).addChoices(...CLASS_CHOICES))
      .addIntegerOption((o) => o.setName('chance').setDescription('Relative chance to appear, e.g. 60 (0 = never)').setMinValue(0).setMaxValue(1000))
      .addIntegerOption((o) => o.setName('bonus_candy').setDescription('Extra candy for winning this class of visitor').setMinValue(0).setMaxValue(10000))
      .addStringOption((o) => o.setName('rarity_text').setDescription('Line under the item picture, e.g. "This item is rare! …"').setMaxLength(200)),
  )
  .addSubcommand((s) => s.setName('status').setDescription('Checklist: what is set up, what is live, what is missing'));

// ── /visitor: create and edit Halloween visitors (Manage Server) ─────

const visitorCommand = command('visitor', 'Create and edit Halloween visitors (admins)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Create a visitor (a form asks for its name and texts)')
      .addStringOption((o) => o.setName('class').setDescription('Common, Uncommon, Rare or Legendary').setRequired(true).addChoices(...CLASS_CHOICES))
      .addAttachmentOption((o) => o.setName('picture').setDescription('The visitor\'s picture (PNG, JPG, GIF or WEBP)'))
      .addStringOption((o) => o.setName('picture_url').setDescription('…or a link to a picture').setMaxLength(500))
      .addStringOption((o) => o.setName('win_text').setDescription('Win message text. Use {winner}, {item}, {name}, {request}').setMaxLength(300)),
  )
  .addSubcommand((s) =>
    s
      .setName('edit')
      .setDescription("Change a visitor's class, picture or texts (opens a form)")
      .addStringOption((o) => o.setName('visitor').setDescription('Which visitor').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('class').setDescription('New class').addChoices(...CLASS_CHOICES))
      .addAttachmentOption((o) => o.setName('picture').setDescription('New picture'))
      .addStringOption((o) => o.setName('picture_url').setDescription('…or a link to a new picture').setMaxLength(500))
      .addBooleanOption((o) => o.setName('remove_picture').setDescription('Remove the picture'))
      .addStringOption((o) => o.setName('win_text').setDescription('Win message text. Use {winner}, {item}, {name}, {request}').setMaxLength(300)),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a visitor (or all placeholder visitors). Collected items are kept.')
      .addStringOption((o) => o.setName('visitor').setDescription('Which visitor').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((s) => s.setName('list').setDescription('All visitors, their classes and pictures'))
  .addSubcommand((s) =>
    s
      .setName('export')
      .setDescription('Download items as a spreadsheet (CSV) to mass-edit')
      .addStringOption((o) =>
        o
          .setName('rarity')
          .setDescription('Which items (default: all)')
          .addChoices(
            { name: 'All items', value: 'all' },
            { name: 'Common', value: 'common' },
            { name: 'Uncommon + Rare', value: 'uncommon-rare' },
            { name: 'Uncommon', value: 'uncommon' },
            { name: 'Rare', value: 'rare' },
            { name: 'Legendary', value: 'legendary' },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('import')
      .setDescription('Upload an edited spreadsheet; you confirm the changes before they apply')
      .addAttachmentOption((o) => o.setName('file').setDescription('The CSV from /visitor export, edited').setRequired(true)),
  );

// ── /admin: running the games (Manage Server) ────────────────────────

const adminCommand = command('admin', 'Run the emojitown games (admins)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('start').setDescription('Start a game right now').addStringOption(gameOpt))
  .addSubcommand((s) =>
    s
      .setName('end')
      .setDescription('End a game now and post the results')
      .addStringOption(gameOpt)
      .addStringOption((o) =>
        o
          .setName('champion_role')
          .setDescription('Halloween only: what happens to the Champion role (default keep)')
          .addChoices({ name: 'keep until next Halloween', value: 'keep' }, { name: 'remove now', value: 'remove' }),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('give-candy')
      .setDescription('Give candy (or take it away with a negative number)')
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('e.g. 25 or -10').setRequired(true).setMinValue(-1000000).setMaxValue(1000000))
      .addStringOption(reasonOpt),
  )
  .addSubcommand((s) =>
    s
      .setName('undo-candy')
      .setDescription('Undo a candy transaction (number from /mod candy-history)')
      .addIntegerOption((o) => o.setName('transaction').setDescription('Transaction number').setRequired(true).setMinValue(1))
      .addStringOption(reasonOpt),
  )
  .addSubcommand((s) =>
    s
      .setName('fix-stats')
      .setDescription("Correct someone's snowball stats")
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('stat')
          .setDescription('Which number')
          .setRequired(true)
          .addChoices(
            { name: 'hits', value: 'hits' },
            { name: 'misses', value: 'misses' },
            { name: 'KOs received', value: 'kos-received' },
            { name: 'snowballs collected', value: 'collected' },
          ),
      )
      .addIntegerOption((o) => o.setName('value').setDescription('New value').setRequired(true).setMinValue(0))
      .addStringOption(reasonOpt),
  )
  .addSubcommand((s) =>
    s
      .setName('fix-item')
      .setDescription("Give or remove a Halloween item in someone's collection")
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
      .addStringOption((o) =>
        o.setName('action').setDescription('Give or remove').setRequired(true).addChoices({ name: 'give', value: 'grant' }, { name: 'remove', value: 'revoke' }),
      )
      .addStringOption((o) => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true))
      .addStringOption(reasonOpt),
  )
  .addSubcommand((s) =>
    s
      .setName('clear-warmup')
      .setDescription('Let someone collect snowballs again right away')
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
      .addStringOption(reasonOpt),
  )
  .addSubcommand((s) =>
    s
      .setName('announce')
      .setDescription('Post how-to-play instructions for a game')
      .addStringOption(gameOpt)
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Where to post').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('message-test')
      .setDescription('Preview any message members can see, with your real content (nothing is saved)')
      .addStringOption(gameOpt)
      .addStringOption((o) => o.setName('message').setDescription('Which message (or All)').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('visitor').setDescription('Halloween: use this visitor (default: random)').setAutocomplete(true))
      .addIntegerOption((o) => o.setName('day').setDescription('Advent: use this door (default: first written door)').setMinValue(1).setMaxValue(31))
      .addBooleanOption((o) => o.setName('public').setDescription('Post it in this channel for everyone (default: only you see it)')),
  )
  .addSubcommand((s) => s.setName('export').setDescription('Download all data for a game').addStringOption(gameOpt).addStringOption(seasonOpt))
  .addSubcommand((s) =>
    s
      .setName('audit')
      .setDescription('Recent staff actions')
      .addUserOption((o) => o.setName('member').setDescription('Only actions involving this member')),
  );

// ── /mod: event staff tools (Event Manager role) ─────────────────────

const modCommand = command('mod', 'Event staff tools')
  // Hidden from regular members. Admins let the staff role see it under
  // Server Settings → Integrations → emojitown → /mod.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('pause').setDescription('Pause a game (progress is kept)').addStringOption(gameOpt).addStringOption(reasonOpt))
  .addSubcommand((s) => s.setName('resume').setDescription('Resume a paused game').addStringOption(gameOpt))
  .addSubcommand((s) =>
    s
      .setName('exclude')
      .setDescription('Stop a member from playing')
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
      .addStringOption((o) => o.setName('game').setDescription('Which game').setRequired(true).addChoices(...GAMES, { name: 'All games', value: 'all' }))
      .addStringOption(reasonOpt),
  )
  .addSubcommand((s) =>
    s
      .setName('include')
      .setDescription('Let an excluded member play again')
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
      .addStringOption((o) => o.setName('game').setDescription('Which game').setRequired(true).addChoices(...GAMES, { name: 'All games', value: 'all' }))
      .addStringOption(reasonOpt),
  )
  .addSubcommand((s) => s.setName('cancel-visitor').setDescription('Send the current Halloween visitor away (no rewards)').addStringOption(reasonOpt))
  .addSubcommand((s) =>
    s
      .setName('preview')
      .setDescription('See what members will see (nothing is saved)')
      .addStringOption(gameOpt)
      .addIntegerOption((o) => o.setName('day').setDescription('Advent: which door').setMinValue(1).setMaxValue(31))
      .addStringOption((o) => o.setName('visitor').setDescription('Halloween: which visitor').setAutocomplete(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('candy-history')
      .setDescription("A member's candy transactions")
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('repost-door')
      .setDescription('Post an Advent door announcement again')
      .addIntegerOption((o) => o.setName('day').setDescription('Door number').setRequired(true).setMinValue(1).setMaxValue(31)),
  )
  .addSubcommand((s) => s.setName('fix-role').setDescription('Re-check who should have the Halloween Champion role'));

const staffCommands = [setupCommand, visitorCommand, adminCommand, modCommand];

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
 * /setup, /admin and /mod from members by default; this is the bot's own check,
 * which also holds if a server changes those defaults.
 */
export function levelFor(key: string): Level {
  const top = key.split(' ')[0];
  if (top === 'setup' || top === 'admin' || top === 'visitor') return 'admin';
  if (top === 'mod') return 'moderator';
  return 'member';
}
