import type { Tab } from "./tab.js";
import type { Space } from "./space.js";
import type { Profile } from "./profile.js";
import type { CommandBarMode, CommandBarState } from "./command-bar.js";

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

/** A single item in the native SPACE context menu, reported back to the renderer
 *  by SpacesApi.showContextMenu. `id` is a stable action key (never the label):
 *  "rename", "delete", "profile" (the submenu parent), "profile:<profileId>", or
 *  "new-profile". `checked` marks the space's current profile in the submenu;
 *  `submenu` holds the Profile submenu's children. */
export interface SpaceContextMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  checked?: boolean;
  submenu?: SpaceContextMenuItem[];
}
/** Descriptor returned by SpacesApi.showContextMenu: the space the menu was built
 *  for and the items it offers. Mirrors TabContextMenuResult — a serializable seam
 *  a headless test can assert against without driving a native popup. */
export interface SpaceContextMenuResult {
  spaceId: string;
  items: SpaceContextMenuItem[];
}
/** A menu action the MAIN process pushes to the renderer over IPC.spaceMenuAction
 *  when a native space-menu item needs renderer-side inline editing: "rename" opens
 *  inline rename of the space; "new-profile" opens an inline new-profile-name prompt
 *  for the space. (Delete and profile-assignment dispatch entirely in main.) */
export type SpaceMenuAction =
  | { action: "rename"; spaceId: string }
  | { action: "new-profile"; spaceId: string };

/**
 * Commands the renderer invokes over IPC. The main process handles each of
 * these against the active space of its `SpaceStore`. `list()` returns the full
 * {@link TabsState} (spaces plus the active space's tab payload), so the renderer
 * gets the whole broadcast shape in one round trip.
 */
export interface TabsApi {
  create(url?: string): Promise<Tab>;
  /**
   * Navigates the tab `id` to `url`. The stored url and its title fallback are
   * updated synchronously and the new state broadcast, then the view's
   * `loadURL` is kicked off; the promise resolves once the load is INITIATED,
   * not once it settles. Rejects for an unknown id or an id outside the active
   * space. Concurrent navigations are last-request-wins.
   */
  navigate(id: string, url: string): Promise<void>;
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
  /**
   * Builds (and, outside test mode, pops) the native space context menu for `id`
   * at window coordinates `x`/`y`, returning a descriptor of the items it
   * offers. Menu actions dispatch through the same store ops as the other
   * commands and broadcast the resulting state.
   */
  showContextMenu(id: string, x: number, y: number): Promise<SpaceContextMenuResult>;
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
 * Command-bar commands the renderer invokes over IPC, handled in main against the
 * single command-bar controller. `open` shows the bar in the given
 * {@link CommandBarMode}; `close` hides it; `submit` resolves the text (defaulting
 * to the currently-open mode when `mode` is omitted) and performs the navigate or
 * new-tab action; `state` reads back the current {@link CommandBarState}.
 */
export interface CommandBarApi {
  open(mode: CommandBarMode): Promise<void>;
  close(): Promise<void>;
  submit(text: string, mode?: CommandBarMode): Promise<void>;
  state(): Promise<CommandBarState>;
  /**
   * Stores `text`, recomputes `suggestions` from a fresh catalog, resets
   * `selectedIndex` to 0 (or `-1` for an empty list), and pushes the state.
   */
  setQuery(text: string): Promise<void>;
  /**
   * Moves the selection by `delta`, wrapping at both ends, and pushes. With an
   * empty list (`selectedIndex === -1`) both deltas keep `-1` and push nothing.
   */
  moveSelection(delta: 1 | -1): Promise<void>;
  /**
   * Performs one suggestion's action and closes the bar: the row at `index`
   * when given (the clicked row), otherwise the row at `selectedIndex`. An
   * index outside `0 .. suggestions.length - 1` rejects; with no index and
   * `selectedIndex === -1` it behaves like {@link CommandBarApi.submit}.
   *
   * `revision` is the {@link CommandBarState.revision} the renderer had rendered
   * when the row was clicked. When both `index` and `revision` are given and the
   * revision no longer matches main's current one, the click raced a newer
   * suggestion list and is rejected with the state left unchanged. The keyboard
   * (no-index) path omits `revision`: it acts on `selectedIndex` against the
   * current list and needs no guard.
   */
  accept(index?: number, revision?: number): Promise<void>;
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
  commandBar: CommandBarApi;
  onStateChange(listener: (state: TabsState) => void): () => void;
  /** Registers a listener for main-pushed command-bar state updates and returns
   *  an unsubscribe function, mirroring onStateChange. */
  onCommandBarChange(listener: (state: CommandBarState) => void): () => void;
  /** Registers a listener for main-pushed space-menu actions (Rename / New
   *  profile…) and returns an unsubscribe function, mirroring onStateChange. */
  onSpaceMenuAction(listener: (action: SpaceMenuAction) => void): () => void;
}

/**
 * Channel name constants shared by main (`ipcMain.handle` /
 * `webContents.send`) and preload (`ipcRenderer.invoke` / `ipcRenderer.on`).
 */
export const IPC = {
  tabsCreate: "zeo:tabs:create",
  tabsNavigate: "zeo:tabs:navigate",
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
  spacesContextMenu: "zeo:spaces:context-menu",
  spaceMenuAction: "zeo:spaces:menu-action",
  profilesCreate: "zeo:profiles:create",
  profilesRename: "zeo:profiles:rename",
  profilesDelete: "zeo:profiles:delete",
  commandBarOpen: "zeo:command-bar:open",
  commandBarClose: "zeo:command-bar:close",
  commandBarSubmit: "zeo:command-bar:submit",
  commandBarState: "zeo:command-bar:state",
  commandBarSetQuery: "zeo:command-bar:set-query",
  commandBarMove: "zeo:command-bar:move",
  commandBarAccept: "zeo:command-bar:accept",
  commandBarChange: "zeo:command-bar:change",
  stateChange: "zeo:state-change",
} as const;
