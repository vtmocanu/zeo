import { app, BrowserWindow, WebContentsView, clipboard, ipcMain, Menu, session } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
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
  COMMANDS,
  isCommandEnabled,
  menuEntries,
  initialBlockingState,
  applyBlockedRequest,
  applyUnattributedBlock,
  resetBlockedCount,
  dropBlockedTab,
} from "@zeo/core";
import type {
  BlockingState,
  CommandBarMode,
  CommandBarState,
  CommandContext,
  CommandDescriptor,
  CommandId,
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
import { createBlocker, createBlockerFromFilters } from "@zeo/adblock";
import type { Blocker } from "@zeo/adblock";
import { loadStore, scheduleSave, flush, readBlockingEnabled, writeBlockingEnabled } from "./db.js";

// The built main is emitted by electron-vite as ESM (out/main/index.js, the
// package is "type": "module"), so `__dirname` is not defined — derive it from
// import.meta.url. Preload and renderer are resolved as siblings of the main
// file's directory (out/preload/index.cjs, out/renderer/index.html).
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the cosmetic-filtering frame preload, shipped as a sibling of
 * the main bundle (out/preload/cosmetic-preload.cjs, copied by
 * scripts/copy-renderer.mjs). Passed to the blocker via `internals.preloadPath`;
 * the wrapper registers it on each attached profile session. Resolved the same
 * way as the renderer preload above.
 */
const cosmeticPreloadPath = join(moduleDir, "../preload/cosmetic-preload.cjs");

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
  revision: 0,
};
/**
 * Monotonic source for {@link CommandBarState.revision}. Bumped whenever the
 * suggestion list is recomputed or cleared, so an accept carrying a clicked
 * row's rendered revision can be matched against the list currently in effect.
 */
let commandBarRevision = 0;
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

/**
 * The single app-lifetime {@link Blocker}, or `null` before the engine has
 * loaded (the 3 s startup cap elapsed with no cache yet) — a null blocker blocks
 * nothing, the empty engine the PRD allows. The real engine swaps in via the
 * cap race's `then` when it arrives.
 */
let blocker: Blocker | null = null;
/**
 * The content-blocking slice main owns and attaches to every broadcast snapshot.
 * Seeded here and replaced at startup with the persisted `enabled` value.
 */
let blocking: BlockingState = initialBlockingState(true, "none");
/**
 * Reverse index `webContents.id -> tabId` for attributing a blocked request to
 * the tab that issued it. Populated in {@link createViewFor}, dropped in
 * {@link destroyView}.
 */
const webContentsToTab = new Map<number, string>();
/**
 * Forward index `tabId -> webContents.id`, the teardown counterpart to
 * {@link webContentsToTab}. It lets {@link destroyView} drop the reverse-index
 * entry by the id captured at creation, independent of whether the webContents is
 * still alive (a destroyed webContents' `id` is inaccessible), so the reverse
 * index never orphans an entry on teardown. Populated in {@link createViewFor}.
 */
const tabToWcId = new Map<string, number>();
/**
 * Per-tab last committed top-level origin, for the navigation reset: a
 * `did-navigate` to a DIFFERENT origin resets that tab's blocked count.
 */
const tabOrigin = new Map<string, string>();
/**
 * Coalescing timer for blocking-only broadcasts (a page loading many blocked
 * resources must not flood the renderer). `null` when no push is pending.
 */
let blockingBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalescing window for {@link scheduleBlockingBroadcast}, in milliseconds. */
const BLOCKING_BROADCAST_MS = 250;

/**
 * The Electron sessions for every profile partition (`persist:<profileId>`), the
 * set the blocker attaches to. Derived from the store's profiles on each call so
 * a newly created profile is covered the next time it runs.
 */
function profileSessions(): Electron.Session[] {
  return store.profiles().map((p) => session.fromPartition("persist:" + p.id));
}

