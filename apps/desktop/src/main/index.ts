import { app, BrowserWindow, WebContentsView, clipboard, ipcMain, Menu, session } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SpaceStore,
  IPC,
  titleForUrl,
  SIDEBAR_WIDTH,
  buildSpaceContextMenu,
  defaultSpaceName,
  commandBarBounds,
  resolveInput,
  suggest,
  nextSelectedIndex,
} from "@zeo/core";
import type {
  CommandBarMode,
  CommandBarState,
  Profile,
  Space,
  SpaceContextMenuResult,
  SpacesState,
  Suggestion,
  SuggestCatalog,
  Tab,
  TabContextMenuResult,
  TabsState,
} from "@zeo/core";
import { loadStore, scheduleSave, flush } from "./db.js";

// The built main is emitted by electron-vite as ESM (out/main/index.js, the
// package is "type": "module"), so `__dirname` is not defined — derive it from
// import.meta.url. Preload and renderer are resolved as siblings of the main
// file's directory (out/preload/index.cjs, out/renderer/index.html).
const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Default url/title used by the renderer's URL-less new-tab button. */
const DEFAULT_URL = "https://example.com";

/**
 * Auto-archive schedule. The *policy* (which tabs are idle) lives in core
 * (`SpaceStore.archiveIdleAll`, which sweeps every space's `TabStore`); the main
 * process only owns these scheduling constants and the timer. A tab untouched for
 * `IDLE_THRESHOLD_MS` is swept, and the sweep runs every `SWEEP_INTERVAL_MS` (plus
 * once on launch).
 */
const IDLE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let store = new SpaceStore();
/**
 * Live WebContentsView per tab id, tagged with the id of its OWNING space. The
 * active space's active tab is the single visible view; every other view (other
 * tabs in the active space, and all tabs in inactive spaces) stays alive but
 * hidden. The owning-space tag lets a space delete destroy exactly that space's
 * views.
 */
interface TrackedView {
  view: WebContentsView;
  spaceId: string;
}
const views = new Map<string, TrackedView>();
/**
 * Tab ids whose most recent view load rejected. A failed load is retried on the
 * next activation of that tab (see the tabsActivate handler); a successful load
 * or a view teardown clears the id.
 */
const failedLoads = new Set<string>();
let win: BrowserWindow | null = null;
/**
 * The command-bar overlay view. A single {@link WebContentsView} layered above
 * the tab views, showing the same renderer bundle loaded with `?view=command-bar`.
 * Created once in {@link createWindow}, kept topmost by re-adding it after every
 * new tab view, hidden except while the bar is open, and nulled on window close.
 */
let overlay: WebContentsView | null = null;
/**
 * The command bar's current state, mirrored to the overlay renderer over
 * {@link IPC.commandBarChange}. Toggled by {@link openCommandBar} /
 * {@link closeCommandBar} and read back by the `commandBarState` IPC handler.
 */
let commandBar: CommandBarState = {
  open: false,
  mode: "navigate",
  initialText: "",
  query: "",
  suggestions: [],
  selectedIndex: -1,
};
/**
 * Per-tab navigation sequence counter for last-request-wins: each
 * {@link navigateTab} bumps its tab's number, and a settling `loadURL` only
 * mutates `failedLoads` when its captured number is still current.
 */
const navSeq = new Map<string, number>();
/**
 * Tab ids whose live page has reported a real `page-title-updated` title. While
 * set, `did-navigate` url tracking leaves the stored title alone (the real page
 * title wins over the hostname fallback); reset at the start of each navigate.
 */
const hasRealTitle = new Set<string>();

/** Bounds of the tab web-view region: everything right of the sidebar. */
function viewBounds(): Electron.Rectangle {
  if (win === null) {
    return { x: SIDEBAR_WIDTH, y: 0, width: 0, height: 0 };
  }
  const [width, height] = win.getContentSize();
  return {
    x: SIDEBAR_WIDTH,
    y: 0,
    width: Math.max(0, width - SIDEBAR_WIDTH),
    height,
  };
}

/**
 * Positions the command-bar overlay over the page region using the shared
 * {@link commandBarBounds} geometry, sized to the current suggestion row count.
 * A no-op unless both the window and the overlay exist. When the window is too
 * short or too narrow the geometry collapses to an all-zero rect; the overlay is
 * hidden in that case and left hidden until a later bounds pass yields a
 * non-zero rectangle. Otherwise, while the bar is open, the overlay is (re-)shown.
 * Returns whether it left the overlay shown, so callers can drive focus off that
 * rather than force visibility. Bounds are re-applied whenever the row count can
 * change — on open, on query change, and on window resize (a selection move
 * pushes state but does not re-layout, which is fine since the row count is
 * unchanged).
 */
function layoutOverlay(): boolean {
  if (win === null || overlay === null) {
    return false;
  }
  const [width, height] = win.getContentSize();
  const bounds = commandBarBounds(width, height, commandBar.suggestions.length);
  if (bounds.width === 0) {
    overlay.setVisible(false);
    return false;
  }
  overlay.setBounds(bounds);
  if (commandBar.open) {
    overlay.setVisible(true);
    return true;
  }
  return false;
}

/**
 * Creates a hidden web view for a tab owned by `spaceId` and starts loading its
 * url. The view is tracked with its owning space so a space switch or delete can
 * find it. `urlOverride`, when given, is loaded instead of the tab's stored url
 * (used by profile remap to preserve each live view's current url).
 */
