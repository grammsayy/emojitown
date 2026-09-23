export const PAGE_SIZE = 10;

export interface Ranked<T> {
  rank: number;
  row: T;
}

/**
 * Standard competition ranking: equal scores share a rank (1, 1, 3).
 * `rows` must already be sorted by score descending with a stable tiebreak.
 */
export function rankRows<T>(rows: T[], score: (row: T) => number): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  rows.forEach((row, i) => {
    const prev = out[i - 1];
    const rank = prev && score(prev.row) === score(row) ? prev.rank : i + 1;
    out.push({ rank, row });
  });
  return out;
}

export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

export function paginate<T>(rows: T[], page: number, size = PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { items: rows.slice((p - 1) * size, p * size), page: p, pages, total: rows.length };
}