/**
 * The full broadcast snapshot: the store snapshot plus the blocking slice, with
 * `listVersion` read LIVE off the blocker so a background refresh's new version
 * surfaces on the next push with no extra observation.
 */
function fullSnapshot(): TabsState {
  return {
    ...store.snapshot(),
    blocking: { ...blocking, listVersion: blocker?.listVersion ?? blocking.listVersion },
  };
}

/**
 * Pushes the blocking-updated snapshot to the renderer, coalesced to at most one
 * push per {@link BLOCKING_BROADCAST_MS}. Unlike {@link broadcast} this does NOT
 * schedule a store save — a blocked request changes no persisted store state.
 */
function scheduleBlockingBroadcast(): void {
  if (blockingBroadcastTimer !== null) {
    return;
  }
  blockingBroadcastTimer = setTimeout(() => {
    blockingBroadcastTimer = null;
    win?.webContents.send(IPC.stateChange, fullSnapshot());
  }, BLOCKING_BROADCAST_MS);
}

/**
 * Subscribes to the blocker's blocked events: a hit in the reverse index
 * attributes the block to that tab, a miss (a torn-down view or a non-tab
 * renderer) is counted as unattributed so a wrong mapping is visible in tests.
 */
function wireOnBlocked(b: Blocker): void {
  b.onBlocked(({ webContentsId }) => {
    const tabId = webContentsToTab.get(webContentsId);
    blocking =
      tabId !== undefined
        ? applyBlockedRequest(blocking, tabId)
        : applyUnattributedBlock(blocking);
    scheduleBlockingBroadcast();
  });
}

/** Attaches the blocker to every profile session (idempotent per session). */
function attachBlockerToAllSessions(b: Blocker): void {
  for (const s of profileSessions()) {
    b.attach(s);
  }
}

/**
 * The ordered set-enabled contract (PRD 5.1 §2): (1) no-op when the value is
 * unchanged; (2) persist synchronously — a throw propagates with nothing else
 * changed; (3) attach/detach every profile session, reverting the sessions
 * already changed AND the persisted value on any throw; (4) update the in-memory
 * flag and broadcast. attach/detach are idempotent, so the revert is safe. When
 * `blocker` is null during the startup cap window the session loop is a no-op but
 * the flag still flips; the cap race's `then` then attaches per `blocking.enabled`.
 */
async function setBlockingEnabled(enabled: boolean): Promise<void> {
  // Reachable from the renderer over IPC.blockingSetEnabled with an untrusted
  // payload: reject a non-boolean BEFORE any persistence or state change so a
  // malformed payload can never persist/broadcast a non-boolean. The IPC handler
  // returns this promise, so the rejection surfaces to the renderer's invoke.
  if (typeof enabled !== "boolean") {
    throw new TypeError("blocking.setEnabled expects a boolean");
  }
  if (enabled === blocking.enabled) {
    return;
  }
  writeBlockingEnabled(enabled);
  const sessions = profileSessions();
  const done: Electron.Session[] = [];
  try {
    for (const s of sessions) {
      if (blocker) {
        if (enabled) {
          blocker.attach(s);
        } else {
          blocker.detach(s);
        }
      }
      done.push(s);
    }
  } catch (err) {
    for (const s of done) {
      if (blocker) {
        if (enabled) {
          blocker.detach(s);
        } else {
          blocker.attach(s);
        }
      }
    }
    writeBlockingEnabled(blocking.enabled);
    throw err;
  }
  blocking = { ...blocking, enabled };
  broadcast();
}

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
  // Reverse index for blocked-request attribution: this view's webContents id
  // maps to its tab. Removed in destroyView. The parallel forward index records
  // the same id keyed by tab so teardown can drop the reverse entry even after
  // the webContents is destroyed (its id would then be inaccessible).
  webContentsToTab.set(view.webContents.id, tab.id);
  tabToWcId.set(tab.id, view.webContents.id);
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

  // Blocked-count reset on a TOP-LEVEL navigation to a DIFFERENT origin (never
  // did-navigate-in-page, an in-document hash/pushState change). The per-tab
  // count is scoped to "since the tab was created or last navigated to a new
  // origin", so crossing origins clears it.
  view.webContents.on("did-navigate", (_event, url) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return; // Unparseable url (e.g. about:blank): leave the count as-is.
    }
    if (tabOrigin.get(tab.id) !== origin) {
      blocking = resetBlockedCount(blocking, tab.id);
      scheduleBlockingBroadcast();
      tabOrigin.set(tab.id, origin);
    }
  });

  // History flags (canGoBack/canGoForward) settle only after a load finishes, so
  // refresh the menu and the open bar's command enablement then. The
  // did-navigate handlers above already broadcast, covering the url side.
  view.webContents.on("did-finish-load", () => {
    refreshCommandState();
  });

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
 * Builds the current {@link CommandContext} from the store and the active view.
 * `spaceCount` is the number of spaces; `activeTab` is `null` when no tab is
 * active, otherwise the active tab's `pinned` flag plus its live navigation
 * history flags read from the active view's non-deprecated `navigationHistory`
 * API (both `false` when the view is missing, but `activeTab` is still non-null).
 */
