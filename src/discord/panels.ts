import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  ButtonStyle,
  type APIModalInteractionResponseCallbackData,
  type EmbedBuilder,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { RARITIES } from '../content/types.js';
import { listDoors } from '../domain/advent.js';
import { CLASS_LABEL, getClasses } from '../domain/classes.js';
import { getChannel, getChannels, getConfig, getStaffRoles } from '../domain/config.js';
import { consumePending, createPending } from '../domain/confirmations.js';
import { UserError } from '../domain/errors.js';
import { addDays, formatSeconds } from '../util/time.js';
import { defaultDates, FEATURE_LABEL, getTargetEvent, listEvents, seasonYear, type Feature } from '../domain/events.js';
import { SHEET_FILTERS } from '../domain/itemSheet.js';
import { activeVisitors, visitorClass } from '../domain/halloween.js';
import { currentPack, isPlaceholder } from '../domain/visitors.js';
import { listItemRewards } from '../domain/rewards.js';
import { reply, type ChatHandler, type ChatInput, type Component, type HandlerSet, type Modal } from './interaction.js';
import { assertLevel, isAdmin, isModerator, type Bot, type Level } from './runtime.js';
import { button, cid, COLORS, embed, field, row, truncate } from './ui.js';
import { manageActions, statusEmbed } from './handlers/manage.js';
import { TEST_MESSAGES } from './handlers/messageTest.js';
import { visitorActions } from './handlers/visitors.js';

// Staff commands are menus: `/season` shows what is going on and a list of
// actions; picking one opens a form with only the fields that action needs.
// Each action runs the same handler a slash command used to, through an
// adapter that makes the form's answers look like command options.

// ── Form fields ──────────────────────────────────────────────────────

interface FieldBase {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
}

export type Field =
  | (FieldBase & { kind: 'text'; value?: string | null; placeholder?: string; max?: number; long?: boolean })
  | (FieldBase & { kind: 'number'; value?: number | null; placeholder?: string; min: number; max: number })
  | (FieldBase & { kind: 'select'; options: { label: string; value: string; description?: string }[]; value?: string | null; orText?: boolean })
  | (FieldBase & { kind: 'channel'; multi?: boolean; value?: string[]; types?: ChannelType[] })
  | (FieldBase & { kind: 'role'; multi?: boolean; value?: string[] })
  | (FieldBase & { kind: 'user' })
  | (FieldBase & { kind: 'file' });

export interface Action {
  id: string;
  /** Shown in the menu (max 100 characters). */
  label: string;
  /** One line under the label in the menu (max 100 characters). */
  description: string;
  emoji: string;
  level: Level;
  /** Options this action always passes, e.g. which game. */
  fixed?: Record<string, string>;
  /** The form. No fields: the action runs as soon as it's picked. */
  fields?: (bot: Bot, guild: Guild) => Field[];
  run: ChatHandler;
}

export interface Panel {
  name: 'settings' | 'season' | 'visitor' | 'player';
  intro: (bot: Bot, guild: Guild, member: GuildMember) => Promise<EmbedBuilder> | EmbedBuilder;
  actions: Action[];
}

const TEXT_CHANNELS = [ChannelType.GuildText];
const yesNo = (value: boolean | null) => [
  { label: 'Yes', value: 'yes', default: value === true },
  { label: 'No', value: 'no', default: value === false },
];
const GAME_OPTIONS = (Object.keys(FEATURE_LABEL) as Feature[]).map((g) => ({ label: FEATURE_LABEL[g], value: g }));
const gameField = (games: Feature[] = ['halloween', 'snowball', 'advent']): Field => ({
  kind: 'select',
  id: 'game',
  label: 'Which game',
  required: true,
  options: GAME_OPTIONS.filter((o) => games.includes(o.value)),
});
const reasonField: Field = { kind: 'text', id: 'reason', label: 'Reason', description: 'Saved in the staff log', required: true, max: 300 };
const memberField: Field = { kind: 'user', id: 'member', label: 'Member', required: true };
const itemField = (description: string): Field => ({ kind: 'text', id: 'item', label: 'Item', description, required: true, max: 100, placeholder: 'e.g. Golden Gourd' });

/** A season's current dates as YYYY-MM-DD, or this year's defaults. */
function dates(bot: Bot, guildId: string, game: Feature): { start: string; end: string } {
  const ev = getTargetEvent(bot.ctx, guildId, game);
  if (ev) return { start: ev.startLocal.slice(0, 10), end: addDays(ev.endLocal.slice(0, 10), -1) };
  const d = defaultDates(game, seasonYear(bot.ctx, guildId, game));
  return { start: d.start.slice(0, 10), end: addDays(d.end.slice(0, 10), -1) };
}

