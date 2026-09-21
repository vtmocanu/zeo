import { clipboard, ipcMain, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { IPC, titleForUrl, dropBlockedTab } from "@zeo/core";
import type { Tab, TabsState, TabContextMenuResult } from "@zeo/core";
import { runtime, DEFAULT_URL, IDLE_THRESHOLD_MS } from "./state.js";
import { broadcast, fullSnapshot } from "./broadcast.js";
import { createViewFor, destroyView } from "./views.js";
import { activateTab, preserveSurvivingPane, reconcileAndApply } from "./layout.js";

/** Full new-tab lifecycle: store entry, view, activation, broadcast. */
export function createTab(url?: string): Tab {
  const u = url ?? DEFAULT_URL;
  const tab = runtime.store.create({ url: u, title: titleForUrl(u) });
  createViewFor(tab, runtime.store.activeSpaceId);
  // store.create makes the new tab active; it is not a split pane, so a live split
  // collapses to single (reconcile) and applyLayout shows the new view + hides the
  // divider. In single mode this is the same show-active-hide-rest transition.
  reconcileAndApply();
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
export function navigateTab(id: string, url: string): void {
  if (!runtime.store.list().some((t) => t.id === id)) {
    throw new Error(`Cannot navigate unknown or non-active-space tab: ${id}`);
  }

  const seq = (runtime.navSeq.get(id) ?? 0) + 1;
  runtime.navSeq.set(id, seq);

  // Reset the real-title flag so the hostname fallback tracks the new url until
  // the destination reports its own title, and seed the stored url synchronously.
  runtime.hasRealTitle.delete(id);
  runtime.store.updateMeta(id, { url, title: titleForUrl(url) });
  broadcast();

  const tracked = runtime.views.get(id);
  if (tracked !== undefined) {
    tracked.view.webContents
      .loadURL(url)
      .then(() => {
        if (runtime.navSeq.get(id) === seq) {
          runtime.failedLoads.delete(id);
        }
      })
      .catch((err: unknown) => {
        if (runtime.navSeq.get(id) !== seq) {
          // Superseded by a newer navigate — the aborted load rejects with
          // ERR_ABORTED; ignore it (no failedLoads, no log).
          return;
        }
        if (runtime.views.get(id)?.view !== tracked.view) {
          return;
        }
        runtime.failedLoads.add(id);
        console.error(`tab ${id} failed to navigate to ${url}:`, err);
      });
  }
  // Navigating a tab whose INITIAL createViewFor load is still in flight aborts
  // that load; createViewFor's own catch ignores ERR_ABORTED, so the superseded
  // initial load never spuriously marks failedLoads or logs — this navigate's
  // load owns the retry state from here.
}

/** Full close lifecycle: store removal, view teardown, re-activation, broadcast. */
export function closeTab(id: string): void {
  // A pinned tab cannot be closed (issue #33). Mirror the store's pinned no-op
  // HERE, before any view/state teardown: `store.close` alone leaves the record
  // in place but does NOT undo the destroyView/ensureActiveView/dropBlockedTab
  // work below, so a direct `tabs.close(pinnedId)` IPC would still tear down and
  // reload a pinned tab's view and reset its blocked-count/history. Guarding the
  // main-process close path here keeps a pinned tab's view fully intact. An
  // unknown or archived id is NOT in `list()` (open, non-archived tabs only), so
  // it falls through to `store.close` and throws exactly as before. Unpin first
  // to close.
  const target = runtime.store.list().find((t) => t.id === id);
  if (target?.pinned) {
    return;
  }
  // A thrown Error (e.g. unknown id) propagates out to the caller.
  runtime.store.close(id);
  // Real tab removal: drop the blocked count and the origin marker for good.
  runtime.blocking = dropBlockedTab(runtime.blocking, id);
  runtime.tabOrigin.delete(id);
  // History per-tab state lives and dies with the real tab (not the view), so
  // drop it here alongside tabOrigin.
  runtime.lastHistoryKey.delete(id);
  runtime.lastVisitId.delete(id);
  runtime.hasRealTitle.delete(id);
  destroyView(id);
  // If the closed tab was a split pane, keep the surviving pane active before the
  // split collapses; then reconcile (→ single) and re-lay the view. Lazy restore
  // still applies: reconcileAndApply materializes the active view if missing.
  preserveSurvivingPane(id);
  reconcileAndApply();
  broadcast();
}

/**
 * Full permanent-delete lifecycle: store removal, view teardown, re-activation,
 * broadcast. Unlike {@link closeTab}, this works on an archived tab too (whose
 * hidden view is still parented in `views`), so the archived-tabs view can
 * delete a tab for good.
 */
export function removeTab(id: string): void {
  // A thrown Error (e.g. unknown id) propagates out to the caller.
  runtime.store.remove(id);
  // Real tab removal: drop the blocked count and the origin marker for good.
  runtime.blocking = dropBlockedTab(runtime.blocking, id);
  runtime.tabOrigin.delete(id);
  // History per-tab state lives and dies with the real tab (not the view), so
  // drop it here alongside tabOrigin.
  runtime.lastHistoryKey.delete(id);
  runtime.lastVisitId.delete(id);
  runtime.hasRealTitle.delete(id);
  destroyView(id);
  // If the removed tab was a split pane, keep the surviving pane active before the
  // split collapses; then reconcile (→ single) and re-lay the view (lazy restore
  // materializes the active view if missing).
  preserveSurvivingPane(id);
  reconcileAndApply();
  broadcast();
}

export function pinTab(id: string): void {
  runtime.store.pin(id);
  broadcast();
}

export function unpinTab(id: string): void {
  runtime.store.unpin(id);
  broadcast();
}

export function archiveTab(id: string): void {
  runtime.store.archive(id);
  // If the archived tab was a split pane, keep the surviving pane active before
  // the split collapses; then reconcile (→ single, since an archived tab is no
  // longer open) and re-lay the view (lazy restore materializes it if missing).
  preserveSurvivingPane(id);
  reconcileAndApply();
  broadcast();
}

/**
 * Runs the idle auto-archive policy and, only if it archived something,
 * re-points the visible view (the active tab is exempt, so this is normally a
 * no-op) and broadcasts. Skipping the broadcast on an empty sweep keeps the
 * hourly timer from churning the renderer when nothing changed.
 */
export function sweepIdle(): void {
  const archived = runtime.store.archiveIdleAll(IDLE_THRESHOLD_MS);
  if (archived.length > 0) {
    // Only the active space's active tab is ever visible; archived tabs in
    // inactive spaces are already hidden, so re-laying the active view covers the
    // visible side of the sweep. A sweep that archived a non-focused split pane
    // collapses the split (reconcile) and hides the divider.
    reconcileAndApply();
    broadcast();
  }
}

export function showTabContextMenu(id: string, x: number, y: number): TabContextMenuResult {
  const tab = runtime.store.list().find((t) => t.id === id);
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
      enabled: !tab.pinned,
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
  if (process.env.ZEO_E2E !== "1" && runtime.win !== null) {
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
    menu.popup({ window: runtime.win!, x, y });
  }

  return { tabId: id, items };
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
  runtime.store.reorder(id, toIndex);
  broadcast();
});

ipcMain.handle(IPC.tabsArchive, (_event, id: string): void => {
  // A thrown Error (e.g. archiving a pinned tab) propagates out and rejects the
  // renderer's invoke, consistent with the other handlers.
  archiveTab(id);
});

ipcMain.handle(IPC.tabsRestore, (_event, id: string): void => {
  runtime.store.restore(id);
  if (!runtime.views.has(id)) {
    const tab = runtime.store.list().find((t) => t.id === id);
    if (tab !== undefined) {
      createViewFor(tab, runtime.store.activeSpaceId);
    }
  }
  // Restoring does not change the active tab, so a live split is preserved; the
  // restored (non-pane) view is materialized hidden. reconcileAndApply re-lays the
  // current layout (single or split).
  reconcileAndApply();
  broadcast();
});

// Permanent delete: drop the tab from the store and tear down its view. A thrown
// Error (e.g. unknown id) propagates out and rejects the renderer's invoke.
ipcMain.handle(IPC.tabsRemove, (_event, id: string): void => {
  removeTab(id);
});

ipcMain.handle(
  IPC.tabsContextMenu,
  (_event, id: string, x: number, y: number): TabContextMenuResult => showTabContextMenu(id, x, y),
);

// tabsNavigate throws (rejecting the invoke) on an unknown/non-active-space id,
// like the other tab commands.
ipcMain.handle(IPC.tabsNavigate, (_event, id: string, url: string): void => {
  navigateTab(id, url);
});
