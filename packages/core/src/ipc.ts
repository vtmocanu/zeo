import type { Tab } from "./tab.js";
import type { Space } from "./space.js";
import type { Profile } from "./profile.js";

/**
 * A single space's tab payload, in the pre-space shape. This is what
 * {@link TabStore.snapshot} produces for one tab set (the pinned-first tab
 * list, the active-tab pointer, and the archived tabs).
 */
export interface TabsSlice {
  tabs: Tab[];
  activeTabId: string | null;
  archived: Tab[];
}

/**
 * The space-only slice returned by {@link SpacesApi.list}: the space list and
 * the active space id, without the active space's tab payload.
 */
export interface SpacesState {
  spaces: Space[];
  activeSpaceId: string;
  profiles: Profile[];
}

/**
 * The full application state broadcast from main to renderers. Produced by
 * {@link SpaceStore.snapshot} and pushed over the state-change channel.
 *
 * The space dimension (`spaces`, `activeSpaceId`) sits alongside the active
 * space's `tabs`/`activeTabId`/`archived` in the existing shape, so renderer
 * code written against the pre-space snapshot keeps working unchanged.
 */
export interface TabsState extends SpacesState, TabsSlice {}

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
 * these against the active space of its `SpaceStore`. `list()` returns the full
 * {@link TabsState} (spaces plus the active space's tab payload), so the renderer
 * gets the whole broadcast shape in one round trip.
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
 * Space commands the renderer invokes over IPC. The main process handles each
 * of these, backed by the single {@link SpaceStore}. Mutating a space rebroadcasts
 * the full {@link TabsState}; `list()` returns just the {@link SpacesState} slice.
 * `create` returns the created {@link Space} so a caller learns its new id.
 */
export interface SpacesApi {
  create(name: string): Promise<Space>;
  rename(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;
  activate(id: string): Promise<void>;
  setProfile(spaceId: string, profileId: string): Promise<void>;
  list(): Promise<SpacesState>;
}

/**
 * Profile commands the renderer invokes over IPC. The main process handles each
 * of these, backed by the single {@link SpaceStore}. `create` returns the created
 * {@link Profile} so a caller learns its new id; mutating a profile rebroadcasts
 * the full {@link TabsState}. Rejections propagate the store's throws (blank name,
 * unknown id, or the delete guards for `"default"` and referenced profiles).
 */
export interface ProfilesApi {
  create(name: string): Promise<Profile>;
  rename(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;
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
  spaces: SpacesApi;
  profiles: ProfilesApi;
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
  spacesCreate: "zeo:spaces:create",
  spacesRename: "zeo:spaces:rename",
  spacesDelete: "zeo:spaces:delete",
  spacesActivate: "zeo:spaces:activate",
  spacesList: "zeo:spaces:list",
  spacesSetProfile: "zeo:spaces:set-profile",
  profilesCreate: "zeo:profiles:create",
  profilesRename: "zeo:profiles:rename",
  profilesDelete: "zeo:profiles:delete",
  stateChange: "zeo:state-change",
} as const;