/** Visitor picker: a list when it fits, otherwise a name box. */
function visitorPick(bot: Bot, guildId: string, forRemove: boolean): Field {
  const active = activeVisitors(currentPack(bot.ctx, guildId));
  const placeholders = active.filter(isPlaceholder).length;
  const options = active.map((v) => ({ label: truncate(v.name, 100), value: v.id, description: CLASS_LABEL[visitorClass(v)] }));
  if (forRemove && placeholders) options.unshift({ label: `All placeholder visitors (${placeholders})`, value: 'placeholders', description: 'The built-in examples' });
  if (options.length <= 25) return { kind: 'select', id: 'visitor', label: 'Visitor', required: true, options, orText: true };
  return {
    kind: 'text',
    id: 'visitor',
    label: 'Visitor',
    description: forRemove && placeholders ? 'Type a name (or part of it), or "placeholders" for all built-in examples' : 'Type the name (or part of it)',
    required: true,
    max: 100,
  };
}

const classOptions = (bot: Bot, guildId: string) => {
  const classes = getClasses(bot.ctx, guildId);
  return RARITIES.map((r) => ({ label: CLASS_LABEL[r], value: r, description: `chance ${classes[r].weight} · +${classes[r].bonusCandy} candy` }));
};

// ── The menus ────────────────────────────────────────────────────────

const run = (key: string): ChatHandler => {
  const h = manageActions[key] ?? visitorActions[key];
  if (!h) throw new Error(`no action handler for ${key}`);
  return h;
};