function createViewFor(tab: Tab, spaceId: string, urlOverride?: string): void {
  if (win === null) {
    return;
  }
  const view = new WebContentsView({
    webPreferences: { partition: "persist:" + store.spaceProfileId(spaceId) },
  });
  views.set(tab.id, { view, spaceId });
  win.contentView.addChildView(view);
  view.setBounds(viewBounds());
  view.setVisible(false);

  // Live title/favicon: the hostname-derived title seeded by store.create stays
  // as the fallback until the first page-title-updated arrives. updateMeta
  // no-ops on an unknown/torn-down id, so late events after close are safe.
  view.webContents.on("page-title-updated", (_event, title) => {
    hasRealTitle.add(tab.id);
    store.updateMeta(tab.id, { title });
    broadcast();
  });
  view.webContents.on("page-favicon-updated", (_event, favicons: string[]) => {
    const faviconUrl = favicons.length > 0 ? favicons[0] : null;
    store.updateMeta(tab.id, { faviconUrl });
    broadcast();
  });

  // Live url tracking: mirror the view's real url into the store on every commit
  // (cross-document and same-document). Until a real page-title-updated arrives
  // (tracked in hasRealTitle), also re-derive the hostname title fallback so the
  // sidebar label follows the url; once a real title is known it wins.
  const onDidNavigate = (): void => {
    const current = view.webContents.getURL(); // read live, never a captured value
    if (current === "") {
      return;
    }
    const meta: { url: string; title?: string } = { url: current };
    if (!hasRealTitle.has(tab.id)) {
      meta.title = titleForUrl(current);
    }
    store.updateMeta(tab.id, meta);
    broadcast();
  };
  view.webContents.on("did-navigate", onDidNavigate);
  view.webContents.on("did-navigate-in-page", onDidNavigate);

  // Track load failure so activation can retry it; a later success clears it.
  view.webContents
    .loadURL(urlOverride ?? tab.url)
    .then(() => {
      failedLoads.delete(tab.id);
    })
    .catch((err: unknown) => {
      if (views.get(tab.id)?.view !== view) {
        return;
      }
      // A navigateTab call on this tab while its initial load is still in flight
      // aborts that load (Electron rejects with ERR_ABORTED). That is a
      // superseded load, not a failure: per the last-request-wins contract it must
      // never mark failedLoads or log. The newer load owns the retry state.
      if ((err as { code?: string }).code === "ERR_ABORTED") {
        return;
      }
      failedLoads.add(tab.id);
      console.error(`tab ${tab.id} failed to load ${urlOverride ?? tab.url}:`, err);
    });

  // Keep the command-bar overlay above every tab view: re-adding it as a child
  // raises it to the top of the z-order over the view just added. Null-guarded so
  // the first createViewFor (which may run before the overlay is created) is safe.
  if (overlay !== null) {
    win.contentView.addChildView(overlay);
  }
}

/** Full new-tab lifecycle: store entry, view, activation, broadcast. */
function createTab(url?: string): Tab {
  const u = url ?? DEFAULT_URL;
  const tab = store.create({ url: u, title: titleForUrl(u) });
  createViewFor(tab, store.activeSpaceId);
  setActive(tab.id);
  broadcast();
  return tab;
}

/**
 * Navigates the tab `id` to `url` with last-request-wins semantics. Validates
 * that the tab is one of the ACTIVE space's open tabs (throwing otherwise, so the
 * ipc handler rejects the invoke like the other tab commands). The stored url and
 * its hostname title fallback are updated and broadcast synchronously; the view's
 * `loadURL` is then kicked off, and its settle only touches `failedLoads` when the
 * captured sequence number is still current (a superseded load aborts silently).
 */
function navigateTab(id: string, url: string): void {
  if (!store.list().some((t) => t.id === id)) {
    throw new Error(`Cannot navigate unknown or non-active-space tab: ${id}`);
  }

  const seq = (navSeq.get(id) ?? 0) + 1;
  navSeq.set(id, seq);

  // Reset the real-title flag so the hostname fallback tracks the new url until
  // the destination reports its own title, and seed the stored url synchronously.
  hasRealTitle.delete(id);
  store.updateMeta(id, { url, title: titleForUrl(url) });
  broadcast();

  const tracked = views.get(id);
  if (tracked !== undefined) {
    tracked.view.webContents
      .loadURL(url)
      .then(() => {
        if (navSeq.get(id) === seq) {
          failedLoads.delete(id);
        }
      })
      .catch((err: unknown) => {
        if (navSeq.get(id) !== seq) {
          // Superseded by a newer navigate — the aborted load rejects with
          // ERR_ABORTED; ignore it (no failedLoads, no log).
          return;
        }
        if (views.get(id)?.view !== tracked.view) {
          return;
        }
        failedLoads.add(id);
        console.error(`tab ${id} failed to navigate to ${url}:`, err);
      });
  }
  // Navigating a tab whose INITIAL createViewFor load is still in flight aborts
  // that load; createViewFor's own catch ignores ERR_ABORTED, so the superseded
  // initial load never spuriously marks failedLoads or logs — this navigate's
  // load owns the retry state from here.
}

/** Pushes the current command-bar state to the OVERLAY renderer (which hosts the
 *  CommandBar UI), seeding its input; the sidebar is intentionally not targeted. */
function pushCommandBar(): void {
  overlay?.webContents.send(IPC.commandBarChange, commandBar);
}

/**
 * Snapshots the store into the plain, store-free {@link SuggestCatalog} that
 * {@link suggest} ranks over: every space (flagged `active`), every open tab, and
 * every archived tab, each carrying its owning space's id and name. Rebuilt on
 * every keystroke so the ranked list always reflects the live store.
 */
