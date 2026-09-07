import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@zeo/core";
import type {
  BlockingState,
  CommandBarMode,
  CommandBarState,
  CommandDescriptor,
  CommandId,
  HistoryEntry,
  HistoryVisit,
  Profile,
  SearchEngineId,
  Settings,
  Space,
  SpaceContextMenuResult,
  SpaceMenuAction,
  SpacesState,
  Tab,
  TabContextMenuResult,
  TabsState,
  ZeoApi,
  ZoomState,
} from "@zeo/core";

// The typed bridge exposed on window.zeo. It implements ZeoApi exactly and
// never leaks ipcRenderer across the contextIsolation boundary. Typed with
// `satisfies ZeoApi` so it stays in lockstep with the @zeo/core contract.
const api = {
  tabs: {
    create: (url?: string): Promise<Tab> => ipcRenderer.invoke(IPC.tabsCreate, url),
    navigate: (id: string, url: string): Promise<void> =>
      ipcRenderer.invoke(IPC.tabsNavigate, id, url),
    close: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsClose, id),
    activate: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsActivate, id),
    list: (): Promise<TabsState> => ipcRenderer.invoke(IPC.tabsList),
    pin: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsPin, id),
    unpin: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsUnpin, id),
    reorder: (id: string, toIndex: number): Promise<void> => ipcRenderer.invoke(IPC.tabsReorder, id, toIndex),
    archive: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsArchive, id),
    restore: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsRestore, id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsRemove, id),
    showContextMenu: (id: string, x: number, y: number): Promise<TabContextMenuResult> =>
      ipcRenderer.invoke(IPC.tabsContextMenu, id, x, y),
  },
  spaces: {
    create: (name: string): Promise<Space> => ipcRenderer.invoke(IPC.spacesCreate, name),
    rename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.spacesRename, id, name),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.spacesDelete, id),
    activate: (id: string): Promise<void> => ipcRenderer.invoke(IPC.spacesActivate, id),
    setProfile: (spaceId: string, profileId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.spacesSetProfile, spaceId, profileId),
    list: (): Promise<SpacesState> => ipcRenderer.invoke(IPC.spacesList),
    showContextMenu: (id: string, x: number, y: number): Promise<SpaceContextMenuResult> =>
      ipcRenderer.invoke(IPC.spacesContextMenu, id, x, y),
  },
  profiles: {
    create: (name: string): Promise<Profile> => ipcRenderer.invoke(IPC.profilesCreate, name),
    rename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.profilesRename, id, name),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.profilesDelete, id),
  },
  commandBar: {
    open: (mode: CommandBarMode): Promise<void> => ipcRenderer.invoke(IPC.commandBarOpen, mode),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.commandBarClose),
    submit: (text: string, mode?: CommandBarMode): Promise<void> =>
      ipcRenderer.invoke(IPC.commandBarSubmit, text, mode),
    state: (): Promise<CommandBarState> => ipcRenderer.invoke(IPC.commandBarState),
    setQuery: (text: string): Promise<void> => ipcRenderer.invoke(IPC.commandBarSetQuery, text),
    moveSelection: (delta: 1 | -1): Promise<void> =>
      ipcRenderer.invoke(IPC.commandBarMove, delta),
    accept: (index?: number, revision?: number): Promise<void> =>
      ipcRenderer.invoke(IPC.commandBarAccept, index, revision),
  },
  commands: {
    list: (): Promise<CommandDescriptor[]> => ipcRenderer.invoke(IPC.commandsList),
    run: (id: CommandId): Promise<void> => ipcRenderer.invoke(IPC.commandsRun, id),
  },
  blocking: {
    setEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.blockingSetEnabled, enabled),
    state: (): Promise<BlockingState> => ipcRenderer.invoke(IPC.blockingState),
    allowSite: (host: string): Promise<void> => ipcRenderer.invoke(IPC.blockingAllowSite, host),
    disallowSite: (host: string): Promise<void> =>
      ipcRenderer.invoke(IPC.blockingDisallowSite, host),
    refreshLists: (): Promise<boolean> => ipcRenderer.invoke(IPC.blockingRefresh),
  },
  history: {
    search: (query: string, limit?: number): Promise<HistoryEntry[]> =>
      ipcRenderer.invoke(IPC.historySearch, query, limit),
    recent: (limit?: number): Promise<HistoryVisit[]> =>
      ipcRenderer.invoke(IPC.historyRecent, limit),
    deleteUrl: (url: string): Promise<void> =>
      ipcRenderer.invoke(IPC.historyDeleteUrl, url),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),
    stats: (): Promise<{ entries: number; visits: number }> =>
      ipcRenderer.invoke(IPC.historyStats),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    setSearchEngine: (id: SearchEngineId): Promise<void> =>
      ipcRenderer.invoke(IPC.settingsSetSearchEngine, id),
  },
  zoom: {
    zoomIn: (): Promise<void> => ipcRenderer.invoke(IPC.zoomIn),
    zoomOut: (): Promise<void> => ipcRenderer.invoke(IPC.zoomOut),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.zoomReset),
    state: (): Promise<ZoomState> => ipcRenderer.invoke(IPC.zoomState),
  },
  onStateChange: (listener: (state: TabsState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TabsState): void => listener(state);
    ipcRenderer.on(IPC.stateChange, handler);
    return () => {
      ipcRenderer.removeListener(IPC.stateChange, handler);
    };
  },
  onCommandBarChange: (listener: (state: CommandBarState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: CommandBarState): void =>
      listener(state);
    ipcRenderer.on(IPC.commandBarChange, handler);
    return () => {
      ipcRenderer.removeListener(IPC.commandBarChange, handler);
    };
  },
  onSpaceMenuAction: (listener: (action: SpaceMenuAction) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: SpaceMenuAction): void => listener(action);
    ipcRenderer.on(IPC.spaceMenuAction, handler);
    return () => {
      ipcRenderer.removeListener(IPC.spaceMenuAction, handler);
    };
  },
} satisfies ZeoApi;

contextBridge.exposeInMainWorld("zeo", api);