export const PANELS: Record<Panel['name'], Panel> = {
  settings: {
    name: 'settings',
    intro: (bot, guild) => statusEmbed(bot, guild, true),
    actions: [
      {
        id: 'edit',
        label: 'Change settings',
        description: 'Timezone, staff roles, log channel, support link',
        emoji: '⚙️',
        level: 'admin',
        fields: (bot, guild) => {
          const cfg = getConfig(bot.ctx, guild.id);
          const logs = getChannel(bot.ctx, guild.id, 'logs');
          return [
            { kind: 'text', id: 'timezone', label: 'Timezone', description: 'e.g. Europe/Copenhagen, America/New_York', value: cfg.timezone, required: true, max: 60 },
            { kind: 'role', id: 'staff_roles', label: 'Event staff roles', description: 'Can use /season (game tools) and /player', multi: true, value: getStaffRoles(bot.ctx, guild.id) },
            { kind: 'channel', id: 'log_channel', label: 'Log channel', description: 'Private channel for staff logs and alerts', value: logs ? [logs] : [], types: TEXT_CHANNELS },
            { kind: 'text', id: 'support', label: 'Support link', description: 'Where members get help, e.g. #help', value: cfg.supportDestination, max: 200 },
          ];
        },
        run: run('settings edit'),
      },
    ],
  },

  season: {
    name: 'season',
    intro: (bot, guild) => statusEmbed(bot, guild, false),
    actions: [
      {
        id: 'halloween',
        label: 'Set up Halloween',
        description: 'Channels, dates and Champion role. Goes live by itself on the start date',
        emoji: '🎃',
        level: 'admin',
        fields: (bot, guild) => {
          const d = dates(bot, guild.id, 'halloween');
          const champ = getConfig(bot.ctx, guild.id).championRoleId;
          return [
            { kind: 'channel', id: 'channels', label: 'Channels', description: 'Where visitors appear', multi: true, value: getChannels(bot.ctx, guild.id, 'halloween'), types: TEXT_CHANNELS },
            { kind: 'text', id: 'start', label: 'First day', description: 'YYYY-MM-DD', value: d.start, required: true, max: 10 },
            { kind: 'text', id: 'end', label: 'Last day', description: 'YYYY-MM-DD', value: d.end, required: true, max: 10 },
            { kind: 'role', id: 'champion_role', label: 'Champion role (optional)', description: 'An empty role given to the top collector', value: champ ? [champ] : [] },
          ];
        },
        run: run('season halloween'),
      },
      {
        id: 'halloween-timing',
        label: 'Halloween visitor timing',
        description: 'Time between visitors, how long they stay, auto-delete',
        emoji: '⏱️',
        level: 'admin',
        fields: (bot, guild) => {
          const cfg = getConfig(bot.ctx, guild.id);
          return [
            { kind: 'text', id: 'wait_min', label: 'Shortest wait between visitors', description: 'e.g. 30s, 10m, 1h', value: formatSeconds(cfg.hwSpawnMinS), required: true, max: 12 },
            { kind: 'text', id: 'wait_max', label: 'Longest wait between visitors', description: 'e.g. 20m, 2h', value: formatSeconds(cfg.hwSpawnMaxS), required: true, max: 12 },
            { kind: 'text', id: 'visit_length', label: 'How long a visitor stays', description: 'e.g. 90s, 2m', value: formatSeconds(cfg.hwEncounterS), required: true, max: 12 },
            {
              kind: 'text',
              id: 'delete_after',
              label: 'Delete finished visitor messages after',
              description: 'e.g. 5s, 1m, or "off" to keep them',
              value: cfg.hwCleanupS > 0 ? formatSeconds(cfg.hwCleanupS) : 'off',
              required: true,
              max: 12,
            },
          ];
        },
        run: run('season halloween'),
      },
      {
        id: 'halloween-candy',
        label: 'Halloween candy',
        description: 'Candy per win and the daily limit',
        emoji: '🍬',
        level: 'admin',
        fields: (bot, guild) => {
          const cfg = getConfig(bot.ctx, guild.id);
          return [
            { kind: 'number', id: 'candy_per_win', label: 'Candy per win', description: 'Rarer visitor classes add their bonus on top', value: cfg.candyPerHalloweenWin, min: 0, max: 10000, required: true },
            { kind: 'number', id: 'daily_candy_limit', label: 'Daily Halloween candy limit per member', value: cfg.candyHalloweenDailyLimit, min: 0, max: 100000, required: true },
          ];
        },
        run: run('season halloween'),
      },
      {
        id: 'snowball',
        label: 'Set up Snowball Fights',
        description: 'Channels and dates. Goes live by itself on the start date',
        emoji: '❄️',
        level: 'admin',
        fields: (bot, guild) => {
          const d = dates(bot, guild.id, 'snowball');
          return [
            { kind: 'channel', id: 'channels', label: 'Channels', description: 'Where snowball fights happen', multi: true, value: getChannels(bot.ctx, guild.id, 'snowball'), types: TEXT_CHANNELS },
            { kind: 'text', id: 'start', label: 'First day', description: 'YYYY-MM-DD', value: d.start, required: true, max: 10 },
            { kind: 'text', id: 'end', label: 'Last day', description: 'YYYY-MM-DD', value: d.end, required: true, max: 10 },
          ];
        },
        run: run('season snowball'),
      },
      {
        id: 'advent',
        label: 'Set up the Advent Calendar',
        description: 'Channel, start day, number of doors, opening time',
        emoji: '🎄',
        level: 'admin',
        fields: (bot, guild) => {
          const cfg = getConfig(bot.ctx, guild.id);
          const ch = getChannel(bot.ctx, guild.id, 'advent');
          return [
            {
              kind: 'channel',
              id: 'channel',
              label: 'Channel',
              description: 'Where the daily doors are posted',
              value: ch ? [ch] : [],
              types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
            },
            { kind: 'text', id: 'start', label: 'Day of door 1', description: 'YYYY-MM-DD', value: dates(bot, guild.id, 'advent').start, required: true, max: 10 },
            { kind: 'number', id: 'doors', label: 'Number of doors', value: cfg.adventDoorCount, min: 1, max: 31, required: true },
            { kind: 'text', id: 'unlock_time', label: 'Doors open at', description: 'HH:MM, server timezone', value: cfg.adventUnlockTime, required: true, max: 5 },
            { kind: 'select', id: 'catch_up', label: 'Can members open missed doors later?', options: yesNo(cfg.adventPolicy === 'catch-up'), required: true },
          ];
        },
        run: run('season advent'),
      },
      {
        id: 'door',
        label: 'Write an Advent door',
        description: 'Pick a door, then fill in its title, message and picture',
        emoji: '🚪',
        level: 'admin',
        fields: (bot, guild) => {
          const ev = getTargetEvent(bot.ctx, guild.id, 'advent');
          const written = ev ? listDoors(bot.ctx, guild.id, ev.id).length : 0;
          return [
            {
              kind: 'number',
              id: 'day',
              label: 'Door number',
              description: `${written}/${getConfig(bot.ctx, guild.id).adventDoorCount} doors written so far`,
              min: 1,
              max: 31,
              required: true,
            },
            { kind: 'number', id: 'candy', label: 'Candy for opening it (optional)', description: 'Default 10, 0 for none', min: 0, max: 10000 },
            { kind: 'text', id: 'reason', label: 'Reason (only once the calendar is live)', description: 'Saved in the staff log', max: 300 },
          ];
        },
        run: run('season door'),
      },
      {
        id: 'content',
        label: 'Content file',
        description: "Download a game's texts and artwork (JSON), or upload an edited file",
        emoji: '📦',
        level: 'admin',
        fields: () => [
          {
            kind: 'select',
            id: 'game',
            label: 'Which content',
            required: true,
            options: [
              { label: 'Halloween (visitors and items)', value: 'halloween' },
              { label: 'Snowball Fights (messages and art)', value: 'snowball' },
            ],
          },
          { kind: 'file', id: 'file', label: 'File to upload (optional)', description: 'Leave empty to download the current file' },
        ],
        run: run('season content'),
      },
      { id: 'start', label: 'Start a game now', description: "Instead of waiting for its start date", emoji: '▶️', level: 'admin', fields: () => [gameField()], run: run('season start') },
      { id: 'pause', label: 'Pause a game', description: 'Progress is kept', emoji: '⏸️', level: 'moderator', fields: () => [gameField(), reasonField], run: run('game pause') },
      { id: 'resume', label: 'Resume a paused game', description: 'Picks up where it left off', emoji: '⏯️', level: 'moderator', fields: () => [gameField()], run: run('game resume') },
      {
        id: 'end',
        label: 'End a game',
        description: 'Posts the results. Asks you to confirm',
        emoji: '🏁',
        level: 'admin',
        fields: () => [
          gameField(),
          {
            kind: 'select',
            id: 'champion_role',
            label: 'Halloween Champion role',
            options: [
              { label: 'Keep it until next Halloween', value: 'keep' },
              { label: 'Remove it now', value: 'remove' },
            ],
            value: 'keep',
          },
        ],
        run: run('season end'),
      },
      {
        id: 'announce',
        label: 'Announce a game',
        description: 'Post how-to-play instructions. Shows a preview first',
        emoji: '📣',
        level: 'admin',
        fields: () => [
          gameField(),
          { kind: 'channel', id: 'channel', label: 'Where to post', required: true, types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] },
        ],
        run: run('season announce'),
      },
      ...(['halloween', 'snowball', 'advent'] as Feature[]).map(
        (g): Action => ({
          id: `preview-${g}`,
          label: `Preview ${FEATURE_LABEL[g]} messages`,
          description: 'See any message members can get, with your real content. Nothing is saved',
          emoji: '👀',
          level: 'moderator',
          fixed: { game: g },
          fields: () => [
            {
              kind: 'select',
              id: 'message',
              label: 'Which message',
              required: true,
              options: [{ label: `All ${TEST_MESSAGES[g].length} messages`, value: 'all' }, ...TEST_MESSAGES[g].map((m) => ({ label: truncate(m.label, 100), value: m.id }))].slice(0, 25),
              value: 'all',
            },
            ...(g === 'halloween'
              ? [{ kind: 'text', id: 'visitor', label: 'Visitor (optional)', description: 'Name of the visitor to show. Default: random', max: 100 } as Field]
              : []),
            ...(g === 'advent' ? [{ kind: 'number', id: 'day', label: 'Door (optional)', description: 'Default: the first written door', min: 1, max: 31 } as Field] : []),
            { kind: 'select', id: 'public', label: 'Who sees it', options: [{ label: 'Only me', value: 'no' }, { label: 'Everyone in this channel', value: 'yes' }], value: 'no' },
          ],
          run: run('game preview'),
        }),
      ),
      { id: 'send-visitor-away', label: 'Send the visitor away', description: 'The Halloween visitor here now leaves without rewards', emoji: '👋', level: 'moderator', fields: () => [reasonField], run: run('game send-visitor-away') },
      { id: 'fix-champion', label: 'Fix the Champion role', description: 'Re-check who should have the Halloween Champion role', emoji: '👑', level: 'moderator', run: run('game fix-champion') },
      {
        id: 'repost-door',
        label: 'Repost an Advent door',
        description: "Post a door's announcement again",
        emoji: '🔁',
        level: 'moderator',
        fields: () => [{ kind: 'number', id: 'day', label: 'Door number', min: 1, max: 31, required: true }],
        run: run('game repost-door'),
      },
      {
        id: 'wipe-items',
        label: 'Wipe ALL Halloween items',
        description: "Deletes every member's items this season. Candy is kept. Asks to confirm",
        emoji: '🧹',
        level: 'admin',
        fields: () => [reasonField],
        run: run('season wipe-items'),
      },
      {
        id: 'export',
        label: 'Export data',
        description: 'Download all data for one season as a file',
        emoji: '💾',
        level: 'admin',
        fields: (bot, guild) => {
          const events = listEvents(bot.ctx, guild.id).filter((e) => e.state !== 'draft');
          if (!events.length) throw new UserError('No season has been set up yet, so there is nothing to export.');
          return [
            {
              kind: 'select',
              id: 'season',
              label: 'Which season',
              required: true,
              options: events.slice(0, 25).map((e) => ({ label: truncate(e.name, 100), value: e.id, description: FEATURE_LABEL[e.feature] })),
            },
          ];
        },
        run: run('season export'),
      },
    ],
  },

  visitor: {
    name: 'visitor',
    intro: (bot, guild) => {
      const active = activeVisitors(currentPack(bot.ctx, guild.id));
      const classes = getClasses(bot.ctx, guild.id);
      const lines = RARITIES.map((r) => {
        const n = active.filter((v) => visitorClass(v) === r).length;
        return `${CLASS_LABEL[r]}: **${n}** visitor${n === 1 ? '' : 's'} · chance ${classes[r].weight} · +${classes[r].bonusCandy} candy`;
      });
      const placeholders = active.filter(isPlaceholder).length;
      const rewards = listItemRewards(bot.ctx, guild.id).length;
      lines.push(`🔓 ${rewards} item${rewards === 1 ? '' : 's'} unlock${rewards === 1 ? 's' : ''} a role or channel`);
      return embed(COLORS.halloween, `👻 Halloween visitors (${active.length})`, lines.join('\n')).addFields(
        ...(placeholders ? [field('Placeholders', `${placeholders} are built-in examples. Replace them with your own visitors.`)] : []),
      );
    },
    actions: [
      {
        id: 'add',
        label: 'Add a visitor',
        description: 'Class and picture first, then a form for its name and texts',
        emoji: '➕',
        level: 'admin',
        fields: (bot, guild) => [
          { kind: 'select', id: 'class', label: 'Class', required: true, options: classOptions(bot, guild.id) },
          { kind: 'file', id: 'picture', label: 'Picture (optional)', description: 'PNG, JPG, GIF or WEBP' },
          { kind: 'text', id: 'picture_url', label: '…or a link to a picture (optional)', max: 500, placeholder: 'https://…' },
          { kind: 'text', id: 'win_text', label: 'Win text (optional)', description: 'Use {winner}, {item}, {name}, {request}', long: true, max: 300 },
        ],
        run: run('visitor add'),
      },
      {
        id: 'edit',
        label: 'Edit a visitor',
        description: 'Class, picture and win text first, then its name and texts',
        emoji: '✏️',
        level: 'admin',
        fields: (bot, guild) => [
          visitorPick(bot, guild.id, false),
          { kind: 'select', id: 'class', label: 'New class (optional)', options: classOptions(bot, guild.id) },
          { kind: 'file', id: 'picture', label: 'New picture (optional)' },
          { kind: 'text', id: 'picture_url', label: '…or a link (optional)', description: 'Type "none" to remove the picture', max: 500 },
          { kind: 'text', id: 'win_text', label: 'New win text (optional)', description: 'Use {winner}, {item}, {name}, {request}', long: true, max: 300 },
        ],
        run: run('visitor edit'),
      },
      {
        id: 'remove',
        label: 'Remove a visitor',
        description: 'Or all placeholder visitors. Items members collected are kept',
        emoji: '🗑️',
        level: 'admin',
        fields: (bot, guild) => [visitorPick(bot, guild.id, true)],
        run: run('visitor remove'),
      },
      { id: 'list', label: 'List visitors', description: 'Every visitor with its class and picture', emoji: '📋', level: 'admin', run: run('visitor list') },
      {
        id: 'class',
        label: 'Visitor classes',
        description: 'How often a class appears, its bonus candy and rarity text',
        emoji: '🏷️',
        level: 'admin',
        fields: (bot, guild) => [
          { kind: 'select', id: 'class', label: 'Which class', required: true, options: classOptions(bot, guild.id) },
          { kind: 'number', id: 'chance', label: 'Chance to appear (optional)', description: 'Relative, e.g. 60. 0 = never. Empty keeps it', min: 0, max: 1000 },
          { kind: 'number', id: 'bonus_candy', label: 'Bonus candy (optional)', description: 'Extra candy for winning. Empty keeps it', min: 0, max: 10000 },
          { kind: 'text', id: 'rarity_text', label: 'Rarity text (optional)', description: 'The line under the item picture. Empty keeps it', long: true, max: 200 },
        ],
        run: run('visitor class'),
      },
      {
        id: 'item',
        label: 'Edit an item',
        description: 'Pick a visitor, then one of its items: name, rarity, description, picture',
        emoji: '🎁',
        level: 'admin',
        run: run('visitor item'),
      },
      {
        id: 'rewards',
        label: 'Item rewards',
        description: 'Make an item give a role and/or open a channel for whoever wins it',
        emoji: '🔓',
        level: 'admin',
        fields: () => [
          itemField('Name of the item (or part of it), as in /inventory or the spreadsheet'),
          { kind: 'role', id: 'role', label: 'Role to give (optional)', description: 'Given to everyone who owns the item' },
          {
            kind: 'channel',
            id: 'channel',
            label: 'Channel to open (optional)',
            description: 'Type to search. Opened just for them, no role needed',
            types: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildStageVoice, ChannelType.GuildMedia],
          },
          {
            kind: 'text',
            id: 'channel_id',
            label: '…or channel ID / name (optional)',
            description: "If the channel isn't in the list: paste its ID or type its exact name",
            max: 100,
            placeholder: 'e.g. 1234567890123456789 or secret-room',
          },
          {
            kind: 'select',
            id: 'what',
            label: 'What to do',
            required: true,
            value: 'set',
            options: [
              { label: 'Set the role / channel picked above', value: 'set', description: 'Anything left empty stays as it is' },
              { label: 'Remove the role reward', value: 'remove-role' },
              { label: 'Remove the channel reward', value: 'remove-channel' },
              { label: 'Remove all rewards from this item', value: 'remove-all' },
            ],
          },
        ],
        run: run('visitor rewards'),
      },
      {
        id: 'export',
        label: 'Export items (spreadsheet)',
        description: 'Download items as a CSV to mass-edit',
        emoji: '📤',
        level: 'admin',
        fields: () => [{ kind: 'select', id: 'rarity', label: 'Which items', required: true, options: SHEET_FILTERS.map((f) => ({ label: f.name, value: f.value })), value: 'all' }],
        run: run('visitor export'),
      },
      {
        id: 'import',
        label: 'Import items (spreadsheet)',
        description: 'Upload the edited CSV. You confirm the changes first',
        emoji: '📥',
        level: 'admin',
        fields: () => [{ kind: 'file', id: 'file', label: 'Edited spreadsheet', description: 'The CSV from Export items', required: true }],
        run: run('visitor import'),
      },
    ],
  },

  player: {
    name: 'player',
    intro: () =>
      embed(COLORS.staff, '🧑 Player tools', "Help or correct one member's game progress. Pick what to do; you'll choose the member in the next step."),
    actions: [
      {
        id: 'history',
        label: 'History',
        description: "A member's candy and staff actions, or the whole staff log",
        emoji: '📜',
        level: 'moderator',
        fields: () => [{ kind: 'user', id: 'member', label: 'Member (optional)', description: 'Leave empty for the whole staff log' }],
        run: run('player history'),
      },
      { id: 'give-item', label: 'Give an item', description: 'Adds a Halloween item. No candy changes', emoji: '🎁', level: 'moderator', fields: () => [memberField, itemField('The item to give'), reasonField], run: run('player give-item') },
      {
        id: 'remove-item',
        label: 'Remove an item',
        description: "Takes one Halloween item out of a member's collection. Candy is kept",
        emoji: '➖',
        level: 'moderator',
        fields: () => [memberField, itemField('Check their /inventory for the exact name'), reasonField],
        run: run('player remove-item'),
      },
      {
        id: 'wipe-items',
        label: "Wipe a member's items",
        description: 'Deletes all their Halloween items this season. Candy is kept. Asks to confirm',
        emoji: '🧹',
        level: 'moderator',
        fields: () => [memberField, reasonField],
        run: run('player wipe-items'),
      },
      { id: 'clear-warmup', label: 'Clear a snowball warm-up', description: 'Let a member who was hit collect again right away', emoji: '☃️', level: 'moderator', fields: () => [memberField, reasonField], run: run('player clear-warmup') },
      {
        id: 'exclude',
        label: 'Exclude a member',
        description: 'Stop them from playing. Their progress is kept',
        emoji: '🚫',
        level: 'moderator',
        fields: () => [memberField, { ...gameField(), options: [...GAME_OPTIONS, { label: 'All games', value: 'all' }] }, reasonField],
        run: run('player exclude'),
      },
      {
        id: 'include',
        label: 'Include a member',
        description: 'Let an excluded member play again',
        emoji: '✅',
        level: 'moderator',
        fields: () => [memberField, { ...gameField(), options: [...GAME_OPTIONS, { label: 'All games', value: 'all' }] }, reasonField],
        run: run('player include'),
      },
      {
        id: 'candy',
        label: 'Give or take candy (admins)',
        description: 'A negative amount takes candy away. Asks to confirm',
        emoji: '🍬',
        level: 'admin',
        fields: () => [memberField, { kind: 'number', id: 'amount', label: 'Amount', description: 'e.g. 25 or -10', min: -1000000, max: 1000000, required: true }, reasonField],
        run: run('adjust candy'),
      },
      {
        id: 'undo-candy',
        label: 'Undo a candy transaction (admins)',
        description: 'Transaction numbers are in History',
        emoji: '↩️',
        level: 'admin',
        fields: () => [{ kind: 'number', id: 'transaction', label: 'Transaction number', description: 'e.g. 42', min: 1, max: 1_000_000_000, required: true }, reasonField],
        run: run('adjust undo-candy'),
      },
      {
        id: 'snowball-stats',
        label: 'Correct snowball stats (admins)',
        description: "Set one number in a member's snowball stats. Asks to confirm",
        emoji: '📊',
        level: 'admin',
        fields: () => [
          memberField,
          {
            kind: 'select',
            id: 'stat',
            label: 'Which number',
            required: true,
            options: [
              { label: 'hits', value: 'hits' },
              { label: 'misses', value: 'misses' },
              { label: 'KOs received', value: 'kos-received' },
              { label: 'snowballs collected', value: 'collected' },
            ],
          },
          { kind: 'number', id: 'value', label: 'New value', min: 0, max: 1_000_000_000, required: true },
          reasonField,
        ],
        run: run('adjust snowball-stats'),
      },
    ],
  },
};

