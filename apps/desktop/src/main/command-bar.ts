import { ipcMain } from "electron";
import {
  IPC,
  COMMANDS,
  isCommandEnabled,
  suggest,
  nextSelectedIndex,
  resolveInput,
  historyTerms,
  promoteQuickBrowse,
} from "@zeo/core";
import type {
  CommandBarMode,
  CommandBarState,
  HistoryEntry,
  SuggestCatalog,
  Suggestion,
} from "@zeo/core";
import { searchHistory } from "./db.js";
import { runtime, HISTORY_CANDIDATES } from "./state.js";
import { pushCommandBar } from "./broadcast.js";
import { layoutOverlay } from "./overlay.js";
import { createTab, navigateTab } from "./tabs.js";
import { createViewFor } from "./views.js";
import { switchSpace } from "./spaces.js";
import { activateTab, doSplitWith } from "./layout.js";
import { teardownQuickBrowse } from "./quick-browse.js";
import { openDownloadById } from "./downloads.js";
import { logHistoryError } from "./history.js";

/**
 * Snapshots the store into the plain, store-free {@link SuggestCatalog} that
 * {@link suggest} ranks over: every space (flagged `active`), every open tab, and
 * every archived tab, each carrying its owning space's id and name. Rebuilt on
 * every keystroke so the ranked list always reflects the live store.
 */
export function buildCatalog(): SuggestCatalog {
  const spaceNameById = new Map(runtime.store.spaces().map((s) => [s.id, s.name]));
  // Compute the context once per call and reuse it for every command's enablement.
  const context = runtime.commandContextOf!();
  return {
    commands: COMMANDS.map((c) => ({
      id: c.id,
      title: c.title,
      keywords: c.keywords,
      accelerator: c.accelerator,
      enabled: isCommandEnabled(c.id, context),
    })),
    spaces: runtime.store
      .spaces()
      .map((s) => ({ id: s.id, name: s.name, active: s.id === runtime.store.activeSpaceId })),
    tabs: runtime.store.allOpenTabs().map(({ spaceId, tab }) => ({
      tabId: tab.id,
      spaceId,
      title: tab.title,
      url: tab.url,
      spaceName: spaceNameById.get(spaceId) ?? "",
      lastActiveAt: tab.lastActiveAt,
    })),
    archived: runtime.store.allArchivedTabs().map(({ spaceId, tab }) => ({
      tabId: tab.id,
      spaceId,
      title: tab.title,
      url: tab.url,
      spaceName: spaceNameById.get(spaceId) ?? "",
      // archivedAt is `number | null` on Tab; an archived tab always carries a
      // number, but coalesce to satisfy the catalog's `number` field.
      archivedAt: tab.archivedAt ?? 0,
    })),
    history: historyCandidates(),
    // suggest only reads this in downloads mode; newest-first, capped at 100.
    downloads: runtime.downloads.items,
  };
}

/**
 * The history rows for the current bar `query`/`mode` (PRD 6.1 §5): a non-empty
 * query in `navigate`, `new-tab` or `history` mode searches history; an empty
 * query in `history` mode lists the {@link HISTORY_CANDIDATES} most-recent
 * entries by `lastVisitedAt` (an empty `terms` array); every other case is `[]`.
 * A database read error is caught and logged once, returning `[]` so a history
 * failure never breaks the command bar.
 */
export function historyCandidates(): HistoryEntry[] {
  const { query, mode } = runtime.commandBar;
  const searchableMode = mode === "navigate" || mode === "new-tab" || mode === "history";
  try {
    if (query !== "" && searchableMode) {
      return searchHistory(historyTerms(query), HISTORY_CANDIDATES);
    }
    if (query === "" && mode === "history") {
      return searchHistory([], HISTORY_CANDIDATES);
    }
    return [];
  } catch (err) {
    logHistoryError(err);
    return [];
  }
}

/**
 * Recomputes {@link commandBar}'s `suggestions` from the current `query` and a
 * fresh {@link buildCatalog} snapshot, then resets `selectedIndex` to the first
 * row (or `-1` for an empty list). Mutates state only — callers push and lay out.
 */
