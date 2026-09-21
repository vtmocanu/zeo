import { ipcMain, WebContentsView } from "electron";
import { IPC, siteKeyForUrl, setHostZoom, DEFAULT_ZOOM_FACTOR, zoomIn, zoomOut } from "@zeo/core";
import type { ZoomState } from "@zeo/core";
import { deleteSiteZoom, upsertSiteZoom } from "./db.js";
import { runtime } from "./state.js";
import { broadcast, fullSnapshot } from "./broadcast.js";

/** Sets the on-screen zoom factor for one view. The ONLY caller of
 *  `setZoomFactor`; never persists or broadcasts. No-op on a destroyed view. */
export function applyViewZoom(view: WebContentsView, factor: number): void {
  if (view.webContents.isDestroyed()) {
    return;
  }
  view.webContents.setZoomFactor(factor);
}

/** The single write path for a host's persisted zoom factor. Resolves the tab's
 *  view and host; a null host (non-http(s)) just forces the view to 1.0 and
 *  touches no state. Otherwise computes the would-be ZoomState; if the host's
 *  stored factor is unchanged it is a FULL no-op. Else it persists first (upsert
 *  for a non-default factor, delete when the reducer removed the host), and only
 *  on success replaces the in-memory zoom, re-applies to every LIVE view on that
 *  host, and broadcasts. A DB write failure aborts with no state/view/broadcast
 *  change. No-op for an unknown/destroyed tab view. */
export function applyZoom(tabId: string, factor: number): void {
  const view = runtime.views.get(tabId)?.view;
  if (view === undefined || view.webContents.isDestroyed()) {
    return;
  }
  const host = siteKeyForUrl(view.webContents.getURL());
  if (host === null) {
    applyViewZoom(view, DEFAULT_ZOOM_FACTOR);
    return;
  }
  const next = setHostZoom(runtime.zoom, host, factor);
  const after = next.byHost[host];
  if (runtime.zoom.byHost[host] === after) {
    return; // idempotent: the host's factor is unchanged
  }
  try {
    if (after === undefined) {
      deleteSiteZoom(host);
    } else {
      upsertSiteZoom(host, after, Date.now());
    }
  } catch (err) {
    console.error("[zoom] failed to persist zoom for", host, err);
    return; // abort: leave persisted state, in-memory zoom, and views consistent
  }
  runtime.zoom = next;
  const applied = after ?? DEFAULT_ZOOM_FACTOR;
  for (const tracked of runtime.views.values()) {
    const v = tracked.view;
    if (v.webContents.isDestroyed()) {
      continue;
    }
    if (siteKeyForUrl(v.webContents.getURL()) === host) {
      applyViewZoom(v, applied);
    }
  }
  broadcast();
}

/** Steps or resets the ACTIVE tab's host zoom. Rejects (changing nothing) when
 *  there is no active tab, no live view, or the tab's current URL is not
 *  http(s). Backs the ZoomApi IPC handlers and the zoom.* command handlers. */
export function zoomActiveTab(direction: "in" | "out" | "reset"): Promise<void> {
  const activeTabId = runtime.store.activeTabId;
  if (activeTabId === null) {
    return Promise.reject(new Error("no active tab"));
  }
  const view = runtime.views.get(activeTabId)?.view;
  if (view === undefined || view.webContents.isDestroyed()) {
    return Promise.reject(new Error("no active tab view"));
  }
  const host = siteKeyForUrl(view.webContents.getURL());
  if (host === null) {
    return Promise.reject(new Error("active tab is not http(s)"));
  }
  const current = runtime.zoom.byHost[host] ?? DEFAULT_ZOOM_FACTOR;
  const factor =
    direction === "in" ? zoomIn(current) : direction === "out" ? zoomOut(current) : DEFAULT_ZOOM_FACTOR;
  applyZoom(activeTabId, factor);
  return Promise.resolve();
}

// --- Zoom ---------------------------------------------------------------------
// zoomIn/zoomOut/reset act on the active tab of the active space and reject when
// there is no active tab or the active tab's url is non-http(s); each routes
// through the shared zoomActiveTab helper (and applyZoom, the single host-state
// write path). zoomState reads back the current ZoomState off the broadcast
// snapshot; zoom changes ride the existing stateChange broadcast.
ipcMain.handle(IPC.zoomIn, (): Promise<void> => zoomActiveTab("in"));
ipcMain.handle(IPC.zoomOut, (): Promise<void> => zoomActiveTab("out"));
ipcMain.handle(IPC.zoomReset, (): Promise<void> => zoomActiveTab("reset"));
ipcMain.handle(IPC.zoomState, (): ZoomState => fullSnapshot().zoom);
