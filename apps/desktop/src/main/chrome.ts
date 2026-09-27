/**
 * PRD 10.2 — frameless chrome: the main-process side of the resizable,
 * collapsible sidebar. Owns bounds-only re-layout, the window-button
 * visibility mirror (macOS only), the `runtime.chrome` mutator, and the debounced
 * persistence of the sidebar width/collapsed prefs. Imports views, layout,
 * overlay, settings, broadcast, db-window and state — never window.ts or
 * commands.ts, so this stays outside their import cycle (lint:cycles).
 */
import { ipcMain } from "electron";
import {
  IPC,
  sidebarVisible,
  splitPaneBounds,
  withSidebarWidth,
  withSidebarRevealed,
  toggleSidebar,
} from "@zeo/core";
import type { ChromeState } from "@zeo/core";
import { writeChromePrefs } from "./db-window.js";
import { runtime } from "./state.js";
import { broadcast } from "./broadcast.js";
import { viewBounds } from "./views.js";
import { sendDividerGeometry } from "./layout.js";
import { layoutOverlay } from "./overlay.js";
import { settingsBoundsRect } from "./settings.js";

/** Debounce window for {@link scheduleChromeSave}, in milliseconds. */
const CHROME_SAVE_DEBOUNCE_MS = 500;

let chromeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let chromeSaveErrorLogged = false;

/**
 * Re-bounds every on-screen surface to the current `runtime.chrome` (and, in
 * split, `runtime.layout`): the active tab view in single mode, the two pane
 * views plus the divider in split, the settings view when open, and the
 * command-bar/find overlay when open (re-running the hidden-to-visible focus
 * rule window.ts's resize handler used to own). Sets bounds ONLY — it never
 * changes visibility or focus (beyond that one documented overlay exception).
 * Always finishes with {@link applyWindowButtons}. A no-op with no window.
 */
export function relayoutWindow(): void {
  if (runtime.win === null) {
    return;
  }
  const [width, height] = runtime.win.getContentSize();
  if (runtime.layout.mode === "single") {
    const active = runtime.store.activeTabId;
    if (active !== null) {
      runtime.views.get(active)?.setBounds(viewBounds());
    }
  } else {
    const b = splitPaneBounds(width, height, runtime.chrome, runtime.layout.ratio);
    const leftView = runtime.views.get(runtime.layout.left);
    if (leftView !== undefined && !leftView.webContents.isDestroyed()) {
      leftView.setBounds(b.left);
    }
    const rightView = runtime.views.get(runtime.layout.right);
    if (rightView !== undefined && !rightView.webContents.isDestroyed()) {
      rightView.setBounds(b.right);
    }
    if (runtime.dividerView !== null && !runtime.dividerView.webContents.isDestroyed()) {
      runtime.dividerView.setBounds(b.divider);
    }
    sendDividerGeometry();
  }
  if (runtime.settingsOpen && runtime.settingsView !== null) {
    runtime.settingsView.setBounds(settingsBoundsRect());
  }
  if (runtime.commandBar.open || runtime.find.open) {
    // Mirrors window.ts's former resize handler: focus returns to the overlay
    // only on a hidden -> visible transition, so a relayout of an already-shown
    // bar never steals focus from the input mid-typing.
    const wasVisible = runtime.overlay?.getVisible() ?? false;
    const shown = layoutOverlay();
    if (shown && !wasVisible) {
      runtime.overlay?.webContents.focus();
    }
  }
  applyWindowButtons();
}

/**
 * Mirrors the traffic-light visibility to whether the sidebar currently
 * occupies space ({@link sidebarVisible}). `setWindowButtonVisibility` is
 * macOS-only, so the setter runs only under `process.platform === "darwin"`.
 * Electron exposes no getter for it, so under `ZEO_E2E === "1"` the computed
 * value is always mirrored onto `globalThis.__zeoWindowButtonsVisible` (on
 * every platform) so the e2e suite can assert on it regardless of CI host.
 */
