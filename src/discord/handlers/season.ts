import { ActionRowBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type Guild } from 'discord.js';
import { DateTime } from 'luxon';
import { listDoors } from '../../domain/advent.js';
import { audit, listAudit } from '../../domain/audit.js';
import { history } from '../../domain/candy.js';
import {
  addChannel,
  getChannel,
  getChannels,
  getConfig,
  getStaffRoles,
  missingSetup,
  removeChannel,
  setStaffRole,
  updateConfig,
  type ChannelFeature,
} from '../../domain/config.js';
import { consumePending, createPending } from '../../domain/confirmations.js';
import { getPack, importPack, latestVersion, parsePackJson, validatePack } from '../../domain/content.js';
import { tx } from '../../domain/context.js';
import { UserError } from '../../domain/errors.js';
import {
  createEvent,
  eventWindow,
  FEATURE_LABEL,
  FEATURES,
  listEvents,
  requireEvent,
  scheduleEvent,
  windowFor,
  type Feature,
  type SeasonEvent,
} from '../../domain/events.js';
import { checkEvent, endEvent, pauseEvent, resumeEvent, startEvent } from '../../domain/lifecycle.js';
import { exclude, include, type ExclusionScope } from '../../domain/members.js';
import type { ContentFeature, HalloweenPack, SnowballPack } from '../../content/types.js';
import { isValidZone } from '../../util/time.js';
import { askConfirm, reply, type ChatInput, type Component, type HandlerSet, type Modal } from '../interaction.js';
import { discordChecks, featureChannelIds, postResults } from '../results.js';
import { assertLevel, assertSafeStaffRole, isAdmin, syncChampionRole, type Bot } from '../runtime.js';
import { cid, COLORS, embed, field, truncate, when } from '../ui.js';
import { syncEncounterMessage } from './halloween.js';
import { policyText } from './advent.js';

const STATE_ICON: Record<SeasonEvent['state'], string> = { draft: '📝', scheduled: '🗓️', active: '🟢', paused: '⏸️', ended: '🏁' };

function eventLine(bot: Bot, ev: SeasonEvent): string {
  const win = windowFor(bot.ctx, ev);
  return `${STATE_ICON[ev.state]} **${ev.name}** \`${ev.id}\` · ${ev.state}${ev.autoActivate && ev.state === 'scheduled' ? ' (auto-start)' : ''}\n  ${when(win.startsAt)} → ${when(win.endsAt)}`;
}

async function status(bot: Bot, i: ChatInput) {
  const cfg = getConfig(bot.ctx, i.guildId);
  const e = embed(COLORS.brand, '🗓️ emojitown seasons', `Timezone: **${cfg.timezone}**`);
  for (const f of FEATURES) {
    const events = listEvents(bot.ctx, i.guildId, f).filter((ev) => ev.state !== 'ended' && ev.state !== 'draft');
    const channels = featureChannelIds(bot, i.guildId, f).map((c) => `<#${c}>`).join(', ');
    e.addFields(field(FEATURE_LABEL[f], `${events.map((ev) => eventLine(bot, ev)).join('\n') || 'Nothing scheduled.'}\nChannels: ${channels || 'none'}`));
  }
  await reply(i, { embeds: [e] });
}

function missingEmbed(bot: Bot, guildId: string) {
  const missing = missingSetup(bot.ctx, guildId);
  return field('Remaining setup', missing.length ? missing.map((m) => `• ${m}`).join('\n') : 'All basic setup is done ✅. Next: create events with `/admin event create`.');
}

