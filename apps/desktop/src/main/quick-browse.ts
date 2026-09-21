import { app, BrowserWindow, WebContentsView, ipcMain, screen, session } from "electron";
import { join } from "node:path";
import {
  IPC,
  siteKeyForUrl,
  openQuickBrowse,
  replaceQuickBrowseUrl,
  setQuickBrowseUrl,
  setQuickBrowseTitle,
  dismissQuickBrowse,
  quickBrowsePageBounds,
  QUICK_BROWSE_WIDTH,
  QUICK_BROWSE_HEIGHT,
} from "@zeo/core";
import type { CommandId, QuickBrowse } from "@zeo/core";
import { runtime, moduleDir } from "./state.js";
import { broadcast } from "./broadcast.js";
import { createTab } from "./tabs.js";

/**
 * Registers zeo as the OS default handler for http(s) and refreshes the cached
 * {@link isDefaultBrowser} flag, then broadcasts so the set-default affordance
 * updates. Only ever invoked by the `browser.setDefault` command — never at
 * startup or unprompted (PRD 7.2 §6).
 */
export function setAsDefaultBrowser(): void {
  app.setAsDefaultProtocolClient("http");
  app.setAsDefaultProtocolClient("https");
  runtime.isDefaultBrowser = app.isDefaultProtocolClient("http");
  broadcast();
}

/**
 * The page view's `did-navigate` handler (the top-level document commit): mirrors
 * the committed url into the pure {@link quickBrowse} entry (which the chrome
 * renderer follows over the broadcast) and clears {@link quickBrowseLoadPending}.
 * Early-returns after teardown, when the entry is gone, or when the page view is
 * gone, so a straggler event after dismissal mutates no state. A top-level commit
 * — whether the pending programmatic load committing (possibly after a redirect or
 * url normalization) or a user-initiated top-level navigation — is always the real
 * current page, so the live url is applied unconditionally.
 *
 * The required property (a promote/openInTab fired during an in-flight replace
 * captures the replaced url, not the old one) holds because
 * {@link replaceQuickBrowseUrl} updates the pure `quickBrowse.url` synchronously.
 * {@link quickBrowseLoadPending} additionally prevents a same-document straggler
 * from the old document (see {@link onQuickBrowseNavigateInPage}) from reverting
 * the url before the new top-level load commits here.
 */
export function onQuickBrowseNavigate(): void {
  if (
    runtime.quickBrowseTearingDown ||
    runtime.quickBrowse === null ||
    runtime.quickBrowsePageView === null ||
    runtime.quickBrowsePageView.webContents.isDestroyed()
  ) {
    return;
  }
  const current = runtime.quickBrowsePageView.webContents.getURL(); // read live, never a captured value
  if (current === "") {
    return;
  }
  runtime.quickBrowse = setQuickBrowseUrl(runtime.quickBrowse, current);
  runtime.quickBrowseLoadPending = false; // this top-level commit is the current page
  broadcast();
}

/**
 * The page view's `did-navigate-in-page` handler (a same-document navigation, e.g.
 * a fragment or a history.pushState). While {@link quickBrowseLoadPending} is
 * `true` a top-level programmatic load is in flight, so any same-document event is
 * a straggler from the superseded document — drop it, or it would revert the live
 * url to the old page before the new top-level load commits. Otherwise the page is
 * free-navigating within its document and the live url is tracked. Shares the
 * teardown/gone early-returns with {@link onQuickBrowseNavigate}.
 */
export function onQuickBrowseNavigateInPage(): void {
  if (
    runtime.quickBrowseTearingDown ||
    runtime.quickBrowse === null ||
    runtime.quickBrowsePageView === null ||
    runtime.quickBrowsePageView.webContents.isDestroyed()
  ) {
    return;
  }
  if (runtime.quickBrowseLoadPending) {
    return; // straggler from the superseded document during a programmatic load
  }
  const current = runtime.quickBrowsePageView.webContents.getURL(); // read live, never a captured value
  if (current === "") {
    return;
  }
  runtime.quickBrowse = setQuickBrowseUrl(runtime.quickBrowse, current);
  broadcast();
}

/**
 * The page view's `page-title-updated` handler. {@link setQuickBrowseTitle} is a
 * no-op on a url mismatch, so a title racing a navigation to a different url is
 * dropped; the early-returns keep it robust after teardown.
 */
