import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * Thin wrapper over Node's built-in SQLite (`node:sqlite`). It needs no native
 * compilation, so installs work on any machine with Node 22.13+.
 */
/** The statement surface the app uses. Parameters are validated by SQLite at run time. */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function wrap(stmt: StatementSync): Statement {
  return {
    run: (...params) => {
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: (...params) => stmt.get(...(params as never[])),
    all: (...params) => stmt.all(...(params as never[])),
  };
}

export class DB {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, Statement>();
  private depth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  /** Prepared statements are cached by SQL text. */
  prepare(sql: string): Statement {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = wrap(this.db.prepare(sql));
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT, rolling back if it throws. Not reentrant; nest via `tx()`. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  userVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  }

  /** Writes a consistent copy of the database to `path` (used by tests to simulate restarts). */
  copyTo(path: string): void {
    this.db.prepare('VACUUM INTO ?').run(path);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}

/**
 * Ordered schema migrations. Each entry runs once, tracked through
 * `PRAGMA user_version`. Never edit a released migration; append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE guild_config (
    guild_id TEXT PRIMARY KEY,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    timezone_set INTEGER NOT NULL DEFAULT 0,
    support_destination TEXT,
    setup_saved_at INTEGER,
    hw_spawn_min_s INTEGER NOT NULL DEFAULT 600,
    hw_spawn_max_s INTEGER NOT NULL DEFAULT 1200,
    hw_encounter_s INTEGER NOT NULL DEFAULT 90,
    hw_activity_window_s INTEGER NOT NULL DEFAULT 600,
    hw_weight_common INTEGER NOT NULL DEFAULT 70,
    hw_weight_uncommon INTEGER NOT NULL DEFAULT 25,
    hw_weight_rare INTEGER NOT NULL DEFAULT 5,
    candy_per_halloween_win INTEGER NOT NULL DEFAULT 5,
    candy_halloween_daily_limit INTEGER NOT NULL DEFAULT 100,
    champion_role_id TEXT,
    champion_end_policy TEXT NOT NULL DEFAULT 'keep',
    advent_door_count INTEGER NOT NULL DEFAULT 24,
    advent_unlock_time TEXT NOT NULL DEFAULT '09:00',
    advent_announce_time TEXT NOT NULL DEFAULT '09:00',
    advent_policy TEXT NOT NULL DEFAULT 'catch-up'
  );

  CREATE TABLE staff_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE feature_channels (
    guild_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, feature, channel_id)
  );

  CREATE TABLE events (
    guild_id TEXT NOT NULL,
    id TEXT NOT NULL,
    feature TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',
    start_local TEXT NOT NULL,
    end_local TEXT NOT NULL,
    claim_deadline_local TEXT,
    auto_activate INTEGER NOT NULL DEFAULT 0,
    content_version INTEGER,
    advent_published_at INTEGER,
    pause_reason TEXT,
    activated_at INTEGER,
    ended_at INTEGER,
    results_posted INTEGER NOT NULL DEFAULT 0,
    final_champion_id TEXT,
    champion_keep_role INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, id)
  );
  CREATE INDEX events_feature ON events (guild_id, feature, state);

  CREATE TABLE snowball_players (
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    snowballs INTEGER NOT NULL DEFAULT 0 CHECK (snowballs >= 0),
    hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
    misses INTEGER NOT NULL DEFAULT 0 CHECK (misses >= 0),
    kos_received INTEGER NOT NULL DEFAULT 0 CHECK (kos_received >= 0),
    collected INTEGER NOT NULL DEFAULT 0 CHECK (collected >= 0),
    next_collect_at INTEGER NOT NULL DEFAULT 0,
    warm_until INTEGER NOT NULL DEFAULT 0,
    hits_reached_at INTEGER,
    PRIMARY KEY (guild_id, event_id, user_id)
  );

  CREATE TABLE snowball_throws (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    thrower_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    hit INTEGER NOT NULL,
    message_index INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE member_prefs (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    snowball_opt_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE exclusions (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, feature)
  );

  CREATE TABLE departed_members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    departed_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE content_packs (
    guild_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    actor_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, feature, version)
  );

  CREATE TABLE hw_encounters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    visitor_id TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    closed_at INTEGER,
    close_reason TEXT,
    winner_id TEXT,
    item_id TEXT,
    rarity TEXT,
    duplicate INTEGER,
    candy_awarded INTEGER,
    message_synced INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX hw_encounters_open ON hw_encounters (guild_id, status);

  CREATE TABLE hw_attempts (
    encounter_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    correct INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (encounter_id, user_id)
  );

  CREATE TABLE hw_items (
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    first_at INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (guild_id, event_id, user_id, item_id)
  );

  CREATE TABLE hw_state (
    guild_id TEXT PRIMARY KEY,
    event_id TEXT,
    next_spawn_at INTEGER
  );

  CREATE TABLE channel_activity (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_human_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE hw_champion (
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    champion_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, event_id)
  );

  CREATE TABLE champion_role_state (
    guild_id TEXT PRIMARY KEY,
    holder_id TEXT,
    desired_id TEXT,
    pending INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    alerted INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE advent_doors (
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    image_url TEXT,
    link_url TEXT,
    trivia_answer TEXT,
    candy INTEGER NOT NULL DEFAULT 10 CHECK (candy >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, event_id, day)
  );

  CREATE TABLE advent_claims (
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    candy INTEGER NOT NULL,
    txn_id INTEGER,
    PRIMARY KEY (guild_id, event_id, user_id, day)
  );

  CREATE TABLE advent_posts (
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    channel_id TEXT,
    message_id TEXT,
    recovery INTEGER NOT NULL DEFAULT 0,
    posted_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, event_id, day)
  );

  CREATE TABLE candy_balances (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE candy_txns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    source TEXT NOT NULL,
    event_id TEXT,
    reason TEXT,
    actor_id TEXT,
    idem_key TEXT NOT NULL,
    local_day TEXT NOT NULL,
    balance_after INTEGER NOT NULL,
    reverses_id INTEGER,
    reversed_by_id INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (guild_id, idem_key)
  );
  CREATE INDEX candy_txns_user ON candy_txns (guild_id, user_id, id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    event_id TEXT,
    target_id TEXT,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_log_guild ON audit_log (guild_id, id);

  CREATE TABLE pending_actions (
    token TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
];

export function migrate(db: DB): void {
  for (let i = db.userVersion(); i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

export function openDatabase(path: string): DB {
  const db = new DB(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}