async function setup(bot: Bot, i: ChatInput) {
  const zone = i.options.getString('timezone');
  if (zone && !isValidZone(zone)) throw new UserError(`\`${zone}\` isn't a valid IANA timezone. Try something like Europe/Copenhagen.`);
  const support = i.options.getString('support');
  const logs = i.options.getChannel('log_channel');
  const role = i.options.getRole('event_manager_role');
  if (role) assertSafeStaffRole(i.guild, role);
  tx(bot.ctx, () => {
    const change = updateConfig(bot.ctx, i.guildId, {
      timezone: zone ?? undefined,
      supportDestination: support ?? undefined,
      setupSavedAt: bot.ctx.now(),
    });
    if (logs) addChannel(bot.ctx, i.guildId, 'logs', logs.id);
    if (role) setStaffRole(bot.ctx, i.guildId, role.id, true);
    audit(bot.ctx, {
      guildId: i.guildId,
      actorId: i.user.id,
      action: 'season.setup',
      before: change.before,
      after: { ...change.after, ...(logs ? { logChannel: logs.id } : {}), ...(role ? { staffRole: role.id } : {}) },
    });
  });
  const cfg = getConfig(bot.ctx, i.guildId);
  const e = embed(COLORS.staff, '⚙️ emojitown setup saved').addFields(
    field('Timezone', cfg.timezoneSet ? cfg.timezone : 'Not set (UTC)', true),
    field('Support', cfg.supportDestination ?? 'Not set', true),
    field('Log channel', getChannel(bot.ctx, i.guildId, 'logs') ? `<#${getChannel(bot.ctx, i.guildId, 'logs')}>` : 'Not set', true),
    field('Event Manager roles', getStaffRoles(bot.ctx, i.guildId).map((r) => `<@&${r}>`).join(', ') || 'None', true),
    missingEmbed(bot, i.guildId),
  );
  await reply(i, { embeds: [e] });
}

async function config(bot: Bot, i: ChatInput) {
  const cfg = getConfig(bot.ctx, i.guildId);
  const chans = (f: ChannelFeature) => getChannels(bot.ctx, i.guildId, f).map((c) => `<#${c}>`).join(', ') || 'none';
  const events = listEvents(bot.ctx, i.guildId).filter((e) => e.state !== 'ended');
  const e = embed(COLORS.staff, '⚙️ emojitown configuration').addFields(
    field('Timezone', `${cfg.timezone}${cfg.timezoneSet ? '' : ' (default)'}`, true),
    field('Support', cfg.supportDestination ?? 'Not set', true),
    field('Event Manager roles', getStaffRoles(bot.ctx, i.guildId).map((r) => `<@&${r}>`).join(', ') || 'None', true),
    field('Channels', `❄️ ${chans('snowball')}\n🎃 ${chans('halloween')}\n🎄 ${chans('advent')}\n📋 logs: ${chans('logs')}`),
    field(
      'Trick or Treat',
      `Every ${cfg.hwSpawnMinS / 60}–${cfg.hwSpawnMaxS / 60} min · stays ${cfg.hwEncounterS}s · activity window ${cfg.hwActivityWindowS / 60} min\n` +
        `Rarity weights ${cfg.hwWeightCommon}/${cfg.hwWeightUncommon}/${cfg.hwWeightRare} · Champion role ${cfg.championRoleId ? `<@&${cfg.championRoleId}>` : 'none'} (${cfg.championEndPolicy} at end)`,
    ),
    field('Candy', `Halloween ${cfg.candyPerHalloweenWin} per win, daily limit ${cfg.candyHalloweenDailyLimit} · Advent per door`),
    field('Advent', `${cfg.adventDoorCount} doors · unlock ${cfg.adventUnlockTime} · announce ${cfg.adventAnnounceTime} · ${cfg.adventPolicy}`),
    field('Content', `Snowball pack v${latestVersion(bot.ctx, i.guildId, 'snowball')} · Halloween pack v${latestVersion(bot.ctx, i.guildId, 'halloween')} (v0 = built-in placeholder)`),
    field('Open events', events.map((ev) => eventLine(bot, ev)).join('\n') || 'None'),
    missingEmbed(bot, i.guildId),
  );
  await reply(i, { embeds: [e] });
}

