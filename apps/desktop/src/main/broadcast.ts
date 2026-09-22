import { IPC, reconcileLayout } from "@zeo/core";
import type { TabsState } from "@zeo/core";
import { scheduleSave } from "./db.js";
import {
  runtime,
  BLOCKING_BROADCAST_MS,
  DOWNLOADS_BROADCAST_MS,
} from "./state.js";

/**
 * The full broadcast snapshot: the store snapshot plus the blocking slice, with
 * `listVersion` read LIVE off the blocker so a background refresh's new version
 * surfaces on the next push with no extra observation.
 */
export function fullSnapshot(): TabsState {
  return {
    ...runtime.store.snapshot(),
    unloadedTabIds: runtime.store
      .list()
      .filter((t) => !runtime.views.has(t.id))
      .map((t) => t.id),
    blocking: {
      ...runtime.blocking,
      listVersion: runtime.blocker?.listVersion ?? runtime.blocking.listVersion,
    },
    settingsOpen: runtime.settingsOpen,
    zoom: runtime.zoom,
    settings: runtime.settings,
    settingsSection: runtime.settingsSection,
    settingsSectionNonce: runtime.settingsSectionNonce,
    downloads: runtime.downloads,
    find: runtime.find,
    // Cached module vars: fullSnapshot runs on every broadcast, so it must never
    // call app.isDefaultProtocolClient here (isDefaultBrowser is re-read only at
    // startup and after browser.setDefault).
    quickBrowse: runtime.quickBrowse,
    isDefaultBrowser: runtime.isDefaultBrowser,
    layout: runtime.layout,
  };
}

/**
 * Pushes the blocking-updated snapshot to the renderer, coalesced to at most one
 * push per {@link BLOCKING_BROADCAST_MS}. Unlike {@link broadcast} this does NOT
 * schedule a store save — a blocked request changes no persisted store state.
 */
export function scheduleBlockingBroadcast(): void {
  if (runtime.blockingBroadcastTimer !== null) {
    return;
  }
  runtime.blockingBroadcastTimer = setTimeout(() => {
    runtime.blockingBroadcastTimer = null;
    const snapshot = fullSnapshot();
    runtime.win?.webContents.send(IPC.stateChange, snapshot);
    // The settings view mirrors the same snapshot while it exists (even when
    // hidden — a stale slice on the next open is harmless but avoidable).
    if (runtime.settingsView !== null) {
      runtime.settingsView.webContents.send(IPC.stateChange, snapshot);
    }
    // The quick-browse chrome renderer follows the snapshot too, so its url/title
    // track every change (same pattern as the settings view).
    if (runtime.quickBrowseWindow !== null && !runtime.quickBrowseWindow.webContents.isDestroyed()) {
      runtime.quickBrowseWindow.webContents.send(IPC.stateChange, snapshot);
    }
  }, BLOCKING_BROADCAST_MS);
}

/**
 * Pushes a downloads-updated snapshot, coalesced to at most one push per
 * {@link DOWNLOADS_BROADCAST_MS}. Unlike {@link scheduleBlockingBroadcast} it
 * routes through {@link broadcast} with `persist: false`, so the renderer `send`
 * AND {@link refreshCommandState} run (an open downloads-mode bar re-ranks live
 * and `downloads.clearFinished` enablement refreshes) while the debounced
 * full-state save is skipped — download rows persist only through their own
 * throttled update helper and the final flush on `done`.
 */
export function scheduleDownloadsBroadcast(): void {
  if (runtime.downloadsBroadcastTimer !== null) {
    return;
  }
  runtime.downloadsBroadcastTimer = setTimeout(() => {
    runtime.downloadsBroadcastTimer = null;
    broadcast({ persist: false });
  }, DOWNLOADS_BROADCAST_MS);
}

/** Pushes the current command-bar state to the OVERLAY renderer (which hosts the
 *  CommandBar UI), seeding its input; the sidebar is intentionally not targeted. */
export function pushCommandBar(): void {
  runtime.overlay?.webContents.send(IPC.commandBarChange, runtime.commandBar);
}

/**
 * Pushes the current store snapshot to the renderer and refreshes command state.
 * Schedules a debounced full-state save UNLESS `persist` is `false` — the
 * downloads progress/`updated`/`done` paths pass `{ persist: false }` so a 250 ms
 * progress tick never triggers a full-state serialization (download rows persist
 * through their own throttled update helper); every other caller keeps the default
 * and save behavior is unchanged.
 *
 * Also keeps `layout` consistent with the live open tabs and active tab before
 * every snapshot (idempotent guard), so a broadcast always carries a layout that
 * matches the store even on a path that mutated the store without reconciling.
 */
export function broadcast({ persist = true }: { persist?: boolean } = {}): void {
  // Idempotent guard only: reconcileAndApply owns persisting a reconcile-driven
  // layout change (#140), and every collapse-capable path routes through it before
  // reaching here, so this raw reconcile must never be the first place a collapse
  // is observed — keep it a no-op re-reconcile, not a new persistence site.
  runtime.layout = reconcileLayout(
    runtime.layout,
    runtime.store.list().map((t) => t.id),
    runtime.store.activeTabId,
  );
  const snapshot = fullSnapshot();
  runtime.win?.webContents.send(IPC.stateChange, snapshot);
  // The settings view mirrors the same snapshot while it exists (even when
  // hidden), so its blocking/allowlist rows follow every change.
  if (runtime.settingsView !== null) {
    runtime.settingsView.webContents.send(IPC.stateChange, snapshot);
  }
  // The overlay renders the find surface, which echoes its committed query and
  // counter from TabsState.find — so it needs the full snapshot too (the surface
  // selector still travels separately on commandBarChange).
  runtime.overlay?.webContents.send(IPC.stateChange, snapshot);
  // The quick-browse chrome renderer mirrors the same snapshot while it exists, so
  // its url/title follow every change (same pattern as the settings view).
  if (runtime.quickBrowseWindow !== null && !runtime.quickBrowseWindow.webContents.isDestroyed()) {
    runtime.quickBrowseWindow.webContents.send(IPC.stateChange, snapshot);
  }
  if (persist) {
    scheduleSave(runtime.store);
  }
  // Every active-tab/active-space/store change can change command enablement and
  // the pin/unpin menu label, so refresh the menu (and the open bar) here.
  runtime.onStateApplied?.();
}
