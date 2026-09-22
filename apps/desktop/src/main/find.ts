import { ipcMain, WebContentsView } from "electron";
import { IPC, openFind, setFindQuery, beginFindRequest, closeFind } from "@zeo/core";
import type { FindState } from "@zeo/core";
import { runtime } from "./state.js";
import { broadcast, pushCommandBar } from "./broadcast.js";
import { layoutOverlay } from "./overlay.js";
import { closeCommandBar } from "./command-bar.js";

/**
 * Resolves the live {@link WebContentsView} the find session is bound to, or
 * `null` when the session is closed, the bound tab has no live view, or its
 * webContents has been destroyed.
 */
export function findBoundView(): WebContentsView | null {
  if (runtime.find.tabId === null) {
    return null;
  }
  const view = runtime.views.get(runtime.find.tabId);
  if (view == null || view.webContents.isDestroyed()) {
    return null;
  }
  return view;
}

/**
 * Issues one `findInPage` on the bound view (match-case always off) and records
 * its request id via {@link beginFindRequest}, so `found-in-page` results route
 * to this request by exact id. A no-op when there is no live bound view.
 */
export function issueFind(text: string, findNext: boolean, forward: boolean): void {
  const view = findBoundView();
  if (view === null) {
    return;
  }
  const requestId = view.webContents.findInPage(text, { findNext, forward, matchCase: false });
  runtime.find = beginFindRequest(runtime.find, requestId);
}

/**
 * Tears down the find session (PRD 6.3 §3 `close()`): clears highlights on the
 * bound view, resets the session, restores the overlay to the command-bar
 * surface, hides the overlay, pushes and broadcasts, then returns focus to the
 * active tab's page. Idempotent: a no-op when find is already closed.
 *
 * `returnFocus` defaults to true. It is passed `false` when the caller is about
 * to re-focus the overlay itself (opening the command bar over the same overlay):
 * focusing the page in between would blur the overlay, and that blur — delivered
 * asynchronously after the command bar has reopened — would fire the overlay's
 * blur handler and immediately close the just-opened bar.
 */
export function closeFindSession(returnFocus = true): void {
  if (!runtime.find.open) {
    return;
  }
  const view = findBoundView();
  if (view !== null) {
    view.webContents.stopFindInPage("clearSelection");
  }
  runtime.find = closeFind(runtime.find);
  runtime.commandBar = { ...runtime.commandBar, surface: "bar" };
  runtime.overlay?.setVisible(false);
  pushCommandBar();
  broadcast();
  if (!returnFocus) {
    return;
  }
  // Mirror closeCommandBar's focus return: hand focus back to the active tab's
  // page (or the window when there is none).
  const activeTabId = runtime.store.activeTabId;
  if (activeTabId !== null && runtime.views.has(activeTabId)) {
    runtime.views.get(activeTabId)?.webContents.focus();
  } else {
    runtime.win?.webContents.focus();
  }
}

/**
 * Opens (or re-focuses) the find session on the active tab (PRD 6.3 §3
 * `open()`). With no active tab it is a no-op — the IPC handler and command
 * enablement reject that case. When already open it just re-focuses the overlay
 * input (the find bar selects its text on focus). Otherwise it closes the command
 * bar if open (mutual exclusion), opens a fresh session, flips the overlay to the
 * find surface, lays it out with {@link findBarBounds}, and pushes/broadcasts.
 */
export function openFindSession(): void {
  const activeTabId = runtime.store.activeTabId;
  if (activeTabId === null) {
    return;
  }
  if (runtime.find.open) {
    // Already open: just re-focus the input; the find bar selects its text on focus.
    runtime.overlay?.webContents.focus();
    return;
  }
  if (runtime.commandBar.open) {
    closeCommandBar();
  }
  runtime.find = openFind(runtime.find, activeTabId);
  runtime.commandBar = { ...runtime.commandBar, surface: "find" };
  const shown = layoutOverlay();
  if (shown) {
    runtime.overlay?.webContents.focus();
  }
  pushCommandBar();
  broadcast();
}

/**
 * Cycles the find session forward (PRD 6.3 §3 `next()`). A no-op that issues no
 * request when find is closed or the query is empty/whitespace-only; otherwise
 * issues the forward directional `findInPage` and broadcasts.
 */
export function findNext(): void {
  if (!runtime.find.open || runtime.find.query.trim().length === 0) {
    return;
  }
  issueFind(runtime.find.query, true, true);
  broadcast();
}

/**
 * Cycles the find session backward (PRD 6.3 §3 `previous()`). A no-op that issues
 * no request when find is closed or the query is empty/whitespace-only; otherwise
 * issues the backward directional `findInPage` and broadcasts.
 */
export function findPrevious(): void {
  if (!runtime.find.open || runtime.find.query.trim().length === 0) {
    return;
  }
  issueFind(runtime.find.query, true, false);
  broadcast();
}

// Register the closeFindSession hook: destroyView, setActive (views.ts) and
// openCommandBar (command-bar.ts) call it to close find on a tab/bar change.
runtime.closeFindSession = closeFindSession;

// --- Find in page -------------------------------------------------------------
// open() opens (or re-focuses) a session bound to the active tab and rejects with
// no active tab; setQuery commits the search text and issues the search (an empty
// query clears highlights and issues no request); next/previous cycle the
// directional search (no-ops with an empty query) and reject with no active tab;
// close() is idempotent; state() reads back the current FindState. Find rides the
// existing stateChange broadcast on TabsState.find.
ipcMain.handle(IPC.findOpen, (): void => {
  if (runtime.store.activeTabId === null) {
    throw new Error("find.open: no active tab");
  }
  openFindSession();
});
ipcMain.handle(IPC.findSetQuery, (_event, text: string): void => {
  if (!runtime.find.open || runtime.store.activeTabId === null) {
    throw new Error("find.setQuery: no open session");
  }
  runtime.find = setFindQuery(runtime.find, text);
  if (text.trim().length === 0) {
    // Empty/whitespace-only query: clear highlights with no request so a delayed
    // result for the cleared query is rejected; the counter reads 0/0.
    findBoundView()?.webContents.stopFindInPage("clearSelection");
  } else {
    issueFind(text, false, true); // fresh search that selects the first match
  }
  broadcast();
});
ipcMain.handle(IPC.findNext, (): void => {
  if (runtime.store.activeTabId === null) {
    throw new Error("find.next: no active tab");
  }
  findNext();
});
ipcMain.handle(IPC.findPrevious, (): void => {
  if (runtime.store.activeTabId === null) {
    throw new Error("find.previous: no active tab");
  }
  findPrevious();
});
ipcMain.handle(IPC.findClose, (): void => {
  closeFindSession();
});
ipcMain.handle(IPC.findState, (): FindState => runtime.find);