export function onQuickBrowseTitle(_event: Electron.Event, title: string): void {
  if (
    runtime.quickBrowseTearingDown ||
    runtime.quickBrowse === null ||
    runtime.quickBrowsePageView === null ||
    runtime.quickBrowsePageView.webContents.isDestroyed()
  ) {
    return;
  }
  runtime.quickBrowse = setQuickBrowseTitle(
    runtime.quickBrowse,
    runtime.quickBrowsePageView.webContents.getURL(),
    title,
  );
  broadcast();
}

/** Wires the quick-browse page view's url/title tracking (see {@link onQuickBrowseNavigate}). */
export function wireQuickBrowsePageEvents(view: WebContentsView): void {
  view.webContents.on("did-navigate", onQuickBrowseNavigate);
  view.webContents.on("did-navigate-in-page", onQuickBrowseNavigateInPage);
  view.webContents.on("page-title-updated", onQuickBrowseTitle);
}

/**
 * The window-local key handler wired onto BOTH the quick-browse chrome window and
 * its page view (PRD 7.2 §5, the sanctioned exception to the menu-accelerator
 * convention — scoped to these two webContents, never a global accelerator). Maps
 * keyDown to the quick-browse commands and dispatches through {@link executeCommand};
 * `preventDefault` keeps a handled key off the page. The commands are enabled only
 * while the window is open, so the try/catch just defends executeCommand's
 * disabled-command throw (e.g. a key delivered mid-teardown).
 */
export function handleQuickBrowseKey(event: Electron.Event, input: Electron.Input): void {
  if (input.type !== "keyDown") {
    return;
  }
  const mod = input.meta || input.control; // Cmd (darwin) or Ctrl (win/linux)
  let commandId: CommandId | null = null;
  if (input.key === "Escape") {
    commandId = "quickBrowse.dismiss";
  } else if (input.key === "Enter") {
    if (mod && input.shift) {
      commandId = "quickBrowse.openInTab";
    } else if (mod) {
      commandId = "quickBrowse.promoteToSpace";
    } else if (!input.shift) {
      commandId = "quickBrowse.promote";
    }
  }
  if (commandId === null) {
    return;
  }
  event.preventDefault();
  try {
    runtime.executeCommand!(commandId);
  } catch (err) {
    console.error("[quick-browse] key command failed:", err);
  }
}

/**
 * Opens the singleton quick-browse window for `url`: a frameless chrome window (a
 * renderer surface main pushes state to, mirroring the settings view) hosting an
 * untrusted page view (mirroring a tab view) on a fresh EPHEMERAL in-memory
 * session. Called only when no quick-browse window is open; a second external
 * link while one is open routes to {@link replaceQuickBrowseLink}.
 */