async function timezone(bot: Bot, i: ChatInput) {
  const zone = i.options.getString('zone', true);
  if (!isValidZone(zone)) throw new UserError(`\`${zone}\` isn't a valid IANA timezone. Try something like Europe/Copenhagen.`);
  const cfg = getConfig(bot.ctx, i.guildId);
  if (cfg.timezone === zone && cfg.timezoneSet) throw new UserError(`The timezone is already ${zone}.`);
  const changes = listEvents(bot.ctx, i.guildId)
    .filter((ev) => ev.state !== 'ended')
    .map((ev) => {
      const a = eventWindow(ev, cfg.timezone);
      const b = eventWindow(ev, zone);
      return `**${ev.name}**: starts ${when(a.startsAt)} → ${when(b.startsAt)}`;
    });
  await askConfirm(
    bot,
    i,
    'season.timezone',
    { zone },
    embed(COLORS.warn, `Change the timezone from ${cfg.timezone} to ${zone}?`, 'Event dates, Advent unlock times and daily candy limits follow the server timezone.').addFields(
      field('Schedule changes', changes.join('\n') || 'No upcoming events are affected.'),
    ),
  );
}

async function channel(bot: Bot, i: ChatInput) {
  const feature = i.options.getString('feature', true) as ChannelFeature;
  const action = i.options.getString('action', true);
  const ch = i.options.getChannel('channel');
  if (action !== 'list') {
    if (!ch) throw new UserError('Pick a `channel` to add or remove.');
    tx(bot.ctx, () => {
      if (action === 'add') {
        const previous = addChannel(bot.ctx, i.guildId, feature, ch.id);
        audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'channel.add', before: { feature, channels: previous }, after: { feature, channels: getChannels(bot.ctx, i.guildId, feature) } });
      } else {
        removeChannel(bot.ctx, i.guildId, feature, ch.id);
        audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'channel.remove', before: { feature, channel: ch.id }, after: { feature, channels: getChannels(bot.ctx, i.guildId, feature) } });
      }
    });
  }
  const list = getChannels(bot.ctx, i.guildId, feature);
  await reply(i, `${feature === 'logs' ? 'Staff log' : FEATURE_LABEL[feature]} channel${list.length === 1 ? '' : 's'}: ${list.map((c) => `<#${c}>`).join(', ') || 'none'}`);
}

async function staff(bot: Bot, i: ChatInput) {
  const role = i.options.getRole('role', true);
  const grant = i.options.getString('action', true) === 'grant';
  if (grant) assertSafeStaffRole(i.guild, role);
  if (grant && role.id === getConfig(bot.ctx, i.guildId).championRoleId) throw new UserError('That is the Halloween Champion role. Pick a staff role.');
  tx(bot.ctx, () => {
    if (!setStaffRole(bot.ctx, i.guildId, role.id, grant)) throw new UserError(grant ? `${role} already has Event Manager access.` : `${role} doesn't have Event Manager access.`);
    audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: grant ? 'staff.grant' : 'staff.remove', after: { role: role.id } });
  });
  await reply(
    i,
    `${grant ? 'Granted' : 'Removed'} Event Manager access for ${role}.` +
      (grant ? '\nSo they can see `/staff`, add this role under **Server Settings → Integrations → emojitown → /staff**.' : ''),
  );
}

async function support(bot: Bot, i: ChatInput) {
  const destination = i.options.getString('destination', true);
  tx(bot.ctx, () => {
    const change = updateConfig(bot.ctx, i.guildId, { supportDestination: destination });
    audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'season.support', ...change });
  });
  await reply(i, `\`/support\` now shows: ${destination}`);
}

async function eventCreate(bot: Bot, i: ChatInput) {
  const ev = createEvent(bot.ctx, i.guildId, i.options.getString('feature', true) as Feature, i.options.getString('name', true), i.user.id);
  const win = windowFor(bot.ctx, ev);
  await reply(i, {
    embeds: [
      embed(COLORS.staff, `📝 Created draft event \`${ev.id}\``, `${FEATURE_LABEL[ev.feature]}: **${ev.name}**`).addFields(
        field('Default dates', `${when(win.startsAt)} → ${when(win.endsAt)}`),
        field('Next', `Adjust dates with \`/admin event schedule event:${ev.id}\`, check it with \`/admin season check\`, then start it or let it auto-start.`),
      ),
    ],
  });
}

