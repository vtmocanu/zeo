import type { Tab } from "./tab.js";

/**
 * The full tabs state broadcast from main to renderers. This is the shape
 * produced by {@link TabStore.snapshot} and pushed over the state-change
 * channel.
 */
export interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
}

/**
 * Commands the renderer invokes over IPC. The main process handles each of
 * these, backed by a `TabStore`. `list()` returns the full {@link TabsState}
 * so the renderer gets both the tabs and the active pointer in one round trip.
 */
export interface TabsApi {
  create(url?: string): Promise<Tab>;
  close(id: string): Promise<void>;
  activate(id: string): Promise<void>;
  list(): Promise<TabsState>;
}

/**
 * The full bridge surface exposed on `window.zeo` by the preload script.
 *
 * `onStateChange` registers a listener for main-pushed state updates and
 * returns an unsubscribe function. Under `contextIsolation` the preload must
 * wrap `ipcRenderer.on` internally and never expose `ipcRenderer` itself.
 */
export interface ZeoApi {
  tabs: TabsApi;
  onStateChange(listener: (state: TabsState) => void): () => void;
}

/**
 * Channel name constants shared by main (`ipcMain.handle` /
 * `webContents.send`) and preload (`ipcRenderer.invoke` / `ipcRenderer.on`).
 */
export const IPC = {
  tabsCreate: "zeo:tabs:create",
  tabsClose: "zeo:tabs:close",
  tabsActivate: "zeo:tabs:activate",
  tabsList: "zeo:tabs:list",
  stateChange: "zeo:state-change",
} as const;