function buildCatalog(): SuggestCatalog {
  const spaceNameById = new Map(store.spaces().map((s) => [s.id, s.name]));
  return {
    spaces: store.spaces().map((s) => ({ id: s.id, name: s.name, active: s.id === store.activeSpaceId })),
    tabs: store.allOpenTabs().map(({ spaceId, tab }) => ({
      tabId: tab.id,
      spaceId,
      title: tab.title,
      url: tab.url,
      spaceName: spaceNameById.get(spaceId) ?? "",
      lastActiveAt: tab.lastActiveAt,
    })),
    archived: store.allArchivedTabs().map(({ spaceId, tab }) => ({
      tabId: tab.id,
      spaceId,
      title: tab.title,
      url: tab.url,
      spaceName: spaceNameById.get(spaceId) ?? "",
      // archivedAt is `number | null` on Tab; an archived tab always carries a
      // number, but coalesce to satisfy the catalog's `number` field.
      archivedAt: tab.archivedAt ?? 0,
    })),
  };
}

/**
 * Recomputes {@link commandBar}'s `suggestions` from the current `query` and a
 * fresh {@link buildCatalog} snapshot, then resets `selectedIndex` to the first
 * row (or `-1` for an empty list). Mutates state only — callers push and lay out.
 */
function recomputeSuggestions(): void {
  commandBar.suggestions = suggest(commandBar.query, buildCatalog(), {
    mode: commandBar.mode,
    activeTabId: store.activeTabId,
  });
  commandBar.selectedIndex = commandBar.suggestions.length > 0 ? 0 : -1;
}

/**
 * Opens the command bar in `mode`. A `"navigate"` request with no active tab
 * falls back to `"new-tab"`. `initialText` is the active tab's current stored url
 * in navigate mode (empty if it cannot be found) and empty in new-tab mode. Lays
 * out and shows the overlay, focuses it, and pushes the new state.
 */
function openCommandBar(mode: CommandBarMode): void {
  const effectiveMode: CommandBarMode =
    mode === "navigate" && store.activeTabId === null ? "new-tab" : mode;
  let initialText = "";
  if (effectiveMode === "navigate") {
    const active = store.list().find((t) => t.id === store.activeTabId);
    initialText = active?.url ?? "";
  }
  commandBar = {
    open: true,
    mode: effectiveMode,
    initialText,
    query: initialText,
    suggestions: [],
    selectedIndex: -1,
  };
  // Rank the initial suggestions BEFORE laying out so the overlay is sized to the
  // row count on open — a `Cmd+T` with empty text already shows the recent-tabs
  // list at its full height.
  recomputeSuggestions();
  const shown = layoutOverlay();
  if (shown) {
    overlay?.webContents.focus();
  }
  pushCommandBar();
}

/**
 * Closes the command bar and returns focus to the active tab's view (or the
 * window when there is none). Idempotent: a no-op when already closed, which
 * prevents the overlay-blur handler from recursing through the focus return.
 */
function closeCommandBar(): void {
  if (!commandBar.open) {
    return;
  }
  commandBar = {
    open: false,
    mode: commandBar.mode,
    initialText: "",
    query: "",
    suggestions: [],
    selectedIndex: -1,
  };
  overlay?.setVisible(false);
  pushCommandBar();
  const activeTabId = store.activeTabId;
  if (activeTabId !== null && views.has(activeTabId)) {
    views.get(activeTabId)?.view.webContents.focus();
  } else {
    win?.webContents.focus();
  }
}

/**
 * Resolves `text` and performs the command-bar action. A null resolution (empty
 * or whitespace-only input) closes the bar without navigating. Otherwise the
 * effective mode (the passed `mode`, else the open bar's mode, else `"navigate"`,
 * downgraded to `"new-tab"` when there is no active tab) either navigates the
 * active tab or creates a new tab, then closes the bar if it was open.
 */
