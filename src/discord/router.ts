import { MessageFlags, type AutocompleteInteraction, type Interaction } from 'discord.js';
import { consumePending } from '../domain/confirmations.js';
import { UserError } from '../domain/errors.js';
import { type Feature } from '../domain/events.js';
import { levelFor } from './commands.js';
import { adventHandlers } from './handlers/advent.js';
import { candyHandlers } from './handlers/candy.js';
import { halloweenHandlers } from './handlers/halloween.js';
import { helpHandlers } from './handlers/help.js';
import { manageHandlers } from './handlers/manage.js';
import { visitorHandlers } from './handlers/visitors.js';
import { panelHandlers } from './panels.js';
import { seasonChoices, seasonHandlers } from './handlers/season.js';
import { snowballHandlers } from './handlers/snowball.js';
import { reply, type Button, type ChatHandler, type ComponentHandler, type ConfirmHandler, type HandlerSet } from './interaction.js';
import { assertLevel, type Bot, type Level } from './runtime.js';
import { COLORS, embed } from './ui.js';

const SETS: HandlerSet[] = [snowballHandlers, halloweenHandlers, adventHandlers, candyHandlers, seasonHandlers, helpHandlers, manageHandlers, visitorHandlers, panelHandlers];

const chat = new Map<string, ChatHandler>();
const components = new Map<string, ComponentHandler>();
const confirms = new Map<string, { level: Level; run: ConfirmHandler }>();
for (const set of SETS) {
  for (const [k, v] of Object.entries(set.chat ?? {})) chat.set(k, v);
  for (const [k, v] of Object.entries(set.components ?? {})) components.set(k, v);
  for (const [k, v] of Object.entries(set.confirms ?? {})) confirms.set(k, v);
}

/** Staff components whose own handlers do not re-check permissions. */
const COMPONENT_LEVELS: Record<string, Level> = { advedit: 'admin', visitorform: 'admin', vlist: 'admin' };

/** Which game's seasons a `season` option should suggest. */
function seasonFeature(i: AutocompleteInteraction<'cached'>): Feature | undefined {
  if (i.commandName === 'stats') return 'snowball';
  if (i.commandName === 'inventory') return 'halloween';
  const game = i.options.getString('game');
  return game === 'snowball' || game === 'halloween' || game === 'advent' ? game : undefined;
}

async function autocomplete(bot: Bot, i: AutocompleteInteraction<'cached'>): Promise<void> {
  const focused = i.options.getFocused(true);
  const q = String(focused.value).toLowerCase();
  let choices: { name: string; value: string }[] = [];
  if (focused.name === 'season') choices = seasonChoices(bot, i.guildId, seasonFeature(i), q);
  await i.respond(choices);
}

function commandKey(i: { commandName: string; options: { getSubcommandGroup(r: false): string | null; getSubcommand(r: false): string | null } }): string {
  return [i.commandName, i.options.getSubcommandGroup(false), i.options.getSubcommand(false)].filter(Boolean).join(' ');
}

async function handleError(i: Interaction, err: unknown): Promise<void> {
  if (!i.isRepliable()) return;
  const userError = err instanceof UserError;
  if (!userError) console.error('interaction failed', err);
  const message = userError ? err.message : 'Something went wrong on our side. Nothing was lost; please try again in a moment.';
  try {
    await reply(i, { embeds: [embed(userError ? COLORS.warn : COLORS.error, undefined, message)] });
  } catch (e) {
    console.error('could not report error', e);
  }
}

/**
 * Discord only sends a server's data to bots that are members of it. When a
 * command arrives from a server the bot user isn't in (it was added as
 * "commands only"), say so and give the invite link that fixes it.
 */
export function notInServerMessage(i: Interaction): string {
  if (!i.guildId) return 'emojitown commands only work inside a server, not in DMs.';
  return (
    "⚠️ The emojitown bot isn't a member of this server yet. Its commands were added, but the bot itself wasn't, so it can't do anything here.\n" +
    `An admin can fix this by opening this link and choosing this server: ${inviteUrl(i.applicationId, i.guildId)}`
  );
}

export function inviteUrl(clientId: string, guildId?: string): string {
  const base = `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;
  return guildId ? `${base}&guild_id=${guildId}&disable_guild_select=true` : base;
}

/** View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Manage Roles. */
export const BOT_PERMISSIONS = '268553216';

export async function route(bot: Bot, i: Interaction): Promise<void> {
  if (!i.inCachedGuild()) {
    if (i.isAutocomplete()) return void (await i.respond([]).catch(() => undefined));
    if (i.isRepliable()) await i.reply({ content: notInServerMessage(i), flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  try {
    if (i.isAutocomplete()) return await autocomplete(bot, i);

    if (i.isChatInputCommand()) {
      const key = commandKey(i);
      const handler = chat.get(key);
      if (!handler) throw new Error(`no handler for /${key}`);
      assertLevel(bot, i.member, levelFor(key));
      return await handler(bot, i);
    }

    if (i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) {
      const [prefix, ...args] = i.customId.split('|');
      if (prefix === 'noop') return void (i.isButton() && (await i.deferUpdate()));
      if (prefix === 'cf' || prefix === 'cx') return await confirm(bot, i as Button, prefix === 'cf', args[0]!);
      const handler = components.get(prefix!);
      if (!handler) throw new Error(`no component handler for ${prefix}`);
      const level = COMPONENT_LEVELS[prefix!];
      if (level) assertLevel(bot, i.member, level);
      return await handler(bot, i, args);
    }
  } catch (err) {
    await handleError(i, err);
  }
}

async function confirm(bot: Bot, i: Button, accepted: boolean, token: string): Promise<void> {
  if (!accepted) {
    consumePending(bot.ctx, i.guildId, i.user.id, token);
    await i.update({ content: 'Cancelled. Nothing was changed.', embeds: [], components: [] });
    return;
  }
  const { kind, payload } = consumePending(bot.ctx, i.guildId, i.user.id, token);
  const action = confirms.get(kind);
  if (!action) throw new Error(`no confirm handler for ${kind}`);
  // Permissions are checked again at confirmation time.
  assertLevel(bot, i.member, action.level);
  await i.update({ content: 'Working…', components: [] });
  try {
    const result = await action.run(bot, i, payload);
    await i.editReply(typeof result === 'string' ? { content: result, embeds: [], components: [] } : { content: '', embeds: [result], components: [] });
  } catch (err) {
    if (!(err instanceof UserError)) console.error(`confirmed action ${kind} failed`, err);
    const message = err instanceof UserError ? err.message : 'Something went wrong on our side. Please check `/player` → **History** before retrying.';
    await i.editReply({ content: '', embeds: [embed(COLORS.warn, 'Not saved', message)], components: [] });
  }
}
