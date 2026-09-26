import { BrowserWindow, WebContentsView, screen } from "electron";
import { join } from "node:path";
import {
  titleForUrl,
  closeFind,
  reconcileLayout,
  SINGLE_LAYOUT,
  resolveWindowBounds,
  centerInWorkArea,
  MIN_WINDOW_SIZE,
} from "@zeo/core";
import type { WindowLayout, WindowState } from "@zeo/core";
import { readWindowLayout, readWindowState, writeWindowState } from "./db.js";
import { runtime, moduleDir, DEFAULT_URL } from "./state.js";
import { broadcast } from "./broadcast.js";
import { closeCommandBar } from "./command-bar.js";
import { layoutOverlay } from "./overlay.js";
import { applyLayout, sendDividerGeometry } from "./layout.js";
import { viewBounds } from "./views.js";
import { settingsBoundsRect } from "./settings.js";

let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
let windowStateSaveErrorLogged = false;
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

/** Persist the live window's normal (un-maximized) bounds + maximized flag.
 *  Fullscreen is not persisted: getNormalBounds reports the pre-fullscreen frame. */
function saveWindowState(): void {
  const win = runtime.win;
  if (win === null || win.isDestroyed()) {
    return;
  }
  try {
    const bounds = win.getNormalBounds();
    writeWindowState({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized(),
    });
  } catch (err) {
    if (!windowStateSaveErrorLogged) {
      console.error("[window] failed to persist window state:", err);
      windowStateSaveErrorLogged = true;
    }
  }
}

/** Debounced save behind resize/move/maximize/unmaximize. */
function scheduleWindowStateSave(): void {
  if (windowStateSaveTimer !== null) {
    clearTimeout(windowStateSaveTimer);
  }
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowState();
  }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
}

/** Synchronous save that cancels any pending debounce — for `close`/`before-quit`. */
export function flushWindowStateSave(): void {
  if (windowStateSaveTimer !== null) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  saveWindowState();
}

/**
 * Creates the main window and its renderer. When `seed` is true and no open tab
 * exists, seeds the default first tab (a fresh launch); a restored launch and a
 * macOS re-activate pass `seed: false`. Restored tabs are NOT eagerly given
 * views — only the active tab's view is materialized here (lazy restore), and
 * every other tab materializes on first activation.
 */
