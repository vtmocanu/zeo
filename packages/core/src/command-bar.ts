/**
 * Which action the command bar performs on submit.
 *
 * - `"navigate"` acts on the ACTIVE tab: the bar opens prefilled with that tab's
 *   current url (selected, so typing replaces it) and submitting navigates the
 *   same tab to the resolved target.
 * - `"new-tab"` acts on a fresh tab: the bar opens empty and submitting CREATES a
 *   new tab pointed at the resolved target.
 */
export type CommandBarMode = "navigate" | "new-tab";

/**
 * The command bar's serializable state, broadcast from main to the renderer.
 * `open` is whether the bar is showing; `mode` selects navigate vs new-tab (see
 * {@link CommandBarMode}); `initialText` is the text the input should open with
 * (the active tab's url in `"navigate"` mode, empty in `"new-tab"` mode).
 */
export interface CommandBarState {
  open: boolean;
  mode: CommandBarMode;
  initialText: string;
}
