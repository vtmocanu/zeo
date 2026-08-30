import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@zeo/core";
import type { Tab, TabsState, ZeoApi } from "@zeo/core";

// The typed bridge exposed on window.zeo. It implements ZeoApi exactly and
// never leaks ipcRenderer across the contextIsolation boundary. Typed with
// `satisfies ZeoApi` so it stays in lockstep with the @zeo/core contract.
const api = {
  tabs: {
    create: (url?: string): Promise<Tab> => ipcRenderer.invoke(IPC.tabsCreate, url),
    close: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsClose, id),
    activate: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsActivate, id),
    list: (): Promise<TabsState> => ipcRenderer.invoke(IPC.tabsList),
    pin: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsPin, id),
    unpin: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsUnpin, id),
    reorder: (id: string, toIndex: number): Promise<void> => ipcRenderer.invoke(IPC.tabsReorder, id, toIndex),
    archive: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsArchive, id),
    restore: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabsRestore, id),
  },
  onStateChange: (listener: (state: TabsState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TabsState): void => listener(state);
    ipcRenderer.on(IPC.stateChange, handler);
    return () => {
      ipcRenderer.removeListener(IPC.stateChange, handler);
    };
  },
} satisfies ZeoApi;

contextBridge.exposeInMainWorld("zeo", api);