async function eventSchedule(bot: Bot, i: ChatInput) {
  const ev = requireEvent(bot.ctx, i.guildId, i.options.getString('event', true));
  if (ev.state === 'ended') throw new UserError('Ended events are frozen and cannot be rescheduled.');
  const token = createPending(bot.ctx, i.guildId, i.user.id, 'season.schedule', { eventId: ev.id });
  const endDate = DateTime.fromISO(ev.endLocal).minus({ days: 1 }).toISODate()!;
  const input = (id: string, label: string, value: string, required = true, placeholder?: string) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setValue(value).setMaxLength(16);
    if (placeholder) t.setPlaceholder(placeholder);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
  };
  const modal = new ModalBuilder()
    .setCustomId(cid('schedule', token))
    .setTitle(truncate(`Schedule ${ev.name}`, 45))
    .addComponents(
      input('start', 'Start date (YYYY-MM-DD)', ev.startLocal.slice(0, 10)),
      input('end', 'End date, inclusive (YYYY-MM-DD)', endDate),
      input('auto', 'Start automatically? (yes/no)', ev.autoActivate || ev.state === 'draft' ? 'yes' : 'no'),
    );
  if (ev.feature === 'advent') {
    modal.addComponents(input('deadline', 'Claim deadline (YYYY-MM-DD HH:MM)', (ev.claimDeadlineLocal ?? ev.endLocal).replace('T', ' '), false));
  }
  await i.showModal(modal);
}

async function scheduleSubmit(bot: Bot, i: Component, [token]: string[]) {
  if (!i.isModalSubmit()) return;
  const m = i as Modal;
  assertLevel(bot, m.member, 'admin');
  const { payload } = consumePending<{ eventId: string }>(bot.ctx, m.guildId, m.user.id, token!);
  const auto = m.fields.getTextInputValue('auto').trim().toLowerCase();
  if (!['yes', 'no', 'y', 'n'].includes(auto)) throw new UserError('Answer "yes" or "no" for automatic start.');
  const ev = requireEvent(bot.ctx, m.guildId, payload.eventId);
  const updated = scheduleEvent(
    bot.ctx,
    m.guildId,
    payload.eventId,
    {
      startDate: m.fields.getTextInputValue('start'),
      endDate: m.fields.getTextInputValue('end'),
      autoActivate: auto.startsWith('y'),
      claimDeadline: ev.feature === 'advent' ? m.fields.getTextInputValue('deadline') : null,
    },
    m.user.id,
  );
  const win = windowFor(bot.ctx, updated);
  const e = embed(COLORS.staff, `🗓️ ${updated.name} scheduled`, `State: **${updated.state}**${updated.autoActivate ? ' (starts automatically)' : ''}`).addFields(
    field('Dates', `${when(win.startsAt)} → ${when(win.endsAt)}`),
  );
  if (win.claimDeadline) e.addFields(field('Claim deadline', when(win.claimDeadline)));
  await reply(m, { embeds: [e] });
}

async function eventStart(bot: Bot, i: ChatInput) {
  const eventId = i.options.getString('event', true);
  const ev = requireEvent(bot.ctx, i.guildId, eventId);
  const discord = await discordChecks(bot, i.guild, ev.feature);
  const started = startEvent(bot.ctx, i.guildId, eventId, i.user.id, discord.errors);
  if (started.feature === 'halloween') void syncChampionRole(bot, i.guildId);
  const win = windowFor(bot.ctx, started);
  await reply(i, `🟢 **${started.name}** is now active until ${when(win.endsAt)}.${discord.warnings.length ? `\n\n⚠️ ${discord.warnings.join('\n⚠️ ')}` : ''}`);
}

