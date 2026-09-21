import { ipcMain, WebContentsView } from "electron";
import { join } from "node:path";
import {
  IPC,
  SIDEBAR_WIDTH,
  DIVIDER_WIDTH,
  splitPaneBounds,
  DEFAULT_SPLIT_RATIO,
  clampRatio,
  enterSplit,
  unsplit,
  swapPanes,
  setRatio,
  focusOtherPane,
  reconcileLayout,
  focusedPaneTab,
  paneOf,
} from "@zeo/core";
import type { DividerGeometry, PaneSide, Tab, WindowLayout } from "@zeo/core";
import { writeWindowLayout } from "./db.js";
import { runtime, moduleDir, LAYOUT_SAVE_DEBOUNCE_MS } from "./state.js";
import { broadcast } from "./broadcast.js";
import { createViewFor, destroyView, ensureActiveView, raiseOverlays } from "./views.js";

/**
 * The usable page width a split `ratio` applies to: the content width minus the
 * sidebar and the divider gutter. Zero when there is no window.
 */
export function dividableWidth(): number {
  if (runtime.win === null) {
    return 0;
  }
  const [contentWidth] = runtime.win.getContentSize();
  return contentWidth - SIDEBAR_WIDTH - DIVIDER_WIDTH;
}

/**
 * Creates the divider gutter view lazily on first entry into a split, mirroring
 * the command-bar overlay: same preload/webPreferences (default session), parented
 * to the window, started hidden, loading the shared renderer bundle with a
 * `?view=divider` marker (dev URL, or the prod `loadFile` query fallback). A no-op
 * when the window is gone or the view already exists.
 */
