import { app, BrowserWindow, WebContentsView, clipboard, ipcMain, Menu, session } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SpaceStore,
  IPC,
  titleForUrl,
  SIDEBAR_WIDTH,
  buildSpaceContextMenu,
  defaultSpaceName,
} from "@zeo/core";
import type {
  Profile,
  Space,
  SpaceContextMenuResult,
  SpacesState,
  Tab,
  TabContextMenuResult,
  TabsState,
} from "@zeo/core";
import { loadStore, scheduleSave, flush } from "./db.js";

// The built main is emitted by electron-vite as ESM (out/main/index.js, the
// package is "type": "module"), so `__dirname` is not defined — derive it from
// import.meta.url. Preload and renderer are resolved as siblings of the main
// file's directory (out/preload/index.cjs, out/renderer/index.html).
const moduleDir = dirname(fileURLToPath(import.meta.url));

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
  win.contentView.addChildView(view);
  view.setBounds(viewBounds());
  view.setVisible(false);

  // Live title/favicon: the hostname-derived title seeded by store.create stays
  // as the fallback until the first page-title-updated arrives. updateMeta
  // no-ops on an unknown/torn-down id, so late events after close are safe.
  view.webContents.on("page-title-updated", (_event, title) => {
    store.updateMeta(tab.id, { title });
    broadcast();
  });
  view.webContents.on("page-favicon-updated", (_event, favicons: string[]) => {
    const faviconUrl = favicons.length > 0 ? favicons[0] : null;
    store.updateMeta(tab.id, { faviconUrl });
    broadcast();
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
      failedLoads.add(tab.id);
      console.error(`tab ${tab.id} failed to load ${urlOverride ?? tab.url}:`, err);
    });
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

/** Full close lifecycle: store removal, view teardown, re-activation, broadcast. */
function closeTab(id: string): void {
  // A thrown Error (e.g. unknown id) propagates out to the caller.
  store.close(id);
  destroyView(id);
  setActive(store.activeTabId);
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
  destroyView(id);
  setActive(store.activeTabId);
  broadcast();
}

/** Tears down and unparents the tracked view for `id`, if one exists. */
function destroyView(id: string): void {
  const tracked = views.get(id);
  if (tracked !== undefined) {
    win?.contentView.removeChildView(tracked.view);
    if (!tracked.view.webContents.isDestroyed()) {
      tracked.view.webContents.close();
    }
    views.delete(id);
    // Drop any retry marker so a stale id never lingers past its view.
    failedLoads.delete(id);
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
  setActive(store.activeTabId);
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

  // Destroy every view owned by the space (open and archived). Snapshot the
  // entries first: destroyView mutates `views` as it goes.
  for (const [tabId, tracked] of [...views]) {
    if (tracked.spaceId === id) {
      destroyView(tabId);
    }
  }

  store.deleteSpace(id);

  if (wasActive) {
    // The store activated a surviving space; show its active tab, hide the rest.
    setActive(store.activeTabId);
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
  win?.webContents.send(IPC.stateChange, store.snapshot());
  scheduleSave(store);
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

  win.on("resize", () => {
    const active = store.activeTabId;
    if (active !== null) {
      views.get(active)?.view.setBounds(viewBounds());
    }
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

ipcMain.handle(IPC.tabsList, (): TabsState => store.snapshot());

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

  const tabsSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "New Tab",
      accelerator: "CmdOrCtrl+T",
      click: () => {
        createTab();
      },
    },
    {
      label: "Close Tab",
      accelerator: "CmdOrCtrl+W",
      click: () => {
        const id = store.activeTabId;
        if (id !== null) {
          closeTab(id);
        }
      },
    },
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
    {
      label: "New Space",
      accelerator: "CmdOrCtrl+Shift+N",
      // Create a default-named space, make it active, then run the same
      // hide/show transition as a space switch and broadcast the new snapshot.
      click: () => {
        const space = store.createSpace(defaultSpaceName(store.spaces()));
        store.setActiveSpace(space.id);
        setActive(store.activeTabId);
        broadcast();
      },
    },
    { type: "separator" },
    ...activateSpaceItems,
  ];

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu (role: appMenu) provides the standard about/quit set;
    // omitting it on darwin would strip Cmd+Q and friends.
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" } as MenuItemConstructorOptions]
      : []),
    { label: "Tabs", submenu: tabsSubmenu },
    { label: "Spaces", submenu: spacesSubmenu },
    // editMenu preserves undo/redo/cut/copy/paste/selectAll accelerators so web
    // contents keep Cmd/Ctrl+C/V/X/A.
    { role: "editMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Restore from disk if a prior session was persisted; otherwise start empty and
  // let createWindow seed the first tab.
  const restored = loadStore();
  const restoredFromDisk = restored !== null;
  if (restored !== null) {
    store = restored;
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