async function eventEnd(bot: Bot, i: ChatInput) {
  const ev = requireEvent(bot.ctx, i.guildId, i.options.getString('event', true));
  if (ev.state === 'ended') throw new UserError('This event has already ended.');
  const cfg = getConfig(bot.ctx, i.guildId);
  const effects = ['New gameplay stops and results are frozen.', 'Results are posted once, and stay viewable in the archive.'];
  if (ev.feature === 'halloween') {
    effects.push('Any open visitor leaves without rewards.');
    effects.push(
      cfg.championEndPolicy === 'keep'
        ? 'The final Champion keeps the role until the next Halloween event starts.'
        : 'The Champion role is removed now (change with `/admin halloween champion`).',
    );
  }
  if (ev.feature === 'advent') effects.push('Doors can no longer be claimed; released content stays readable.');
  await askConfirm(bot, i, 'season.end', { eventId: ev.id }, embed(COLORS.warn, `End ${ev.name}?`, effects.map((e) => `• ${e}`).join('\n')));
}

async function eventPause(bot: Bot, i: ChatInput) {
  const { event, closed } = pauseEvent(bot.ctx, i.guildId, i.options.getString('event', true), i.options.getString('reason', true), i.user.id);
  for (const enc of closed) await syncEncounterMessage(bot, i.guild, enc);
  await reply(i, `⏸️ **${event.name}** is paused. Progress is kept; new gameplay and scheduled posts are stopped.`);
}

async function eventResume(bot: Bot, i: ChatInput) {
  const ev = resumeEvent(bot.ctx, i.guildId, i.options.getString('event', true), i.user.id);
  await reply(i, `▶️ **${ev.name}** has resumed.${ev.feature === 'halloween' ? ' Missed visitors are not replayed; the next one arrives after a normal wait.' : ''}`);
}

function announcementEmbed(bot: Bot, ev: SeasonEvent) {
  const win = windowFor(bot.ctx, ev);
  const channels = featureChannelIds(bot, ev.guildId, ev.feature).map((c) => `<#${c}>`).join(', ') || '—';
  const how: Record<Feature, string> = {
    snowball: 'Use `/collect` to make a snowball (one every 30 seconds), then `/throw target:@friend`. Half of all throws hit! Getting hit means a 2-minute warm-up before you can collect again, but you can still throw snowballs you already have. Check `/stats` and `/leaderboard`. Prefer not to play? `/snowball participation state:off`.',
    halloween: 'Keep chatting in the Halloween channels and emojitown visitors will drop by. Each one asks for a **Trick** or a **Treat**; the first correct answer wins a collectible and candy. Wrong answers use up your try for that visitor. Collect all items and chase the Champion role! See `/halloween inventory` and `/halloween leaderboard`.',
    advent: 'A new door opens every day. Press **Open Door** or use `/advent open` for a surprise and candy. `/advent calendar` shows every door.',
  };
  const e = embed(COLORS.brand, `✨ ${ev.name} is ${ev.state === 'active' ? 'on' : 'coming'}!`, how[ev.feature]).addFields(
    field('When', `${when(win.startsAt)} → ${when(win.endsAt)}`),
    field('Where', channels),
  );
  if (ev.feature === 'advent') e.addFields(field('Catch-up', policyText(getConfig(bot.ctx, ev.guildId).adventPolicy, win.claimDeadline)));
  e.addFields(field('Questions?', '`/help` explains everything. `/support` shows where to ask.'));
  return e;
}

async function announce(bot: Bot, i: ChatInput) {
  const ev = requireEvent(bot.ctx, i.guildId, i.options.getString('event', true));
  const target = i.options.getChannel('channel', true);
  const preview = announcementEmbed(bot, ev);
  await askConfirm(bot, i, 'season.announce', { eventId: ev.id, channelId: target.id }, preview.setAuthor({ name: `Preview · will be posted in #${target.name}` }));
}

