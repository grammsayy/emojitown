import { DateTime } from 'luxon';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** True when `zone` is a valid IANA timezone name, such as Europe/Copenhagen. */
export function isValidZone(zone: string): boolean {
  return DateTime.now().setZone(zone).isValid && (zone.includes('/') || zone === 'UTC');
}

/** Converts a local `YYYY-MM-DDTHH:mm` string in `zone` to epoch milliseconds. */
export function localToMs(local: string, zone: string): number {
  const dt = DateTime.fromISO(local, { zone });
  if (!dt.isValid) throw new Error(`Invalid local date/time: ${local}`);
  return dt.toMillis();
}

export function msToLocalDate(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toISODate()!;
}

export function formatLocal(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("yyyy-LL-dd HH:mm");
}

/** Parses a `YYYY-MM-DD` date. Returns null when the date is invalid. */
export function parseDate(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const dt = DateTime.fromISO(trimmed);
  return dt.isValid ? trimmed : null;
}

/** Parses a `HH:mm` time. Returns null when invalid. */
export function parseTime(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date).plus({ days }).toISODate()!;
}

/** Discord timestamp markup, rendered in each viewer's own locale. */
export function discordTime(ms: number, style: 'f' | 'F' | 'R' | 'd' | 't' = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} second${s === 1 ? '' : 's'}`;
  if (s === 0) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${m}m ${s}s`;
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/**
 * Parses a duration such as `30s`, `5m`, `2h`, `1d`, `1w` or combinations like
 * `1h30m` into seconds. A bare number uses `defaultUnit`. Returns null if invalid.
 */
export function parseDuration(value: string, defaultUnit: keyof typeof UNIT_SECONDS = 'm'): number | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * UNIT_SECONDS[defaultUnit]!);
  const re = /(\d+(?:\.\d+)?)([smhdw])/g;
  let total = 0;
  let consumed = 0;
  for (const m of v.matchAll(re)) {
    total += Number(m[1]) * UNIT_SECONDS[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed !== v.length || total <= 0) return null;
  return Math.round(total);
}

/** Formats seconds compactly, e.g. 90 → "1m 30s", 7200 → "2h". */
export function formatSeconds(total: number): string {
  const parts: string[] = [];
  let rest = Math.round(total);
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.join(' ') || '0s';
}
