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
 */
export type CommandBarMode = "navigate" | "new-tab" | "commands";

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
}
