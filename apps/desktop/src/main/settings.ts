import { ipcMain, WebContentsView } from "electron";
import { join } from "node:path";
import { IPC, SIDEBAR_WIDTH, settingsBounds, searchEngine } from "@zeo/core";
import type { Settings, SearchEngineId, SettingsSectionId } from "@zeo/core";
import { writeSearchEngine, writeQuickBrowseExternal } from "./db.js";
import { runtime, moduleDir } from "./state.js";
import { broadcast } from "./broadcast.js";

/**
 * Bounds of the settings view: the whole content area right of the sidebar,
 * computed by the shared {@link settingsBounds} geometry. Collapses to a
 * zero-size rect when there is no window.
 */
export function settingsBoundsRect(): Electron.Rectangle {
  if (runtime.win === null) {
    return { x: SIDEBAR_WIDTH, y: 0, width: 0, height: 0 };
  }
  const [w, h] = runtime.win.getContentSize();
  return settingsBounds(w, h);
}

/**
 * Opens the settings view, creating its {@link WebContentsView} lazily on first
 * use (default session, same preload as the sidebar, loaded with `?view=settings`
 * — mirroring the command-bar overlay). While open it sits above every tab view
 * and below the command-bar overlay, so after adding it the overlay is re-raised.
 * A no-op focus when already open. Broadcasts so `settingsOpen` propagates (and
 * `settings.close` becomes enabled).
 */
export function openSettings(): void {
  if (runtime.win === null) {
    return;
  }
  if (runtime.settingsOpen && runtime.settingsView !== null) {
    runtime.settingsView.webContents.focus();
    return;
  }
  if (runtime.settingsView === null) {
    runtime.settingsView = new WebContentsView({
      webPreferences: {
        preload: join(moduleDir, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl !== undefined && rendererUrl !== "") {
      runtime.settingsView.webContents.loadURL(rendererUrl + "?view=settings").catch(() => {
        // Dev-server races are retried by the window's loadDev loop; the settings
        // view shares the same bundle, so a transient failure here is non-fatal.
      });
    } else {
      void runtime.settingsView.webContents.loadFile(join(moduleDir, "../renderer/index.html"), {
        query: { view: "settings" },
      });
    }
  }
  runtime.win!.contentView.addChildView(runtime.settingsView!);
  runtime.settingsView!.setBounds(settingsBoundsRect());
  runtime.settingsView!.setVisible(true);
  // Keep the command-bar overlay above the settings view: re-adding it raises it
  // back to the top of the z-order over the settings view just added.
  if (runtime.overlay !== null) {
    runtime.win!.contentView.addChildView(runtime.overlay);
  }
  runtime.settingsOpen = true;
  runtime.settingsView!.webContents.focus();
  broadcast();
}

/**
 * Opens the settings view with `section` selected (PRD 6.5 §7). Sets the pushed
 * {@link settingsSection} and bumps {@link settingsSectionNonce} so the renderer
 * re-selects the section even when it is unchanged (a re-invoked section-open
 * command must reveal that section whether the view was closed or already open on
 * another section), then opens: a cold open path broadcasts (carrying the new
 * section+nonce), while {@link openSettings} on an already-open view only
 * refocuses and does not broadcast, so the new section+nonce is pushed explicitly
 * with an extra {@link broadcast} in that warm case. Backs the per-section open
 * commands.
 */
export function openSettingsAt(section: SettingsSectionId): void {
  runtime.settingsSection = section;
  runtime.settingsSectionNonce++;
  const wasOpen = runtime.settingsOpen;
  openSettings();
  if (wasOpen) {
    broadcast();
  }
}

/**
 * Closes the settings view: removes it from the window (keeping the instance for
 * reuse), hides it, returns focus to the active tab's view (or the window), and
 * broadcasts so `settingsOpen` clears. A no-op when the settings view is not open.
 */
export function closeSettings(): void {
  if (!runtime.settingsOpen || runtime.settingsView === null || runtime.win === null) {
    return;
  }
  runtime.win.contentView.removeChildView(runtime.settingsView);
  runtime.settingsView!.setVisible(false);
  runtime.settingsOpen = false;
  const activeTabId = runtime.store.activeTabId;
  if (activeTabId !== null && runtime.views.has(activeTabId)) {
    runtime.views.get(activeTabId)?.webContents.focus();
  } else {
    runtime.win!.webContents.focus();
  }
  broadcast();
}

/**
 * Changes the default search engine on the main thread in the PRD 6.5 §6 ordered
 * contract: (1) resolve with no side effect when `id` is already the current
 * engine; (2) reject with a `TypeError` (changing nothing) when `id` is not a
 * catalog id; (3) persist with {@link writeSearchEngine} synchronously — a throw
 * (including the missing-`id = 0`-row / zero-row-affected case) rejects and stops
 * before step 4, so the in-memory state is unchanged and no broadcast occurs;
 * (4) update the in-memory `settings` and broadcast. Reachable from the renderer
 * over IPC.settingsSetSearchEngine with an untrusted payload; the IPC handler
 * returns this promise, so a rejection surfaces to the renderer's invoke.
 */
export async function setSearchEngine(id: SearchEngineId): Promise<void> {
  if (id === runtime.settings.searchEngine) {
    return;
  }
  if (searchEngine(id) === undefined) {
    throw new TypeError(`unknown search engine: ${id}`);
  }
  writeSearchEngine(id);
  runtime.settings = { ...runtime.settings, searchEngine: id };
  broadcast();
}

/**
 * Sets whether external links open in the quick-browse window, mirroring
 * {@link setSearchEngine}'s ordered contract exactly: (1) reject with a
 * `TypeError` (changing nothing) when `enabled` is not a boolean; (2) resolve
 * with no side effect when it already matches the current value; (3) persist with
 * {@link writeQuickBrowseExternal} synchronously — a throw rejects and stops
 * before the in-memory state changes and no broadcast occurs; (4) update the
 * in-memory `settings` and broadcast. Reachable from the renderer over
 * IPC.settingsSetQuickBrowseExternal with an untrusted payload; the IPC handler
 * returns this promise, so a rejection surfaces to the renderer's invoke.
 */
export async function setQuickBrowseExternal(enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") {
    throw new TypeError("settings.setQuickBrowseExternal expects a boolean");
  }
  if (enabled === runtime.settings.quickBrowseExternal) {
    return;
  }
  writeQuickBrowseExternal(enabled);
  runtime.settings = { ...runtime.settings, quickBrowseExternal: enabled };
  broadcast();
}

// --- Settings -----------------------------------------------------------------
// get() resolves the current in-memory settings slice; setSearchEngine runs the
// ordered set-search-engine contract (persist → update → broadcast) and rejects
// the invoke on an unknown id (TypeError) or a persistence failure.
ipcMain.handle(IPC.settingsGet, (): Settings => runtime.settings);

ipcMain.handle(IPC.settingsSetSearchEngine, (_event, id: SearchEngineId): Promise<void> =>
  setSearchEngine(id),
);

ipcMain.handle(IPC.settingsSetQuickBrowseExternal, (_event, enabled: boolean): Promise<void> =>
  setQuickBrowseExternal(enabled),
);
