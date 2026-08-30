import { app, BrowserWindow, WebContentsView, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TabStore, IPC } from "@zeo/core";
import type { Tab, TabsState } from "@zeo/core";

// The built main is emitted by electron-vite as ESM (out/main/index.js, the
// package is "type": "module"), so `__dirname` is not defined — derive it from
// import.meta.url. Preload and renderer are resolved as siblings of the main
// file's directory (out/preload/index.cjs, out/renderer/index.html).
const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Width of the React sidebar; tab web views occupy the region right of it. */
const SIDEBAR_WIDTH = 240;
/** Default url/title used by the renderer's URL-less new-tab button. */
const DEFAULT_URL = "https://example.com";

/** Derives a tab title from a url's hostname, falling back to the raw url. */
const titleFor = (u: string): string => {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
};

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
  // Do NOT await: a network-restricted/e2e runner must not stall or crash
  // startup, so swallow load rejections.
  view.webContents.loadURL(tab.url).catch(() => {});
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
    void win.loadURL(rendererUrl);
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
    // The views are children of the destroyed window and are torn down with
    // it; drop our references so a macOS re-activate rebuilds fresh ones.
    views.clear();
    win = null;
  });

  // Seed the first tab only when the store is empty (a fresh launch). On a
  // macOS re-activate the store still holds the prior tabs, so we just rebuild
  // their views for the new window.
  if (store.list().length === 0) {
    store.create({ url: DEFAULT_URL, title: titleFor(DEFAULT_URL) });
  }
  for (const tab of store.list()) {
    createViewFor(tab);
  }
  setActive(store.activeTabId);
  broadcast();
}

ipcMain.handle(IPC.tabsCreate, (_event, url?: string): Tab => {
  const u = url ?? DEFAULT_URL;
  const tab = store.create({ url: u, title: titleFor(u) });
  createViewFor(tab);
  setActive(tab.id);
  broadcast();
  return tab;
});

ipcMain.handle(IPC.tabsClose, (_event, id: string): void => {
  // A thrown Error (e.g. unknown id) propagates out of the handler and
  // ipcMain.handle rejects the renderer's invoke instead of crashing main.
  store.close(id);
  const view = views.get(id);
  if (view !== undefined) {
    win?.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(id);
  }
  setActive(store.activeTabId);
  broadcast();
});

ipcMain.handle(IPC.tabsActivate, (_event, id: string): void => {
  store.activate(id);
  setActive(id);
  broadcast();
});

ipcMain.handle(IPC.tabsList, (): TabsState => store.snapshot());

app.whenReady().then(() => {
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
