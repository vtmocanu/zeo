import type { Tab } from "./tab.js";
import type { Space } from "./space.js";
import type { Profile } from "./profile.js";
import type { CommandBarMode, CommandBarState } from "./command-bar.js";
import type { CommandDescriptor, CommandId } from "./commands.js";
import type { BlockingState } from "./blocking.js";
import type { Download, DownloadsState } from "./downloads.js";
import type { HistoryEntry, HistoryVisit } from "./history.js";
import type { ZoomState } from "./zoom.js";
import type { FindState } from "./page-search.js";
import type { SettingsSectionId, SearchEngineId } from "./settings.js";
import type { QuickBrowse } from "./quick-browse.js";
import type { PaneSide, WindowLayout } from "./split-view.js";

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
 * The pure store's snapshot shape: the space slice plus the active space's tab
 * slice, with NO blocking dimension. Produced by {@link SpaceStore.snapshot};
 * the store does not know about content blocking.
 */
export interface StoreSnapshot extends SpacesState, TabsSlice {}

/**
 * The full application state broadcast from main to renderers: the store
 * snapshot plus the {@link BlockingState} slice main maintains. Pushed over the
 * state-change channel.
 *
 * The space dimension (`spaces`, `activeSpaceId`) sits alongside the active
 * space's `tabs`/`activeTabId`/`archived` in the existing shape, so renderer
 * code written against the pre-space snapshot keeps working unchanged; `blocking`
 * carries the content-blocking counts main attaches before broadcast, and
 * `settingsOpen` (attached by main, not part of the pure store snapshot)
 * reflects whether the settings view is currently open. `zoom` carries the
 * per-host zoom factors and rides the `stateChange` broadcast exactly like
 * `blocking` — main attaches it before every broadcast, so it is never absent.
 * `settings` rides the broadcast the same way, carrying the current
 * {@link Settings} (the chosen search engine) so every settings change reaches
 * renderers without a separate channel; `settingsSection` is the
 * currently-targeted settings section main pushes to the settings view (the
 * section-open commands set it), which the PRD calls the pushed `section`.
 *
 * `settingsSectionNonce` is a monotonically increasing counter main bumps each
 * time a section-open command (or a cold `settings.open`) targets a section, so
 * the settings renderer re-selects the pushed `settingsSection` on every such
 * request even when the section id is unchanged (a discrete user intent to
 * reveal that section must win over a stale local selection). An unrelated
 * broadcast carries the same nonce as the previous one, so it never disturbs the
 * renderer's local keyboard selection.
 *
 * `find` carries the single in-page find session (see {@link FindState}) and
 * rides the `stateChange` broadcast exactly like `zoom` and `settings` — main
 * attaches it before every broadcast, so it is never absent.
 *
 * `layout` carries the active space's window {@link WindowLayout} (single pane or
 * a two-pane split) and rides the `stateChange` broadcast exactly like
 * `blocking`, `zoom`, and `find` — main attaches it before every broadcast, so
 * it is never absent.
 */