async function check(bot: Bot, i: ChatInput) {
  const eventId = i.options.getString('event');
  const events = eventId ? [requireEvent(bot.ctx, i.guildId, eventId)] : listEvents(bot.ctx, i.guildId).filter((e) => e.state !== 'ended');
  const e = embed(COLORS.staff, '🩺 Readiness check');
  const missing = missingSetup(bot.ctx, i.guildId);
  if (missing.length) e.addFields(field('Setup', missing.map((m) => `• ${m}`).join('\n')));
  if (events.length === 0) {
    const d = await discordChecks(bot, i.guild, null);
    e.addFields(field('Discord', [...d.errors.map((x) => `❌ ${x}`), ...d.warnings.map((x) => `⚠️ ${x}`)].join('\n') || '✅ Channels and permissions look good.'));
  }
  for (const ev of events.slice(0, 10)) {
    const r = checkEvent(bot.ctx, i.guildId, ev.id);
    const d = await discordChecks(bot, i.guild, ev.feature);
    const errors = [...r.errors, ...d.errors];
    const warnings = [...r.warnings, ...d.warnings];
    e.addFields(
      field(
        `${errors.length ? '❌' : '✅'} ${ev.name} (${ev.state})`,
        [...errors.map((x) => `❌ ${x}`), ...warnings.map((x) => `⚠️ ${x}`)].join('\n') || 'Ready.',
      ),
    );
  }
  await reply(i, { embeds: [e] });
}

async function exportEvent(bot: Bot, i: ChatInput) {
  const ev = requireEvent(bot.ctx, i.guildId, i.options.getString('event', true));
  const db = bot.ctx.db;
  const q = (sql: string) => db.prepare(sql).all(i.guildId, ev.id);
  const data = {
    exportedAt: new Date(bot.ctx.now()).toISOString(),
    guildId: i.guildId,
    config: getConfig(bot.ctx, i.guildId),
    event: ev,
    snowball: ev.feature === 'snowball' ? { players: q('SELECT * FROM snowball_players WHERE guild_id = ? AND event_id = ?'), throws: q('SELECT * FROM snowball_throws WHERE guild_id = ? AND event_id = ?') } : undefined,
    halloween:
      ev.feature === 'halloween'
        ? {
            contentVersion: ev.contentVersion,
            items: q('SELECT * FROM hw_items WHERE guild_id = ? AND event_id = ?'),
            encounters: q('SELECT * FROM hw_encounters WHERE guild_id = ? AND event_id = ?'),
            champion: q('SELECT * FROM hw_champion WHERE guild_id = ? AND event_id = ?'),
          }
        : undefined,
    advent: ev.feature === 'advent' ? { doors: listDoors(bot.ctx, i.guildId, ev.id), claims: q('SELECT * FROM advent_claims WHERE guild_id = ? AND event_id = ?') } : undefined,
    candyTransactions: q('SELECT * FROM candy_txns WHERE guild_id = ? AND event_id = ?'),
    audit: q('SELECT * FROM audit_log WHERE guild_id = ? AND event_id = ?'),
  };
  audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'season.export', eventId: ev.id });
  const file = new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2)), { name: `${ev.id}-export.json` });
  await reply(i, { content: `Export for \`${ev.id}\` (staff only, handle with care):`, files: [file] });
}