export function applyWindowButtons(): void {
  const visible = sidebarVisible(runtime.chrome);
  if (process.platform === "darwin") {
    runtime.win?.setWindowButtonVisibility(visible);
  }
  if (process.env.ZEO_E2E === "1") {
    (globalThis as Record<string, unknown>).__zeoWindowButtonsVisible = visible;
  }
}

/**
 * Replaces `runtime.chrome` with `next`, a no-op when every field is equal
 * (width, collapsed AND revealed). Otherwise assigns, re-lays out the window,
 * and broadcasts (`persist: false` — the broadcast's own store save is
 * unrelated to the chrome prefs), then schedules the debounced chrome-prefs
 * save when `opts.persist` is set.
 */
export function setChrome(next: ChromeState, opts: { persist: boolean }): void {
  const prev = runtime.chrome;
  if (
    prev.sidebarWidth === next.sidebarWidth &&
    prev.sidebarCollapsed === next.sidebarCollapsed &&
    prev.sidebarRevealed === next.sidebarRevealed
  ) {
    return;
  }
  runtime.chrome = next;
  relayoutWindow();
  broadcast({ persist: false });
  if (opts.persist) {
    scheduleChromeSave();
  }
}

/** Toggles the sidebar's collapsed state (⌘S / View ▸ Toggle Sidebar), persisting. */
export function toggleSidebarChrome(): void {
  setChrome(toggleSidebar(runtime.chrome), { persist: true });
}

/**
 * Writes the current sidebar width/collapsed prefs synchronously, along with
 * the live window frame (seeding a missing row) — mirroring `saveWindowState`
 * in window.ts. A no-op with no window (or a destroyed one). A write failure
 * is logged once per launch.
 */
function saveChromeNow(): void {
  const win = runtime.win;
  if (win === null || win.isDestroyed()) {
    return;
  }
  try {
    const bounds = win.getNormalBounds();
    writeChromePrefs(
      {
        sidebarWidth: runtime.chrome.sidebarWidth,
        sidebarCollapsed: runtime.chrome.sidebarCollapsed,
      },
      {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: win.isMaximized(),
      },
    );
  } catch (err) {
    if (!chromeSaveErrorLogged) {
      console.error("[chrome] failed to persist sidebar prefs:", err);
      chromeSaveErrorLogged = true;
    }
  }
}

/** Debounced save behind a width drag or a persisted toggle, replacing any pending one. */
export function scheduleChromeSave(): void {
  if (chromeSaveTimer !== null) {
    clearTimeout(chromeSaveTimer);
  }
  chromeSaveTimer = setTimeout(() => {
    chromeSaveTimer = null;
    saveChromeNow();
  }, CHROME_SAVE_DEBOUNCE_MS);
}

/** Synchronous save that cancels any pending debounce — for `close`/`before-quit`. */
export function flushChromeSave(): void {
  if (chromeSaveTimer === null) {
    return;
  }
  clearTimeout(chromeSaveTimer);
  chromeSaveTimer = null;
  saveChromeNow();
}

// The chrome bridge: setSidebarWidth drags/steps the sidebar to a clamped width
// (persisted); setSidebarRevealed drives the edge-reveal while collapsed (never
// persisted — sidebarRevealed never survives a relaunch); state reads the
// current ChromeState back synchronously. Both setters validate their payload
// type, rejecting (throwing, over the bridge) rather than coercing an
// untrusted invoke argument.
ipcMain.handle(IPC.chromeSetSidebarWidth, (_event, px: number): void => {
  if (typeof px !== "number") {
    throw new TypeError("chrome.setSidebarWidth expects a number");
  }
  setChrome(withSidebarWidth(runtime.chrome, px), { persist: true });
});

ipcMain.handle(IPC.chromeSetSidebarRevealed, (_event, revealed: boolean): void => {
  if (typeof revealed !== "boolean") {
    throw new TypeError("chrome.setSidebarRevealed expects a boolean");
  }
  setChrome(withSidebarRevealed(runtime.chrome, revealed), { persist: false });
});

ipcMain.handle(IPC.chromeState, (): ChromeState => runtime.chrome);