export function recomputeSuggestions(): void {
  const previous = runtime.commandBar.suggestions;
  runtime.commandBar.suggestions = suggest(runtime.commandBar.query, buildCatalog(), {
    mode: runtime.commandBar.mode,
    activeTabId: runtime.store.activeTabId,
    searchEngine: runtime.settings.searchEngine,
  });
  runtime.commandBar.selectedIndex = runtime.commandBar.suggestions.length > 0 ? 0 : -1;
  // A CHANGED list gets a fresh revision so a click bound to a prior list is
  // recognized as stale by acceptCommandBar. An identical list keeps its
  // revision, so an unrelated broadcast (title/favicon/navigation) that re-ranks
  // to the same suggestions never invalidates a pending row click.
  if (JSON.stringify(previous) !== JSON.stringify(runtime.commandBar.suggestions)) {
    runtime.commandBar.revision = ++runtime.commandBarRevision;
  }
}

/**
 * Opens the command bar in `mode`. A `"navigate"` request with no active tab
 * falls back to `"new-tab"`; `"commands"` never falls back to another mode.
 * `initialText` is the active tab's current stored url in navigate mode (empty if
 * it cannot be found) and empty in both new-tab and commands mode (commands mode
 * also opens with an empty `query`). Lays out the overlay, showing and focusing it
 * when the window has room for the bar (a collapsed window leaves it hidden until
 * the next resize pass), and pushes the new state.
 */
export function openCommandBar(mode: CommandBarMode): void {
  // Opening any command-bar mode while find is open first closes find, so the
  // overlay's surface is restored to the command bar before it is reconstructed.
  // Skip find's focus return — this handler re-focuses the overlay itself below,
  // and an intervening page focus would blur-close the just-opened bar.
  if (runtime.find.open) {
    runtime.closeFindSession?.(false);
  }
  const effectiveMode: CommandBarMode =
    mode === "navigate" && runtime.store.activeTabId === null ? "new-tab" : mode;
  let initialText = "";
  if (effectiveMode === "navigate") {
    const active = runtime.store.list().find((t) => t.id === runtime.store.activeTabId);
    initialText = active?.url ?? "";
  }
  runtime.commandBar = {
    open: true,
    mode: effectiveMode,
    initialText,
    query: initialText,
    suggestions: [],
    selectedIndex: -1,
    revision: runtime.commandBar.revision,
    surface: "bar",
  };
  // Rank the initial suggestions BEFORE laying out so the overlay is sized to the
  // row count on open — a `Cmd+T` with empty text already shows the recent-tabs
  // list at its full height.
  recomputeSuggestions();
  const shown = layoutOverlay();
  if (shown) {
    runtime.overlay?.webContents.focus();
  }
  pushCommandBar();
}

/**
 * Closes the command bar and returns focus to the active tab's view (or the
 * window when there is none). Idempotent: a no-op when already closed, which
 * prevents the overlay-blur handler from recursing through the focus return.
 */
export function closeCommandBar(): void {
  if (!runtime.commandBar.open) {
    return;
  }
  runtime.commandBar = {
    open: false,
    mode: runtime.commandBar.mode,
    initialText: "",
    query: "",
    suggestions: [],
    selectedIndex: -1,
    // Clearing the list bumps the revision so a click that raced the close is
    // rejected rather than resolved against the now-empty list.
    revision: ++runtime.commandBarRevision,
    surface: "bar",
  };
  runtime.overlay?.setVisible(false);
  pushCommandBar();
  const activeTabId = runtime.store.activeTabId;
  if (activeTabId !== null && runtime.views.has(activeTabId)) {
    runtime.views.get(activeTabId)?.view.webContents.focus();
  } else {
    runtime.win?.webContents.focus();
  }
}

