import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { getChannels } from './domain/config.js';
import type { Ctx } from './domain/context.js';
import { recordActivity } from './domain/halloween.js';
import { markDeparted, markReturned } from './domain/members.js';
import { route } from './discord/router.js';
import { auditLogger, syncChampionRole, type Bot } from './discord/runtime.js';
import { startScheduler } from './discord/scheduler.js';

const config = loadConfig();
if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true });

const ctx: Ctx = { db: openDatabase(config.databasePath), now: () => Date.now(), random: () => Math.random() };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // Privileged: needed to notice members leaving/returning and to manage the Champion role holders.
    GatewayIntentBits.GuildMembers,
    // Message *timing* in Halloween channels decides where visitors appear. Message content is never read.
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.GuildMember],
});

const bot: Bot = { client, ctx };
ctx.onAudit = auditLogger(bot);

client.once(Events.ClientReady, (c) => {
  console.log(`emojitown bot ready as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  startScheduler(bot, config.tickIntervalMs);
});

client.on(Events.InteractionCreate, (i) => void route(bot, i));

/** Gateway listeners run outside the interaction router, so they guard their own errors. */
function safely<A extends unknown[]>(name: string, fn: (...args: A) => void) {
  return (...args: A) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(`${name} handler failed`, err);
    }
  };
}

client.on(
  Events.MessageCreate,
  safely('messageCreate', (m) => {
    if (!m.inGuild() || m.author.bot || m.webhookId || m.system) return;
    if (getChannels(ctx, m.guildId, 'halloween').includes(m.channelId)) recordActivity(ctx, m.guildId, m.channelId);
  }),
);

client.on(
  Events.GuildMemberRemove,
  safely('guildMemberRemove', (m) => {
    markDeparted(ctx, m.guild.id, m.id);
    void syncChampionRole(bot, m.guild.id);
  }),
);

client.on(
  Events.GuildMemberAdd,
  safely('guildMemberAdd', (m) => {
    if (markReturned(ctx, m.guild.id, m.id)) void syncChampionRole(bot, m.guild.id);
  }),
);

// Log and keep running: one failed handler must not take the bot down for every server.
client.on(Events.Error, (err) => console.error('discord client error', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection', err));

const shutdown = () => {
  console.log('shutting down');
  void client.destroy().finally(() => {
    ctx.db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await client.login(config.token);
