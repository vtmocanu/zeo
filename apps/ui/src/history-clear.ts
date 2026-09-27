/**
 * Pure text builders for the settings history section (PRD 10.6 §3), kept free
 * of React and the DOM so they are unit-testable. `HistoryStatsStatus` mirrors
 * the three states `history.stats()` can be in from the section's point of
 * view: `"loading"` before the first read (or a reload) resolves, `"loaded"`
 * once counts are in hand, and `"failed"` when the read rejected — which must
 * not block the clear trigger forever, so the wording here is written to make
 * sense without ever knowing the counts.
 */
export type HistoryStatsStatus = "loading" | "loaded" | "failed";

/** The `entries`/`visits` counts returned by `history.stats()`. */
export interface HistoryStats {
  entries: number;
  visits: number;
}

/**
 * The text for the settings history section's stats row. `"loading"` reads as
 * a neutral placeholder, `"failed"` as a short, actionable-free notice (no
 * counts to show), and `"loaded"` reports the real counts.
 */
export function historyStatsText(status: HistoryStatsStatus, stats: HistoryStats | null): string {
  if (status === "loaded" && stats !== null) {
    return `${stats.entries} entries · ${stats.visits} visits`;
  }
  if (status === "failed") {
    return "History stats unavailable";
  }
  return "Loading…";
}

/**
 * The clear-history confirmation dialog's body. When the counts are known
 * (`status === "loaded"`) it quotes them, matching the PRD's copy; otherwise —
 * a failed read, or (defensively) a dialog opened before the read settled —
 * it falls back to count-free wording, since quoting a stale or placeholder
 * "0 entries" count would be misleading.
 */
export function historyClearDialogBody(
  status: HistoryStatsStatus,
  stats: HistoryStats | null,
): string {
  if (status === "loaded" && stats !== null) {
    return `This removes ${stats.entries} entries and ${stats.visits} visits. It cannot be undone.`;
  }
  return "This removes all browsing history. It cannot be undone.";
}

/**
 * Whether the "Clear Browsing History…" trigger should be disabled: only while
 * the first (or a reload's) stats read is in flight. A failed read still
 * enables it — clearing does not require knowing the counts first.
 */
export function historyClearTriggerDisabled(status: HistoryStatsStatus): boolean {
  return status === "loading";
}

/** The message shown inline in the dialog when `history.clear()` rejects. */
export const HISTORY_CLEAR_ERROR = "Couldn't clear history. Try again.";
