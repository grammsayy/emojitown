/**
 * A minimal in-memory stand-in for the parts of discord.js the handlers use,
 * so full command flows can run through the real router without a gateway.
 */
import type { Bot } from '../src/discord/runtime.js';
import { route } from '../src/discord/router.js';
import { tickGuild } from '../src/discord/scheduler.js';
import { GUILD, makeCtx, type TestCtx } from './helpers.js';

export interface Sent {
  channelId: string;
  payload: any;
  message: FakeMessage;
}

export interface FakeMessage {
  id: string;
  url: string;
  channelId: string;
  payload: any;
  edit(p: any): Promise<FakeMessage>;
}

export class World {
  ctx: TestCtx;
  bot: Bot;
  sent: Sent[] = [];
  messages = new Map<string, FakeMessage>();
  channels = new Map<string, any>();
  users = new Map<string, any>();
  members = new Map<string, any>();
  roles = new Map<string, any>();
  guild: any;
  private seq = 0;

  constructor(startIso: string) {
    this.ctx = makeCtx(startIso);
    const botUser = this.user('bot', { bot: true });
    const me = this.member('bot', false);
    me.roles.highest = { position: 100 };
    this.guild = {
      id: GUILD,
      ownerId: 'owner',
      channels: { cache: this.channels, fetch: async (id: string) => this.channels.get(id) ?? null },
      roles: { cache: this.roles, fetch: async (id: string) => this.roles.get(id) ?? null },
      members: {
        me,
        fetchMe: async () => me,
        fetch: async (id: string) => {
          const m = this.members.get(id);
          if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
          return m;
        },
      },
    };
    const client: any = { user: botUser, guilds: { cache: new Map([[GUILD, this.guild]]) } };
    this.bot = { client, ctx: this.ctx };
    this.channel('snow');
    this.channel('spooky');
    this.channel('advent');
    this.channel('logs');
    this.channel('general');
    for (const id of ['owner', 'alice', 'bob', 'carol', 'mod']) {
      this.user(id);
      this.member(id, id === 'owner');
    }
  }

  user(id: string, extra: Record<string, unknown> = {}) {
    const u = { id, bot: false, displayName: id, username: id, toString: () => `<@${id}>`, ...extra };
    this.users.set(id, u);
    return u;
  }

  member(id: string, admin: boolean) {
    const m: any = {
      id,
      user: this.users.get(id),
      permissions: { has: () => admin },
      roles: {
        cache: new Map<string, unknown>(),
        highest: { position: 1 },
        add: async (r: string) => m.roles.cache.set(r, true),
        remove: async (r: string) => m.roles.cache.delete(r),
      },
      permissionsIn: () => ({ has: () => true }),
    };
    Object.defineProperty(m, 'guild', { get: () => this.guild });
    this.members.set(id, m);
    return m;
  }

  role(id: string, position = 5, perms = 0n) {
    const r = { id, position, managed: false, members: new Map(), permissions: { has: (p: bigint) => (perms & p) === p && p !== 0n }, toString: () => `<@&${id}>`, name: id };
    this.roles.set(id, r);
    return r;
  }

