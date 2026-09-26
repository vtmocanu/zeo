/**
 * PRD 9.3 — pure view-unload policy. A tab's WebContentsView is a cache of the
 * tab, not its identity; this decides which hidden, silent, idle views the main
 * process may tear down. No Electron here: main reads `isCurrentlyAudible` and
 * on-screen visibility itself and feeds the booleans in.
 */

/** A hidden, silent view untouched at least this long is unloadable. */
export const VIEW_UNLOAD_AFTER_MS = 30 * 60 * 1000;

/** How often the main process runs the idle-unload sweep. */
export const VIEW_UNLOAD_INTERVAL_MS = 5 * 60 * 1000;

/** One tracked view's inputs to the unload decision. */
export interface UnloadCandidate {
  tabId: string;
  lastActiveAt: number;
  visible: boolean;
  audible: boolean;
}

/**
 * The ids to unload: every candidate that is hidden (`!visible`), silent
 * (`!audible`), and idle longer than `maxIdleMs` — strictly greater, matching
 * `archiveIdle`. Input order is preserved. Pure and total: an empty input
 * returns `[]`; a negative `maxIdleMs` unloads every hidden, silent candidate.
 */
export function selectViewsToUnload(
  candidates: readonly UnloadCandidate[],
  now: number,
  maxIdleMs: number,
): string[] {
  return candidates
    .filter((c) => !c.visible && !c.audible && now - c.lastActiveAt > maxIdleMs)
    .map((c) => c.tabId);
}
