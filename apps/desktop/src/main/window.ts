import { BrowserWindow, WebContentsView } from "electron";
import { join } from "node:path";
import { titleForUrl, closeFind, reconcileLayout, SINGLE_LAYOUT } from "@zeo/core";
import type { WindowLayout } from "@zeo/core";
import { readWindowLayout } from "./db.js";
import { runtime, moduleDir, DEFAULT_URL } from "./state.js";
import { broadcast } from "./broadcast.js";
import { closeCommandBar } from "./command-bar.js";
import { layoutOverlay } from "./overlay.js";
import { applyLayout, sendDividerGeometry } from "./layout.js";
import { viewBounds } from "./views.js";
import { settingsBoundsRect } from "./settings.js";

/**
 * Creates the main window and its renderer. When `seed` is true and no open tab
 * exists, seeds the default first tab (a fresh launch); a restored launch and a
 * macOS re-activate pass `seed: false`. Restored tabs are NOT eagerly given
 * views — only the active tab's view is materialized here (lazy restore), and
 * every other tab materializes on first activation.
 */
export function createWindow(seed: boolean): void {
  runtime.win = new BrowserWindow({
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
