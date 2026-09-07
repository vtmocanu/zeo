/**
 * The pure history vocabulary: the aggregated entry and per-visit row shapes,
 * the url rules that decide what may be recorded, the storage-key and
 * query-term normalizers, and the retention window. Electron-free and
 * store-free — the desktop SQLite layer and the suggest ranker both read these,
 * and the SQL itself lives in `apps/desktop`.
 */

/**
 * One aggregated history row: a recorded url with its most recent `title`, the
 * lifetime `visitCount`, and the `lastVisitedAt` timestamp (epoch ms) of its
 * newest visit.
 */
export interface HistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
}

/**
 * One recorded visit: its autoincrement `id`, the `url` and `title` captured
 * for that visit, and the `visitedAt` timestamp (epoch ms).
 */
export interface HistoryVisit {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
}

/** Upper bound on the length of a url that may be recorded in history. */
const MAX_HISTORY_URL_LENGTH = 2048;

/**
 * Whether `url` may be recorded in history: true only for `http:`/`https:`
 * urls with no `username` or `password` and a length of at most 2048
 * characters. An unparseable url is rejected.
 */
export function isHistoryUrl(url: string): boolean {
  if (url.length > MAX_HISTORY_URL_LENGTH) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  return true;
}

/**
 * The storage key for `url`: the url with only its `#fragment` removed. Query
 * strings are kept because they distinguish pages. An already-fragmentless url
 * is returned unchanged (modulo url parsing); an unparseable url is truncated
 * at the first `#` as a string fallback.
 */
export function historyKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const hashIndex = url.indexOf("#");
    return hashIndex === -1 ? url : url.slice(0, hashIndex);
  }
}

/** The search terms for `query`: lowercased, whitespace-split, empties dropped. */
export function historyTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
}

/** How long a visit is retained before pruning: 90 days, in milliseconds. */
export const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
