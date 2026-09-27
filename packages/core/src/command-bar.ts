import type { Suggestion } from "./suggest.js";

/**
 * Which action the command bar performs on submit.
 *
 * - `"navigate"` acts on the ACTIVE tab: the bar opens prefilled with that tab's
 *   current url (selected, so typing replaces it) and submitting navigates the
 *   same tab to the resolved target.
 * - `"new-tab"` acts on a fresh tab: the bar opens empty and submitting CREATES a
 *   new tab pointed at the resolved target.
 * - `"commands"` opens the palette empty: the typed text is a command-name filter
 *   only, there is no text (navigate/search) action, and submitting is not a valid
 *   action (accept runs the highlighted command).
 * - `"history"` opens the bar to search recorded history: the input placeholder
 *   reads "Search history", the typed text filters recent/matching visits, there
 *   is no text (navigate/search) action row, and accepting a row navigates the
 *   active tab to that url.
 * - `"promote"` opens the bar to pick a target SPACE for the quick-browse link:
 *   the typed text filters spaces by name, there is no text (navigate/search)
 *   action row, and every row is a `"space"` suggestion.
 * - `"split"` opens the bar to pick the second pane for a split: the typed text
 *   filters the active space's OTHER open tabs (the active tab excluded), there is
 *   no text (navigate/search) action row, and accepting a tab row fills the
 *   second pane, entering the split against that tab.
 * - `"downloads"` opens the bar to filter the download list: it opens with
 *   `initialText: ""`, the input placeholder reads "Filter downloads", the typed
 *   text is a filter only (no navigate/search row and no command row), and
 *   submit is not a valid action (accepting a row opens/reveals/removes that
 *   download over the bridge).
 */
export type CommandBarMode =
  | "navigate"
  | "new-tab"
  | "commands"
  | "history"
  | "promote"
  | "split"
  | "downloads";

/**
 * The command bar's serializable state, broadcast from main to the renderer.
 * `open` is whether the bar is showing; `mode` selects navigate vs new-tab (see
 * {@link CommandBarMode}); `initialText` is the text the input should open with
 * (the active tab's url in `"navigate"` mode, empty in `"new-tab"` and
 * `"commands"` mode).
 */
export interface CommandBarState {
  open: boolean;
  mode: CommandBarMode;
  initialText: string;
  /** The current query text main has ranked `suggestions` from. */
  query: string;
  /** The ranked suggestion list for `query` (row 0 is the text action; no row 0 in commands mode). */
  suggestions: Suggestion[];
  /** 0-based index into `suggestions`; `-1` when the list is empty. */
  selectedIndex: number;
  /**
   * Monotonic id of the current `suggestions` list, bumped whenever the list is
   * recomputed or cleared. The renderer echoes the revision it rendered when it
   * accepts a clicked row, so main can reject a click that raced a newer list
   * (the clicked index would otherwise resolve against different rows).
   */
  revision: number;
  /**
   * Which surface the single overlay `WebContentsView` renders: the command bar
   * (`"bar"`) or the find bar (`"find"`). The two are mutually exclusive surfaces
   * of that one overlay; defaults to `"bar"`.
   */
  surface: "bar" | "find";
}

/**
 * A suggestion's stable identity: the same logical row across re-ranks, even
 * when its title, label or position changes. Row 0's text action
 * (`navigate`/`search`) has one identity per kind, since it always stands for
 * "act on the typed text".
 */
export function suggestionKey(s: Suggestion): string {
  switch (s.kind) {
    case "navigate":
    case "search":
      return s.kind;
    case "tab":
    case "archived-tab":
      return `${s.kind}:${s.tabId}`;
    case "space":
      return `space:${s.spaceId}`;
    case "command":
      return `command:${s.id}`;
    case "history":
      return `history:${s.url}`;
    case "download":
      return `download:${s.id}`;
  }
}

/**
 * The selection to keep after a background re-rank: the index in `next` of the
 * row `prev[prevIndex]` identified (by {@link suggestionKey}), so a row the user
 * arrowed to stays selected even if it moved. Falls back to row 0 when that row
 * is gone (or there was no selection), and `-1` for an empty `next`.
 */
export function reselectIndex(
  prev: readonly Suggestion[],
  prevIndex: number,
  next: readonly Suggestion[],
): number {
  if (next.length === 0) {
    return -1;
  }
  const selected = prev[prevIndex];
  if (selected === undefined) {
    return 0;
  }
  const key = suggestionKey(selected);
  const found = next.findIndex((s) => suggestionKey(s) === key);
  return found === -1 ? 0 : found;
}

/** The suggestion list a row click may have been rendered against. */
export interface RevisionedSuggestions {
  revision: number;
  suggestions: readonly Suggestion[];
}

/**
 * How many background-superseded suggestion lists main keeps for
 * {@link resolveAcceptIndex}. One slow page load re-ranks the open bar more than
 * once (url commit, title, favicon, finish), so a click rendered just before the
 * load must survive several background revisions.
 */
export const MAX_PREVIOUS_SUGGESTION_LISTS = 8;

/**
 * Resolves a clicked row (`index` rendered against `revision`) to an index into
 * the `current` list, or `null` when the click must be rejected. A current
 * revision uses `index` as-is (range-checked). A click rendered against one of
 * the `previous` lists — each superseded by a BACKGROUND re-rank only; main
 * clears them on any user-driven change (query, mode, open, close) — is remapped
 * by {@link suggestionKey} to where that row now sits, and rejected when the row
 * is gone. Any other revision, or an index out of range for the list it was
 * rendered against, is rejected.
 */
export function resolveAcceptIndex(
  index: number,
  revision: number,
  current: RevisionedSuggestions,
  previous: readonly RevisionedSuggestions[],
): number | null {
  if (revision === current.revision) {
    return index >= 0 && index < current.suggestions.length ? index : null;
  }
  const rendered = previous.find((p) => p.revision === revision);
  if (rendered === undefined) {
    return null;
  }
  const clicked = rendered.suggestions[index];
  if (clicked === undefined) {
    return null;
  }
  const key = suggestionKey(clicked);
  const found = current.suggestions.findIndex((s) => suggestionKey(s) === key);
  return found === -1 ? null : found;
}
