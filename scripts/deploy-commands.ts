/**
 * The bot registers its own slash commands per server when it starts, and
 * shows or hides each game's commands as games start and end. You don't need
 * to run anything to update commands: just restart the bot.
 *
 * This script only cleans up: it removes any commands registered globally or
 * by older versions, so the bot's own list is the only one left.
 *   node --env-file=.env dist/scripts/deploy-commands.js
 */
import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env.');
  process.exit(1);
}
const rest = new REST().setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: [] });
console.log('Removed global commands. The bot sets up each server\'s commands itself when it starts.');
const guildId = process.env.DEV_GUILD_ID;
if (guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
  console.log(`Cleared old commands in server ${guildId}; start the bot to register the current ones.`);
}
console.log(
  `\nIf the bot isn't in your server yet, invite it with:\n` +
    `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=268553216${guildId ? `&guild_id=${guildId}&disable_guild_select=true` : ''}`,
);
