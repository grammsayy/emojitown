/**
 * Registers the slash commands with Discord. Run after changing commands:
 *   npm run deploy-commands
 * With DEV_GUILD_ID set, commands register to that server only (instant).
 * Without it, they register globally (can take up to an hour to appear).
 */
import { REST, Routes } from 'discord.js';
import { commands } from '../src/discord/commands.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID.');
  process.exit(1);
}
const guildId = process.env.DEV_GUILD_ID;
const body = commands.map((c) => c.toJSON());
const rest = new REST().setToken(token);
const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
await rest.put(route, { body });
console.log(`Registered ${body.length} commands ${guildId ? `in server ${guildId}` : 'globally'}.`);
console.log(
  `\nIf you haven't yet, invite the bot itself (not just its commands) with:\n` +
    `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=268553216${guildId ? `&guild_id=${guildId}&disable_guild_select=true` : ''}`,
);