export function createWindow(seed: boolean): void {
  let savedWindowState: WindowState | null = null;
  try {
    savedWindowState = readWindowState();
  } catch (err) {
    console.error("[window] failed to read saved window state; using defaults:", err);
  }
  const resolved = resolveWindowBounds(
    savedWindowState,
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const { maximized, ...frame } = resolved;
  // Electron's own centering (when x/y are omitted) centers on the full screen
  // frame on macOS, not the work area, so center explicitly here on the primary
  // display's work area whenever there is no saved position to restore. The size
  // is first fitted to that same area so the centered window never overhangs it.
  if (frame.x === undefined || frame.y === undefined) {
    const primary = screen.getPrimaryDisplay().workArea;
    frame.width = Math.min(frame.width, primary.width);
    frame.height = Math.min(frame.height, primary.height);
    const center = centerInWorkArea(frame.width, frame.height, primary);
    frame.x = center.x;
    frame.y = center.y;
  }
  runtime.win = new BrowserWindow({
    ...frame,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  // getNormalBounds reports the pre-maximize frame, so restoring the frame then
  // maximizing is correct — and this MUST run before the renderer load below.
  if (maximized) {
    runtime.win.maximize();
  }

  // Dev vs prod must NOT use app.isPackaged: Playwright launches an unpackaged
  // build. electron-vite sets ELECTRON_RENDERER_URL only in dev.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined && rendererUrl !== "") {
    const loadDev = (attempt: number): void => {
      runtime.win?.loadURL(rendererUrl).catch(() => {
        if (attempt < 20) {
          setTimeout(() => loadDev(attempt + 1), 500);
        }
      });
    };
    loadDev(0);
  } else {
    void runtime.win.loadFile(join(moduleDir, "../renderer/index.html"));
  }

  // Create the command-bar overlay ONCE, before any tab view is materialized, so
  // createViewFor's topmost re-add always has a target. Same webPreferences as the
  // window and no partition (default session, like the sidebar). It stays parented
  // and hidden until the bar opens. Load the same renderer bundle with a
  // ?view=command-bar marker, mirroring the window's dev/prod branch above.
  runtime.overlay = new WebContentsView({
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  runtime.win!.contentView.addChildView(runtime.overlay);
  runtime.overlay!.setVisible(false);
  if (rendererUrl !== undefined && rendererUrl !== "") {
    runtime.overlay!.webContents.loadURL(rendererUrl + "?view=command-bar").catch(() => {
      // Dev-server races are retried by the window's loadDev loop; the overlay
      // shares the same bundle, so a transient failure here is non-fatal.
    });
  } else {
    void runtime.overlay!.webContents.loadFile(join(moduleDir, "../renderer/index.html"), {
      query: { view: "command-bar" },
    });
  }
  // Click on the page or sidebar (overlay loses focus) dismisses the bar.
  // closeCommandBar is idempotent, so the focus return it performs never recurses.
  runtime.overlay!.webContents.on("blur", () => {
    closeCommandBar();
  });

  runtime.win!.on("resize", () => {
    scheduleWindowStateSave();
    const active = runtime.store.activeTabId;
    if (active !== null) {
      runtime.views.get(active)?.setBounds(viewBounds());
    }
    if (runtime.settingsOpen && runtime.settingsView !== null) {
      runtime.settingsView.setBounds(settingsBoundsRect());
    }
    if (runtime.commandBar.open || runtime.find.open) {
      // A resize that grows a too-short window can bring a previously collapsed
      // (all-zero rect) overlay back into view. Focus is returned to the overlay
      // only on that hidden→visible transition, so a resize of an already-shown
      // bar (command or find surface) never steals focus from the input mid-typing.
      const wasVisible = runtime.overlay?.getVisible() ?? false;
      const shown = layoutOverlay();
      if (shown && !wasVisible) {
        runtime.overlay?.webContents.focus();
      }
    }
    // In split, re-bound both panes + the divider to the new content size and push
    // the fresh divider geometry (the single-mode active-view bound above is a
    // harmless no-op, immediately overwritten by applyLayout).
    if (runtime.layout.mode === "split") {
      applyLayout();
      sendDividerGeometry();
    }
  });

  // Persist window geometry behind a debounce on move/maximize/unmaximize (resize
  // already schedules a save above). getNormalBounds always reports the
  // pre-maximize frame, so the maximize/unmaximize saves capture the flag + the
  // frame to restore to.
  runtime.win!.on("move", scheduleWindowStateSave);
  runtime.win!.on("maximize", scheduleWindowStateSave);
  runtime.win!.on("unmaximize", scheduleWindowStateSave);

  // Flush the geometry synchronously on close (DISTINCT from the `closed` teardown
  // handler below): getNormalBounds is still valid here, before destruction.
  runtime.win!.on("close", () => {
    flushWindowStateSave();
  });

  // Window lost OS focus → dismiss the command bar.
  runtime.win!.on("blur", () => {
    closeCommandBar();
  });

  // Re-stamp the active tab's lastActiveAt on window focus so a tab left focused
  // (e.g. overnight) is never swept by the idle policy. This changes no visible
  // state, so it does not broadcast.
  runtime.win!.on("focus", () => {
    const active = runtime.store.activeTabId;
    if (active !== null) {
      runtime.store.activate(active);
    }
  });

  runtime.win!.on("closed", () => {
    for (const view of runtime.views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    }
    runtime.views.clear();
    runtime.overlay = null;
    runtime.find = closeFind(runtime.find);
    // Fully close the command bar (not just reset its surface): win.on("closed")
    // previously preserved commandBar.open, so a bar open at close resurrected as
    // a phantom overlay on the next window recreation (broadcast → refreshCommandState
    // → layoutOverlay when open). commandBarRevision bumps so a raced click is rejected.
    runtime.commandBar = {
      open: false,
      mode: runtime.commandBar.mode,
      initialText: "",
      query: "",
      suggestions: [],
      selectedIndex: -1,
      revision: ++runtime.commandBarRevision,
      surface: "bar",
    };
    // Drop the settings view with the window it was parented to; a later
    // createWindow + settings.open recreates it lazily.
    if (runtime.settingsView !== null && !runtime.settingsView.webContents.isDestroyed()) {
      runtime.settingsView.webContents.close();
    }
    runtime.settingsView = null;
    runtime.settingsOpen = false;
    // Drop the divider view with the window too; a later split recreates it
    // lazily. The layout itself is re-derived from the persisted value on the
    // next createWindow, so it is left as-is here.
    if (runtime.dividerView !== null && !runtime.dividerView.webContents.isDestroyed()) {
      runtime.dividerView.webContents.close();
    }
    runtime.dividerView = null;
    runtime.win = null;
    // Rebuild the menu so its enabled flags reflect the no-window/no-live-view
    // context: with views cleared, commandContextOf() yields canGoBack/canGoForward
    // === false and siteHost === null, so tab.back/tab.forward/zoom.* are disabled
    // (their accelerators would otherwise fire and throw after recreation) while
    // tab.new/tab.close/tab.reload/space.new stay enabled.
    runtime.rebuildMenu?.();
  });

  // Seed the first tab into the active (seeded "Personal") space only on a truly
  // empty store — no open AND no archived tabs. A restored or re-activated launch
  // keeps its state and does not seed (the persisted-DB check drives `seed`, and
  // `hasData()` already counts archived rows), so an archived-only session shows
  // the empty-with-archive state rather than a fresh tab seeded over the archive.
  // Views are created lazily: only the active tab's view is materialized now;
  // every other tab gets its view on first activation.
  if (
    seed &&
    runtime.store.allOpenTabs().length === 0 &&
    runtime.store.allArchivedTabs().length === 0
  ) {
    runtime.store.create({ url: DEFAULT_URL, title: titleForUrl(DEFAULT_URL) });
  }
  // Restore the persisted window layout, reconciled against the live open tabs and
  // active tab (a fresh/seeded store, or a persisted split whose panes are gone,
  // collapses to single — which is correct). applyLayout then materializes the
  // pane views lazily and, in split, the divider gets its geometry pushed.
  let persistedLayout: WindowLayout = SINGLE_LAYOUT;
  try {
    persistedLayout = readWindowLayout();
  } catch (err) {
    console.error("[split] failed to read persisted layout; defaulting to single:", err);
  }
  runtime.layout = reconcileLayout(
    persistedLayout,
    runtime.store.list().map((t) => t.id),
    runtime.store.activeTabId,
  );
  applyLayout();
  sendDividerGeometry();
  broadcast();
}

// Register the createWindow hook: handleExternalLink (quick-browse.ts) calls it to
// ensure a fallback main window exists before dispatching an external link.
runtime.createWindow = createWindow;

// ZEO_E2E-only: let the e2e pre-write a window_state row to exercise the
// off-screen-restore path deterministically. Gated strictly on ZEO_E2E === "1";
// a packaged build never defines it.
if (process.env.ZEO_E2E === "1") {
  (globalThis as Record<string, unknown>).__zeoWriteWindowState = (state: WindowState): void => {
    writeWindowState(state);
  };
}