export interface TabsState extends StoreSnapshot {
  blocking: BlockingState;
  downloads: DownloadsState;
  settingsOpen: boolean;
  zoom: ZoomState;
  settings: Settings;
  settingsSection: SettingsSectionId;
  settingsSectionNonce: number;
  find: FindState;
  /** The current quick-browse entry, or `null` when no quick-browse window is open. */
  quickBrowse: QuickBrowse | null;
  /** Whether zeo is currently the OS default browser (drives the set-default affordance). */
  isDefaultBrowser: boolean;
  layout: WindowLayout;
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
 * {@link CommandBarMode} (a `commands` bar opens empty and, unlike `navigate`,
 * never falls back to another mode); `close` hides it; `submit` resolves the text
 * (defaulting to the currently-open mode when `mode` is omitted) and performs the
 * navigate or new-tab action, but rejects when the effective mode is `commands`
 * (which has no text action) and changes nothing; `state` reads back the current
 * {@link CommandBarState}.
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
   * Performs one suggestion's action and closes the bar, EXCEPT when the
   * accepted row is the `tab.new`, `bar.open-location`, or `bar.open-commands`
   * command, whose handlers re-open or switch the bar and leave it open in the
   * resulting mode. The row is the one at `index` when given (the clicked row),
   * otherwise the row at `selectedIndex`. An index outside
   * `0 .. suggestions.length - 1` rejects; with no index and
   * `selectedIndex === -1` it behaves like {@link CommandBarApi.submit} — except
   * in `commands` mode, which has no text action, so an empty list is a no-op
   * (submit rejects in commands mode) and the bar is left open.
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
 * Command-registry commands the renderer invokes over IPC, handled in main. `list()`
 * returns every registry {@link CommandDescriptor} in registry order; `run(id)`
 * dispatches command `id` through main's checked boundary. `run` rejects for an
 * unknown id or a command disabled in the current {@link CommandContext}.
 */
export interface CommandsApi {
  list(): Promise<CommandDescriptor[]>;
  run(id: CommandId): Promise<void>;
}

/**
 * Content-blocking commands the renderer invokes over IPC, handled in main.
 * `setEnabled(enabled)` turns blocking on or off; `state()` reads back the
 * current {@link BlockingState} (enabled flag, list version, blocked counts, and
 * allowlist). `allowSite(host)` adds `host` to the per-site allowlist and
 * `disallowSite(host)` removes it, both riding the existing `stateChange`
 * broadcast; `refreshLists()` re-fetches the filter lists and resolves `true`
 * on success.
 */
export interface BlockingApi {
  setEnabled(enabled: boolean): Promise<void>;
  state(): Promise<BlockingState>;
  allowSite(host: string): Promise<void>;
  disallowSite(host: string): Promise<void>;
  refreshLists(): Promise<boolean>;
}

/**
 * History commands the renderer invokes over IPC, handled in main against the
 * SQLite history tables. `search(query, limit)` returns the matching aggregated
 * {@link HistoryEntry} rows; `recent(limit)` returns the newest
 * {@link HistoryVisit} rows; `deleteUrl(url)` forgets one url (its visits
 * cascade); `clear()` empties all history. `limit` defaults to 50 in main and
 * is clamped there; a non-string url rejects with `TypeError`. History is never
 * broadcast — surfaces query it on demand.
 */
export interface HistoryApi {
  search(query: string, limit?: number): Promise<HistoryEntry[]>;
  recent(limit?: number): Promise<HistoryVisit[]>;
  deleteUrl(url: string): Promise<void>;
  clear(): Promise<void>;
  /**
   * The current history entry and visit counts, queried on demand from the
   * SQLite tables. Not broadcast — the settings history section reads it when
   * shown and re-reads it after a successful clear.
   */
  stats(): Promise<{ entries: number; visits: number }>;
}

/**
 * Download commands the renderer invokes over IPC, handled in main against the
 * single trusted global download manager (no per-profile or per-space ownership
 * check — any handler may act on any record by `id`). `list()` returns the
 * in-memory {@link Download} items (newest first, capped at 100). `cancel(id)`
 * cancels the live item when it is active and is a no-op on a finished, unknown,
 * or already-cleaned-up `id`. `open(id)` opens a completed file with the OS
 * handler and rejects otherwise; `reveal(id)` shows the item's path in Finder
 * and rejects for an unknown `id`. `remove(id)` forgets one record (commit-first;
 * it never deletes the file on disk); `clearFinished()` forgets every finished
 * record (never touching an active download or any file). Updates ride the
 * existing `stateChange` broadcast on {@link TabsState}, so there is no separate
 * change channel.
 */
export interface DownloadsApi {
  list(): Promise<Download[]>;
  cancel(id: string): Promise<void>;
  open(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  clearFinished(): Promise<void>;
}

/**
 * The persisted, broadcast settings slice. Currently just the chosen default
 * search engine; it rides the `stateChange` broadcast on {@link TabsState} the
 * same way {@link BlockingState} does, so a change needs no separate channel.
 */
export interface Settings {
  searchEngine: SearchEngineId;
  /**
   * When `true`, external links open in the transient quick-browse window
   * rather than a new tab in the active space.
   */
  quickBrowseExternal: boolean;
}

/**
 * Settings commands the renderer invokes over IPC, handled in main. `get()`
 * resolves the current in-memory {@link Settings}; `setSearchEngine(id)`
 * changes the default search engine: it resolves without side effects when
 * `id` is already current, rejects with a `TypeError` (changing nothing) when
 * `id` is not a catalog id, otherwise persists the new value then updates the
 * in-memory state and broadcasts — a persistence failure rejects and changes
 * nothing.
 */
export interface SettingsApi {
  get(): Promise<Settings>;
  setSearchEngine(id: SearchEngineId): Promise<void>;
  /**
   * Sets whether external links open in the quick-browse window: it resolves
   * without side effects when `enabled` is already current, rejects with a
   * `TypeError` (changing nothing) when `enabled` is not a boolean, otherwise
   * persists the new value then updates the in-memory state and broadcasts — a
   * persistence failure rejects and changes nothing.
   */
  setQuickBrowseExternal(enabled: boolean): Promise<void>;
}

/**
 * Quick-browse commands the renderer invokes over IPC, handled in main against
 * the single transient quick-browse window. Quick-browse rides the
 * `stateChange` broadcast on `TabsState.quickBrowse` — there is no dedicated
 * change channel.
 */
export interface QuickBrowseApi {
  /** The current quick-browse entry, or null when no window is open. */
  state(): Promise<QuickBrowse | null>;
  /** Promote the current link into the ACTIVE space, then tear the window down. */
  promote(): Promise<void>;
  /** Throw the current link away and tear the window down. */
  dismiss(): Promise<void>;
}

/**
 * Zoom commands the renderer invokes over IPC, handled in main. All three
 * mutating calls act on the ACTIVE tab of the active space: `zoomIn`/`zoomOut`
 * step the active tab's host up/down the Chromium zoom ladder and `reset`
 * returns it to the default factor. Each REJECTS and changes nothing when there
 * is no active tab or the active tab's current URL is not http(s). `state()`
 * reads back the current {@link ZoomState}. Zoom rides the `stateChange`
 * broadcast on `TabsState.zoom` — there is no dedicated change channel.
 */
export interface ZoomApi {
  zoomIn(): Promise<void>;
  zoomOut(): Promise<void>;
  reset(): Promise<void>;
  state(): Promise<ZoomState>;
}

/**
 * In-page find commands the renderer invokes over IPC, handled in main against
 * the single find session bound to the active tab. `open()` opens a fresh
 * session (rejects when there is no active tab); `setQuery(text)` commits the
 * search text and issues the search (an empty query clears highlights);
 * `next()`/`previous()` cycle the directional search (no-ops with an empty
 * query); `close()` is idempotent and hides the bar. `state()` reads back the
 * current {@link FindState}. Find rides the `stateChange` broadcast on
 * `TabsState.find` — there is no dedicated change channel.
 */
export interface FindApi {
  open(): Promise<void>;
  setQuery(text: string): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  close(): Promise<void>;
  state(): Promise<FindState>;
}

/**
 * The geometry the divider view needs to render and drag: the current left-pane
 * `ratio` and `dividableWidth`, the usable page width (in px) the ratio applies
 * to, so the view can translate a pixel drag back into a ratio.
 */
export interface DividerGeometry {
  ratio: number;
  dividableWidth: number;
}

/**
 * Split-view commands the renderer invokes over IPC, handled in main against the
 * active space's window {@link WindowLayout}. `split()` enters a split of the
 * active tab with the most recent other open tab; `splitWith(tabId)` splits
 * against a chosen tab; `unsplit()` collapses back to a single pane; `swap()`
 * exchanges the two panes; `focusPane(pane)` focuses a specific pane and
 * `focusOther()` toggles focus to the other one; `setRatio(ratio)` sets the
 * clamped left-pane fraction; `dividerGeometry()` reads the current
 * {@link DividerGeometry}; `state()` reads back the current {@link WindowLayout}.
 * The layout rides the `stateChange` broadcast on `TabsState.layout` — there is
 * no dedicated change channel for the layout itself.
 */
export interface SplitViewApi {
  split(): Promise<void>;
  splitWith(tabId: string): Promise<void>;
  unsplit(): Promise<void>;
  swap(): Promise<void>;
  focusPane(pane: PaneSide): Promise<void>;
  focusOther(): Promise<void>;
  setRatio(ratio: number): Promise<void>;
  dividerGeometry(): Promise<DividerGeometry>;
  state(): Promise<WindowLayout>;
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
  commands: CommandsApi;
  blocking: BlockingApi;
  history: HistoryApi;
  downloads: DownloadsApi;
  zoom: ZoomApi;
  settings: SettingsApi;
  quickBrowse: QuickBrowseApi;
  find: FindApi;
  splitView: SplitViewApi;
  onStateChange(listener: (state: TabsState) => void): () => void;
  /** Registers a listener for main-pushed command-bar state updates and returns
   *  an unsubscribe function, mirroring onStateChange. */
  onCommandBarChange(listener: (state: CommandBarState) => void): () => void;
  /** Registers a listener for main-pushed space-menu actions (Rename / New
   *  profile…) and returns an unsubscribe function, mirroring onStateChange. */
  onSpaceMenuAction(listener: (action: SpaceMenuAction) => void): () => void;
  /** Registers a listener for main-pushed divider layout geometry and returns an
   *  unsubscribe function, mirroring onStateChange. Delivered ONLY to the divider
   *  view (the draggable gutter between split panes), not to every renderer. */
  onDividerLayout(listener: (geom: DividerGeometry) => void): () => void;
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
  commandsList: "zeo:commands:list",
  commandsRun: "zeo:commands:run",
  blockingSetEnabled: "zeo:blocking:set-enabled",
  blockingState: "zeo:blocking:state",
  blockingAllowSite: "zeo:blocking:allow-site",
  blockingDisallowSite: "zeo:blocking:disallow-site",
  blockingRefresh: "zeo:blocking:refresh",
  historySearch: "zeo:history:search",
  historyRecent: "zeo:history:recent",
  historyDeleteUrl: "zeo:history:delete-url",
  historyClear: "zeo:history:clear",
  historyStats: "zeo:history:stats",
  downloadsList: "zeo:downloads:list",
  downloadsCancel: "zeo:downloads:cancel",
  downloadsOpen: "zeo:downloads:open",
  downloadsReveal: "zeo:downloads:reveal",
  downloadsRemove: "zeo:downloads:remove",
  downloadsClearFinished: "zeo:downloads:clear-finished",
  zoomIn: "zeo:zoom:in",
  zoomOut: "zeo:zoom:out",
  zoomReset: "zeo:zoom:reset",
  zoomState: "zeo:zoom:state",
  findOpen: "zeo:find:open",
  findSetQuery: "zeo:find:set-query",
  findNext: "zeo:find:next",
  findPrevious: "zeo:find:previous",
  findClose: "zeo:find:close",
  findState: "zeo:find:state",
  settingsGet: "zeo:settings:get",
  settingsSetSearchEngine: "zeo:settings:set-search-engine",
  settingsSetQuickBrowseExternal: "zeo:settings:set-quick-browse-external",
  quickBrowseState: "zeo:quick-browse:state",
  quickBrowsePromote: "zeo:quick-browse:promote",
  quickBrowseDismiss: "zeo:quick-browse:dismiss",
  splitViewSplit: "zeo:split-view:split",
  splitViewSplitWith: "zeo:split-view:split-with",
  splitViewUnsplit: "zeo:split-view:unsplit",
  splitViewSwap: "zeo:split-view:swap",
  splitViewFocusPane: "zeo:split-view:focus-pane",
  splitViewFocusOther: "zeo:split-view:focus-other",
  splitViewSetRatio: "zeo:split-view:set-ratio",
  splitViewDividerGeometry: "zeo:split-view:divider-geometry",
  splitViewState: "zeo:split-view:state",
  splitViewDividerLayout: "zeo:split-view:divider-layout",
  stateChange: "zeo:state-change",
} as const;