/**
 * Resolves `text` and performs the command-bar action. A `commands` effective
 * mode (the passed `mode`, else the open bar's mode, else `"navigate"`) rejects
 * (throws) and changes nothing — commands mode has no text action and the bar
 * stays open. Otherwise a null resolution (empty or whitespace-only input) closes
 * the bar without navigating, and a resolved target either navigates the active
 * tab or creates a new tab (the effective mode downgraded to `"new-tab"` when
 * there is no active tab), then closes the bar if it was open.
 */
export function submitCommandBar(text: string, mode?: CommandBarMode): void {
  const requestedMode: CommandBarMode =
    mode ?? (runtime.commandBar.open ? runtime.commandBar.mode : "navigate");
  if (requestedMode === "commands" || requestedMode === "promote" || requestedMode === "split") {
    // None of these modes has a free-text action: commands runs the highlighted
    // command, promote picks a target space from the rows, and split fills the
    // second pane from a chosen tab row. A raw submit is not valid.
    throw new Error(`submit is not valid in ${requestedMode} mode`);
  }
  const target = resolveInput(text, runtime.settings.searchEngine);
  if (target === null) {
    if (runtime.commandBar.open) {
      closeCommandBar();
    }
    return;
  }
  const wasOpen = runtime.commandBar.open;
  let effectiveMode: CommandBarMode =
    mode ?? (runtime.commandBar.open ? runtime.commandBar.mode : "navigate");
  if (effectiveMode === "navigate" && runtime.store.activeTabId === null) {
    effectiveMode = "new-tab";
  }
  if (effectiveMode === "navigate") {
    navigateTab(runtime.store.activeTabId!, target.url);
  } else {
    createTab(target.url);
  }
  if (wasOpen) {
    closeCommandBar();
  }
}

/**
 * Sets the query, re-ranks the suggestion list from a fresh catalog, re-lays-out
 * the overlay to the new row count, and pushes the state. The renderer drives
 * this on every keystroke.
 */
export function setQueryCommandBar(text: string): void {
  runtime.commandBar.query = text;
  recomputeSuggestions();
  layoutOverlay();
  pushCommandBar();
}

/**
 * Moves the selection by `delta` (`+1`/`-1`), wrapping at both ends via
 * {@link nextSelectedIndex}, and pushes. With an empty list (`selectedIndex ===
 * -1`) it is a no-op — no wrap, no push.
 */
export function moveSelectionCommandBar(delta: 1 | -1): void {
  if (runtime.commandBar.selectedIndex === -1) {
    return;
  }
  runtime.commandBar.selectedIndex = nextSelectedIndex(
    runtime.commandBar.selectedIndex,
    runtime.commandBar.suggestions.length,
    delta,
  );
  pushCommandBar();
}

/**
 * Performs a catalog suggestion's action WITHOUT closing the bar — the caller
 * ({@link acceptCommandBar}) closes afterward. Only the catalog kinds
 * (`tab`/`archived-tab`/`space`) are handled here; the text kinds
 * (`navigate`/`search`) are dispatched by {@link acceptCommandBar} through
 * {@link submitCommandBar} (which closes the bar itself) before this runs, so
 * they must never reach here. A `tab` activates its owning space (if not already
 * active) then the tab; an `archived-tab` switches space, restores + materializes
 * the view (mirroring the tabsRestore handler), then activates; a `space` just
 * switches the active space and reconciles the visible view.
 */
