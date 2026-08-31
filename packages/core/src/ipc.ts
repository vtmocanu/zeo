import type { Tab } from "./tab.js";

/**
 * The full tabs state broadcast from main to renderers. This is the shape
 * produced by {@link TabStore.snapshot} and pushed over the state-change
 * channel.
 */
export interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  archived: Tab[];
}

/**
 * A single item in the tab context menu, as reported back to the renderer by
 * {@link TabsApi.showContextMenu}. `id` is a stable action key (never the
 * localized `label`), so callers and tests can key off it regardless of label
 * text. `enabled` mirrors the native `MenuItem.enabled` (e.g. Archive is
 * disabled on a pinned tab).
 */
export interface TabContextMenuItem {
  id: string;
  label: string;
  enabled: boolean;
}

/**
 * The descriptor returned by {@link TabsApi.showContextMenu}: the tab the menu
 * was built for and the items it offers. The main process returns this on every
 * call (whether or not it also pops a native menu), giving a serializable seam
 * that a headless test can assert against without driving a native popup.
 */
export interface TabContextMenuResult {
  tabId: string;
  items: TabContextMenuItem[];
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
  pin(id: string): Promise<void>;
  unpin(id: string): Promise<void>;
  reorder(id: string, toIndex: number): Promise<void>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * Builds (and, outside test mode, pops) the native tab context menu for `id`
   * at window coordinates `x`/`y`, returning a descriptor of the items it
   * offers. Menu actions dispatch through the same store ops as the other
   * commands and broadcast the resulting state.
   */
  showContextMenu(id: string, x: number, y: number): Promise<TabContextMenuResult>;
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
  tabsPin: "zeo:tabs:pin",
  tabsUnpin: "zeo:tabs:unpin",
  tabsReorder: "zeo:tabs:reorder",
  tabsArchive: "zeo:tabs:archive",
  tabsRestore: "zeo:tabs:restore",
  tabsRemove: "zeo:tabs:remove",
  tabsContextMenu: "zeo:tabs:context-menu",
  stateChange: "zeo:state-change",
} as const;