function commandContextOf(): CommandContext {
  const spaceCount = store.spaces().length;
  const activeTabId = store.activeTabId;
  if (activeTabId === null) {
    return { activeTab: null, spaceCount };
  }
  const tab = store.list().find((t) => t.id === activeTabId);
  const wc = views.get(activeTabId)?.view.webContents;
  return {
    activeTab: {
      pinned: tab?.pinned ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    },
    spaceCount,
  };
}

/**
 * The one handler per {@link CommandId}, called only by {@link executeCommand}
 * (which gates enablement first, so the `!`/no-op guards here never run on a
 * disabled command). Each handler reuses the existing store/view helper for its
 * action, so command dispatch and the old menu/context-menu paths stay in step.
 */
const commandHandlers: Record<CommandId, () => void> = {
  "tab.new": () => openCommandBar("new-tab"),
  "tab.close": () => closeTab(store.activeTabId!),
  "tab.pin": () => pinTab(store.activeTabId!),
  "tab.unpin": () => unpinTab(store.activeTabId!),
  "tab.archive": () => archiveTab(store.activeTabId!),
  "tab.copy-url": () => {
    const tab = store.list().find((t) => t.id === store.activeTabId);
    if (tab !== undefined) {
      clipboard.writeText(tab.url);
    }
  },
  "tab.reload": () => views.get(store.activeTabId!)?.view.webContents.reload(),
  "tab.back": () => views.get(store.activeTabId!)?.view.webContents.navigationHistory.goBack(),
  "tab.forward": () => views.get(store.activeTabId!)?.view.webContents.navigationHistory.goForward(),
  "space.new": () => {
    const space = store.createSpace(defaultSpaceName(store.spaces()));
    store.setActiveSpace(space.id);
    setActive(store.activeTabId);
    broadcast();
  },
  "space.rename": () =>
    win?.webContents.send(IPC.spaceMenuAction, { action: "rename", spaceId: store.activeSpaceId }),
  "space.delete": () => deleteSpace(store.activeSpaceId),
  "bar.open-location": () => openCommandBar("navigate"),
  "bar.open-commands": () => {
    if (commandBar.open && commandBar.mode === "commands") {
      closeCommandBar();
    } else {
      openCommandBar("commands");
    }
  },
  "blocking.toggle": () => {
    setBlockingEnabled(!blocking.enabled).catch((err) => {
      console.error("[blocking] toggle failed:", err);
    });
  },
};

/**
 * The single checked dispatch boundary. Builds the current context, throws for
 * an unknown id or a command disabled in that context (rejecting a stale menu
 * click, a stale accepted row, or a bad/disabled `commands.run`), and only then
 * runs the handler. Every dispatch path goes through here.
 */