export function openQuickBrowseWindow(url: string): void {
  if (runtime.quickBrowseWindow !== null) {
    return; // a window is already open; callers route to replaceQuickBrowseLink
  }
  // 1. Allocate this lifecycle's unique in-memory partition — NO `persist:` prefix,
  //    so it shares nothing with a profile and is discarded on teardown.
  const partition = "quick-browse-" + ++runtime.quickBrowseSessionSeq;
  runtime.quickBrowseSession = session.fromPartition(partition);

  // 2. Frameless chrome window centered on the primary display's work area.
  const primary = screen.getPrimaryDisplay();
  runtime.quickBrowseWindow = new BrowserWindow({
    width: QUICK_BROWSE_WIDTH,
    height: QUICK_BROWSE_HEIGHT,
    x: Math.round(primary.workArea.x + (primary.workArea.width - QUICK_BROWSE_WIDTH) / 2),
    y: Math.round(primary.workArea.y + (primary.workArea.height - QUICK_BROWSE_HEIGHT) / 2),
    frame: false,
    show: false,
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  // 3. Load the shared renderer bundle with ?view=quick-browse for the chrome,
  //    mirroring the settings/overlay dev/prod branch.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined && rendererUrl !== "") {
    runtime.quickBrowseWindow!.webContents.loadURL(rendererUrl + "?view=quick-browse").catch(() => {
      // Dev-server races are retried by the window's loadDev loop; the quick-browse
      // chrome shares the same bundle, so a transient failure here is non-fatal.
    });
  } else {
    void runtime.quickBrowseWindow!.webContents.loadFile(join(moduleDir, "../renderer/index.html"), {
      query: { view: "quick-browse" },
    });
  }

  // 4. Untrusted page view on the ephemeral partition, SAME secure prefs as a tab
  //    view: no preload, contextIsolation/sandbox at their secure defaults,
  //    nodeIntegration off, subframe cosmetic preload allowed.
  const pageView = new WebContentsView({
    webPreferences: {
      partition,
      nodeIntegrationInSubFrames: true,
    },
  });
  runtime.quickBrowsePageView = pageView;
  runtime.quickBrowseWindow!.contentView.addChildView(pageView);
  const layoutPageView = (): void => {
    if (runtime.quickBrowseWindow === null || pageView.webContents.isDestroyed()) {
      return;
    }
    const [w, h] = runtime.quickBrowseWindow.getContentSize();
    pageView.setBounds(quickBrowsePageBounds(w, h));
  };
  layoutPageView();
  runtime.quickBrowseWindow!.on("resize", layoutPageView);

  // 5. Deny every window.open / target=_blank; the current page does NOT navigate.
  pageView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // 6. Filter the ephemeral session when blocking is enabled and the engine has
  //    loaded (same condition as the profile-session attach).
  if (runtime.blocking.enabled && runtime.blocker) {
    try {
      runtime.blocker.attach(runtime.quickBrowseSession!);
    } catch (err) {
      teardownQuickBrowse();
      throw err;
    }
  }

  // 7. Seed the pure state.
  runtime.quickBrowse = openQuickBrowse(url);
  runtime.quickBrowseTearingDown = false;

  // 8. Wire url/title tracking before navigating so no first commit is missed.
  wireQuickBrowsePageEvents(pageView);

  // 9. Programmatic navigation; flag the in-flight load so same-document stragglers
  //    from the superseded (blank) document are dropped until the top-level commit.
  runtime.quickBrowseLoadPending = true;
  void pageView.webContents.loadURL(url);

  // 10. Show + focus the window.
  runtime.quickBrowseWindow!.show();
  runtime.quickBrowseWindow!.focus();

  // 11. Route an OS/user close through the single-flight teardown.
  runtime.quickBrowseWindow!.on("closed", () => {
    teardownQuickBrowse();
  });

  // 12. Window-local keys on BOTH webContents (scoped exception, never global).
  runtime.quickBrowseWindow!.webContents.on("before-input-event", handleQuickBrowseKey);
  pageView.webContents.on("before-input-event", handleQuickBrowseKey);

  // 13. Broadcast so TabsState.quickBrowse populates and the quickBrowse.* commands
  //     enable.
  broadcast();
}

/**
 * Handles a second external link while a quick-browse window is already open:
 * replaces the pure entry's url (resetting the derived title), programmatically
 * navigates the existing page view (flagging the in-flight load so same-document
 * stragglers from the superseded document are dropped), and brings the window to
 * the front. A no-op if the window vanished between the caller's check and here.
 */
export function replaceQuickBrowseLink(url: string): void {
  if (runtime.quickBrowse === null || runtime.quickBrowsePageView === null) {
    return;
  }
  runtime.quickBrowse = replaceQuickBrowseUrl(runtime.quickBrowse, url);
  runtime.quickBrowseLoadPending = true;
  void runtime.quickBrowsePageView.webContents.loadURL(url);
  runtime.quickBrowseWindow?.moveTop();
  runtime.quickBrowseWindow?.focus();
  broadcast();
}

/**
 * Tears the quick-browse window down (single-flight, best-effort). Steps 1-2 close
 * the page view and window synchronously; step 3 nulls the singleton state and
 * broadcasts (so TabsState.quickBrowse clears and the quickBrowse.* commands
 * disable) and returns focus to the main window; step 4 fire-and-forget clears the
 * ephemeral session's storage + cache so teardown never blocks. The
 * {@link quickBrowseTearingDown} guard absorbs the synchronous `closed` re-entry
 * that {@link BrowserWindow.close} triggers, and the "already torn down" guard
 * absorbs a later async `closed` (e.g. at app quit) after the state was nulled.
 */
export function teardownQuickBrowse(): void {
  if (runtime.quickBrowseTearingDown) {
    return; // single-flight: BrowserWindow.close() below can re-fire 'closed'
  }
  if (
    runtime.quickBrowseWindow === null &&
    runtime.quickBrowsePageView === null &&
    runtime.quickBrowseSession === null &&
    runtime.quickBrowse === null
  ) {
    return; // already torn down (e.g. a late 'closed' after teardown completed)
  }
  runtime.quickBrowseTearingDown = true;
  const closingWindow = runtime.quickBrowseWindow;
  const closingView = runtime.quickBrowsePageView;
  const closingSession = runtime.quickBrowseSession;

  // 1. Remove + close the page view (guard isDestroyed), matching settings-view teardown.
  if (closingView !== null) {
    if (closingWindow !== null && !closingWindow.isDestroyed()) {
      closingWindow.contentView.removeChildView(closingView);
    }
    if (!closingView.webContents.isDestroyed()) {
      closingView.webContents.close();
    }
  }
  // 2. Close the chrome window (app-quit can deliver 'closed' on an already-destroyed window).
  if (closingWindow !== null && !closingWindow.isDestroyed()) {
    closingWindow.close();
  }

  // 3. Reset the singleton state synchronously and broadcast.
  runtime.quickBrowse = dismissQuickBrowse(runtime.quickBrowse);
  runtime.quickBrowseWindow = null;
  runtime.quickBrowsePageView = null;
  runtime.quickBrowseSession = null;
  runtime.quickBrowseLoadPending = false;
  broadcast();

  // Return focus to the main window (its active tab view when present, else the window).
  if (runtime.win !== null && !runtime.win.isDestroyed()) {
    const activeTabId = runtime.store.activeTabId;
    if (activeTabId !== null && runtime.views.has(activeTabId)) {
      runtime.views.get(activeTabId)?.view.webContents.focus();
    } else {
      runtime.win!.webContents.focus();
    }
  }

  // 4. Best-effort clear the ephemeral session storage + cache; fire-and-forget so
  //    teardown never blocks, matching the deleted-profile cleanup.
  if (closingSession !== null) {
    closingSession
      .clearStorageData()
      .then(() => closingSession.clearCache())
      .catch((err: unknown) => {
        console.error("[quick-browse] failed to clear ephemeral session data:", err);
      });
  }

  runtime.quickBrowseTearingDown = false;
}

/**
 * Dispatches an external web link (PRD 7.2). A non-http(s) target is ignored (the
 * handoff is web-only). Ensures a fallback main window exists first (darwin keeps
 * the process alive with no window after window-all-closed). With
 * `settings.quickBrowseExternal` on it opens (or, if a window is already open,
 * replaces the link in) the quick-browse window; otherwise it opens the url as a
 * normal new tab in the active space and activates it, bringing the main window
 * forward.
 */
export function handleExternalLink(url: string): void {
  if (siteKeyForUrl(url) === null) {
    console.warn("[quick-browse] ignoring non-http(s) external link:", JSON.stringify(url));
    return;
  }
  if (runtime.win === null) {
    runtime.createWindow?.(false);
  }
  if (runtime.settings.quickBrowseExternal) {
    if (runtime.quickBrowseWindow === null) {
      openQuickBrowseWindow(url);
    } else {
      replaceQuickBrowseLink(url);
    }
    return;
  }
  createTab(url);
  if (runtime.win !== null && !runtime.win.isDestroyed()) {
    runtime.win.show();
    runtime.win!.focus();
  }
}

/**
 * Drains the queued open-url links that arrived before {@link appReady}, in
 * arrival order, through the external-link handoff path.
 */
export function drainExternalLinks(): void {
  for (const queued of runtime.pendingExternalLinks.splice(0)) {
    handleExternalLink(queued);
  }
}

// --- Quick-browse -------------------------------------------------------------
// state() reads back the current entry (null when closed). promote()/dismiss()
// resolve gracefully as no-ops when no window is open — the underlying commands
// are enabled only while the window exists, so the handlers guard on
// quickBrowseWindow before dispatch rather than reject the renderer's invoke.
ipcMain.handle(IPC.quickBrowseState, (): QuickBrowse | null => runtime.quickBrowse);

ipcMain.handle(IPC.quickBrowsePromote, (): void => {
  if (runtime.quickBrowseWindow === null) {
    return;
  }
  runtime.executeCommand!("quickBrowse.promote");
});

ipcMain.handle(IPC.quickBrowseDismiss, (): void => {
  if (runtime.quickBrowseWindow !== null) {
    teardownQuickBrowse();
  }
});