  channel(id: string) {
    const ch = {
      id,
      name: id,
      type: 0,
      isTextBased: () => true,
      toString: () => `<#${id}>`,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload: any) => {
        const message = this.makeMessage(id, payload);
        this.sent.push({ channelId: id, payload, message });
        return message;
      },
      messages: {
        fetch: async (mid: string) => {
          const m = this.messages.get(mid);
          if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
          return m;
        },
      },
    };
    this.channels.set(id, ch);
    return ch;
  }

  private makeMessage(channelId: string, payload: any): FakeMessage {
    const id = `msg${++this.seq}`;
    const m: FakeMessage = {
      id,
      url: `https://discord.test/${channelId}/${id}`,
      channelId,
      payload,
      edit: async (p: any) => {
        m.payload = p;
        return m;
      },
    };
    this.messages.set(id, m);
    return m;
  }

  private base(userId: string, channelId: string) {
    const calls: { type: string; payload: any }[] = [];
    const i: any = {
      guildId: GUILD,
      guild: this.guild,
      channelId,
      channel: this.channels.get(channelId),
      user: this.users.get(userId),
      member: this.members.get(userId),
      client: this.bot.client,
      deferred: false,
      replied: false,
      calls,
      inCachedGuild: () => true,
      isRepliable: () => true,
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => false,
      isAnySelectMenu: () => false,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      reply: async (payload: any) => {
        i.replied = true;
        calls.push({ type: 'reply', payload });
      },
      followUp: async (payload: any) => calls.push({ type: 'followUp', payload }),
      editReply: async (payload: any) => calls.push({ type: 'editReply', payload }),
      update: async (payload: any) => {
        i.replied = true;
        calls.push({ type: 'update', payload });
      },
      deferUpdate: async () => calls.push({ type: 'deferUpdate', payload: null }),
      showModal: async (payload: any) => calls.push({ type: 'modal', payload: payload.toJSON() }),
    };
    return i;
  }

  /** Runs a slash command. `name` is "command", "command sub" or "command group sub". */
  async command(userId: string, name: string, opts: Record<string, unknown> = {}, channelId = 'general') {
    const parts = name.split(' ');
    const i = this.base(userId, channelId);
    i.isChatInputCommand = () => true;
    i.commandName = parts[0];
    const get = (n: string) => (n in opts ? opts[n] : null);
    i.options = {
      getSubcommandGroup: () => (parts.length === 3 ? parts[1] : null),
      getSubcommand: () => (parts.length >= 2 ? parts[parts.length - 1] : null),
      getString: get,
      getInteger: get,
      getBoolean: get,
      getUser: (n: string) => (get(n) ? this.users.get(get(n) as string) : null),
      getMember: (n: string) => (get(n) ? (this.members.get(get(n) as string) ?? null) : null),
      getChannel: (n: string) => (get(n) ? this.channels.get(get(n) as string) : null),
      getRole: (n: string) => (get(n) ? this.roles.get(get(n) as string) : null),
      getAttachment: (n: string) => get(n),
    };
    await route(this.bot, i);
    return i.calls as { type: string; payload: any }[];
  }

  async button(userId: string, customId: string, message?: FakeMessage, channelId = 'general') {
    const i = this.base(userId, message?.channelId ?? channelId);
    i.isButton = () => true;
    i.customId = customId;
    i.message = message ?? { id: 'ephemeral', edit: async () => undefined };
    await route(this.bot, i);
    return i.calls as { type: string; payload: any }[];
  }

  async select(userId: string, customId: string, values: string[], channelId = 'general') {
    const i = this.base(userId, channelId);
    i.isAnySelectMenu = () => true;
    i.isStringSelectMenu = () => !customId.startsWith('sb|');
    i.isUserSelectMenu = () => customId.startsWith('sb|');
    i.customId = customId;
    i.values = values;
    i.users = { first: () => this.users.get(values[0]!) };
    await route(this.bot, i);
    return i.calls as { type: string; payload: any }[];
  }

  async modal(userId: string, customId: string, fields: Record<string, string>) {
    const i = this.base(userId, 'general');
    i.isModalSubmit = () => true;
    i.customId = customId;
    i.fields = { getTextInputValue: (k: string) => fields[k] ?? '' };
    await route(this.bot, i);
    return i.calls as { type: string; payload: any }[];
  }

  tick() {
    return tickGuild(this.bot, this.guild);
  }
}

/** All text of a reply, for assertions. */
export function text(calls: { payload: any }[]): string {
  return JSON.stringify(calls.map((c) => c.payload));
}

/** Finds a custom ID starting with `prefix` in a payload's components. */
export function findCustomId(payload: any, prefix: string): string | undefined {
  const json = JSON.stringify(payload?.components?.map((r: any) => (r.toJSON ? r.toJSON() : r)) ?? []);
  const m = new RegExp(`"custom_id":"(${prefix.replace(/[|]/g, '\\|')}[^"]*)"`).exec(json);
  return m?.[1];
}
