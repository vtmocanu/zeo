import { ipcMain } from "electron";
import { IPC, isHistoryUrl, historyKey, titleForUrl, historyTerms } from "@zeo/core";
import type { HistoryEntry, HistoryVisit } from "@zeo/core";
import {
  recordVisit,
  searchHistory,
  recentVisits,
  deleteHistoryUrl,
  clearHistory,
  historyStats,
  pruneHistory,
} from "./db.js";
import { runtime } from "./state.js";

/**
 * Logs a history database error once per launch and swallows it thereafter, so a
 * failing history write never breaks navigation or the command bar.
 */
export function logHistoryError(err: unknown): void {
  if (!runtime.historyErrorLogged) {
    runtime.historyErrorLogged = true;
    console.error("[history] database error; history recording disabled for this launch:", err);
  }
}

/**
 * Records a top-level history visit for tab `id` from its view's LIVE url (PRD
 * 6.1 §3). Called by the tab's `did-navigate` (after clearing `hasRealTitle`) and
 * `did-navigate-in-page` listeners. Reads `webContents.getURL()` live; when the
 * url is not a history url (about:blank, data:, …) it clears the tab's
 * `lastHistoryKey`, `lastVisitId` and `hasRealTitle` so a later return to a
 * recorded url is a fresh visit, then returns. Otherwise it computes the
 * `historyKey` and skips when it equals the tab's last recorded key (hash /
 * pushState churn records once). A new key records a visit — the live document
 * title when the tab has emitted its own (`hasRealTitle`), else `titleForUrl` —
 * and stores the returned visit id and key together. A database error is logged
 * once and never breaks navigation.
 */
export function recordNavigation(id: string): void {
  const webContents = runtime.views.get(id)?.webContents;
  if (webContents === undefined) {
    return;
  }
  const current = webContents.getURL(); // read live, never a captured value
  if (!isHistoryUrl(current)) {
    runtime.lastHistoryKey.delete(id);
    runtime.lastVisitId.delete(id);
    runtime.hasRealTitle.delete(id);
    return;
  }
  const key = historyKey(current);
  if (key === runtime.lastHistoryKey.get(id)) {
    return;
  }
  const currentTitle = runtime.hasRealTitle.has(id) ? webContents.getTitle() : titleForUrl(key);
  try {
    const visitId = recordVisit(key, currentTitle, Date.now());
    // Set both together so the tab's recorded key and visit id are always the
    // pair produced by this one navigation.
    runtime.lastVisitId.set(id, visitId);
    runtime.lastHistoryKey.set(id, key);
  } catch (err) {
    logHistoryError(err);
  }
}

/**
 * Drops the per-tab history record cache (`lastHistoryKey` + `lastVisitId`) for
 * every open tab whose last-recorded key is one of `keys`. Called after a stored
 * history row is removed out of band (a url delete or a prune) so a later
 * same-key navigation records a fresh visit instead of short-circuiting the
 * key-equality check in {@link recordNavigation}. `hasRealTitle` is intentionally
 * left intact — the live document's title flag is still valid.
 */
export function invalidateHistoryKeys(keys: Iterable<string>): void {
  const removed = keys instanceof Set ? keys : new Set(keys);
  if (removed.size === 0) {
    return;
  }
  for (const [id, key] of runtime.lastHistoryKey) {
    if (removed.has(key)) {
      runtime.lastHistoryKey.delete(id);
      runtime.lastVisitId.delete(id);
    }
  }
}

/**
 * Drops EVERY open tab's per-tab history record cache after `clearHistory` has
 * wiped all rows, so a reload or same-key navigation records a fresh visit.
 * `hasRealTitle` is intentionally left intact.
 */
export function invalidateAllHistoryKeys(): void {
  runtime.lastHistoryKey.clear();
  runtime.lastVisitId.clear();
}

/**
 * Clamps a renderer-supplied history `limit` to the contract (PRD 6.1 §4):
 * `undefined` or a non-finite number defaults to 50, everything else is floored
 * to an integer and clamped to `[1, 500]`.
 */
export function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

/**
 * Prunes history older than the retention window once on launch (the db is open
 * via loadStore) and then every 24 h. A database error is logged once and never
 * blocks startup or the recurring timer.
 */
export function startHistoryPruning(): void {
  try {
    invalidateHistoryKeys(pruneHistory(Date.now()));
  } catch (err) {
    logHistoryError(err);
  }
  setInterval(
    () => {
      try {
        invalidateHistoryKeys(pruneHistory(Date.now()));
      } catch (err) {
        logHistoryError(err);
      }
    },
    24 * 60 * 60 * 1000,
  );
}

// --- History ------------------------------------------------------------------
// search/recent read the SQLite history tables on demand (history is never part
// of TabsState and never broadcast); deleteUrl/clear mutate them. A read error is
// allowed to reject the invoke (the renderer catches); the buildCatalog read is
// guarded separately so a database error never breaks the command bar.

ipcMain.handle(IPC.historySearch, (_event, query: string, limit?: number): HistoryEntry[] =>
  searchHistory(historyTerms(query), clampLimit(limit)),
);

ipcMain.handle(IPC.historyRecent, (_event, limit?: number): HistoryVisit[] =>
  recentVisits(clampLimit(limit)),
);

ipcMain.handle(IPC.historyDeleteUrl, (_event, url: string): void => {
  // Reject a non-string url with a TypeError (PRD 6.1 §4) before touching the db.
  if (typeof url !== "string") {
    throw new TypeError("history.deleteUrl expects a string");
  }
  deleteHistoryUrl(url);
  // The deleted aggregated url IS a historyKey; drop any open tab's cache for it.
  invalidateHistoryKeys([url]);
});

ipcMain.handle(IPC.historyClear, (): void => {
  clearHistory();
  invalidateAllHistoryKeys();
});

ipcMain.handle(IPC.historyStats, (): { entries: number; visits: number } => historyStats());