async function auditCmd(bot: Bot, i: ChatInput) {
  const member = i.options.getUser('member');
  const eventId = i.options.getString('event');
  const entries = listAudit(bot.ctx, i.guildId, { memberId: member?.id, eventId: eventId ?? undefined, limit: 15 });
  const lines = entries.map(
    (a) =>
      `\`#${a.id}\` <t:${Math.floor(a.createdAt / 1000)}:g> **${a.action}** by ${a.actorId === 'system' ? 'system' : `<@${a.actorId}>`}${a.targetId ? ` → <@${a.targetId}>` : ''}${a.eventId ? ` \`${a.eventId}\`` : ''}${a.reason ? ` · ${truncate(a.reason, 60)}` : ''}`,
  );
  const e = embed(COLORS.staff, '📋 Audit log', lines.join('\n') || 'No matching staff changes.');
  if (member) {
    const h = history(bot.ctx, i.guildId, member.id, 1, eventId);
    e.addFields(
      field(
        `Recent rewards for ${member.displayName}`,
        h.items.map((t) => `\`#${t.id}\` ${t.amount > 0 ? '+' : ''}${t.amount} ${t.source}${t.eventId ? ` \`${t.eventId}\`` : ''} → ${t.balanceAfter}`).join('\n') || 'None',
      ),
    );
  }
  await reply(i, { embeds: [e] });
}

async function excludeCmd(bot: Bot, i: ChatInput, on: boolean) {
  const member = i.options.getUser('member', true);
  const scope = i.options.getString('feature', true) as ExclusionScope;
  const reason = i.options.getString('reason', true);
  const changed = on ? exclude(bot.ctx, i.guildId, member.id, scope, reason, i.user.id) : include(bot.ctx, i.guildId, member.id, scope, reason, i.user.id);
  if (changed.includes('halloween')) void syncChampionRole(bot, i.guildId);
  await reply(
    i,
    on
      ? `${member} is excluded from ${changed.map((f) => FEATURE_LABEL[f]).join(', ')}. Their records are kept; candy is unchanged (use \`/admin candy adjust\` if needed).`
      : `${member} can take part in ${changed.map((f) => FEATURE_LABEL[f]).join(', ')} again. Standings were recalculated.`,
  );
}

const ATTACHMENT_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

async function fetchAttachmentJson(url: string): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ATTACHMENT_HOSTS.includes(u.hostname)) throw new UserError('Attach the file directly to the command.');
  const res = await fetch(u, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!res.ok) throw new UserError(`Could not download the file (HTTP ${res.status}).`);
  return parsePackJson(await res.text());
}

async function content(bot: Bot, i: ChatInput) {
  const feature = i.options.getString('feature', true) as ContentFeature;
  const action = i.options.getString('action', true);
  const file = i.options.getAttachment('file');
  if ((action === 'import' || action === 'export') && !isAdmin(i.member)) throw new UserError('Only server administrators can import or export content.');
  if (file && file.size > 2_000_000) throw new UserError('Content packs are limited to 2 MB.');

  if (action === 'import') {
    if (!file) throw new UserError('Attach the content pack JSON with the `file` option.');
    const data = await fetchAttachmentJson(file.url);
    const r = tx(bot.ctx, () => {
      const result = importPack(bot.ctx, i.guildId, feature, data, i.user.id);
      if (result.version !== null) audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'content.import', after: { feature, version: result.version } });
      return result;
    });
    if (r.version === null) {
      await reply(i, { embeds: [embed(COLORS.error, 'Import rejected', `Nothing was changed.\n• ${r.errors.slice(0, 25).join('\n• ')}`)] });
      return;
    }
    await reply(i, {
      embeds: [
        embed(COLORS.hit, `Imported ${feature} pack v${r.version}`, 'New events use this version. Running events keep the version they started with.').addFields(
          field('Warnings', r.warnings.slice(0, 10).join('\n') || 'None'),
        ),
      ],
    });
    return;
  }
  if (action === 'validate') {
    const data = file ? await fetchAttachmentJson(file.url) : getPack(bot.ctx, i.guildId, feature);
    const r = validatePack(feature, data);
    await reply(i, {
      embeds: [
        embed(r.errors.length ? COLORS.error : COLORS.hit, r.errors.length ? `${r.errors.length} error(s)` : 'Pack is valid ✅', file ? `File: ${file.name}` : 'Current pack').addFields(
          field('Errors', r.errors.slice(0, 20).join('\n') || 'None'),
          field('Warnings', r.warnings.slice(0, 10).join('\n') || 'None'),
        ),
      ],
    });
    return;
  }
  if (action === 'export') {
    const pack = getPack(bot.ctx, i.guildId, feature);
    const version = latestVersion(bot.ctx, i.guildId, feature);
    await reply(i, { content: `${feature} pack v${version}:`, files: [new AttachmentBuilder(Buffer.from(JSON.stringify(pack, null, 2)), { name: `${feature}-pack-v${version}.json` })] });
    return;
  }
  // preview
  const pack = getPack(bot.ctx, i.guildId, feature);
  if (feature === 'snowball') {
    const p = pack as SnowballPack;
    await reply(i, {
      embeds: [
        embed(COLORS.snow, 'Snowball pack preview').addFields(
          field('Hit messages', p.hit.map((m) => `• ${m}`).join('\n')),
          field('Miss messages', p.miss.map((m) => `• ${m}`).join('\n')),
          field('Artwork', Object.entries(p.images).map(([k, v]) => `${k}: ${v}`).join('\n') || 'None (text only)'),
        ),
      ],
    });
  } else {
    const p = pack as HalloweenPack;
    await reply(i, {
      embeds: [
        embed(COLORS.halloween, 'Halloween pack preview', `${p.visitors.length} visitors · ${p.visitors.reduce((n, v) => n + v.items.length, 0)} items`).addFields(
          field('Visitors', truncate(p.visitors.map((v) => `${v.name}: ${v.items.map((it) => it.name).join(', ')}`).join('\n'), 1024)),
          field('Request text', `${p.messages.trickRequest}\n${p.messages.treatRequest}`),
        ),
      ],
    });
  }
}