export function performSuggestion(s: Suggestion): void {
  switch (s.kind) {
    case "tab": {
      // Split mode: the bar is picking the second pane. The split suggest branch
      // only offers active-space tabs, so there is no space switch — fill the
      // second pane against the chosen tab. doSplitWith may reject (e.g. already
      // split, or the tab is the active one); swallow-log it like view.split.
      if (runtime.commandBar.mode === "split") {
        doSplitWith(s.tabId).catch((err) =>
          console.error("[split] splitWith from bar failed:", err),
        );
        return;
      }
      switchSpace(s.spaceId);
      // activateTab does store.activate + view reconcile (the cross-space
      // hide/show transition, and a split collapse when the tab is not a pane) +
      // broadcast.
      activateTab(s.tabId);
      return;
    }
    case "archived-tab": {
      switchSpace(s.spaceId);
      // After the space switch, store.list()/store.restore act on the now-active
      // owning space. Restore and materialize the view like the tabsRestore
      // handler before activating it.
      runtime.store.restore(s.tabId);
      if (!runtime.views.has(s.tabId)) {
        const tab = runtime.store.list().find((t) => t.id === s.tabId);
        if (tab !== undefined) {
          createViewFor(tab, runtime.store.activeSpaceId);
        }
      }
      activateTab(s.tabId);
      return;
    }
    case "space": {
      if (runtime.commandBar.mode === "promote") {
        // Promote the quick-browse link into the chosen space (PRD 7.2 §6).
        // Failure paths (acceptCommandBar closes the bar after this returns):
        //   - the window was dismissed while the picker was open (quickBrowse null)
        //     → no-op, the bar just closes;
        //   - the picked space no longer exists → no-op that leaves the quick-browse
        //     window open (its url stays promotable).
        if (runtime.quickBrowse === null) {
          return;
        }
        if (!runtime.store.spaces().some((sp) => sp.id === s.spaceId)) {
          return;
        }
        const entry = promoteQuickBrowse(runtime.quickBrowse);
        runtime.store.setActiveSpace(s.spaceId);
        createTab(entry.url); // create + activate in the now-active target space
        teardownQuickBrowse();
        return;
      }
      switchSpace(s.spaceId);
      return;
    }
    case "history": {
      // Accepting a history row (PRD 6.1 §5): create a tab at its url in new-tab
      // mode, otherwise (navigate/history mode) navigate the active tab. With no
      // active tab (an empty space, or the active tab was closed while a history-
      // mode bar stayed open), fall back to creating a tab so accept never throws
      // on a null id — the same downgrade openCommandBar applies for navigate mode.
      if (runtime.commandBar.mode === "new-tab" || runtime.store.activeTabId === null) {
        createTab(s.url);
      } else {
        navigateTab(runtime.store.activeTabId, s.url);
      }
      return;
    }
    case "download": {
      // Mouse-click open: no-op unless the record is completed and its file still
      // exists on disk (openDownloadById enforces both). The bar stays open.
      void openDownloadById(s.id);
      return;
    }
    case "navigate":
    case "search":
    case "command": {
      // Unreachable: acceptCommandBar routes the text kinds through
      // submitCommandBar and command kinds through executeCommand itself, and
      // never calls performSuggestion for any of them.
      throw new Error(`performSuggestion received kind "${s.kind}"`);
    }
  }
}

/**
 * Accepts a suggestion and closes the bar. The target row is the explicit
 * `index` (a clicked row) when given, else the current `selectedIndex`, resolved
 * against the CURRENT `suggestions`. An explicit `index` outside
 * `0 .. suggestions.length - 1` throws — the invoke rejects and the bar is left
 * untouched (not closed, not mutated). With no index and an empty list
 * (`selectedIndex === -1`) it submits the raw query like the Enter action
 * ({@link submitCommandBar} closes the open bar) — except in `commands` mode,
 * which has no text action: it is a no-op there, leaving the bar open (submit
 * rejects in commands mode). The text kinds (`navigate`/`search`) also route
 * through {@link submitCommandBar} (which closes the bar itself, so no extra
 * close); a `command` kind runs {@link executeCommand} and then closes, except
 * `tab.new`, `bar.open-location`, and `bar.open-commands`, whose handlers
 * re-open or switch the bar and so are left open; every other kind runs
 * {@link performSuggestion} and then closes.
 *
 * `revision` is the {@link CommandBarState.revision} the renderer rendered the
 * clicked row against. When an explicit `index` is paired with a `revision` that
 * no longer matches the current list, the click raced a newer suggestion list;
 * it is rejected (thrown, so the invoke rejects) with the bar left untouched,
 * exactly like the out-of-range guard. The keyboard path passes no `revision`
 * (it acts on `selectedIndex` against the current list), so the guard is skipped.
 */
