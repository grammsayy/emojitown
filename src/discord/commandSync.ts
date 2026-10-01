import { createHash } from 'node:crypto';
import type { Guild } from 'discord.js';
import { getCurrentEvent, type Feature } from '../domain/events.js';
import { commandsFor } from './commands.js';
import { alertStaff, type Bot } from './runtime.js';

const GAMES: Feature[] = ['halloween', 'snowball', 'advent'];

/** Games whose member commands should be visible: live or paused (paused commands explain the pause). */
export function liveGames(bot: Bot, guildId: string): Feature[] {
  return GAMES.filter((g) => {
    const ev = getCurrentEvent(bot.ctx, guildId, g);
    return ev?.state === 'active' || ev?.state === 'paused';
  });
}

interface Synced {
  key: string;
  names: string[];
}

const synced = new Map<string, Synced>();
const inFlight = new Map<string, Promise<CommandDiff | null>>();
const alerted = new Set<string>();

export interface CommandDiff {
  added: string[];
  removed: string[];
}

/**
 * Registers exactly the commands this server should have right now. Cheap to
 * call often: it only talks to Discord when the list actually changes.
 * Returns which member commands appeared or disappeared, or null if nothing changed.
 */
export function syncGuildCommands(bot: Bot, guild: Guild): Promise<CommandDiff | null> {
  const running = inFlight.get(guild.id);
  if (running) return running.then(() => syncGuildCommands(bot, guild));
  const p = doSync(bot, guild).finally(() => inFlight.delete(guild.id));
  inFlight.set(guild.id, p);
  return p;
}

async function doSync(bot: Bot, guild: Guild): Promise<CommandDiff | null> {
  const json = commandsFor(liveGames(bot, guild.id)).map((c) => c.toJSON());
  const key = createHash('sha1').update(JSON.stringify(json)).digest('hex');
  const previous = synced.get(guild.id);
  if (previous?.key === key) return null;
  try {
    await guild.commands.set(json);
  } catch (err) {
    console.error(`[${guild.id}] could not update slash commands`, err);
    if (!alerted.has(guild.id)) {
      alerted.add(guild.id);
      await alertStaff(
        bot,
        guild.id,
        'Could not update slash commands',
        'The bot could not change which commands members see. Re-invite it with the invite link (it needs the `applications.commands` permission), then restart it.',
      );
    }
    return null;
  }
  alerted.delete(guild.id);
  const names = json.map((c) => c.name).sort();
  // Before the first sync after a restart, compare against the always-visible commands.
  const before = previous?.names ?? commandsFor([]).map((c) => c.name).sort();
  synced.set(guild.id, { key, names });
  return { added: names.filter((n) => !before.includes(n)), removed: before.filter((n) => !names.includes(n)) };
}

/** A "what changed" line for command visibility, or null. */
export function describeDiff(diff: CommandDiff | null): string | null {
  if (!diff || (!diff.added.length && !diff.removed.length)) return null;
  const parts: string[] = [];
  if (diff.added.length) parts.push(`now showing ${diff.added.map((n) => `/${n}`).join(', ')}`);
  if (diff.removed.length) parts.push(`hidden ${diff.removed.map((n) => `/${n}`).join(', ')}`);
  return `**Member commands:** ${parts.join('; ')}`;
}

/** For tests: forget what was synced. */
export function resetCommandSync(): void {
  synced.clear();
  alerted.clear();
}
