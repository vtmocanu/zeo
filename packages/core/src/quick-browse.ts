/**
 * The pure quick-browse slice and its state reducers. This module owns the
 * singleton quick-browse entry main attaches to the broadcast snapshot: the url
 * of the link opened in the transient quick-browse window and the title derived
 * for it (see {@link titleForUrl}).
 *
 * Everything here is Electron-free and total: {@link QuickBrowseState} is `null`
 * exactly when no quick-browse window is open, and the reducers treat their
 * input as immutable, each returning a NEW {@link QuickBrowse} (or `null`)
 * rather than mutating the argument, matching the existing reducers in
 * `packages/core` (e.g. `zoom.ts`).
 */

import { titleForUrl } from "./tab-title.js";

/** A single open quick-browse entry: the link's url and its derived title. */
export interface QuickBrowse {
  url: string;
  title: string;
}

/** `null` means no quick-browse window is open (the singleton is closed). */
export type QuickBrowseState = QuickBrowse | null;

/**
 * Opens a fresh quick-browse entry for `url`, its title seeded from the url's
 * fallback (see {@link titleForUrl}). Ignores any prior state — opening always
 * starts a new singleton entry.
 */
export function openQuickBrowse(url: string): QuickBrowse {
  return { url, title: titleForUrl(url) };
}

/**
 * Replaces the open quick-browse entry's url with `url`, RESETTING the title to
 * the new url's fallback (see {@link titleForUrl}). THROWS when `state` is
 * `null` — there is no window to replace the url in. The input `state` is not
 * mutated.
 */
export function replaceQuickBrowseUrl(
  state: QuickBrowseState,
  url: string,
): QuickBrowse {
  if (state === null) {
    throw new Error("replaceQuickBrowseUrl: no quick-browse window is open");
  }
  return { url, title: titleForUrl(url) };
}

/**
 * Tracks a navigation INSIDE the quick-browse page: updates the url to `url` and
 * re-derives the fallback title (see {@link titleForUrl}). THROWS when `state`
 * is `null` — there is no live page to track. The input `state` is not mutated.
 */
export function setQuickBrowseUrl(
  state: QuickBrowseState,
  url: string,
): QuickBrowse {
  if (state === null) {
    throw new Error("setQuickBrowseUrl: no quick-browse window is open");
  }
  return { url, title: titleForUrl(url) };
}

/**
 * Updates the entry's `title` ONLY when a window is open AND its current `url`
 * still matches `url`; otherwise returns the input `state` unchanged in value.
 * The url guard drops a title event that raced a navigation to a different url,
 * or that arrived after dismissal. The input `state` is not mutated.
 */
export function setQuickBrowseTitle(
  state: QuickBrowseState,
  url: string,
  title: string,
): QuickBrowseState {
  if (state === null || state.url !== url) {
    return state;
  }
  return { url: state.url, title };
}

/**
 * Returns the current quick-browse entry — the url+title to hand to the target
 * space when the link is promoted. THROWS when `state` is `null` — there is
 * nothing to promote. The input `state` is not mutated.
 */
export function promoteQuickBrowse(state: QuickBrowseState): QuickBrowse {
  if (state === null) {
    throw new Error("promoteQuickBrowse: no quick-browse window is open");
  }
  return { url: state.url, title: state.title };
}

/**
 * Dismisses the quick-browse window, throwing the current link away. Returns
 * `null` unconditionally, so it is idempotent when already `null`.
 */
export function dismissQuickBrowse(_state: QuickBrowseState): null {
  return null;
}