export function ensureDividerView(): void {
  if (runtime.win === null || runtime.dividerView !== null) {
    return;
  }
  runtime.dividerView = new WebContentsView({
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  runtime.win!.contentView.addChildView(runtime.dividerView);
  runtime.dividerView!.setVisible(false);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined && rendererUrl !== "") {
    runtime.dividerView!.webContents.loadURL(rendererUrl + "?view=divider").catch(() => {
      // Dev-server races are retried by the window's loadDev loop; the divider
      // view shares the same bundle, so a transient failure here is non-fatal.
    });
  } else {
    void runtime.dividerView!.webContents.loadFile(join(moduleDir, "../renderer/index.html"), {
      query: { view: "divider" },
    });
  }
}

/**
 * Reconciles the on-screen views to the current {@link layout} and
 * `store.activeTabId`. In single mode it hides the divider (if it exists) and runs
 * the existing single-view logic via {@link ensureActiveView} (materialize + show
 * the active view, hide the rest). In split mode it materializes each pane view if
 * missing, bounds the two panes and the divider via {@link splitPaneBounds}, shows
 * them, hides every other tracked view, re-raises the z-order, and focuses the
 * focused pane's view. Every op is guarded so a pane view destroyed mid-reconcile
 * is skipped, not fatal. Called everywhere the layout or the active view can
 * change.
 */
export function applyLayout(): void {
  if (runtime.win === null) {
    return;
  }
  const layout = runtime.layout;
  if (layout.mode === "single") {
    if (runtime.dividerView !== null && !runtime.dividerView.webContents.isDestroyed()) {
      runtime.dividerView.setVisible(false);
    }
    ensureActiveView();
    return;
  }
  // Split: materialize each pane's view if it has none yet (mirroring
  // ensureActiveView's lazy create), then lay both panes + the divider out.
  const paneIds: readonly [string, string] = [layout.left, layout.right];
  for (const paneTabId of paneIds) {
    if (!runtime.views.has(paneTabId)) {
      const tab = runtime.store.list().find((t) => t.id === paneTabId);
      if (tab !== undefined) {
        createViewFor(tab, runtime.store.activeSpaceId);
      }
    }
  }
  const [contentWidth, contentHeight] = runtime.win!.getContentSize();
  const b = splitPaneBounds(contentWidth, contentHeight, layout.ratio);
  for (const [tabId, tracked] of runtime.views) {
    const view = tracked.view;
    if (view.webContents.isDestroyed()) {
      continue;
    }
    if (tabId === layout.left) {
      view.setBounds(b.left);
      view.setVisible(true);
    } else if (tabId === layout.right) {
      view.setBounds(b.right);
      view.setVisible(true);
    } else {
      view.setVisible(false);
    }
  }
  ensureDividerView();
  // A freshly created divider sits on top of everything; re-raise the overlays so
  // the divider is above the panes and the settings view / command bar above it.
  raiseOverlays();
  if (runtime.dividerView !== null && !runtime.dividerView.webContents.isDestroyed()) {
    runtime.dividerView.setBounds(b.divider);
    runtime.dividerView.setVisible(true);
  }
  const focusedTabId = focusedPaneTab(layout);
  if (focusedTabId !== null) {
    const focusedView = runtime.views.get(focusedTabId)?.view;
    if (focusedView !== undefined && !focusedView.webContents.isDestroyed()) {
      focusedView.webContents.focus();
    }
  }
}

/**
 * Reconciles {@link layout} against the active space's live open tabs and active
 * tab, then materializes the result with {@link applyLayout}. The single
 * idempotent view-reconcile entry point: in single mode it behaves like
 * {@link ensureActiveView}; in split mode it re-lays the panes + divider or
 * collapses to single when the split can no longer be honored.
 */
export function reconcileAndApply(): void {
  runtime.layout = reconcileLayout(
    runtime.layout,
    runtime.store.list().map((t) => t.id),
    runtime.store.activeTabId,
  );
  applyLayout();
}

/**
 * When `closedId` was a split pane, activates the SURVIVING pane's tab (if still
 * open) so it becomes the single active view after the split collapses, rather
 * than an arbitrary MRU tab the store may have re-pointed to. Reads {@link layout}
 * (unchanged by the store mutation) so it must be called AFTER the store op but
 * BEFORE reconciling. A no-op when `closedId` was not a pane.
 */
export function preserveSurvivingPane(closedId: string): void {
  const layout = runtime.layout;
  const side = paneOf(layout, closedId);
  if (side !== null && layout.mode === "split") {
    const survivor = side === "left" ? layout.right : layout.left;
    if (runtime.store.list().some((t) => t.id === survivor)) {
      runtime.store.activate(survivor);
    }
  }
}

/**
 * Persists the current {@link layout} immediately, swallowing (logging) a write
 * failure so a persistence outage (e.g. running without a db this session) never
 * breaks the in-memory split. Discrete split ops call this directly; ratio drags
 * coalesce onto {@link scheduleLayoutSave}.
 */
export function persistLayout(): void {
  try {
    writeWindowLayout(runtime.layout);
  } catch (err) {
    console.error("[split] failed to persist layout:", err);
  }
}

/**
 * Schedules a debounced persist of {@link layout} (~{@link LAYOUT_SAVE_DEBOUNCE_MS}),
 * replacing any pending one, so a ratio drag collapses into a single write after
 * it settles. Used only by {@link doSetRatio}.
 */
export function scheduleLayoutSave(): void {
  if (runtime.layoutSaveTimer !== null) {
    clearTimeout(runtime.layoutSaveTimer);
  }
  runtime.layoutSaveTimer = setTimeout(() => {
    runtime.layoutSaveTimer = null;
    persistLayout();
  }, LAYOUT_SAVE_DEBOUNCE_MS);
}

/**
 * Flushes a pending debounced layout save SYNCHRONOUSLY, cancelling the timer
 * first. Called at quit alongside {@link flush} so a divider drag that settled
 * within {@link LAYOUT_SAVE_DEBOUNCE_MS} of Cmd+Q is still persisted — the layout
 * lives outside the store snapshot, so the store flush does not cover it.
 */
export function flushLayoutSave(): void {
  if (runtime.layoutSaveTimer === null) {
    return;
  }
  clearTimeout(runtime.layoutSaveTimer);
  runtime.layoutSaveTimer = null;
  persistLayout();
}

/**
 * Sends the divider view its current geometry (the left-pane `ratio` and the
 * usable `dividableWidth` the ratio applies to) over
 * {@link IPC.splitViewDividerLayout}, so the gutter can translate a pixel drag
 * back into a ratio. A no-op unless in split with a live divider view. Called
 * after entering split, after {@link doSetRatio}, and on resize.
 */
export function sendDividerGeometry(): void {
  const layout = runtime.layout;
  if (layout.mode !== "split") {
    return;
  }
  if (runtime.dividerView === null || runtime.dividerView.webContents.isDestroyed()) {
    return;
  }
  runtime.dividerView.webContents.send(IPC.splitViewDividerLayout, {
    ratio: layout.ratio,
    dividableWidth: dividableWidth(),
  });
}

/**
 * The {@link DividerGeometry} seed the renderer reads on demand: the live `ratio`
 * and `dividableWidth` in split, or {@link DEFAULT_SPLIT_RATIO} + `dividableWidth`
 * in single. Changes no state.
 */
export function dividerGeometrySeed(): DividerGeometry {
  const layout = runtime.layout;
  return {
    ratio: layout.mode === "split" ? layout.ratio : DEFAULT_SPLIT_RATIO,
    dividableWidth: dividableWidth(),
  };
}

/**
 * The most-recently-active OTHER open tab of the active space: from `store.list()`
 * (the active space's open tabs) excluding the active tab, the one with the
 * greatest `lastActiveAt`, ties broken by ascending order in `store.list()`.
 * `null` when there is no other open tab.
 */
export function mostRecentOtherTabId(): string | null {
  const activeId = runtime.store.activeTabId;
  let best: Tab | null = null;
  for (const t of runtime.store.list()) {
    if (t.id === activeId) {
      continue;
    }
    if (best === null || t.lastActiveAt > best.lastActiveAt) {
      best = t;
    }
  }
  return best?.id ?? null;
}

/**
 * Enters a split of the active tab (left, focused) with the most recent other
 * open tab (PRD §6). REJECTS (changing nothing) when there is no active tab, the
 * layout is already split, or the active space has fewer than two open tabs. On
 * success it updates + persists the layout, re-lays the views, sends the divider
 * geometry, and broadcasts.
 */
export function doSplit(): Promise<void> {
  const activeId = runtime.store.activeTabId;
  if (activeId === null) {
    return Promise.reject(new Error("split: no active tab"));
  }
  if (runtime.layout.mode === "split") {
    return Promise.reject(new Error("split: layout is already split"));
  }
  if (runtime.store.list().length < 2) {
    return Promise.reject(new Error("split: need at least two open tabs"));
  }
  const otherId = mostRecentOtherTabId();
  if (otherId === null) {
    return Promise.reject(new Error("split: no other open tab to split against"));
  }
  runtime.layout = enterSplit(activeId, otherId);
  persistLayout();
  applyLayout();
  sendDividerGeometry();
  broadcast();
  return Promise.resolve();
}

/**
 * Enters a split of the active tab (left, focused) with the chosen `tabId` (PRD
 * §6). REJECTS (changing nothing) when there is no active tab, the layout is
 * already split, `tabId` is the active tab, or `tabId` is not an open tab of the
 * active space. On success it updates + persists the layout, re-lays the views,
 * sends the divider geometry, and broadcasts.
 */
export function doSplitWith(tabId: string): Promise<void> {
  const activeId = runtime.store.activeTabId;
  if (activeId === null) {
    return Promise.reject(new Error("splitWith: no active tab"));
  }
  if (runtime.layout.mode === "split") {
    return Promise.reject(new Error("splitWith: layout is already split"));
  }
  if (tabId === activeId) {
    return Promise.reject(new Error("splitWith: cannot split a tab with itself"));
  }
  if (!runtime.store.list().some((t) => t.id === tabId)) {
    return Promise.reject(new Error("splitWith: not an open tab of the active space"));
  }
  runtime.layout = enterSplit(activeId, tabId);
  persistLayout();
  applyLayout();
  sendDividerGeometry();
  broadcast();
  return Promise.resolve();
}

/**
 * Collapses a split back to a single pane (PRD §6), keeping the focused pane's tab
 * active. A no-op when already single. Persists, re-lays the views (hiding the
 * divider), and broadcasts.
 */
export function doUnsplit(): void {
  if (runtime.layout.mode === "single") {
    return;
  }
  const focusedTabId = focusedPaneTab(runtime.layout);
  if (focusedTabId !== null) {
    runtime.store.activate(focusedTabId);
  }
  runtime.layout = unsplit(runtime.layout);
  persistLayout();
  applyLayout();
  broadcast();
}

/**
 * Swaps the two panes (PRD §6): the same tab stays active and focused, so no
 * store re-activation is needed. A no-op when single. Persists, re-lays the views,
 * sends the divider geometry, and broadcasts.
 */
export function doSwap(): void {
  if (runtime.layout.mode === "single") {
    return;
  }
  runtime.layout = swapPanes(runtime.layout);
  persistLayout();
  applyLayout();
  sendDividerGeometry();
  broadcast();
}

/**
 * Focuses a specific pane (PRD §6). Throws a `TypeError` (rejecting before any
 * change) when `pane` is not exactly `"left"` or `"right"` — a runtime guard on
 * the untrusted IPC payload. A no-op when single or the pane is already focused.
 * Otherwise it points focus + the active tab at that pane (keeping the §2
 * invariant), reconciles to confirm, persists, re-lays, and broadcasts.
 */
export function doFocusPane(pane: PaneSide): void {
  if (pane !== "left" && pane !== "right") {
    throw new TypeError("splitView.focusPane expects 'left' or 'right'");
  }
  if (runtime.layout.mode === "single" || runtime.layout.focused === pane) {
    return;
  }
  const paneTabId = pane === "left" ? runtime.layout.left : runtime.layout.right;
  runtime.layout = { ...runtime.layout, focused: pane };
  runtime.store.activate(paneTabId);
  runtime.layout = reconcileLayout(
    runtime.layout,
    runtime.store.list().map((t) => t.id),
    runtime.store.activeTabId,
  );
  persistLayout();
  applyLayout();
  broadcast();
}

/**
 * Toggles focus to the other pane (PRD §6), pointing the active tab at the newly
 * focused pane so `store.activeTabId` tracks focus (§2). The only caller of
 * {@link focusOtherPane}. A no-op when single. Persists, re-lays, and broadcasts.
 */
export function doFocusOther(): void {
  if (runtime.layout.mode === "single") {
    return;
  }
  runtime.layout = focusOtherPane(runtime.layout);
  const focusedTabId = focusedPaneTab(runtime.layout);
  if (focusedTabId !== null) {
    runtime.store.activate(focusedTabId);
  }
  persistLayout();
  applyLayout();
  broadcast();
}

/**
 * Sets the left-pane width fraction to `clampRatio(ratio)` (PRD §6). A no-op when
 * single OR when the clamped ratio equals the current one (no broadcast). Else it
 * updates the layout, re-bounds both panes + the divider, sends the divider
 * geometry, broadcasts, and schedules a DEBOUNCED persist (a drag writes once
 * after it settles).
 */
export function doSetRatio(ratio: number): void {
  const layout = runtime.layout;
  if (layout.mode === "single") {
    return;
  }
  if (clampRatio(ratio) === layout.ratio) {
    return;
  }
  runtime.layout = setRatio(layout, ratio);
  applyLayout();
  sendDividerGeometry();
  broadcast();
  scheduleLayoutSave();
}

/**
 * Activates a tab: selects it in the store, then reconciles its view — recreating
 * a missing view (e.g. a not-yet-materialized restored tab, so a numeric
 * activator shows a real page rather than blank) and retrying a view whose last
 * load failed — before showing it and broadcasting. Shared by the tabsActivate
 * IPC handler and the "Activate Tab N" menu items.
 */
export function activateTab(id: string): void {
  runtime.store.activate(id);
  // Honor the remap contract: a tab whose view failed to be created or failed
  // to load is retried when the user next activates it. Recreate a missing
  // view; otherwise re-issue the load for a view whose last load failed.
  if (!runtime.views.has(id)) {
    const tab = runtime.store.list().find((t) => t.id === id);
    if (tab !== undefined) {
      createViewFor(tab, runtime.store.activeSpaceId);
    }
  } else if (runtime.failedLoads.has(id)) {
    const tracked = runtime.views.get(id);
    const tab = runtime.store.list().find((t) => t.id === id);
    if (tracked !== undefined && tab !== undefined) {
      destroyView(id);
      runtime.failedLoads.delete(id);
      createViewFor(tab, tracked.spaceId);
    }
  }
  // Layout-aware reconcile: activating a pane tab re-focuses that pane; activating
  // a non-pane tab collapses the split to single (reconcile drops the split when
  // the active tab is neither pane), and applyLayout materializes the view.
  reconcileAndApply();
  broadcast();
}

// --- Split view (PRD 7.1) -----------------------------------------------------
// split/splitWith run the internal ops and let a rejection (no active tab,
// already split, bad tab, < 2 open tabs) propagate to the renderer's invoke;
// unsplit/swap/focusOther/setRatio are always-valid no-op-or-apply void ops;
// focusPane throws a TypeError on a bad pane payload (rejecting over the bridge);
// dividerGeometry/state read the current geometry/layout back synchronously. The
// layout rides the existing stateChange broadcast on TabsState.layout.
ipcMain.handle(IPC.splitViewSplit, async (): Promise<void> => {
  await doSplit();
});

ipcMain.handle(IPC.splitViewSplitWith, async (_event, tabId: string): Promise<void> => {
  await doSplitWith(tabId);
});

ipcMain.handle(IPC.splitViewUnsplit, (): void => {
  doUnsplit();
});

ipcMain.handle(IPC.splitViewSwap, (): void => {
  doSwap();
});

ipcMain.handle(IPC.splitViewFocusPane, (_event, pane: PaneSide): void => {
  doFocusPane(pane);
});

ipcMain.handle(IPC.splitViewFocusOther, (): void => {
  doFocusOther();
});

ipcMain.handle(IPC.splitViewSetRatio, (_event, ratio: number): void => {
  doSetRatio(ratio);
});

ipcMain.handle(IPC.splitViewDividerGeometry, (): DividerGeometry => dividerGeometrySeed());

ipcMain.handle(IPC.splitViewState, (): WindowLayout => runtime.layout);
