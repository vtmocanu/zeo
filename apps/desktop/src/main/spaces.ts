import { ipcMain, Menu, session } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { IPC, buildSpaceContextMenu } from "@zeo/core";
import type { Profile, Space, SpaceContextMenuResult, SpacesState } from "@zeo/core";
import { updateDownload } from "./db.js";
import { terminalizeProfileDownloads } from "./download-ops.js";
import { runtime } from "./state.js";
import { broadcast } from "./broadcast.js";
import { createViewFor, destroyView, unloadSpaceViews } from "./views.js";
import { forgetTab } from "./tabs.js";
import { reconcileAndApply } from "./layout.js";
import { installDownloadHandler, logDownloadError } from "./downloads.js";
import { attachBlockerToProfileSession } from "./blocking.js";

/**
 * Full space-delete lifecycle. `store.deleteSpace` validates FIRST (unknown id or
 * the last remaining space → throw BEFORE any mutation, so a rejected delete tears
 * down no views) and returns the ids of every tab it removed (open and archived).
 * Each removed tab's view is then destroyed and its per-tab state forgotten; then —
 * only when the deleted space was active — the same hide/show transition as a space
 * activate runs for the newly active space, then broadcasts. No orphaned views
 * survive a delete.
 */
export function deleteSpace(id: string): void {
  const wasActive = runtime.store.activeSpaceId === id;
  // The store validates before mutating: an unknown id or the last remaining space
  // throws here, before any view teardown. On success it returns every removed tab
  // id (open + archived) and has already dropped them from the ownership index.
  const removed = runtime.store.deleteSpace(id);

  for (const tabId of removed) {
    destroyView(tabId);
    // Drop the blocked count, origin marker, and history per-tab state for good,
    // mirroring closeTab/removeTab.
    forgetTab(tabId);
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
  attachBlockerToProfileSession(profileId);
  // Capture downloads started on the new partition's session; idempotent per
  // session, so a profile already carrying the handler is a no-op.
  installDownloadHandler(profileId);

  // Capture the exact tab ids whose views are on the OLD partition, from the LIVE
  // views map filtered by owning space — NOT from tabsOfSpace, which would
  // spuriously materialize views for archived tabs that currently have none.
  const tabIds = [...runtime.views]
    .filter(([tabId]) => runtime.store.spaceOfTab(tabId) === spaceId)
    .map(([tabId]) => tabId);
  // tabsOfSpace supplies only the id→url lookup for the captured ids.
  const tabsById = new Map(runtime.store.tabsOfSpace(spaceId).map((t) => [t.id, t]));
  // Snapshot each live view's current url BEFORE teardown so recreation resumes
  // where the user was, not the tab's original creation url. getURL() returns ""
  // for a view that never finished loading.
  const liveUrls = new Map(
    tabIds.map((tabId) => {
      const wc = runtime.views.get(tabId)?.webContents;
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
    canDelete: runtime.store.spaces().length > 1 && runtime.store.spaces().some((s) => s.id === id),
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

/**
 * The single space-switch transition (PRD 9.3 §5). Switches the active space,
 * frees the OUTGOING space's views except its own active tab and any audible one
 * (#58), then reconciles the window layout (a split of the outgoing space's tabs
 * collapses to single) and materializes the incoming space's active view. A
 * no-op when `id` is already the active space.
 */
export function switchSpace(id: string): void {
  const outgoing = runtime.store.activeSpaceId;
  if (id === outgoing) {
    return;
  }
  runtime.store.setActiveSpace(id);
  unloadSpaceViews(outgoing, runtime.store.activeTabIdOf(outgoing));
  reconcileAndApply();
  broadcast();
}

// Register the space-switch hook so layout.ts (activateTab) and tabs.ts
// (restoreTab) can trigger a cross-space switch with NO import edge to spaces.ts
// (madge --circular clean). spaces.ts imports from both of those modules, so the
// dependency is inverted through the runtime singleton, exactly like
// command-bar.ts registers runtime.onStateApplied.
runtime.switchSpace = switchSpace;

/**
 * Creates a space AND makes it active, atomically from the caller's view: if the
 * activation throws, the just-created space is rolled back (deleted) and the throw
 * is re-raised, so `store.spaces()` AND `store.activeSpaceId` are left exactly as
 * they were before the call. The `activate` collaborator defaults to
 * {@link switchSpace}; the seam lets a unit test inject a throwing activate to
 * exercise the rollback. `createSpace` throws on a blank name (nothing created)
 * before any activation is attempted.
 */
export function createSpaceAndActivate(
  name: string,
  activate: (id: string) => void = switchSpace,
): Space {
  // Remember the active space so a failed switch can be fully undone: switchSpace
  // calls store.setActiveSpace(new) before its throwable work, and deleteSpace on
  // rollback re-points active to order[0], which may not be the pre-call one.
  const previousActiveSpaceId = runtime.store.activeSpaceId;
  const space = runtime.store.createSpace(name);
  try {
    activate(space.id);
  } catch (err) {
    runtime.store.deleteSpace(space.id);
    // Restore the space that was active before the (failed) switch — deleteSpace
    // re-points to order[0], which may not be the pre-call active space.
    if (runtime.store.activeSpaceId !== previousActiveSpaceId) {
      runtime.store.setActiveSpace(previousActiveSpaceId);
    }
    broadcast();
    throw err;
  }
  return space;
}

/**
 * Creates a profile AND assigns it to the space `spaceId`, atomically from the
 * caller's view: `spaceProfileId(spaceId)` runs FIRST so an unknown space throws
 * before any profile exists; `createProfile` then throws on a blank/duplicate name
 * (nothing created); and if attaching the blocker / download handler or the
 * assignment throws, the just-created profile is rolled back (deleted) and the
 * throw is re-raised, so `store.profiles()` AND the space's assigned profile are
 * left exactly as they were. The `assign` collaborator defaults to
 * {@link remapSpaceProfile}; the seam lets a unit test inject a throwing assign to
 * exercise the rollback.
 */
export function createProfileAndAssign(
  spaceId: string,
  name: string,
  assign: (sid: string, pid: string) => void = remapSpaceProfile,
): Profile {
  // Pre-check the space FIRST (unknown space throws before any profile exists),
  // and remember its current profile so a failed assign can be fully undone.
  const previousProfileId = runtime.store.spaceProfileId(spaceId);
  const profile = runtime.store.createProfile(name);
  try {
    attachBlockerToProfileSession(profile.id);
    installDownloadHandler(profile.id);
    assign(spaceId, profile.id);
  } catch (err) {
    // If assign already re-pointed the space at the new profile (remapSpaceProfile
    // sets it before its throwable createViewFor/reconcile work), restore the
    // previous one so deleteProfile — which refuses a still-referenced profile —
    // can succeed and the store returns to exactly its pre-call state.
    if (runtime.store.spaceProfileId(spaceId) === profile.id) {
      runtime.store.setSpaceProfile(spaceId, previousProfileId);
    }
    runtime.store.deleteProfile(profile.id);
    broadcast();
    throw err;
  }
  return profile;
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

// Create + activate as one op. A throw (blank name, or a failed activation whose
// rollback restores the pre-call spaces) rejects the invoke and leaves
// store.spaces() at its pre-call value.
ipcMain.handle(
  IPC.spacesCreateAndActivate,
  (_event, name: string): Space => createSpaceAndActivate(name),
);

ipcMain.handle(IPC.spacesRename, (_event, id: string, name: string): void => {
  runtime.store.renameSpace(id, name);
  broadcast();
});

ipcMain.handle(IPC.spacesActivate, (_event, id: string): void => {
  switchSpace(id);
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
  attachBlockerToProfileSession(profile.id);
  // Capture downloads started on the new profile's session (always, not gated on
  // blocking); idempotent per session.
  installDownloadHandler(profile.id);
  broadcast();
  return profile;
});

// Create + assign as one op. A throw (unknown space, blank/duplicate name, or a
// failed assignment whose rollback deletes the new profile) rejects the invoke and
// leaves store.profiles() at its pre-call value.
ipcMain.handle(
  IPC.profilesCreateAndAssign,
  (_event, spaceId: string, name: string): Profile => createProfileAndAssign(spaceId, name),
);

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