function executeCommand(id: CommandId): void {
  const context = commandContextOf();
  const handler = commandHandlers[id] as (() => void) | undefined;
  if (handler === undefined || !COMMANDS.some((c) => c.id === id)) {
    throw new Error(`unknown command: ${id}`);
  }
  if (!isCommandEnabled(id, context)) {
    throw new Error(`command disabled in current context: ${id}`);
  }
  handler();
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
function refreshCommandState(): void {
  buildMenu();
  if (commandBar.open) {
    recomputeSuggestions();
    layoutOverlay();
    pushCommandBar();
  }
}

/**
 * Snapshots the store into the plain, store-free {@link SuggestCatalog} that
 * {@link suggest} ranks over: every space (flagged `active`), every open tab, and
 * every archived tab, each carrying its owning space's id and name. Rebuilt on
 * every keystroke so the ranked list always reflects the live store.
 */
function buildCatalog(): SuggestCatalog {
  const spaceNameById = new Map(store.spaces().map((s) => [s.id, s.name]));
  // Compute the context once per call and reuse it for every command's enablement.
  const context = commandContextOf();
  return {
    commands: COMMANDS.map((c) => ({
      id: c.id,
      title: c.title,
      keywords: c.keywords,
      accelerator: c.accelerator,
      enabled: isCommandEnabled(c.id, context),
    })),
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
  const previous = commandBar.suggestions;
  commandBar.suggestions = suggest(commandBar.query, buildCatalog(), {
    mode: commandBar.mode,
    activeTabId: store.activeTabId,
  });
  commandBar.selectedIndex = commandBar.suggestions.length > 0 ? 0 : -1;
  // A CHANGED list gets a fresh revision so a click bound to a prior list is
  // recognized as stale by acceptCommandBar. An identical list keeps its
  // revision, so an unrelated broadcast (title/favicon/navigation) that re-ranks
  // to the same suggestions never invalidates a pending row click.
  if (JSON.stringify(previous) !== JSON.stringify(commandBar.suggestions)) {
    commandBar.revision = ++commandBarRevision;
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
    revision: commandBar.revision,
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
    // Clearing the list bumps the revision so a click that raced the close is
    // rejected rather than resolved against the now-empty list.
    revision: ++commandBarRevision,
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
 * Resolves `text` and performs the command-bar action. A `commands` effective
 * mode (the passed `mode`, else the open bar's mode, else `"navigate"`) rejects
 * (throws) and changes nothing — commands mode has no text action and the bar
 * stays open. Otherwise a null resolution (empty or whitespace-only input) closes
 * the bar without navigating, and a resolved target either navigates the active
 * tab or creates a new tab (the effective mode downgraded to `"new-tab"` when
 * there is no active tab), then closes the bar if it was open.
 */
function submitCommandBar(text: string, mode?: CommandBarMode): void {
  const requestedMode: CommandBarMode = mode ?? (commandBar.open ? commandBar.mode : "navigate");
  if (requestedMode === "commands") {
    throw new Error("submit is not valid in commands mode");
  }
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
function acceptCommandBar(index?: number, revision?: number): void {
  if (index !== undefined && revision !== undefined && revision !== commandBar.revision) {
    throw new Error(`accept revision stale: ${revision} !== ${commandBar.revision}`);
  }
  if (index !== undefined && (index < 0 || index >= commandBar.suggestions.length)) {
    throw new Error(`accept index out of range: ${index}`);
  }
  const idx = index ?? commandBar.selectedIndex;
  if (idx === -1) {
    // Commands mode has no text action: a no-match query simply leaves the bar
    // open rather than routing to submit (which rejects in commands mode).
    if (commandBar.mode === "commands") {
      return;
    }
    submitCommandBar(commandBar.query);
    return;
  }
  const s = commandBar.suggestions[idx]!;
  if (s.kind === "navigate" || s.kind === "search") {
    submitCommandBar(commandBar.query, commandBar.mode);
    return;
  }
  if (s.kind === "command") {
    // executeCommand throws on a stale/disabled command; the throw propagates
    // and the invoke rejects with the bar untouched (do not catch it).
    executeCommand(s.id);
    // bar.open-location, tab.new, and bar.open-commands re-open or switch the
    // bar (openCommandBar sets open:true unconditionally; bar.open-commands
    // switches into commands mode), so closing here would immediately dismiss
    // the just-opened bar. Every other command closes it.
    if (s.id !== "bar.open-location" && s.id !== "tab.new" && s.id !== "bar.open-commands") {
      closeCommandBar();
    }
    return;
  }
  performSuggestion(s);
  closeCommandBar();
}

/** Full close lifecycle: store removal, view teardown, re-activation, broadcast. */
function closeTab(id: string): void {
  // A thrown Error (e.g. unknown id) propagates out to the caller.
  store.close(id);
  // Real tab removal: drop the blocked count and the origin marker for good.
  blocking = dropBlockedTab(blocking, id);
  tabOrigin.delete(id);
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
  // Real tab removal: drop the blocked count and the origin marker for good.
  blocking = dropBlockedTab(blocking, id);
  tabOrigin.delete(id);
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
    // Drop the reverse-index entry via the forward index, so the entry is removed
    // even when the webContents is already destroyed (its `id` would then be
    // inaccessible). NOT the blocked COUNT: a remap or activate-retry recreates
    // the same tab, so the count survives a view teardown and is dropped only on
    // real tab removal (close/remove/delete).
    const wcId = tabToWcId.get(id);
    if (wcId !== undefined) {
      webContentsToTab.delete(wcId);
    }
    tabToWcId.delete(id);
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

  // Every tab id the delete will remove (open + archived) — captured BEFORE the
  // store drops the space — so their blocked counts and origin markers can be
  // dropped for good, mirroring closeTab/removeTab.
  const removedTabIds = store.tabsOfSpace(id).map((t) => t.id);

  // Destroy every view owned by the space (open and archived). Snapshot the
  // entries first: destroyView mutates `views` as it goes.
  for (const [tabId, tracked] of [...views]) {
    if (tracked.spaceId === id) {
      destroyView(tabId);
    }
  }

  store.deleteSpace(id);

  for (const tabId of removedTabIds) {
    blocking = dropBlockedTab(blocking, tabId);
    tabOrigin.delete(tabId);
  }

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

  // The recreated views below load on the NEW partition; attach the blocker to
  // it so they are filtered from their first request (enabled + engine loaded).
  if (blocking.enabled && blocker) {
    blocker.attach(session.fromPartition("persist:" + profileId));
  }

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
  win?.webContents.send(IPC.stateChange, fullSnapshot());
  scheduleSave(store);
  // Every active-tab/active-space/store change can change command enablement and
  // the pin/unpin menu label, so refresh the menu (and the open bar) here.
  refreshCommandState();
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
      // A resize that grows a too-short window can bring a previously collapsed
      // (all-zero rect) overlay back into view. Focus is returned to the overlay
      // only on that hidden→visible transition, so a resize of an already-shown
      // bar never steals focus from the input mid-typing.
      const wasVisible = overlay?.getVisible() ?? false;
      const shown = layoutOverlay();
      if (shown && !wasVisible) {
        overlay?.webContents.focus();
      }
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

ipcMain.handle(IPC.tabsList, (): TabsState => fullSnapshot());

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
ipcMain.handle(IPC.commandBarAccept, (_event, index?: number, revision?: number): void => {
  acceptCommandBar(index, revision);
});

ipcMain.handle(IPC.commandBarState, (): CommandBarState => commandBar);

// --- Command registry ---------------------------------------------------------
// list() returns the registry verbatim; run() dispatches through the single
// checked boundary executeCommand, which throws (rejecting the invoke) on an
// unknown id or a command disabled in the current context.
ipcMain.handle(IPC.commandsList, (): CommandDescriptor[] => [...COMMANDS]);

ipcMain.handle(IPC.commandsRun, (_event, id: CommandId): void => {
  executeCommand(id);
});

// --- Content blocking ---------------------------------------------------------
// setEnabled runs the ordered set-enabled contract (persist → attach/detach →
// broadcast) and rejects the invoke on a persistence/session failure; state()
// reads back the live blocking slice (listVersion derived off the blocker).
ipcMain.handle(IPC.blockingSetEnabled, (_event, enabled: boolean): Promise<void> =>
  setBlockingEnabled(enabled),
);

ipcMain.handle(IPC.blockingState, (): BlockingState => fullSnapshot().blocking);

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
  // Cover the new partition so views created on it are filtered from their first
  // request (only while blocking is enabled and the engine has loaded).
  if (blocking.enabled && blocker) {
    blocker.attach(session.fromPartition("persist:" + profile.id));
  }
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

  // Registry-generated menu items for a given submenu name: menuEntries collapses
  // the pin/unpin accelerator pair into one entry and computes each entry's
  // label/enabled from the current context; every item dispatches through the
  // single checked boundary executeCommand.
  const context = commandContextOf();
  const registryItems = (name: "tabs" | "spaces" | "view"): MenuItemConstructorOptions[] =>
    menuEntries(
      COMMANDS.filter((c) => c.menu === name),
      context,
    ).map((entry): MenuItemConstructorOptions => ({
      label: entry.label,
      accelerator: entry.accelerator ?? undefined,
      enabled: entry.enabled,
      click: () => executeCommand(entry.id),
    }));

  const tabsSubmenu: MenuItemConstructorOptions[] = [
    ...registryItems("tabs"),
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
    ...registryItems("spaces"),
    { type: "separator" },
    ...activateSpaceItems,
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = registryItems("view");

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu (role: appMenu) provides the standard about/quit set;
    // omitting it on darwin would strip Cmd+Q and friends.
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" } as MenuItemConstructorOptions]
      : []),
    { label: "Tabs", submenu: tabsSubmenu },
    { label: "Spaces", submenu: spacesSubmenu },
    { label: "View", submenu: viewSubmenu },
    // editMenu preserves undo/redo/cut/copy/paste/selectAll accelerators so web
    // contents keep Cmd/Ctrl+C/V/X/A.
    { role: "editMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
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

  // --- Content-blocking startup gate (PRD 5.1 §3) --------------------------
  // The ENTIRE startup is wrapped so ANY failure — a bad ZEO_ADBLOCK_FILTERS
  // path (readFileSync throws ENOENT), a cache/engine load error, a session
  // attach failure — degrades gracefully to "blocking off" rather than aborting
  // the whenReady handler before the window is ever created. buildMenu() and
  // createWindow(...) below ALWAYS run afterward. `blocking` is left seeded so
  // fullSnapshot() never dereferences undefined.
  try {
    // Read the persisted enabled flag (needs the store's open db handle) and seed
    // the blocking slice before any window or tab view exists.
    const enabled = readBlockingEnabled();
    blocking = initialBlockingState(enabled, "none");

    const filtersFile = process.env.ZEO_ADBLOCK_FILTERS;
    if (filtersFile !== undefined && filtersFile !== "") {
      // Test/e2e hook, checked FIRST: build the engine from a fixture list only —
      // no cache read/write, no remote fetch, no daily refresh. It is a test hook,
      // so a bad path must degrade gracefully (logged in the catch) not brick the
      // app.
      const text = readFileSync(filtersFile, "utf8");
      // ZEO_ADBLOCK_RESOURCES (fixture path only): scriptlet resource text in the
      // library's resources format, applied to the parsed engine so fixture
      // scriptlets (##+js(...)) resolve. Read only here, alongside the filters.
      const resourcesFile = process.env.ZEO_ADBLOCK_RESOURCES;
      const resources =
        resourcesFile !== undefined && resourcesFile !== ""
          ? readFileSync(resourcesFile, "utf8")
          : undefined;
      blocker = createBlockerFromFilters(text, "fixture:" + basename(filtersFile), {
        preloadPath: cosmeticPreloadPath,
        resources,
      });
    } else {
      // Kick off the real engine load and race it against a 3 s cap. createBlocker's
      // promise covers only the fast local step (cache or empty engine); if the cap
      // wins the window opens with an empty engine (blocker stays null) and the
      // loaded engine swaps in when it arrives.
      const p = createBlocker({
        cacheFile: join(app.getPath("userData"), "adblock-engine.bin"),
        fetch,
        internals: { preloadPath: cosmeticPreloadPath },
      });
      const capped = await Promise.race([
        p.then((b) => ({ won: true as const, blocker: b })),
        new Promise<{ won: false }>((resolve) =>
          setTimeout(() => resolve({ won: false }), 3000),
        ),
      ]);
      if (capped.won) {
        blocker = capped.blocker;
      } else {
        // Cap won the race: leave blocker null (empty engine) for now and swap in
        // the loaded engine when it arrives, attaching + wiring like the cap-winner
        // path below.
        void p
          .then((b) => {
            blocker = b;
            if (blocking.enabled) {
              attachBlockerToAllSessions(b);
            }
            wireOnBlocked(b);
            scheduleBlockingBroadcast();
          })
          .catch(() => {});
      }
      // Refresh once a day while running. createBlocker already starts ONE
      // background refresh on startup (§1), so this interval covers only the
      // recurring "once a day" case. Because fullSnapshot derives listVersion LIVE
      // off the blocker, the startup refresh's (and each daily refresh's) new
      // version surfaces on the next push with no extra observation — so main does
      // not separately gate on cache age (an intentional simplification vs. §3's
      // "on launch when the cache is older than a day").
      setInterval(
        () => {
          // Skip the recurring refresh while blocking is disabled: a user who
          // turned content blocking off must not trigger a remote filter-list
          // download every 24h.
          if (!blocking.enabled) {
            return;
          }
          blocker
            ?.refresh()
            .then((ok) => {
              if (ok) {
                scheduleBlockingBroadcast();
              }
            })
            .catch(() => {});
        },
        24 * 60 * 60 * 1000,
      );
    }
    // After the blocker is set (fixture or cap-winner) attach it to every existing
    // profile session when enabled, and wire the blocked-event listener. In the
    // cap-lost case blocker is still null here; its p.then above does both.
    if (enabled && blocker) {
      attachBlockerToAllSessions(blocker);
    }
    if (blocker) {
      wireOnBlocked(blocker);
    }
  } catch (err) {
    console.error("[blocking] startup failed; continuing without content blocking:", err);
    // Detach any sessions attached before the failure so no session hook is
    // left pointing at a blocker we are about to drop the reference to (a
    // partial attachBlockerToAllSessions above could leave some attached).
    if (blocker) {
      // Terminal transition: dispose() detaches every session AND removes the
      // wrapper's IPC handlers, so a replacement blocker (e.g. next launch) can
      // take them. A thrown error is caught and logged once; startup continues.
      try {
        blocker.dispose();
      } catch (disposeErr) {
        console.error("[blocking] dispose during startup cleanup failed:", disposeErr);
      }
    }
    blocker = null;
    // Keep the blocking slice seeded to a sane value even when readBlockingEnabled
    // threw before it was set above, so fullSnapshot() never dereferences undefined.
    blocking = initialBlockingState(blocking.enabled, "none");
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