// ── Showing a menu ───────────────────────────────────────────────────

function levelOf(bot: Bot, member: GuildMember): Level {
  return isAdmin(member) ? 'admin' : isModerator(bot, member) ? 'moderator' : 'member';
}

const RANK: Record<Level, number> = { member: 0, moderator: 1, admin: 2 };

function allowed(bot: Bot, member: GuildMember, panel: Panel): Action[] {
  const level = RANK[levelOf(bot, member)];
  return panel.actions.filter((a) => RANK[a.level] <= level);
}

async function panelMessage(bot: Bot, guild: Guild, member: GuildMember, panel: Panel) {
  const actions = allowed(bot, member, panel);
  if (!actions.length) throw new UserError('Only event staff (the Event Manager role) or administrators can do that.');
  const intro = await panel.intro(bot, guild, member);
  if (actions.length <= 3) {
    return { embeds: [intro], components: [row(...actions.map((a) => button(cid('pact', panel.name, a.id), a.label, ButtonStyle.Primary, a.emoji)))] };
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('panel', panel.name))
    .setPlaceholder('What do you want to do?')
    .addOptions(actions.map((a) => ({ label: truncate(a.label, 100), value: a.id, description: truncate(a.description, 100), emoji: a.emoji })));
  return { embeds: [intro], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

/** `/settings`, `/season`, `/visitor`, `/player`: the menu. */
export async function openPanel(bot: Bot, i: ChatInput) {
  const panel = PANELS[i.commandName as Panel['name']];
  await reply(i, await panelMessage(bot, i.guild, i.member, panel));
}

// ── Running an action ────────────────────────────────────────────────

function findAction(panelName: string, actionId: string): { panel: Panel; action: Action } {
  const panel = PANELS[panelName as Panel['name']];
  const action = panel?.actions.find((a) => a.id === actionId);
  if (!panel || !action) throw new UserError('That option no longer exists. Run the command again.');
  return { panel, action };
}

function buildModal(panel: Panel, action: Action, fields: Field[]): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(cid('act', panel.name, action.id)).setTitle(truncate(action.label.replace(/ \(admins\)$/, ''), 45));
  for (const f of fields.slice(0, 5)) {
    const label = new LabelBuilder().setLabel(truncate(f.label, 45));
    if (f.description) label.setDescription(truncate(f.description, 100));
    switch (f.kind) {
      case 'text':
      case 'number': {
        const t = new TextInputBuilder()
          .setCustomId(f.id)
          .setStyle(f.kind === 'text' && f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(!!f.required)
          .setMaxLength(f.kind === 'number' ? 12 : (f.max ?? 300));
        if (f.value !== undefined && f.value !== null && String(f.value) !== '') t.setValue(String(f.value));
        if (f.placeholder) t.setPlaceholder(f.placeholder);
        label.setTextInputComponent(t);
        break;
      }
      case 'select': {
        const s = new StringSelectMenuBuilder()
          .setCustomId(f.id)
          .setRequired(!!f.required)
          .setMinValues(f.required ? 1 : 0)
          .setMaxValues(1)
          .addOptions(f.options.map((o) => ({ label: o.label, value: o.value, description: o.description, default: (o as { default?: boolean }).default ?? o.value === f.value })));
        label.setStringSelectMenuComponent(s);
        break;
      }
      case 'channel': {
        const c = new ChannelSelectMenuBuilder()
          .setCustomId(f.id)
          .setRequired(!!f.required)
          .setMinValues(f.required ? 1 : 0)
          .setMaxValues(f.multi ? 25 : 1);
        if (f.types) c.setChannelTypes(...f.types);
        if (f.value?.length) c.setDefaultChannels(...f.value);
        label.setChannelSelectMenuComponent(c);
        break;
      }
      case 'role': {
        const r = new RoleSelectMenuBuilder()
          .setCustomId(f.id)
          .setRequired(!!f.required)
          .setMinValues(f.required ? 1 : 0)
          .setMaxValues(f.multi ? 25 : 1);
        if (f.value?.length) r.setDefaultRoles(...f.value);
        label.setRoleSelectMenuComponent(r);
        break;
      }
      case 'user':
        label.setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId(f.id).setRequired(!!f.required).setMinValues(f.required ? 1 : 0).setMaxValues(1));
        break;
      case 'file':
        label.setFileUploadComponent(new FileUploadBuilder().setCustomId(f.id).setRequired(!!f.required).setMinValues(f.required ? 1 : 0).setMaxValues(1));
        break;
    }
    modal.addLabelComponents(label);
  }
  return modal;
}

/** What the form returned, keyed by field ID. Strings for text and menus; arrays for pickers and files. */
type Values = Map<string, unknown>;

function readModal(m: Modal, fields: Field[]): Values {
  const vals: Values = new Map();
  const tryRead = <T>(fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  for (const f of fields) {
    const text = () => tryRead(() => m.fields.getTextInputValue(f.id))?.trim() || null;
    switch (f.kind) {
      case 'text':
      case 'number': {
        // A picker can switch between a list and a text box (e.g. more than 25 visitors) while a form is open.
        const v = text() ?? tryRead(() => m.fields.getStringSelectValues(f.id))?.[0] ?? null;
        if (v !== null) vals.set(f.id, v);
        break;
      }
      case 'select': {
        const v = tryRead(() => m.fields.getStringSelectValues(f.id))?.[0] ?? (f.orText ? text() : null);
        if (v) vals.set(f.id, v);
        break;
      }
      case 'channel': {
        const c = tryRead(() => m.fields.getSelectedChannels(f.id, false));
        if (c) vals.set(f.id, [...c.values()]);
        break;
      }
      case 'role': {
        const r = tryRead(() => m.fields.getSelectedRoles(f.id, false));
        if (r) vals.set(f.id, [...r.values()]);
        break;
      }
      case 'user': {
        const u = tryRead(() => m.fields.getSelectedUsers(f.id, false));
        if (u) vals.set(f.id, [...u.values()]);
        break;
      }
      case 'file': {
        const a = tryRead(() => m.fields.getUploadedFiles(f.id, false));
        if (a) vals.set(f.id, [...a.values()]);
        break;
      }
    }
  }
  return vals;
}

/** Makes form answers look like slash-command options to the action handlers. */
function optionsFrom(vals: Values, fields: Field[], guild: Guild) {
  const def = (name: string) => fields.find((f) => f.id === name);
  const labelOf = (name: string) => def(name)?.label.replace(/ \(optional\)$/, '') ?? name;
  const missing = (name: string) => new UserError(`Please fill in **${labelOf(name)}**.`);
  const str = (name: string, required?: boolean): string | null => {
    const v = vals.get(name);
    if (typeof v === 'string' && v !== '') return v;
    if (required) throw missing(name);
    return null;
  };
  const first = <T>(name: string, required?: boolean): T | null => {
    const v = vals.get(name);
    const x = Array.isArray(v) ? (v[0] as T | undefined) : undefined;
    if (x) return x;
    if (required) throw missing(name);
    return null;
  };
  return {
    data: [...vals.entries()].map(([name, value]) => ({ name, value })),
    getString: str,
    getInteger: (name: string, required?: boolean): number | null => {
      const v = str(name, required);
      if (v === null) return null;
      const f = def(name);
      if (!/^[-+]?\d+$/.test(v.replace(/[\s,_]/g, ''))) throw new UserError(`**${labelOf(name)}** must be a whole number, like 10.`);
      const n = Number(v.replace(/[\s,_]/g, ''));
      if (f?.kind === 'number' && (n < f.min || n > f.max)) throw new UserError(`**${labelOf(name)}** must be between ${f.min} and ${f.max}.`);
      return n;
    },
    getBoolean: (name: string, required?: boolean): boolean | null => {
      const v = str(name, required);
      return v === null ? null : v === 'yes';
    },
    getUser: (name: string, required?: boolean) => first(name, required),
    getMember: (name: string) => {
      const u = first<{ id: string }>(name);
      return u ? (guild.members.cache.get(u.id) ?? null) : null;
    },
    getChannel: (name: string, required?: boolean) => first(name, required),
    getRole: (name: string, required?: boolean) => first(name, required),
    getAttachment: (name: string, required?: boolean) => first(name, required),
    /** All picked IDs for a picker, or null when the form had no such field. */
    getIds: (name: string): string[] | null => {
      const v = vals.get(name);
      return Array.isArray(v) ? v.map((x: { id: string }) => x.id) : null;
    },
    getSubcommand: () => null,
    getSubcommandGroup: () => null,
  };
}

/**
 * Runs an action's handler with the form answers. Discord can't open a form
 * straight from another form, so when a handler wants a follow-up form (the
 * visitor texts, an Advent door), it gets a Continue button instead.
 */
async function runAction(bot: Bot, i: Component, action: Action, vals: Values, fields: Field[]) {
  const options = optionsFrom(vals, fields, i.guild);
  const showModal = async (modal: ModalBuilder) => {
    if (!i.isModalSubmit() && !i.replied && !i.deferred) return (i as unknown as ChatInput).showModal(modal);
    const token = createPending(bot.ctx, i.guildId, i.user.id, 'modal.open', modal.toJSON());
    await reply(i, {
      content: 'One more step: press **Continue** to fill in the rest.',
      components: [row(button(cid('om', token), 'Continue', ButtonStyle.Primary, '📝'))],
    });
  };
  const proxy = new Proxy(i, {
    get(target, prop) {
      if (prop === 'options') return options;
      if (prop === 'showModal') return showModal;
      if (prop === 'commandName') return action.id;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as ChatInput;
  await action.run(bot, proxy);
}

/** Refreshes the menu message (so the same option can be picked again) before showing the result. */
async function refreshPanel(bot: Bot, i: Component, panel: Panel) {
  if (i.isModalSubmit() && !i.isFromMessage()) return;
  await (i as { update(p: unknown): Promise<unknown> }).update(await panelMessage(bot, i.guild, i.member, panel));
}

async function start(bot: Bot, i: Component, panelName: string, actionId: string) {
  const { panel, action } = findAction(panelName, actionId);
  assertLevel(bot, i.member, action.level);
  const fields = action.fields?.(bot, i.guild) ?? [];
  if (fields.length) return void (await (i as unknown as ChatInput).showModal(buildModal(panel, action, fields)));
  await refreshPanel(bot, i, panel);
  await runAction(bot, i, action, new Map(Object.entries(action.fixed ?? {})), []);
}

export const panelHandlers: HandlerSet = {
  chat: {
    settings: openPanel,
    season: openPanel,
    visitor: openPanel,
    player: openPanel,
  },
  components: {
    // Menu pick: `panel|<panel>` with the action as the selected value.
    panel: async (bot, i, [panelName]) => {
      if (!i.isStringSelectMenu()) return;
      await start(bot, i, panelName!, i.values[0]!);
    },
    // Button pick (small menus): `pact|<panel>|<action>`.
    pact: async (bot, i, [panelName, actionId]) => start(bot, i, panelName!, actionId!),
    // Form submitted: `act|<panel>|<action>`.
    act: async (bot, i, [panelName, actionId]) => {
      if (!i.isModalSubmit()) return;
      const { panel, action } = findAction(panelName!, actionId!);
      assertLevel(bot, i.member, action.level);
      const fields = action.fields?.(bot, i.guild) ?? [];
      const vals = readModal(i, fields);
      for (const [k, v] of Object.entries(action.fixed ?? {})) vals.set(k, v);
      await refreshPanel(bot, i, panel);
      await runAction(bot, i, action, vals, fields);
    },
    // Continue button for a follow-up form: `om|<token>`.
    om: async (bot, i, [token]) => {
      if (!i.isButton()) return;
      const { payload } = consumePending<APIModalInteractionResponseCallbackData>(bot.ctx, i.guildId, i.user.id, token!);
      await i.showModal(payload);
    },
  },
};
