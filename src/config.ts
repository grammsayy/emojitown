export interface AppConfig {
  token: string;
  clientId: string;
  databasePath: string;
  /** Register commands to a single server for instant updates during development. */
  devGuildId: string | null;
  tickIntervalMs: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. See README.md.`);
  return v;
}

export function loadConfig(): AppConfig {
  return {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    databasePath: process.env.DATABASE_PATH ?? './data/emojitown.db',
    devGuildId: process.env.DEV_GUILD_ID || null,
    tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 15_000),
  };
}
