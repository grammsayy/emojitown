/**
 * A minimal in-memory stand-in for the parts of discord.js the handlers use,
 * so full command flows can run through the real router without a gateway.
 */
import type { Bot } from '../src/discord/runtime.js';
import { route } from '../src/discord/router.js';
import { resetCommandSync } from '../src/discord/commandSync.js';
import { tickGuild } from '../src/discord/scheduler.js';
import { PANELS, type Field, type Panel } from '../src/discord/panels.js';
import { getChannels, getStaffRoles } from '../src/domain/config.js';
import { getCurrentOrLatestEvent, type Feature } from '../src/domain/events.js';
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
  delete(): Promise<FakeMessage>;
  deleted?: boolean;
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
  /** Command names currently registered in the fake server. */
  registered: string[] = [];
  commandSyncs = 0;
  private seq = 0;

  constructor(startIso: string) {
    resetCommandSync();
    this.ctx = makeCtx(startIso);
    const botUser = this.user('bot', { bot: true });
    const me = this.member('bot', false);
    me.roles.highest = { position: 100 };
    this.guild = {
      id: GUILD,
      ownerId: 'owner',
      commands: {
        set: async (json: { name: string }[]) => {
          this.registered = json.map((c) => c.name).sort();
          this.commandSyncs++;
          return json;
        },
      },
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
      delete: async () => {
        m.deleted = true;
        this.messages.delete(id);
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
      showModal: async (payload: any) => calls.push({ type: 'modal', payload: payload.toJSON ? payload.toJSON() : payload }),
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
      data: Object.keys(opts).map((n) => ({ name: n, value: opts[n] })),
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

  /**
   * Picks a menu action and submits its form, like a staff member would.
   * Fields start with the values the form shows (Discord sends those back
   * untouched), then `values` overrides them. Pickers take IDs.
   */
  async action(userId: string, panel: Panel['name'], actionId: string, values: Record<string, unknown> = {}, channelId = 'general') {
    const action = PANELS[panel].actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`no action ${panel}/${actionId}`);
    let fields: Field[] = [];
    try {
      fields = action.fields?.(this.bot, this.guild) ?? [];
    } catch {
      // The real menu would show this error; let the submit path report it.
    }
    if (!action.fields) return this.select(userId, `panel|${panel}`, [actionId], channelId);
    const form: Record<string, unknown> = {};
    for (const f of fields) {
      if ((f.kind === 'text' || f.kind === 'number') && f.value !== undefined && f.value !== null && f.value !== '') form[f.id] = String(f.value);
      if (f.kind === 'select') {
        const d = (f.options as { value: string; default?: boolean }[]).find((o) => o.default) ?? f.options.find((o) => o.value === f.value);
        if (d) form[f.id] = d.value;
      }
      if ((f.kind === 'channel' || f.kind === 'role') && f.value) form[f.id] = f.value;
    }
    for (const [k, v] of Object.entries(values)) {
      if (v === null || v === undefined) delete form[k];
      else form[k] = typeof v === 'boolean' ? (v ? 'yes' : 'no') : v;
    }
    const i = this.base(userId, channelId);
    i.isModalSubmit = () => true;
    i.isFromMessage = () => true;
    i.customId = `act|${panel}|${actionId}`;
    const ids = (k: string) => (k in form ? ([] as string[]).concat(form[k] as string | string[]) : null);
    const pick = (k: string, from: Map<string, any>) => {
      const list = ids(k);
      return list ? new Map(list.map((id) => [id, from.get(id) ?? { id }])) : null;
    };
    const has = (k: string) => {
      if (!(k in form)) throw new Error(`no field ${k}`);
      return form[k];
    };
    i.fields = {
      getTextInputValue: (k: string) => String(has(k)),
      getStringSelectValues: (k: string) => [String(has(k))],
      getSelectedChannels: (k: string) => pick(k, this.channels),
      getSelectedRoles: (k: string) => pick(k, this.roles),
      getSelectedUsers: (k: string) => pick(k, this.users),
      getUploadedFiles: (k: string) => (k in form ? new Map([[`f${k}`, form[k]]]) : null),
    };
    await route(this.bot, i);
    // A follow-up form comes behind a Continue button; press it.
    const next = i.calls.map((c: any) => findCustomId(c.payload, 'om|')).find(Boolean);
    if (next) return this.button(userId, next);
    return i.calls as { type: string; payload: any }[];
  }

  /**
   * Runs a staff action by its old slash-command name and options, e.g.
   * `staff('owner', 'season halloween', { channel: 'spooky', wait_min: '30s' })`.
   * Keeps the flow tests readable while going through the real menus.
   */
  async staff(userId: string, key: string, opts: Record<string, unknown> = {}) {
    const o = { ...opts };
    const run = async (panel: Panel['name'], id: string, values: Record<string, unknown>) => this.action(userId, panel, id, values);
    const addChannel = (game: 'halloween' | 'snowball') => {
      if (!('channel' in o)) return {};
      const ch = o.channel as string;
      delete o.channel;
      return { channels: [...new Set([...getChannels(this.bot.ctx, GUILD, game), ch])] };
    };
    const [cmd, sub] = key.split(' ') as [string, string | undefined];
    if (cmd === 'settings') {
      if ('staff_role' in o) {
        o.staff_roles = [...new Set([...getStaffRoles(this.bot.ctx, GUILD), o.staff_role as string])];
        delete o.staff_role;
      }
      return run('settings', 'edit', o);
    }
    if (cmd === 'season' && sub === 'halloween') {
      const timing = ['wait_min', 'wait_max', 'visit_length', 'delete_after'];
      const candy = ['candy_per_win', 'daily_candy_limit'];
      const pickOut = (keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
      const base = { ...addChannel('halloween'), ...pickOut(['start', 'end', 'champion_role']) };
      const calls: { type: string; payload: any }[] = [];
      const t = pickOut(timing);
      const c = pickOut(candy);
      if (Object.keys(base).length || (!Object.keys(t).length && !Object.keys(c).length)) calls.push(...(await run('season', 'halloween', base)));
      if (Object.keys(t).length) calls.push(...(await run('season', 'halloween-timing', t)));
      if (Object.keys(c).length) calls.push(...(await run('season', 'halloween-candy', c)));
      return calls;
    }
    if (cmd === 'season' && sub === 'snowball') return run('season', 'snowball', { ...addChannel('snowball'), ...o });
    if (cmd === 'season' && sub === 'export') {
      const ev = getCurrentOrLatestEvent(this.bot.ctx, GUILD, o.game as Feature);
      return run('season', 'export', { season: ev?.id });
    }
    if (cmd === 'game' && sub === 'preview') {
      const { game, ...rest } = o;
      return run('season', `preview-${game}`, rest);
    }
    if (cmd === 'season' || cmd === 'game') return run('season', sub!, o);
    if (cmd === 'adjust') return run('player', sub === 'candy' ? 'candy' : sub!, o);
    if (cmd === 'player') return run('player', sub!, o);
    if (cmd === 'visitor') {
      if (o.visitor === '__placeholders__') o.visitor = 'placeholders';
      return run('visitor', sub!, o);
    }
    throw new Error(`unknown staff action ${key}`);
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