function submitCommandBar(text: string, mode?: CommandBarMode): void {
  const target = resolveInput(text);
  if (target === null) {
    if (commandBar.open) {
      closeCommandBar();
    }
    return;
  }
  const wasOpen = commandBar.open;
  let effectiveMode: CommandBarMode = mode ?? (commandBar.open ? commandBar.mode : "navigate");
  if (effectiveMode === "navigate" && store.activeTabId === null) {
    effectiveMode = "new-tab";
  }
  if (effectiveMode === "navigate") {
    navigateTab(store.activeTabId!, target.url);
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
function setQueryCommandBar(text: string): void {
  commandBar.query = text;
  recomputeSuggestions();
  layoutOverlay();
  pushCommandBar();
}

/**
 * Moves the selection by `delta` (`+1`/`-1`), wrapping at both ends via
 * {@link nextSelectedIndex}, and pushes. With an empty list (`selectedIndex ===
 * -1`) it is a no-op — no wrap, no push.
 */
function moveSelectionCommandBar(delta: 1 | -1): void {
  if (commandBar.selectedIndex === -1) {
    return;
  }
  commandBar.selectedIndex = nextSelectedIndex(
    commandBar.selectedIndex,
    commandBar.suggestions.length,
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
function performSuggestion(s: Suggestion): void {
  switch (s.kind) {
    case "tab": {
      if (s.spaceId !== store.activeSpaceId) {
        store.setActiveSpace(s.spaceId);
      }
      // activateTab does store.activate + view reconcile + setActive (the
      // cross-space hide/show transition, since setActive hides every other
      // space's views) + broadcast.
      activateTab(s.tabId);
      return;
    }
    case "archived-tab": {
      if (s.spaceId !== store.activeSpaceId) {
        store.setActiveSpace(s.spaceId);
      }
      // After the space switch, store.list()/store.restore act on the now-active
      // owning space. Restore and materialize the view like the tabsRestore
      // handler before activating it.
      store.restore(s.tabId);
      if (!views.has(s.tabId)) {
        const tab = store.list().find((t) => t.id === s.tabId);
        if (tab !== undefined) {
          createViewFor(tab, store.activeSpaceId);
        }
      }
      activateTab(s.tabId);
      return;
    }
    case "space": {
      store.setActiveSpace(s.spaceId);
      ensureActiveView();
      broadcast();
      return;
    }
    case "navigate":
    case "search": {
      // Unreachable: acceptCommandBar routes the text kinds through
      // submitCommandBar itself and never calls performSuggestion for them.
      throw new Error(`performSuggestion received text kind "${s.kind}"`);
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
 * ({@link submitCommandBar} closes the open bar). The text kinds
 * (`navigate`/`search`) also route through {@link submitCommandBar} (which closes
 * the bar itself, so no extra close); every other kind runs
 * {@link performSuggestion} and then closes.
 */
function acceptCommandBar(index?: number): void {
  if (index !== undefined && (index < 0 || index >= commandBar.suggestions.length)) {
    throw new Error(`accept index out of range: ${index}`);
  }
  const idx = index ?? commandBar.selectedIndex;
  if (idx === -1) {
    submitCommandBar(commandBar.query);
    return;
  }
  const s = commandBar.suggestions[idx]!;
  if (s.kind === "navigate" || s.kind === "search") {
    submitCommandBar(commandBar.query, commandBar.mode);
    return;
  }
  performSuggestion(s);
  closeCommandBar();
}

/** Full close lifecycle: store removal, view teardown, re-activation, broadcast. */
function closeTab(id: string): void {
  // A thrown Error (e.g. unknown id) propagates out to the caller.
  store.close(id);
  destroyView(id);
  // MRU re-activation may land on a not-yet-materialized restored sibling tab,
  // so ensure its view exists before showing it (lazy restore).
  ensureActiveView();
  broadcast();
}

/**
 * Full permanent-delete lifecycle: store removal, view teardown, re-activation,
 * broadcast. Unlike {@link closeTab}, this works on an archived tab too (whose
 * hidden view is still parented in `views`), so the archived-tabs view can
 * delete a tab for good.
 */
function removeTab(id: string): void {
  // A thrown Error (e.g. unknown id) propagates out to the caller.
  store.remove(id);
  destroyView(id);
  // MRU re-activation may land on a not-yet-materialized restored sibling tab,
  // so ensure its view exists before showing it (lazy restore).
  ensureActiveView();
  broadcast();
}

/** Tears down and unparents the tracked view for `id`, if one exists. */
function destroyView(id: string): void {
  const tracked = views.get(id);
  if (tracked !== undefined) {
    win?.contentView.removeChildView(tracked.view);
    if (!tracked.view.webContents.isDestroyed()) {
      tracked.view.webContents.close();
    }
    views.delete(id);
    // Drop any retry marker so a stale id never lingers past its view.
    failedLoads.delete(id);
    // Drop the per-tab nav sequence and title-state so a reused id starts fresh.
    navSeq.delete(id);
    hasRealTitle.delete(id);
  }
}

function pinTab(id: string): void {
  store.pin(id);
  broadcast();
}

function unpinTab(id: string): void {
  store.unpin(id);
  broadcast();
}

function archiveTab(id: string): void {
  store.archive(id);
  // Archiving the active tab re-points active to an MRU sibling that may be a
  // not-yet-materialized restored tab, so ensure its view exists (lazy restore).
  ensureActiveView();
  broadcast();
}

/**
 * Full space-delete lifecycle. Validates deletability FIRST (unknown id or the
 * last remaining space → throw, so a rejected delete tears down no views), then
 * destroys EVERY view owned by the space (open and archived alike), then removes
 * the space from the store, then — only when the deleted space was active — runs
 * the same hide/show transition as a space activate for the newly active space,
 * then broadcasts. No orphaned views survive a delete.
 */
function deleteSpace(id: string): void {
  // Gate teardown on the store's OWN deletability predicate, so the rule is not
  // duplicated here. When the delete would reject (unknown id or the last
  // remaining space), defer to store.deleteSpace to throw the specific error
  // BEFORE any view is torn down — a rejected delete has no side effect.
  if (!store.canDeleteSpace(id)) {
    store.deleteSpace(id);
    return; // unreachable: canDeleteSpace() === false means deleteSpace() throws.
  }

  const wasActive = store.activeSpaceId === id;

  // Destroy every view owned by the space (open and archived). Snapshot the
  // entries first: destroyView mutates `views` as it goes.
  for (const [tabId, tracked] of [...views]) {
    if (tracked.spaceId === id) {
      destroyView(tabId);
    }
  }

  store.deleteSpace(id);

  if (wasActive) {
    // The store activated a surviving space; materialize its active tab's view
    // if the lazy restore never created one, then show it and hide the rest.
    ensureActiveView();
  }
  broadcast();
}

/**
 * Re-points a space at a different profile and migrates its live views onto the
 * new session partition. Electron cannot change a live WebContents' partition in
 * place, so every view the space owns is destroyed and recreated — the recreated
 * views resolve the NEW partition via {@link createViewFor}'s `spaceProfileId`
 * lookup.
 *
 */
function remapSpaceProfile(spaceId: string, profileId: string): void {
  // Nothing changes when the space already references this profile: no teardown,
  // no recreation, no broadcast.
  if (store.spaceProfileId(spaceId) === profileId) {
    return;
  }

  store.setSpaceProfile(spaceId, profileId);

  // Capture the exact tab ids whose views are on the OLD partition, from the LIVE
  // views map filtered by owning space — NOT from tabsOfSpace, which would
  // spuriously materialize views for archived tabs that currently have none.
  const tabIds = [...views]
    .filter(([, tracked]) => tracked.spaceId === spaceId)
    .map(([tabId]) => tabId);
  // tabsOfSpace supplies only the id→url lookup for the captured ids.
  const tabsById = new Map(store.tabsOfSpace(spaceId).map((t) => [t.id, t]));
  // Snapshot each live view's current url BEFORE teardown so recreation resumes
  // where the user was, not the tab's original creation url. getURL() returns ""
  // for a view that never finished loading.
  const liveUrls = new Map(
    tabIds.map((tabId) => {
      const wc = views.get(tabId)?.view.webContents;
      return [tabId, wc !== undefined && !wc.isDestroyed() ? wc.getURL() : ""] as const;
    }),
  );

  for (const tabId of tabIds) {
    destroyView(tabId);
  }

  for (const tabId of tabIds) {
    const tab = tabsById.get(tabId);
    if (tab !== undefined) {
      // Pass the captured url only when non-empty; otherwise fall back to tab.url.
      const liveUrl = liveUrls.get(tabId);
      createViewFor(tab, spaceId, liveUrl && liveUrl.length > 0 ? liveUrl : undefined);
    }
  }

  // Global active tab: hides an inactive space's recreated views, shows the
  // active one.
  setActive(store.activeTabId);
  broadcast();
}

/**
 * Shows the given tab's view, hides ALL others, and re-lays-out the active one.
 * Because it iterates every tracked view across all spaces, calling it after a
 * space switch with the incoming space's active tab id also hides the outgoing
 * space's views — the whole space-switch view transition.
 */
function setActive(id: string | null): void {
  for (const [tabId, tracked] of views) {
    const active = tabId === id;
    tracked.view.setVisible(active);
    if (active) {
      tracked.view.setBounds(viewBounds());
    }
  }
}

/** Pushes the current store snapshot to the renderer, then schedules a save. */
function broadcast(): void {
  win?.webContents.send(IPC.stateChange, store.snapshot());
  scheduleSave(store);
}

/**
 * Creates the active space's active-tab view if it has none yet (lazy restore),
 * then shows it and hides the rest. Every other restored tab materializes its
 * view on first activation.
 */
function ensureActiveView(): void {
  const activeTabId = store.activeTabId;
  if (activeTabId !== null && !views.has(activeTabId)) {
    const tab = store.list().find((t) => t.id === activeTabId);
    if (tab !== undefined) {
      createViewFor(tab, store.activeSpaceId);
    }
  }
  setActive(activeTabId);
}

/**
 * Activates a tab: selects it in the store, then reconciles its view — recreating
 * a missing view (e.g. a not-yet-materialized restored tab, so a numeric
 * activator shows a real page rather than blank) and retrying a view whose last
 * load failed — before showing it and broadcasting. Shared by the tabsActivate
 * IPC handler and the "Activate Tab N" menu items.
 */
function activateTab(id: string): void {
  store.activate(id);
  // Honor the remap contract: a tab whose view failed to be created or failed
  // to load is retried when the user next activates it. Recreate a missing
  // view; otherwise re-issue the load for a view whose last load failed.
  if (!views.has(id)) {
    const tab = store.list().find((t) => t.id === id);
    if (tab !== undefined) {
      createViewFor(tab, store.activeSpaceId);
    }
  } else if (failedLoads.has(id)) {
    const tracked = views.get(id);
    const tab = store.list().find((t) => t.id === id);
    if (tracked !== undefined && tab !== undefined) {
      destroyView(id);
      failedLoads.delete(id);
      createViewFor(tab, tracked.spaceId);
    }
  }
  setActive(id);
  broadcast();
}

/**
 * Runs the idle auto-archive policy and, only if it archived something,
 * re-points the visible view (the active tab is exempt, so this is normally a
 * no-op) and broadcasts. Skipping the broadcast on an empty sweep keeps the
 * hourly timer from churning the renderer when nothing changed.
 */
function sweepIdle(): void {
  const archived = store.archiveIdleAll(IDLE_THRESHOLD_MS);
  if (archived.length > 0) {
    // Only the active space's active tab is ever visible; archived tabs in
    // inactive spaces are already hidden, so re-pointing the active view covers
    // the visible side of the sweep.
    setActive(store.activeTabId);
    broadcast();
  }
}

function showTabContextMenu(id: string, x: number, y: number): TabContextMenuResult {
  const tab = store.list().find((t) => t.id === id);
  if (tab === undefined) {
    return { tabId: id, items: [] };
  }

  const actions: { id: string; label: string; enabled: boolean; click: () => void }[] = [
    {
      id: tab.pinned ? "unpin" : "pin",
      label: tab.pinned ? "Unpin" : "Pin",
      enabled: true,
      click: () => (tab.pinned ? unpinTab(id) : pinTab(id)),
    },
    {
      id: "archive",
      label: "Archive",
      enabled: !tab.pinned,
      click: () => archiveTab(id),
    },
    {
      id: "close",
      label: "Close",
      enabled: true,
      click: () => closeTab(id),
    },
    {
      id: "copyUrl",
      label: "Copy URL",
      enabled: true,
      click: () => clipboard.writeText(tab.url),
    },
  ];

  const items: TabContextMenuResult["items"] = actions.map(({ id: actionId, label, enabled }) => ({
    id: actionId,
    label,
    enabled,
  }));

  // Gate the native popup so headless e2e never blocks on it.
  if (process.env.ZEO_E2E !== "1" && win !== null) {
    const menu = Menu.buildFromTemplate(
      actions.map((a): MenuItemConstructorOptions => ({
        label: a.label,
        enabled: a.enabled,
        click: () => {
          try {
            a.click();
          } catch (err: unknown) {
            console.error(`context-menu action "${a.id}" failed:`, err);
          }
        },
      })),
    );
    // x/y are window-relative (the renderer passes clientX/clientY); popup's
    // x/y are window-relative too, so no screen conversion is needed.
    menu.popup({ window: win, x, y });
  }

  return { tabId: id, items };
}

/**
 * Builds a space's context-menu descriptor and, outside headless e2e, pops the
 * native menu for it. Mirrors {@link showTabContextMenu}: an unknown id returns
 * an empty descriptor (and skips the throwing store reads), the descriptor is
 * built purely by core's `buildSpaceContextMenu`, and the returned descriptor is
 * the assertable seam. The native popup is dispatched by stable item id — rename
 * and new-profile push a `spaceMenuAction` to the renderer for inline editing,
 * delete and profile-assignment resolve entirely in main.
 */
function showSpaceContextMenu(id: string, x: number, y: number): SpaceContextMenuResult {
  if (!store.spaces().some((s) => s.id === id)) {
    return { spaceId: id, items: [] };
  }

  const result = buildSpaceContextMenu({
    spaceId: id,
    profiles: store.profiles(),
    tabCount: store.tabsOfSpace(id).length,
    currentProfileId: store.spaceProfileId(id),
    canDelete: store.canDeleteSpace(id),
  });

  // Gate the native popup so headless e2e never blocks on it. win is non-null in
  // this branch, so the webContents.send calls below are safe.
  if (process.env.ZEO_E2E !== "1" && win !== null) {
    const popWin = win;
    const menu = Menu.buildFromTemplate(
      result.items.map((item): MenuItemConstructorOptions => {
        const wrap = (actionId: string, body: () => void) => (): void => {
          try {
            body();
          } catch (err: unknown) {
            console.error(`space context-menu action "${actionId}" failed:`, err);
          }
        };
        if (item.id === "rename") {
          return {
            label: item.label,
            enabled: item.enabled,
            click: wrap(item.id, () =>
              popWin.webContents.send(IPC.spaceMenuAction, { action: "rename", spaceId: id }),
            ),
          };
        }
        if (item.id === "delete") {
          return {
            label: item.label,
            enabled: item.enabled,
            click: wrap(item.id, () => deleteSpace(id)),
          };
        }
        // item.id === "profile": the submenu parent.
        return {
          label: item.label,
          enabled: item.enabled,
          submenu: (item.submenu ?? []).map((child): MenuItemConstructorOptions => {
            if (child.id === "new-profile") {
              return {
                label: child.label,
                enabled: child.enabled,
                click: wrap(child.id, () =>
                  popWin.webContents.send(IPC.spaceMenuAction, { action: "new-profile", spaceId: id }),
                ),
              };
            }
            const pid = child.id.slice("profile:".length);
            return {
              label: child.label,
              enabled: child.enabled,
              type: "radio",
              checked: child.checked === true,
              click: wrap(child.id, () => remapSpaceProfile(id, pid)),
            };
          }),
        };
      }),
    );
    // x/y are window-relative (the renderer passes clientX/clientY); popup's
    // x/y are window-relative too, so no screen conversion is needed.
    menu.popup({ window: popWin, x, y });
  }

  return result;
}

/**
 * Creates the main window and its renderer. When `seed` is true and no open tab
 * exists, seeds the default first tab (a fresh launch); a restored launch and a
 * macOS re-activate pass `seed: false`. Restored tabs are NOT eagerly given
 * views — only the active tab's view is materialized here (lazy restore), and
 * every other tab materializes on first activation.
 */
function createWindow(seed: boolean): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  // Dev vs prod must NOT use app.isPackaged: Playwright launches an unpackaged
  // build. electron-vite sets ELECTRON_RENDERER_URL only in dev.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined && rendererUrl !== "") {
    const loadDev = (attempt: number): void => {
      win?.loadURL(rendererUrl).catch(() => {
        if (attempt < 20) {
          setTimeout(() => loadDev(attempt + 1), 500);
        }
      });
    };
    loadDev(0);
  } else {
    void win.loadFile(join(moduleDir, "../renderer/index.html"));
  }

  // Create the command-bar overlay ONCE, before any tab view is materialized, so
  // createViewFor's topmost re-add always has a target. Same webPreferences as the
  // window and no partition (default session, like the sidebar). It stays parented
  // and hidden until the bar opens. Load the same renderer bundle with a
  // ?view=command-bar marker, mirroring the window's dev/prod branch above.
  overlay = new WebContentsView({
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(overlay);
  overlay.setVisible(false);
  if (rendererUrl !== undefined && rendererUrl !== "") {
    overlay.webContents.loadURL(rendererUrl + "?view=command-bar").catch(() => {
      // Dev-server races are retried by the window's loadDev loop; the overlay
      // shares the same bundle, so a transient failure here is non-fatal.
    });
  } else {
    void overlay.webContents.loadFile(join(moduleDir, "../renderer/index.html"), {
      query: { view: "command-bar" },
    });
  }
  // Click on the page or sidebar (overlay loses focus) dismisses the bar.
  // closeCommandBar is idempotent, so the focus return it performs never recurses.
  overlay.webContents.on("blur", () => {
    closeCommandBar();
  });

  win.on("resize", () => {
    const active = store.activeTabId;
    if (active !== null) {
      views.get(active)?.view.setBounds(viewBounds());
    }
    if (commandBar.open) {
      layoutOverlay();
    }
  });

  // Window lost OS focus → dismiss the command bar.
  win.on("blur", () => {
    closeCommandBar();
  });

  // Re-stamp the active tab's lastActiveAt on window focus so a tab left focused
  // (e.g. overnight) is never swept by the idle policy. This changes no visible
  // state, so it does not broadcast.
  win.on("focus", () => {
    const active = store.activeTabId;
    if (active !== null) {
      store.activate(active);
    }
  });

  win.on("closed", () => {
    for (const { view } of views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    }
    views.clear();
    overlay = null;
    win = null;
  });

  // Seed the first tab into the active (seeded "Personal") space only on a fresh
  // launch with no open tab. A restored or re-activated launch keeps its state
  // and does not seed. Views are created lazily: only the active tab's view is
  // materialized now; every other tab gets its view on first activation.
  if (seed && store.allOpenTabs().length === 0) {
    store.create({ url: DEFAULT_URL, title: titleForUrl(DEFAULT_URL) });
  }
  ensureActiveView();
  broadcast();
}

ipcMain.handle(IPC.tabsCreate, (_event, url?: string): Tab => createTab(url));

ipcMain.handle(IPC.tabsClose, (_event, id: string): void => {
  // A thrown Error (e.g. unknown id) propagates out of the handler and
  // ipcMain.handle rejects the renderer's invoke instead of crashing main.
  closeTab(id);
});

ipcMain.handle(IPC.tabsActivate, (_event, id: string): void => {
  activateTab(id);
});

ipcMain.handle(IPC.tabsList, (): TabsState => store.snapshot());

// pin/unpin/reorder only change ordering — no view create/destroy and no active
// change, so broadcast() alone suffices. A thrown Error (unknown id, archived,
// non-integer index, …) propagates out and rejects the renderer's invoke.
ipcMain.handle(IPC.tabsPin, (_event, id: string): void => {
  pinTab(id);
});

ipcMain.handle(IPC.tabsUnpin, (_event, id: string): void => {
  unpinTab(id);
});

ipcMain.handle(IPC.tabsReorder, (_event, id: string, toIndex: number): void => {
  store.reorder(id, toIndex);
  broadcast();
});

ipcMain.handle(IPC.tabsArchive, (_event, id: string): void => {
  // A thrown Error (e.g. archiving a pinned tab) propagates out and rejects the
  // renderer's invoke, consistent with the other handlers.
  archiveTab(id);
});

ipcMain.handle(IPC.tabsRestore, (_event, id: string): void => {
  store.restore(id);
  if (!views.has(id)) {
    const tab = store.list().find((t) => t.id === id);
    if (tab !== undefined) {
      createViewFor(tab, store.activeSpaceId);
    }
  }
  setActive(store.activeTabId);
  broadcast();
});

// Permanent delete: drop the tab from the store and tear down its view. A thrown
// Error (e.g. unknown id) propagates out and rejects the renderer's invoke.
ipcMain.handle(IPC.tabsRemove, (_event, id: string): void => {
  removeTab(id);
});

ipcMain.handle(
  IPC.tabsContextMenu,
  (_event, id: string, x: number, y: number): TabContextMenuResult =>
    showTabContextMenu(id, x, y),
);

// --- Command bar --------------------------------------------------------------
// tabsNavigate throws (rejecting the invoke) on an unknown/non-active-space id,
// like the other tab commands. The command-bar handlers drive the single overlay
// controller; commandBarState reads the current state back synchronously.
ipcMain.handle(IPC.tabsNavigate, (_event, id: string, url: string): void => {
  navigateTab(id, url);
});

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
ipcMain.handle(IPC.commandBarAccept, (_event, index?: number): void => {
  acceptCommandBar(index);
});

ipcMain.handle(IPC.commandBarState, (): CommandBarState => commandBar);

// --- Space commands -----------------------------------------------------------
// The renderer's single UI bridge drives these; tab WebContentsViews have no
// bridge and cannot dispatch. A thrown Error (unknown/last space) propagates out
// and rejects the renderer's invoke, exactly like the tab handlers.

ipcMain.handle(IPC.spacesCreate, (_event, name: string): Space => {
  const space = store.createSpace(name);
  // Active space (and thus the visible view) is unchanged by a create.
  broadcast();
  return space;
});

ipcMain.handle(IPC.spacesRename, (_event, id: string, name: string): void => {
  store.renameSpace(id, name);
  broadcast();
});

ipcMain.handle(IPC.spacesActivate, (_event, id: string): void => {
  store.setActiveSpace(id);
  // Hide the outgoing space's views and show the incoming space's active tab,
  // materializing that tab's view if the restored space never had one.
  ensureActiveView();
  broadcast();
});

ipcMain.handle(IPC.spacesDelete, (_event, id: string): void => {
  deleteSpace(id);
});

ipcMain.handle(IPC.spacesSetProfile, (_event, spaceId: string, profileId: string): void => {
  remapSpaceProfile(spaceId, profileId);
});

ipcMain.handle(IPC.profilesCreate, (_event, name: string): Profile => {
  const profile = store.createProfile(name);
  broadcast();
  return profile;
});

ipcMain.handle(IPC.profilesRename, (_event, id: string, name: string): void => {
  store.renameProfile(id, name);
  broadcast();
});

ipcMain.handle(IPC.profilesDelete, async (_event, id: string): Promise<void> => {
  // Throws before any mutation on a rejected delete (default profile, unknown
  // id, or still referenced by a space), so a rejected delete never wipes a
  // live partition.
  store.deleteProfile(id);
  broadcast();
  // The profile record is gone, so nothing can reach persist:<id> again — drop
  // its on-disk cookies/storage/cache instead of orphaning them forever.
  const doomed = session.fromPartition("persist:" + id);
  try {
    await doomed.clearStorageData();
    await doomed.clearCache();
  } catch (err: unknown) {
    console.error(`failed to clear session data for deleted profile ${id}:`, err);
  }
});

ipcMain.handle(
  IPC.spacesContextMenu,
  (_event, id: string, x: number, y: number): SpaceContextMenuResult =>
    showSpaceContextMenu(id, x, y),
);

ipcMain.handle(IPC.spacesList, (): SpacesState => store.spacesSnapshot());

/**
 * Builds and installs the application menu. Accelerators here are
 * application-level, so they fire whether focus is in the sidebar renderer or
 * inside a tab's WebContentsView — the reason we use a Menu rather than
 * globalShortcut / before-input-event (both forbidden by the PRD).
 */
function buildMenu(): void {
  const activateItems: MenuItemConstructorOptions[] = Array.from(
    { length: 9 },
    (_unused, i): MenuItemConstructorOptions => ({
      label: `Activate Tab ${i + 1}`,
      accelerator: `CmdOrCtrl+Alt+${i + 1}`,
      visible: false,
      click: () => {
        const tabs = store.list();
        const target = tabs[i];
        if (target !== undefined) {
          activateTab(target.id);
        }
      },
    }),
  );

  const tabsSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "New Tab",
      accelerator: "CmdOrCtrl+T",
      // Open the command bar in new-tab mode instead of immediately creating a
      // tab, so the user types the destination first.
      click: () => {
        openCommandBar("new-tab");
      },
    },
    {
      label: "Open Location",
      accelerator: "CmdOrCtrl+L",
      // Open the command bar in navigate mode, prefilled with the active tab's url.
      click: () => {
        openCommandBar("navigate");
      },
    },
    {
      label: "Close Tab",
      accelerator: "CmdOrCtrl+W",
      click: () => {
        const id = store.activeTabId;
        if (id !== null) {
          closeTab(id);
        }
      },
    },
    { type: "separator" },
    ...activateItems,
  ];

  const activateSpaceItems: MenuItemConstructorOptions[] = Array.from(
    { length: 9 },
    (_unused, i): MenuItemConstructorOptions => ({
      label: `Activate Space ${i + 1}`,
      accelerator: `CmdOrCtrl+${i + 1}`,
      visible: false,
      click: () => {
        const target = store.spaces()[i];
        if (target !== undefined) {
          store.setActiveSpace(target.id);
          ensureActiveView();
          broadcast();
        }
      },
    }),
  );

  const spacesSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "New Space",
      accelerator: "CmdOrCtrl+Shift+N",
      // Create a default-named space, make it active, then run the same
      // hide/show transition as a space switch and broadcast the new snapshot.
      click: () => {
        const space = store.createSpace(defaultSpaceName(store.spaces()));
        store.setActiveSpace(space.id);
        setActive(store.activeTabId);
        broadcast();
      },
    },
    { type: "separator" },
    ...activateSpaceItems,
  ];

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu (role: appMenu) provides the standard about/quit set;
    // omitting it on darwin would strip Cmd+Q and friends.
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" } as MenuItemConstructorOptions]
      : []),
    { label: "Tabs", submenu: tabsSubmenu },
    { label: "Spaces", submenu: spacesSubmenu },
    // editMenu preserves undo/redo/cut/copy/paste/selectAll accelerators so web
    // contents keep Cmd/Ctrl+C/V/X/A.
    { role: "editMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Restore from disk if a prior session was persisted; otherwise start empty and
  // let createWindow seed the first tab.
  const restored = loadStore();
  const restoredFromDisk = restored !== null;
  if (restored !== null) {
    store = restored;
    // Reset the idle clock to relaunch time so restored non-active tabs are not
    // archived by the recurring sweep just because the app was closed: re-base
    // every open tab's lastActiveAt so the most-recently-active one sits at now.
    store.rebaseActivity(Date.now());
  }
  buildMenu();
  createWindow(!restoredFromDisk);
  // Skip the launch sweep on a restored session: its tabs' persisted
  // lastActiveAt are stale by design (the app was closed), so an initial sweep
  // would wrongly auto-archive every non-active restored tab. The recurring
  // interval sweep still runs unconditionally.
  if (!restoredFromDisk) {
    sweepIdle();
  }
  setInterval(sweepIdle, SWEEP_INTERVAL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // A re-activate must never seed: the in-memory store already reflects the
      // user's state (even if all tabs are archived).
      createWindow(false);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Capture the final store snapshot synchronously at quit, so a mutation that
// never broadcast (e.g. the window-focus lastActiveAt re-stamp) is still saved.
app.on("before-quit", () => {
  flush(store);
});
