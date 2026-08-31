import { app, BrowserWindow, WebContentsView, clipboard, ipcMain, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TabStore, IPC, titleForUrl, SIDEBAR_WIDTH } from "@zeo/core";
import type { Tab, TabContextMenuResult, TabsState } from "@zeo/core";

// The built main is emitted by electron-vite as ESM (out/main/index.js, the
// package is "type": "module"), so `__dirname` is not defined — derive it from
// import.meta.url. Preload and renderer are resolved as siblings of the main
// file's directory (out/preload/index.cjs, out/renderer/index.html).
const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Default url/title used by the renderer's URL-less new-tab button. */
const DEFAULT_URL = "https://example.com";

const store = new TabStore();
/** Live WebContentsView per tab id; the active tab's view is the visible one. */
const views = new Map<string, WebContentsView>();
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

/** Creates a hidden web view for a tab and starts loading its url. */
function createViewFor(tab: Tab): void {
  if (win === null) {
    return;
  }
  const view = new WebContentsView();
  views.set(tab.id, view);
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

  view.webContents.loadURL(tab.url).catch((err: unknown) => {
    console.error(`tab ${tab.id} failed to load ${tab.url}:`, err);
  });
}

/** Full new-tab lifecycle: store entry, view, activation, broadcast. */
function createTab(url?: string): Tab {
  const u = url ?? DEFAULT_URL;
  const tab = store.create({ url: u, title: titleForUrl(u) });
  createViewFor(tab);
  setActive(tab.id);
  broadcast();
  return tab;
}

/** Full close lifecycle: store removal, view teardown, re-activation, broadcast. */
function closeTab(id: string): void {
  // A thrown Error (e.g. unknown id) propagates out to the caller.
  store.close(id);
  const view = views.get(id);
  if (view !== undefined) {
    win?.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(id);
  }
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
  const view = views.get(id);
  if (view !== undefined) {
    win?.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(id);
  }
  setActive(store.activeTabId);
  broadcast();
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

/** Shows the given tab's view, hides all others, and re-lays-out the active. */
function setActive(id: string | null): void {
  for (const [tabId, view] of views) {
    const active = tabId === id;
    view.setVisible(active);
    if (active) {
      view.setBounds(viewBounds());
    }
  }
}

/** Pushes the current store snapshot to the renderer. */
function broadcast(): void {
  win?.webContents.send(IPC.stateChange, store.snapshot());
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
      views.get(active)?.setBounds(viewBounds());
    }
  });

  win.on("closed", () => {
    for (const view of views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    }
    views.clear();
    win = null;
  });

  // Seed the first tab only when the store is empty (a fresh launch). On a
  // macOS re-activate the store still holds the prior tabs, so we just rebuild
  // their views for the new window.
  if (store.list().length === 0) {
    store.create({ url: DEFAULT_URL, title: titleForUrl(DEFAULT_URL) });
  }
  for (const tab of store.list()) {
    createViewFor(tab);
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

// archive/restore can move the active pointer, so re-run setActive so the
// visible view follows it. Views are not created/destroyed here (out of PRD 2.2
// UI scope).
ipcMain.handle(IPC.tabsArchive, (_event, id: string): void => {
  // A thrown Error (e.g. archiving a pinned tab) propagates out and rejects the
  // renderer's invoke, consistent with the other handlers.
  archiveTab(id);
});

ipcMain.handle(IPC.tabsRestore, (_event, id: string): void => {
  store.restore(id);
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
