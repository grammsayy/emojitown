/**
 * Minimal CSV support for spreadsheet round-trips (Google Sheets, Excel).
 * Handles quoted fields, embedded commas/quotes/newlines, a UTF-8 BOM, and
 * semicolon-separated files (Excel's default in many European locales).
 */

function quote(value: string): string {
  return /[",;\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Writes rows as CSV with a BOM so Excel detects UTF-8 (keeps emoji intact). */
export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => quote(r[h] ?? '')).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Parses CSV text into header-keyed rows. `line` is the 1-based spreadsheet row number. */
export function parseCsv(text: string): { headers: string[]; rows: { line: number; values: Record<string, string> }[] } {
  let src = text.replace(/^﻿/, '');
  if (/^sep=.\r?\n/i.test(src)) src = src.replace(/^sep=.\r?\n/i, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }

  const headers = (records.shift() ?? []).map((h) => h.trim().toLowerCase());
  const rows = records
    .map((values, idx) => ({ line: idx + 2, values: Object.fromEntries(headers.map((h, j) => [h, (values[j] ?? '').trim()])) }))
    .filter((r) => Object.values(r.values).some((v) => v !== ''));
  return { headers, rows };
}
