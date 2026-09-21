import { ipcMain, Menu, session } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { IPC, buildSpaceContextMenu, dropBlockedTab } from "@zeo/core";
import type { Profile, Space, SpaceContextMenuResult, SpacesState } from "@zeo/core";
import { updateDownload } from "./db.js";
import { terminalizeProfileDownloads } from "./download-ops.js";
import { runtime } from "./state.js";
import { broadcast } from "./broadcast.js";
import { createViewFor, destroyView } from "./views.js";
import { reconcileAndApply } from "./layout.js";
import { installDownloadHandler, logDownloadError } from "./downloads.js";

/**
 * Full space-delete lifecycle. Validates deletability FIRST (unknown id or the
 * last remaining space → throw, so a rejected delete tears down no views), then
 * destroys EVERY view owned by the space (open and archived alike), then removes
 * the space from the store, then — only when the deleted space was active — runs
 * the same hide/show transition as a space activate for the newly active space,
 * then broadcasts. No orphaned views survive a delete.
 */
export function deleteSpace(id: string): void {
  // Gate teardown on the store's OWN deletability predicate, so the rule is not
  // duplicated here. When the delete would reject (unknown id or the last
  // remaining space), defer to store.deleteSpace to throw the specific error
  // BEFORE any view is torn down — a rejected delete has no side effect.
  if (!runtime.store.canDeleteSpace(id)) {
    runtime.store.deleteSpace(id);
    return; // unreachable: canDeleteSpace() === false means deleteSpace() throws.
  }

  const wasActive = runtime.store.activeSpaceId === id;

  // Every tab id the delete will remove (open + archived) — captured BEFORE the
  // store drops the space — so their blocked counts and origin markers can be
  // dropped for good, mirroring closeTab/removeTab.
  const removedTabIds = runtime.store.tabsOfSpace(id).map((t) => t.id);

  // Destroy every view owned by the space (open and archived). Snapshot the
  // entries first: destroyView mutates `views` as it goes.
  for (const [tabId, tracked] of [...runtime.views]) {
    if (tracked.spaceId === id) {
      destroyView(tabId);
    }
  }

  runtime.store.deleteSpace(id);

  for (const tabId of removedTabIds) {
    runtime.blocking = dropBlockedTab(runtime.blocking, tabId);
    runtime.tabOrigin.delete(tabId);
    // History per-tab state lives and dies with the real tab (not the view).
    runtime.lastHistoryKey.delete(tabId);
    runtime.lastVisitId.delete(tabId);
    runtime.hasRealTitle.delete(tabId);
  }

  if (wasActive) {
    // The store activated a surviving space; reconcile the layout (a split of the
    // deleted space's tabs collapses to single) and materialize + show its active
    // tab's view (hiding the divider), creating it if the lazy restore never did.
    reconcileAndApply();
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
export function remapSpaceProfile(spaceId: string, profileId: string): void {
  // Nothing changes when the space already references this profile: no teardown,
  // no recreation, no broadcast.
  if (runtime.store.spaceProfileId(spaceId) === profileId) {
    return;
  }

  runtime.store.setSpaceProfile(spaceId, profileId);

  // The recreated views below load on the NEW partition; attach the blocker to
  // it so they are filtered from their first request (enabled + engine loaded).
  if (runtime.blocking.enabled && runtime.blocker) {
    runtime.blocker.attach(session.fromPartition("persist:" + profileId));
  }
  // Capture downloads started on the new partition's session; idempotent per
  // session, so a profile already carrying the handler is a no-op.
  installDownloadHandler(profileId);

  // Capture the exact tab ids whose views are on the OLD partition, from the LIVE
  // views map filtered by owning space — NOT from tabsOfSpace, which would
  // spuriously materialize views for archived tabs that currently have none.
  const tabIds = [...runtime.views]
    .filter(([, tracked]) => tracked.spaceId === spaceId)
    .map(([tabId]) => tabId);
  // tabsOfSpace supplies only the id→url lookup for the captured ids.
  const tabsById = new Map(runtime.store.tabsOfSpace(spaceId).map((t) => [t.id, t]));
  // Snapshot each live view's current url BEFORE teardown so recreation resumes
  // where the user was, not the tab's original creation url. getURL() returns ""
  // for a view that never finished loading.
  const liveUrls = new Map(
    tabIds.map((tabId) => {
      const wc = runtime.views.get(tabId)?.view.webContents;
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

  // Global active tab: hides an inactive space's recreated views and shows the
  // active one — or, when the remapped space is active and split, re-lays both
  // recreated pane views and the divider.
  reconcileAndApply();
  broadcast();
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
export function showSpaceContextMenu(id: string, x: number, y: number): SpaceContextMenuResult {
  if (!runtime.store.spaces().some((s) => s.id === id)) {
    return { spaceId: id, items: [] };
  }

  const result = buildSpaceContextMenu({
    spaceId: id,
    profiles: runtime.store.profiles(),
    tabCount: runtime.store.tabsOfSpace(id).length,
    currentProfileId: runtime.store.spaceProfileId(id),
    canDelete: runtime.store.canDeleteSpace(id),
  });

  // Gate the native popup so headless e2e never blocks on it. win is non-null in
  // this branch, so the webContents.send calls below are safe.
  if (process.env.ZEO_E2E !== "1" && runtime.win !== null) {
    const popWin = runtime.win;
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
                  popWin.webContents.send(IPC.spaceMenuAction, {
                    action: "new-profile",
                    spaceId: id,
                  }),
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

// --- Space commands -----------------------------------------------------------
// The renderer's single UI bridge drives these; tab WebContentsViews have no
// bridge and cannot dispatch. A thrown Error (unknown/last space) propagates out
// and rejects the renderer's invoke, exactly like the tab handlers.

ipcMain.handle(IPC.spacesCreate, (_event, name: string): Space => {
  const space = runtime.store.createSpace(name);
  // Active space (and thus the visible view) is unchanged by a create.
  broadcast();
  return space;
});

ipcMain.handle(IPC.spacesRename, (_event, id: string, name: string): void => {
  runtime.store.renameSpace(id, name);
  broadcast();
});

ipcMain.handle(IPC.spacesActivate, (_event, id: string): void => {
  runtime.store.setActiveSpace(id);
  // A space switch invalidates any split of the outgoing space's tabs: reconcile
  // (→ single, hiding the divider) and show the incoming space's active tab,
  // materializing that tab's view if the restored space never had one.
  reconcileAndApply();
  broadcast();
});

ipcMain.handle(IPC.spacesDelete, (_event, id: string): void => {
  deleteSpace(id);
});

ipcMain.handle(IPC.spacesSetProfile, (_event, spaceId: string, profileId: string): void => {
  remapSpaceProfile(spaceId, profileId);
});

ipcMain.handle(IPC.profilesCreate, (_event, name: string): Profile => {
  const profile = runtime.store.createProfile(name);
  // Cover the new partition so views created on it are filtered from their first
  // request (only while blocking is enabled and the engine has loaded).
  if (runtime.blocking.enabled && runtime.blocker) {
    runtime.blocker.attach(session.fromPartition("persist:" + profile.id));
  }
  // Capture downloads started on the new profile's session (always, not gated on
  // blocking); idempotent per session.
  installDownloadHandler(profile.id);
  broadcast();
  return profile;
});

ipcMain.handle(IPC.profilesRename, (_event, id: string, name: string): void => {
  runtime.store.renameProfile(id, name);
  broadcast();
});

ipcMain.handle(IPC.profilesDelete, async (_event, id: string): Promise<void> => {
  // Throws before any mutation on a rejected delete (default profile, unknown
  // id, or still referenced by a space), so a rejected delete never wipes a
  // live partition and terminalizes nothing.
  runtime.store.deleteProfile(id);
  // The session is about to be cleared out from under any still-active DownloadItem
  // on this profile, which would then never deliver `done`. Terminalize each such
  // download deterministically (interrupted, persisted, filename released, item
  // cancelled, registry entry dropped) BEFORE the broadcast below mirrors the
  // terminal state and BEFORE the partition is cleared. The finished-record
  // invariant (not the removal guard) then suppresses the cancel's later events.
  terminalizeProfileDownloads(id, Date.now(), {
    getState: () => runtime.downloads,
    setState: (next) => {
      runtime.downloads = next;
    },
    updateRow: (record) => {
      try {
        updateDownload(record);
      } catch (err) {
        logDownloadError(err);
      }
    },
    downloadItems: runtime.downloadItems,
    releaseFilename: (filename) => {
      runtime.reservedFilenames.delete(filename);
    },
  });
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

ipcMain.handle(IPC.spacesList, (): SpacesState => runtime.store.spacesSnapshot());
