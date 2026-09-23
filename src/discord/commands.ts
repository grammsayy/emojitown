import {
  ChannelType,
  InteractionContextType,
  SlashCommandBuilder,
  type SlashCommandStringOption,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';

const eventOpt = (required = false, description = 'Event ID (defaults to the current or latest event)') => (o: SlashCommandStringOption) =>
  o.setName('event').setDescription(description).setRequired(required).setAutocomplete(true);

const reasonOpt = (o: SlashCommandStringOption) => o.setName('reason').setDescription('Reason (recorded in the audit log)').setRequired(true).setMaxLength(300);

const pageOpt = (s: SlashCommandSubcommandBuilder) => s.addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1));

const FEATURE_CHOICES = [
  { name: 'Snowball Fights', value: 'snowball' },
  { name: 'Trick or Treat', value: 'halloween' },
  { name: 'Advent Calendar', value: 'advent' },
];

function command(name: string, description: string) {
  return new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
}

export const commands = [
  // ── Snowball Fights ────────────────────────────────────────────────
  command('collect', 'Collect a snowball'),
  command('throw', 'Throw a snowball at another member').addUserOption((o) =>
    o.setName('target').setDescription('Who to throw at').setRequired(true),
  ),
  command('stats', 'Show snowball statistics')
    .addUserOption((o) => o.setName('target').setDescription('Member (defaults to you)'))
    .addStringOption(eventOpt()),
  command('leaderboard', 'Show snowball standings')
    .addStringOption(eventOpt())
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  command('snowball', 'Snowball Fights settings')
    .addSubcommand((s) =>
      s
        .setName('participation')
        .setDescription('Join or leave snowball fights')
        .addStringOption((o) =>
          o
            .setName('state')
            .setDescription('Play or opt out')
            .setRequired(true)
            .addChoices({ name: 'on (join in)', value: 'on' }, { name: 'off (opt out)', value: 'off' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Admin: playing channels and branding; shows the fixed gameplay rules')
        .addChannelOption((o) => o.setName('add_channel').setDescription('Add a playing channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) =>
          o.setName('remove_channel').setDescription('Remove a playing channel').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('preview')
        .setDescription('Staff: preview a snowball message privately')
        .addStringOption((o) =>
          o
            .setName('outcome')
            .setDescription('Which message')
            .setRequired(true)
            .addChoices(
              { name: 'hit', value: 'hit' },
              { name: 'miss', value: 'miss' },
              { name: 'warmup', value: 'warmup' },
              { name: 'collect', value: 'collect' },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('correct')
        .setDescription('Admin: correct a snowball statistic')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption(eventOpt(true, 'Event ID'))
        .addStringOption((o) =>
          o
            .setName('field')
            .setDescription('Statistic')
            .setRequired(true)
            .addChoices(
              { name: 'hits', value: 'hits' },
              { name: 'misses', value: 'misses' },
              { name: 'kos-received', value: 'kos-received' },
              { name: 'collected', value: 'collected' },
            ),
        )
        .addIntegerOption((o) => o.setName('value').setDescription('New value').setRequired(true).setMinValue(0))
        .addStringOption(reasonOpt),
    )
    .addSubcommand((s) =>
      s
        .setName('clear-warmup')
        .setDescription('Admin: remove an erroneous warm-up restriction')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption(reasonOpt),
    ),

  // ── Trick or Treat ─────────────────────────────────────────────────
  command('trick', 'Answer the visitor in this channel with a Trick'),
  command('treat', 'Answer the visitor in this channel with a Treat'),
  command('halloween', 'Trick or Treat')
    .addSubcommand((s) =>
      s
        .setName('inventory')
        .setDescription('Browse collected items')
        .addUserOption((o) => o.setName('member').setDescription('Member (defaults to you)'))
        .addStringOption(eventOpt())
        .addStringOption((o) =>
          o
            .setName('rarity')
            .setDescription('Filter by rarity')
            .addChoices({ name: 'common', value: 'common' }, { name: 'uncommon', value: 'uncommon' }, { name: 'rare', value: 'rare' }),
        ),
    )
    .addSubcommand((s) => s.setName('missing').setDescription('Show items you still need').addStringOption(eventOpt()))
    .addSubcommand((s) =>
      s
        .setName('item')
        .setDescription('Show an item')
        .addStringOption((o) => o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
        .addStringOption(eventOpt()),
    )
    .addSubcommand((s) => s.setName('visitors').setDescription('Browse the visitor roster').addStringOption(eventOpt()))
    .addSubcommand((s) => pageOpt(s.setName('leaderboard').setDescription('Collection standings').addStringOption(eventOpt())))
    .addSubcommand((s) => s.setName('status').setDescription('Event dates, channels, your progress and the current Champion'))
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Admin: spawn timing, channels, rarity weights and candy limit')
        .addIntegerOption((o) => o.setName('spawn_min_minutes').setDescription('Shortest wait between visitors').setMinValue(1).setMaxValue(240))
        .addIntegerOption((o) => o.setName('spawn_max_minutes').setDescription('Longest wait between visitors').setMinValue(1).setMaxValue(240))
        .addIntegerOption((o) => o.setName('visit_seconds').setDescription('How long a visitor stays').setMinValue(15).setMaxValue(900))
        .addIntegerOption((o) =>
          o.setName('activity_minutes').setDescription('Channel must have human messages within this window').setMinValue(1).setMaxValue(120),
        )
        .addChannelOption((o) => o.setName('add_channel').setDescription('Enable a channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) => o.setName('remove_channel').setDescription('Disable a channel').addChannelTypes(ChannelType.GuildText))
        .addIntegerOption((o) => o.setName('common_weight').setDescription('Common drop weight (default 70)').setMinValue(0).setMaxValue(1000))
        .addIntegerOption((o) => o.setName('uncommon_weight').setDescription('Uncommon drop weight (default 25)').setMinValue(0).setMaxValue(1000))
        .addIntegerOption((o) => o.setName('rare_weight').setDescription('Rare drop weight (default 5)').setMinValue(0).setMaxValue(1000))
        .addIntegerOption((o) => o.setName('daily_candy_limit').setDescription('Daily Halloween candy limit per member').setMinValue(0).setMaxValue(100000)),
    )
    .addSubcommand((s) =>
      s
        .setName('champion')
        .setDescription('Admin: Champion role and what happens at event end')
        .addRoleOption((o) => o.setName('role').setDescription('Champion role').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('end_policy')
            .setDescription('At event end')
            .setRequired(true)
            .addChoices(
              { name: 'keep until the next Halloween starts', value: 'keep' },
              { name: 'remove at event end', value: 'remove' },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('preview')
        .setDescription('Staff: a private sample encounter (nothing saved)')
        .addStringOption((o) => o.setName('visitor').setDescription('Visitor name or ID').setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('cancel').setDescription('Staff: send the current visitor away without rewards').addStringOption(reasonOpt))
    .addSubcommand((s) =>
      s
        .setName('collection')
        .setDescription('Admin: correct item ownership')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption(eventOpt(true, 'Event ID'))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Grant or revoke')
            .setRequired(true)
            .addChoices({ name: 'grant', value: 'grant' }, { name: 'revoke', value: 'revoke' }),
        )
        .addStringOption((o) => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true))
        .addStringOption(reasonOpt),
    )
    .addSubcommand((s) => s.setName('reconcile').setDescription('Staff: recheck the Champion role and retry pending changes')),

  // ── Advent Calendar ────────────────────────────────────────────────
  command('advent', 'Advent Calendar')
    .addSubcommand((s) => s.setName('calendar').setDescription('Show the calendar').addStringOption(eventOpt()))
    .addSubcommand((s) =>
      s
        .setName('open')
        .setDescription("Open today's door or a released door")
        .addIntegerOption((o) => o.setName('day').setDescription('Door number').setMinValue(1).setMaxValue(31))
        .addStringOption(eventOpt()),
    )
    .addSubcommand((s) => s.setName('progress').setDescription('Your claimed doors and Advent candy').addStringOption(eventOpt()))
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Admin: channel, doors, times and catch-up policy')
        .addChannelOption((o) => o.setName('channel').setDescription('Advent channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addIntegerOption((o) => o.setName('doors').setDescription('Number of doors (default 24)').setMinValue(1).setMaxValue(31))
        .addStringOption((o) => o.setName('unlock_time').setDescription('Door unlock time, HH:MM (default 09:00)').setMaxLength(5))
        .addStringOption((o) => o.setName('announce_time').setDescription('Announcement time, HH:MM (default 09:00)').setMaxLength(5))
        .addStringOption((o) =>
          o
            .setName('policy')
            .setDescription('Catch-up policy')
            .addChoices(
              { name: 'catch-up (claim earlier doors until the deadline)', value: 'catch-up' },
              { name: 'same-day (each door expires at local midnight)', value: 'same-day' },
            ),
        )
        .addStringOption(eventOpt(false, 'Event whose claim deadline to set'))
        .addStringOption((o) => o.setName('claim_deadline').setDescription('YYYY-MM-DD HH:MM (default Dec 25 00:00)').setMaxLength(16)),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Admin: edit a door (opens a form)')
        .addIntegerOption((o) => o.setName('day').setDescription('Door number').setRequired(true).setMinValue(1).setMaxValue(31))
        .addStringOption(eventOpt(true, 'Event ID'))
        .addIntegerOption((o) => o.setName('candy').setDescription('Candy for opening (default 10, 0 for none)').setMinValue(0).setMaxValue(10000))
        .addStringOption((o) => o.setName('reason').setDescription('Required once the calendar is published').setMaxLength(300)),
    )
    .addSubcommand((s) =>
      s
        .setName('preview')
        .setDescription('Staff: see a door as members will')
        .addIntegerOption((o) => o.setName('day').setDescription('Door number').setRequired(true).setMinValue(1).setMaxValue(31))
        .addStringOption(eventOpt(true, 'Event ID')),
    )
    .addSubcommand((s) => s.setName('validate').setDescription('Staff: list calendar problems').addStringOption(eventOpt(true, 'Event ID')))
    .addSubcommand((s) => s.setName('publish').setDescription('Admin: freeze a validated calendar for release').addStringOption(eventOpt(true, 'Event ID')))
    .addSubcommand((s) =>
      s
        .setName('post')
        .setDescription('Staff: post or repair the announcement for an unlocked door')
        .addIntegerOption((o) => o.setName('day').setDescription('Door number').setRequired(true).setMinValue(1).setMaxValue(31))
        .addStringOption(eventOpt(true, 'Event ID')),
    ),

  // ── Candy Counter ──────────────────────────────────────────────────
  command('candy', 'Candy Counter')
    .addSubcommand((s) =>
      s.setName('balance').setDescription('Show a candy balance').addUserOption((o) => o.setName('member').setDescription('Member (defaults to you)')),
    )
    .addSubcommand((s) =>
      pageOpt(s.setName('leaderboard').setDescription('All-time or event standings').addStringOption(eventOpt(false, 'Event ID (omit for all-time)'))),
    )
    .addSubcommand((s) => pageOpt(s.setName('history').setDescription('Your recent rewards and adjustments')))
    .addSubcommand((s) => s.setName('rules').setDescription('How candy is earned'))
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Admin: Halloween candy per win and daily limit')
        .addIntegerOption((o) => o.setName('halloween_per_win').setDescription('Candy per Halloween win (default 5)').setMinValue(0).setMaxValue(10000))
        .addIntegerOption((o) => o.setName('halloween_daily_limit').setDescription('Daily Halloween limit (default 100)').setMinValue(0).setMaxValue(100000)),
    )
    .addSubcommand((s) =>
      s
        .setName('adjust')
        .setDescription('Admin: add or remove candy')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('Positive to add, negative to remove').setRequired(true).setMinValue(-1000000).setMaxValue(1000000))
        .addStringOption((o) => o.setName('source').setDescription('What this is for, e.g. "trivia night"').setRequired(true).setMaxLength(80))
        .addStringOption(reasonOpt)
        .addStringOption(eventOpt(false, 'Attribute to an event (optional)')),
    )
    .addSubcommand((s) =>
      s
        .setName('reverse')
        .setDescription('Admin: reverse a mistaken transaction')
        .addIntegerOption((o) => o.setName('transaction').setDescription('Transaction number').setRequired(true).setMinValue(1))
        .addStringOption(reasonOpt),
    )
    .addSubcommand((s) =>
      s
        .setName('inspect')
        .setDescription("Staff: a member's candy history")
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption(eventOpt(false, 'Limit to an event')),
    ),

  // ── Shared ─────────────────────────────────────────────────────────
  command('help', 'How the emojitown seasonal games work').addStringOption((o) =>
    o
      .setName('topic')
      .setDescription('Feature')
      .addChoices(
        { name: 'Snowball Fights', value: 'snowball' },
        { name: 'Trick or Treat', value: 'halloween' },
        { name: 'Advent Calendar', value: 'advent' },
        { name: 'Candy Counter', value: 'candy' },
      ),
  ),
  command('support', 'Where to get help'),
  command('season', 'Seasonal events')
    .addSubcommand((s) => s.setName('status').setDescription('Active and upcoming events'))
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Admin: initial setup')
        .addStringOption((o) => o.setName('timezone').setDescription('IANA timezone, e.g. Europe/Copenhagen').setAutocomplete(true))
        .addStringOption((o) => o.setName('support').setDescription('Support channel mention or link').setMaxLength(200))
        .addChannelOption((o) => o.setName('log_channel').setDescription('Private staff log channel').addChannelTypes(ChannelType.GuildText))
        .addRoleOption((o) => o.setName('event_manager_role').setDescription('Event Manager role')),
    )
    .addSubcommand((s) => s.setName('config').setDescription('Admin: saved settings and missing requirements'))
    .addSubcommand((s) =>
      s
        .setName('timezone')
        .setDescription('Admin: set the server timezone')
        .addStringOption((o) => o.setName('zone').setDescription('IANA timezone, e.g. Europe/Copenhagen').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('channel')
        .setDescription('Admin: manage channel assignments')
        .addStringOption((o) =>
          o
            .setName('feature')
            .setDescription('Feature')
            .setRequired(true)
            .addChoices(...FEATURE_CHOICES, { name: 'Staff logs', value: 'logs' }),
        )
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Action')
            .setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel (for add/remove)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('staff')
        .setDescription('Admin: grant or remove Event Manager access')
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Action')
            .setRequired(true)
            .addChoices({ name: 'grant', value: 'grant' }, { name: 'remove', value: 'remove' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('support')
        .setDescription('Admin: set the destination shown by /support')
        .addStringOption((o) => o.setName('destination').setDescription('Channel mention or link').setRequired(true).setMaxLength(200)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('event')
        .setDescription('Manage events')
        .addSubcommand((s) =>
          s
            .setName('create')
            .setDescription('Admin: create a draft event')
            .addStringOption((o) => o.setName('feature').setDescription('Feature').setRequired(true).addChoices(...FEATURE_CHOICES))
            .addStringOption((o) => o.setName('name').setDescription('Name, e.g. "Halloween 2026"').setRequired(true).setMaxLength(60)),
        )
        .addSubcommand((s) => s.setName('schedule').setDescription('Admin: set dates (opens a form)').addStringOption(eventOpt(true, 'Event ID')))
        .addSubcommand((s) => s.setName('start').setDescription('Admin: validate and activate now').addStringOption(eventOpt(true, 'Event ID')))
        .addSubcommand((s) => s.setName('end').setDescription('Admin: freeze an event and publish results').addStringOption(eventOpt(true, 'Event ID')))
        .addSubcommand((s) =>
          s.setName('pause').setDescription('Staff: stop new gameplay').addStringOption(eventOpt(true, 'Event ID')).addStringOption(reasonOpt),
        )
        .addSubcommand((s) => s.setName('resume').setDescription('Staff: resume a paused event').addStringOption(eventOpt(true, 'Event ID'))),
    )
    .addSubcommand((s) =>
      s
        .setName('announce')
        .setDescription('Admin: preview and post member instructions')
        .addStringOption(eventOpt(true, 'Event ID'))
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where to post').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) => s.setName('check').setDescription('Admin: readiness check').addStringOption(eventOpt(false, 'Event ID (omit for all upcoming)')))
    .addSubcommand((s) => s.setName('export').setDescription('Admin: download event data').addStringOption(eventOpt(true, 'Event ID')))
    .addSubcommand((s) =>
      s
        .setName('audit')
        .setDescription('Admin: staff changes and reward activity')
        .addUserOption((o) => o.setName('member').setDescription('Member'))
        .addStringOption(eventOpt(false, 'Event ID')),
    )
    .addSubcommand((s) =>
      s
        .setName('exclude')
        .setDescription('Staff: block a member from features')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption((o) =>
          o.setName('feature').setDescription('Feature').setRequired(true).addChoices(...FEATURE_CHOICES, { name: 'All', value: 'all' }),
        )
        .addStringOption(reasonOpt),
    )
    .addSubcommand((s) =>
      s
        .setName('include')
        .setDescription('Staff: restore eligibility')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption((o) =>
          o.setName('feature').setDescription('Feature').setRequired(true).addChoices(...FEATURE_CHOICES, { name: 'All', value: 'all' }),
        )
        .addStringOption(reasonOpt),
    )
    .addSubcommand((s) =>
      s
        .setName('content')
        .setDescription('Manage branding and content packs')
        .addStringOption((o) =>
          o
            .setName('feature')
            .setDescription('Content pack')
            .setRequired(true)
            .addChoices({ name: 'Snowball Fights', value: 'snowball' }, { name: 'Trick or Treat', value: 'halloween' }),
        )
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Action')
            .setRequired(true)
            .addChoices(
              { name: 'import (admin)', value: 'import' },
              { name: 'validate', value: 'validate' },
              { name: 'preview', value: 'preview' },
              { name: 'export (admin)', value: 'export' },
            ),
        )
        .addAttachmentOption((o) => o.setName('file').setDescription('Content pack JSON (import/validate)')),
    ),
];

/** Required permission level per command key (`command`, `command sub` or `command group sub`). Default: member. */
export const LEVELS: Record<string, 'moderator' | 'admin'> = {
  'snowball setup': 'admin',
  'snowball preview': 'moderator',
  'snowball correct': 'admin',
  'snowball clear-warmup': 'admin',
  'halloween setup': 'admin',
  'halloween champion': 'admin',
  'halloween preview': 'moderator',
  'halloween cancel': 'moderator',
  'halloween collection': 'admin',
  'halloween reconcile': 'moderator',
  'advent setup': 'admin',
  'advent edit': 'admin',
  'advent preview': 'moderator',
  'advent validate': 'moderator',
  'advent publish': 'admin',
  'advent post': 'moderator',
  'candy setup': 'admin',
  'candy adjust': 'admin',
  'candy reverse': 'admin',
  'candy inspect': 'moderator',
  'season setup': 'admin',
  'season config': 'admin',
  'season timezone': 'admin',
  'season channel': 'admin',
  'season staff': 'admin',
  'season support': 'admin',
  'season event create': 'admin',
  'season event schedule': 'admin',
  'season event start': 'admin',
  'season event end': 'admin',
  'season event pause': 'moderator',
  'season event resume': 'moderator',
  'season announce': 'admin',
  'season check': 'admin',
  'season export': 'admin',
  'season audit': 'admin',
  'season exclude': 'moderator',
  'season include': 'moderator',
  // content import/export are admin-only; checked in the handler per action
  'season content': 'moderator',
};
