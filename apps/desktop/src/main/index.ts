import { app, BrowserWindow, WebContentsView, clipboard, ipcMain, Menu, session } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpaceStore, IPC, titleForUrl, SIDEBAR_WIDTH } from "@zeo/core";
import type { Profile, Space, SpacesState, Tab, TabContextMenuResult, TabsState } from "@zeo/core";

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

const store = new SpaceStore();
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
 * Pre-validates with no side effect (mirroring {@link deleteSpace}): when the
 * remap would reject, {@link SpaceStore.setSpaceProfile} throws the specific error
 * (unknown space / unknown profile) before any view is torn down. A same-profile
 * call short-circuits — nothing changes, no teardown, no broadcast.
 *
 * The store reference is moved AFTER the old-partition views are destroyed and
 * BEFORE they are recreated, so recreation resolves the new partition. If a
 * recreation fails, the store reference is already moved, so no old-partition
 * view survives; that tab simply has no view until its next activation retries it.
 */
function remapSpaceProfile(spaceId: string, profileId: string): void {
  // Gate teardown on the store's OWN predicate. When the remap would reject
  // (unknown space or unknown profile), defer to setSpaceProfile to throw the
  // specific error BEFORE any view is torn down — a rejected remap has no effect.
  if (!store.canSetSpaceProfile(spaceId, profileId)) {
    store.setSpaceProfile(spaceId, profileId);
    return; // unreachable: canSetSpaceProfile() === false means setSpaceProfile() throws.
  }

  // Nothing changes when the space already references this profile: no teardown,
  // no recreation, no broadcast.
  if (store.spaceProfileId(spaceId) === profileId) {
    return;
  }

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
    tabIds.map((tabId) => [tabId, views.get(tabId)?.view.webContents.getURL() ?? ""]),
  );

  for (const tabId of tabIds) {
    destroyView(tabId);
  }

  store.setSpaceProfile(spaceId, profileId);

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

/** Pushes the current store snapshot to the renderer. */
function broadcast(): void {
  win?.webContents.send(IPC.stateChange, store.snapshot());
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

function createWindow(): void {
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

  // Seed the first tab into the active (seeded "Personal") space only when it is
  // empty (a fresh launch) — identical single-seeded-space launch behavior. On a
  // macOS re-activate the store still holds the prior spaces and tabs, so we
  // rebuild EVERY space's open-tab views for the new window.
  if (store.allOpenTabs().length === 0) {
    store.create({ url: DEFAULT_URL, title: titleForUrl(DEFAULT_URL) });
  }
  for (const { spaceId, tab } of store.allOpenTabs()) {
    createViewFor(tab, spaceId);
  }
  setActive(store.activeTabId);
  broadcast();
}

ipcMain.handle(IPC.tabsCreate, (_event, url?: string): Tab => createTab(url));

ipcMain.handle(IPC.tabsClose, (_event, id: string): void => {
  // A thrown Error (e.g. unknown id) propagates out of the handler and
  // ipcMain.handle rejects the renderer's invoke instead of crashing main.
  closeTab(id);
});

ipcMain.handle(IPC.tabsActivate, (_event, id: string): void => {
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
    if (tracked !== undefined && tab !== undefined && !tracked.view.webContents.isDestroyed()) {
      tracked.view.webContents
        .loadURL(tab.url)
        .then(() => {
          failedLoads.delete(id);
        })
        .catch((err: unknown) => {
          console.error(`tab ${id} retry failed to load ${tab.url}:`, err);
        });
    }
  }
  setActive(id);
  broadcast();
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
  // Hide the outgoing space's views and show the incoming space's active tab.
  setActive(store.activeTabId);
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
  // The profile record is gone, so nothing can reach persist:<id> again — drop
  // its on-disk cookies/storage/cache instead of orphaning them forever.
  const doomed = session.fromPartition("persist:" + id);
  await doomed.clearStorageData();
  await doomed.clearCache();
  broadcast();
});

ipcMain.handle(IPC.spacesList, (): SpacesState => store.spacesSnapshot());

/**
 * Builds and installs the application menu. Accelerators here are
 * application-level, so they fire whether focus is in the sidebar renderer or
 * inside a tab's WebContentsView — the reason we use a Menu rather than
 * globalShortcut / before-input-event (both forbidden by the PRD).
 */
function buildMenu(): void {
  // Nine hidden Activate-Tab-N items. The list is queried live inside each
  // click at press time (never a build-time snapshot); accelerators still fire
  // while visible:false. i is 0-based (0..8) mapping to Cmd/Ctrl+1..9.
  const activateItems: MenuItemConstructorOptions[] = Array.from(
    { length: 9 },
    (_unused, i): MenuItemConstructorOptions => ({
      label: `Activate Tab ${i + 1}`,
      accelerator: `CmdOrCtrl+${i + 1}`,
      visible: false,
      click: () => {
        const tabs = store.list();
        const target = tabs[i];
        if (target !== undefined) {
          store.activate(target.id);
          setActive(target.id);
          broadcast();
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

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu (role: appMenu) provides the standard about/quit set;
    // omitting it on darwin would strip Cmd+Q and friends.
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" } as MenuItemConstructorOptions]
      : []),
    { label: "Tabs", submenu: tabsSubmenu },
    // editMenu preserves undo/redo/cut/copy/paste/selectAll accelerators so web
    // contents keep Cmd/Ctrl+C/V/X/A.
    { role: "editMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  sweepIdle();
  setInterval(sweepIdle, SWEEP_INTERVAL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
