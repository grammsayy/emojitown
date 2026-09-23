import { afterCommit, type AuditEntry, type Ctx } from './context.js';

export interface AuditInput {
  guildId: string;
  actorId: string;
  action: string;
  eventId?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Records a staff change. Call inside the same transaction as the change so the
 * record and the change commit together. The onAudit hook fires after commit.
 */
export function audit(ctx: Ctx, input: AuditInput): AuditEntry {
  const createdAt = ctx.now();
  const info = ctx.db
    .prepare(
      `INSERT INTO audit_log (guild_id, actor_id, action, event_id, target_id, before_json, after_json, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.guildId,
      input.actorId,
      input.action,
      input.eventId ?? null,
      input.targetId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason ?? null,
      createdAt,
    );
  const entry: AuditEntry = {
    id: Number(info.lastInsertRowid),
    guildId: input.guildId,
    actorId: input.actorId,
    action: input.action,
    eventId: input.eventId ?? null,
    targetId: input.targetId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    createdAt,
  };
  afterCommit(ctx, () => ctx.onAudit?.(entry));
  return entry;
}

interface AuditRow {
  id: number;
  guild_id: string;
  actor_id: string;
  action: string;
  event_id: string | null;
  target_id: string | null;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  created_at: number;
}

function fromRow(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    guildId: r.guild_id,
    actorId: r.actor_id,
    action: r.action,
    eventId: r.event_id,
    targetId: r.target_id,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

export function listAudit(
  ctx: Ctx,
  guildId: string,
  filter: { memberId?: string; eventId?: string; limit?: number; offset?: number } = {},
): AuditEntry[] {
  const where = ['guild_id = ?'];
  const args: unknown[] = [guildId];
  if (filter.memberId) {
    where.push('(target_id = ? OR actor_id = ?)');
    args.push(filter.memberId, filter.memberId);
  }
  if (filter.eventId) {
    where.push('event_id = ?');
    args.push(filter.eventId);
  }
  const rows = ctx.db
    .prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, filter.limit ?? 20, filter.offset ?? 0) as AuditRow[];
  return rows.map(fromRow);
}
