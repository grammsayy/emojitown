import { MessageFlags, type AutocompleteInteraction, type Interaction } from 'discord.js';
import { consumePending, discardPending } from '../domain/confirmations.js';
import { UserError } from '../domain/errors.js';
import { listEvents, type Feature } from '../domain/events.js';
import { LEVELS } from './commands.js';
import { adventHandlers } from './handlers/advent.js';
import { candyHandlers } from './handlers/candy.js';
import { halloweenHandlers, itemChoices, visitorChoices } from './handlers/halloween.js';
import { helpHandlers } from './handlers/help.js';
import { seasonHandlers } from './handlers/season.js';
import { snowballHandlers } from './handlers/snowball.js';
import { reply, type Button, type ChatHandler, type ComponentHandler, type ConfirmHandler, type HandlerSet } from './interaction.js';
import { assertLevel, type Bot, type Level } from './runtime.js';
import { COLORS, embed } from './ui.js';

const SETS: HandlerSet[] = [snowballHandlers, halloweenHandlers, adventHandlers, candyHandlers, seasonHandlers, helpHandlers];

const chat = new Map<string, ChatHandler>();
const components = new Map<string, ComponentHandler>();
const confirms = new Map<string, { level: Level; run: ConfirmHandler }>();
for (const set of SETS) {
  for (const [k, v] of Object.entries(set.chat ?? {})) chat.set(k, v);
  for (const [k, v] of Object.entries(set.components ?? {})) components.set(k, v);
  for (const [k, v] of Object.entries(set.confirms ?? {})) confirms.set(k, v);
}

/** Staff components whose own handlers do not re-check permissions. */
const COMPONENT_LEVELS: Record<string, Level> = { advedit: 'admin', schedule: 'admin' };

/** Which feature's events an `event` option should suggest, per command. */
const EVENT_FEATURE: Record<string, Feature | undefined> = {
  stats: 'snowball',
  leaderboard: 'snowball',
  snowball: 'snowball',
  halloween: 'halloween',
  advent: 'advent',
};

async function autocomplete(bot: Bot, i: AutocompleteInteraction<'cached'>): Promise<void> {
  const focused = i.options.getFocused(true);
  const q = String(focused.value).toLowerCase();
  let choices: { name: string; value: string }[] = [];
  if (focused.name === 'event') {
    const feature = EVENT_FEATURE[i.commandName];
    choices = listEvents(bot.ctx, i.guildId, feature)
      .filter((e) => e.id.includes(q) || e.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((e) => ({ name: `${e.name} (${e.id}, ${e.state})`.slice(0, 100), value: e.id }));
  } else if (focused.name === 'item') {
    choices = itemChoices(bot, i.guildId, q);
  } else if (focused.name === 'visitor') {
    choices = visitorChoices(bot, i.guildId, q);
  } else if (focused.name === 'timezone' || focused.name === 'zone') {
    choices = Intl.supportedValuesOf('timeZone')
      .filter((z) => z.toLowerCase().includes(q))
      .slice(0, 25)
      .map((z) => ({ name: z, value: z }));
  }
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

export async function route(bot: Bot, i: Interaction): Promise<void> {
  if (!i.inCachedGuild()) {
    if (i.isRepliable()) await i.reply({ content: 'emojitown commands work inside the server.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  try {
    if (i.isAutocomplete()) return await autocomplete(bot, i);

    if (i.isChatInputCommand()) {
      const key = commandKey(i);
      const handler = chat.get(key);
      if (!handler) throw new Error(`no handler for /${key}`);
      assertLevel(bot, i.member, LEVELS[key] ?? 'member');
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
    discardPending(bot.ctx, token);
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
    const message = err instanceof UserError ? err.message : 'Something went wrong on our side. Please check `/season audit` before retrying.';
    await i.editReply({ content: '', embeds: [embed(COLORS.warn, 'Not saved', message)], components: [] });
  }
}