export async function finishEnd(bot: Bot, guild: Guild, eventId: string, actorId: string): Promise<SeasonEvent> {
  const { event, closed } = endEvent(bot.ctx, guild.id, eventId, actorId);
  for (const enc of closed) await syncEncounterMessage(bot, guild, enc);
  if (event.feature === 'halloween') void syncChampionRole(bot, guild.id);
  await postResults(bot, guild, event);
  return event;
}

export const seasonHandlers: HandlerSet = {
  chat: {
    'season status': status,
    'admin season setup': setup,
    'admin season config': config,
    'admin season timezone': timezone,
    'admin season channel': channel,
    'admin season staff': staff,
    'admin season support': support,
    'admin event create': eventCreate,
    'admin event schedule': eventSchedule,
    'admin event start': eventStart,
    'admin event end': eventEnd,
    'staff event pause': eventPause,
    'staff event resume': eventResume,
    'admin season announce': announce,
    'admin season check': check,
    'admin season export': exportEvent,
    'admin season audit': auditCmd,
    'staff member exclude': (bot, i) => excludeCmd(bot, i, true),
    'staff member include': (bot, i) => excludeCmd(bot, i, false),
    'admin season content': content,
    'staff content': content,
  },
  components: {
    schedule: scheduleSubmit,
  },
  confirms: {
    'season.timezone': {
      level: 'admin',
      run: async (bot, i, { zone }: { zone: string }) => {
        tx(bot.ctx, () => {
          const change = updateConfig(bot.ctx, i.guildId, { timezone: zone });
          audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'season.timezone', ...change });
        });
        return `Timezone set to **${zone}**.`;
      },
    },
    'season.end': {
      level: 'admin',
      run: async (bot, i, { eventId }: { eventId: string }) => {
        const ev = await finishEnd(bot, i.guild, eventId, i.user.id);
        return `🏁 **${ev.name}** has ended and its results were posted.`;
      },
    },
    'season.announce': {
      level: 'admin',
      run: async (bot, i, { eventId, channelId }: { eventId: string; channelId: string }) => {
        const ev = requireEvent(bot.ctx, i.guildId, eventId);
        const channel = await i.guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) throw new UserError('That channel is no longer available.');
        const msg = await channel.send({ embeds: [announcementEmbed(bot, ev)], allowedMentions: { parse: [] } });
        audit(bot.ctx, { guildId: i.guildId, actorId: i.user.id, action: 'season.announce', eventId, after: { channel: channelId, message: msg.id } });
        return `Posted: ${msg.url}`;
      },
    },
  },
};

