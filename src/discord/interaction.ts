import {
  ButtonStyle,
  MessageFlags,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type RepliableInteraction,
} from 'discord.js';
import { createPending } from '../domain/confirmations.js';
import type { Bot, Level } from './runtime.js';
import { button, cid, row } from './ui.js';

export type ChatInput = ChatInputCommandInteraction<'cached'>;
export type Button = ButtonInteraction<'cached'>;
export type Select = AnySelectMenuInteraction<'cached'>;
export type Modal = ModalSubmitInteraction<'cached'>;
export type Component = Button | Select | Modal;

export type ChatHandler = (bot: Bot, i: ChatInput) => Promise<void>;
/** `args` are the custom ID parts after the prefix. */
export type ComponentHandler = (bot: Bot, i: Component, args: string[]) => Promise<void>;
/** Runs a confirmed staff action. Returns the text shown to the staff member. */
export type ConfirmHandler = (bot: Bot, i: Button, payload: any) => Promise<string | EmbedBuilder>;

export interface HandlerSet {
  chat?: Record<string, ChatHandler>;
  components?: Record<string, ComponentHandler>;
  confirms?: Record<string, { level: Level; run: ConfirmHandler }>;
}

/** Private reply that works whether or not the interaction was already acknowledged. */
export async function reply(i: RepliableInteraction, options: InteractionReplyOptions | string): Promise<void> {
  const opts: InteractionReplyOptions = typeof options === 'string' ? { content: options } : options;
  const flags = MessageFlags.Ephemeral;
  if (i.deferred) {
    await i.editReply({ content: opts.content, embeds: opts.embeds, components: opts.components, files: opts.files });
  } else if (i.replied) {
    await i.followUp({ ...opts, flags });
  } else {
    await i.reply({ ...opts, flags, allowedMentions: { parse: [] } } as InteractionReplyOptions);
  }
}

/** Public reply. Mentions render but do not ping unless `ping` lists user IDs. */
export async function publicReply(i: RepliableInteraction, options: InteractionReplyOptions, ping: string[] = []): Promise<void> {
  await i.reply({ ...options, allowedMentions: { users: ping } });
}

/** Shows a staff action for review with Confirm and Cancel buttons. */
export async function askConfirm(bot: Bot, i: RepliableInteraction & { guildId: string }, kind: string, payload: unknown, preview: EmbedBuilder): Promise<void> {
  const token = createPending(bot.ctx, i.guildId, i.user.id, kind, payload);
  await reply(i, {
    embeds: [preview],
    components: [row(button(cid('cf', token), 'Confirm', ButtonStyle.Danger, '✅'), button(cid('cx', token), 'Cancel', ButtonStyle.Secondary))],
  });
}