export function acceptCommandBar(index?: number, revision?: number): void {
  if (index !== undefined && revision !== undefined && revision !== runtime.commandBar.revision) {
    throw new Error(`accept revision stale: ${revision} !== ${runtime.commandBar.revision}`);
  }
  if (index !== undefined && (index < 0 || index >= runtime.commandBar.suggestions.length)) {
    throw new Error(`accept index out of range: ${index}`);
  }
  const idx = index ?? runtime.commandBar.selectedIndex;
  if (idx === -1) {
    // Commands, promote, split, and downloads modes have no text action: a
    // no-match query simply leaves the bar open rather than routing to submit
    // (which rejects in these modes) — split can only fill the second pane from
    // an existing tab row.
    if (
      runtime.commandBar.mode === "commands" ||
      runtime.commandBar.mode === "promote" ||
      runtime.commandBar.mode === "split" ||
      runtime.commandBar.mode === "downloads"
    ) {
      return;
    }
    submitCommandBar(runtime.commandBar.query);
    return;
  }
  const s = runtime.commandBar.suggestions[idx]!;
  if (s.kind === "navigate" || s.kind === "search") {
    submitCommandBar(runtime.commandBar.query, runtime.commandBar.mode);
    return;
  }
  if (s.kind === "command") {
    // executeCommand throws on a stale/disabled command; the throw propagates
    // and the invoke rejects with the bar untouched (do not catch it).
    runtime.executeCommand!(s.id);
    // bar.open-location, tab.new, bar.open-commands, and history.open re-open or
    // switch the bar (openCommandBar sets open:true unconditionally; the mode
    // switches), so closing here would immediately dismiss the just-opened bar.
    // Every other command closes it.
    if (
      s.id !== "bar.open-location" &&
      s.id !== "tab.new" &&
      s.id !== "bar.open-commands" &&
      s.id !== "history.open" &&
      s.id !== "downloads.open"
    ) {
      closeCommandBar();
    }
    return;
  }
  performSuggestion(s);
  // A download row click opens the file and keeps the bar open; every other kind
  // closes it.
  if (runtime.commandBar.mode !== "downloads") {
    closeCommandBar();
  }
}

/**
 * The single place that recomputes command context and refreshes both the
 * application menu (a full {@link Menu.setApplicationMenu} rebuild, since the
 * pin/unpin label and enabled flags change with context) and, when the bar is
 * open, its suggestions/layout/state (so enablement like Go Back updates without
 * retyping; the revision bumps to reject a stale click only when the re-ranked
 * list actually changes). Never calls {@link broadcast} — {@link broadcast}
 * calls it — so there is no recursion.
 */
export function refreshCommandState(): void {
  runtime.rebuildMenu?.();
  if (runtime.commandBar.open) {
    recomputeSuggestions();
    layoutOverlay();
    pushCommandBar();
  }
}

// Register the onStateApplied hook: broadcast() and createViewFor's
// did-finish-load listener call it to refresh the menu and open bar.
runtime.onStateApplied = refreshCommandState;

// --- Command bar --------------------------------------------------------------
// The command-bar handlers drive the single overlay controller; commandBarState
// reads the current state back synchronously.
ipcMain.handle(IPC.commandBarOpen, (_event, mode: CommandBarMode): void => {
  openCommandBar(mode);
});

ipcMain.handle(IPC.commandBarClose, (): void => {
  closeCommandBar();
});

ipcMain.handle(IPC.commandBarSubmit, (_event, text: string, mode?: CommandBarMode): void => {
  submitCommandBar(text, mode);
});

ipcMain.handle(IPC.commandBarSetQuery, (_event, text: string): void => {
  setQueryCommandBar(text);
});

ipcMain.handle(IPC.commandBarMove, (_event, delta: 1 | -1): void => {
  moveSelectionCommandBar(delta);
});

// acceptCommandBar throws on an out-of-range explicit index; the thrown Error
// propagates out and rejects the renderer's invoke, leaving the bar untouched.
ipcMain.handle(IPC.commandBarAccept, (_event, index?: number, revision?: number): void => {
  acceptCommandBar(index, revision);
});

ipcMain.handle(IPC.commandBarState, (): CommandBarState => runtime.commandBar);
