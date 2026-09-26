import { WebContentsView, session } from "electron";
import {
  SIDEBAR_WIDTH,
  titleForUrl,
  historyKey,
  siteKeyForUrl,
  resetBlockedCount,
  applyFindResult,
  clearFindResults,
  zoomIn,
  zoomOut,
  DEFAULT_ZOOM_FACTOR,
  selectViewsToUnload,
  VIEW_UNLOAD_AFTER_MS,
  VIEW_UNLOAD_INTERVAL_MS,
} from "@zeo/core";
import type { Tab, UnloadCandidate } from "@zeo/core";
import { updateVisitTitle } from "./db.js";
import { runtime } from "./state.js";
import { broadcast, noteInactiveChange, scheduleBlockingBroadcast } from "./broadcast.js";
import { recordNavigation, logHistoryError } from "./history.js";
import { applyViewZoom, applyZoom } from "./zoom.js";

/** Bounds of the tab web-view region: everything right of the sidebar. */
export function viewBounds(): Electron.Rectangle {
  if (runtime.win === null) {
    return { x: SIDEBAR_WIDTH, y: 0, width: 0, height: 0 };
  }
  const [width, height] = runtime.win.getContentSize();
  return {
    x: SIDEBAR_WIDTH,
    y: 0,
    width: Math.max(0, width - SIDEBAR_WIDTH),
    height,
  };
}

/**
 * The Electron sessions for every profile partition (`persist:<profileId>`), the
 * set the blocker attaches to. Derived from the store's profiles on each call so
 * a newly created profile is covered the next time it runs.
 */
export function profileSessions(): Electron.Session[] {
  return runtime.store.profiles().map((p) => session.fromPartition("persist:" + p.id));
}

/**
 * Re-raises the fixed overlay views to the top of the z-order after a tab or
 * divider view has been (re-)added, keeping the invariant tab views < divider
 * view < settings view < command-bar overlay. Re-adding a child raises it over
 * the views added before it, so re-adding the divider, then the settings view,
 * then the overlay lands each above the previous. Null-guarded so an early call
 * (before any of them exist) is safe. Shared by {@link createViewFor} and
 * {@link applyLayout}.
 */
export function raiseOverlays(): void {
  if (runtime.win === null) {
    return;
  }
  if (runtime.dividerView !== null && !runtime.dividerView.webContents.isDestroyed()) {
    runtime.win!.contentView.addChildView(runtime.dividerView);
  }
  if (runtime.settingsOpen && runtime.settingsView !== null) {
    runtime.win!.contentView.addChildView(runtime.settingsView);
  }
  if (runtime.overlay !== null) {
    runtime.win!.contentView.addChildView(runtime.overlay);
  }
}

/**
 * Creates a hidden web view for a tab owned by `spaceId` and starts loading its
 * url. `spaceId` selects the profile partition the view runs on; the view is
 * stored bare (keyed by tab id) — ownership is read back from the store's
 * `spaceOfTab`, not tagged here. `urlOverride`, when given, is loaded instead of
 * the tab's stored url (used by profile remap to preserve each live view's
 * current url).
 */
export function createViewFor(tab: Tab, spaceId: string, urlOverride?: string): void {
  if (runtime.win === null) {
    return;
  }
  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:" + runtime.store.spaceProfileId(spaceId),
      // Run the adblock cosmetic frame preload in cross-origin child frames too:
      // Electron only lets a child frame send IPC (the preload's
      // inject-cosmetic-filters invoke) when nodeIntegrationInSubFrames is
      // enabled, so without this an iframe's ads are never hidden (PRD 5.3). This
      // does NOT weaken isolation — sandbox and contextIsolation keep their secure
      // defaults, so page scripts still get nothing; it only lets the isolated
      // preload run and invoke in subframes, and the wrapper validates
      // event.senderFrame on every message.
      nodeIntegrationInSubFrames: true,
    },
  });
  runtime.views.set(tab.id, view);
  // Route every page-initiated popup (window.open / target="_blank") into a tab
  // in the owning space instead of a BrowserWindow (#62). The handler calls a
  // late-bound runtime hook so views.ts keeps NO import edge to tabs.ts (madge
  // --circular clean); tabs.ts registers runtime.openPopupAsTab at module load.
  view.webContents.setWindowOpenHandler(({ url }) => {
    runtime.openPopupAsTab?.(tab.id, url);
    return { action: "deny" };
  });
  // Disable pinch-to-zoom so the visual viewport never drifts from the applied
  // per-site factor; zoom is driven only by setZoomFactor via applyViewZoom.
  view.webContents.setVisualZoomLevelLimits(1, 1);
  // Reverse index for blocked-request attribution: this view's webContents id
  // maps to its tab. Removed in destroyView. The parallel forward index records
  // the same id keyed by tab so teardown can drop the reverse entry even after
  // the webContents is destroyed (its id would then be inaccessible).
  runtime.webContentsToTab.set(view.webContents.id, tab.id);
  runtime.tabToWcId.set(tab.id, view.webContents.id);
  runtime.win!.contentView.addChildView(view);
  view.setBounds(viewBounds());
  view.setVisible(false);

  // Live title/favicon: the hostname-derived title seeded by store.create stays
  // as the fallback until the first page-title-updated arrives. updateMeta
  // no-ops on an unknown/torn-down id, so late events after close are safe.
  view.webContents.on("page-title-updated", (_event, title) => {
    runtime.hasRealTitle.add(tab.id);
    // Gate ONLY the snapshot push on ownership: an active-space title change pushes
    // a full snapshot, an inactive-space one persists + refreshes the catalog with
    // no push. Never early-return here — the hasRealTitle mark above and the
    // history bookkeeping below must run regardless of whether the title changed.
    const { changed, inActiveSpace } = runtime.store.updateMeta(tab.id, { title });
    if (changed) {
      if (inActiveSpace) {
        broadcast();
      } else {
        noteInactiveChange();
      }
    }
    // Update the title on the visit this document's load recorded. The key check
    // drops a title event that raced a navigation to a DIFFERENT key (the tab has
    // already left that visit's url). A database error is logged once.
    if (
      runtime.lastVisitId.has(tab.id) &&
      historyKey(view.webContents.getURL()) === runtime.lastHistoryKey.get(tab.id)
    ) {
      try {
        updateVisitTitle(runtime.lastVisitId.get(tab.id)!, title);
      } catch (err) {
        logHistoryError(err);
      }
    }
  });
  view.webContents.on("page-favicon-updated", (_event, favicons: string[]) => {
    const faviconUrl = favicons.length > 0 ? favicons[0] : null;
    const { changed, inActiveSpace } = runtime.store.updateMeta(tab.id, { faviconUrl });
    if (!changed) {
      return;
    }
    if (inActiveSpace) {
      broadcast();
    } else {
      noteInactiveChange();
    }
  });

  // Live url tracking: mirror the view's real url into the store on every commit
  // (cross-document and same-document). Until a real page-title-updated arrives
  // (tracked in hasRealTitle), also re-derive the hostname title fallback so the
  // sidebar label follows the url; once a real title is known it wins.
  const onDidNavigate = (): void => {
    const current = view.webContents.getURL(); // read live, never a captured value
    if (current === "") {
      return;
    }
    const meta: { url: string; title?: string } = { url: current };
    if (!runtime.hasRealTitle.has(tab.id)) {
      meta.title = titleForUrl(current);
    }
    const { changed, inActiveSpace } = runtime.store.updateMeta(tab.id, meta);
    if (!changed) {
      return;
    }
    if (inActiveSpace) {
      broadcast();
    } else {
      noteInactiveChange();
    }
  };
  view.webContents.on("did-navigate", onDidNavigate);
  view.webContents.on("did-navigate-in-page", onDidNavigate);

  // Blocked-count reset on a TOP-LEVEL navigation to a DIFFERENT origin (never
  // did-navigate-in-page, an in-document hash/pushState change). The per-tab
  // count is scoped to "since the tab was created or last navigated to a new
  // origin", so crossing origins clears it.
  view.webContents.on("did-navigate", (_event, url) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return; // Unparseable url (e.g. about:blank): leave the count as-is.
    }
    if (runtime.tabOrigin.get(tab.id) !== origin) {
      runtime.blocking = resetBlockedCount(runtime.blocking, tab.id);
      scheduleBlockingBroadcast();
      runtime.tabOrigin.set(tab.id, origin);
    }
  });

  // History recording (PRD 6.1 §3). A new document has committed on did-navigate,
  // so clear hasRealTitle BEFORE recording: a destination that emits no title of
  // its own is then recorded with titleForUrl, not the torn-down document's stale
  // title. A same-document (did-navigate-in-page) navigation keeps the document's
  // title, so it must NOT touch hasRealTitle. Both are dedicated listeners (never
  // folded into onDidNavigate, which fires on both events and runs before the
  // blocked-count sibling above).
  view.webContents.on("did-navigate", () => {
    runtime.hasRealTitle.delete(tab.id);
    recordNavigation(tab.id);
  });
  view.webContents.on("did-navigate-in-page", () => {
    recordNavigation(tab.id);
  });

  // In-page find (PRD 6.3). Route this view's found-in-page results into the
  // session only while find is open and bound to THIS tab, gated by request id in
  // applyFindResult so a superseded/pre-navigation straggler is dropped.
  view.webContents.on("found-in-page", (_event, result) => {
    if (!runtime.find.open || runtime.find.tabId !== tab.id) {
      return;
    }
    runtime.find = applyFindResult(
      runtime.find,
      result.requestId,
      result.activeMatchOrdinal,
      result.matches,
      result.finalUpdate,
    );
    broadcast();
  });
  // A navigation of the bound tab keeps the session open on the same tab but
  // clears highlights, resets the counter to 0/0, and nulls activeRequestId so a
  // pre-navigation result is rejected. The query text stays in the bar with no
  // automatic re-search.
  const onFindNavigate = (): void => {
    if (!runtime.find.open || runtime.find.tabId !== tab.id) {
      return;
    }
    const v = runtime.views.get(tab.id);
    if (v != null && !v.webContents.isDestroyed()) {
      v.webContents.stopFindInPage("clearSelection");
    }
    runtime.find = clearFindResults(runtime.find);
    broadcast();
  };
  view.webContents.on("did-navigate", onFindNavigate);
  view.webContents.on("did-navigate-in-page", onFindNavigate);

  // Apply the host's stored zoom on the first commit and every later navigation.
  view.webContents.on("did-navigate", () => {
    const host = siteKeyForUrl(view.webContents.getURL());
    applyViewZoom(
      view,
      host === null ? DEFAULT_ZOOM_FACTOR : (runtime.zoom.byHost[host] ?? DEFAULT_ZOOM_FACTOR),
    );
  });
  // Ctrl+wheel zoom: snap onto the ladder and route through the host write path.
  view.webContents.on("zoom-changed", (_event, zoomDirection) => {
    const host = siteKeyForUrl(view.webContents.getURL());
    if (host === null) {
      return;
    }
    const current = runtime.zoom.byHost[host] ?? DEFAULT_ZOOM_FACTOR;
    applyZoom(tab.id, zoomDirection === "in" ? zoomIn(current) : zoomOut(current));
  });

  // History flags (canGoBack/canGoForward) settle only after a load finishes, so
  // refresh the menu and the open bar's command enablement then. The
  // did-navigate handlers above already broadcast, covering the url side.
  view.webContents.on("did-finish-load", () => {
    runtime.onStateApplied?.();
  });

  // Track load failure so activation can retry it; a later success clears it.
  view.webContents
    .loadURL(urlOverride ?? tab.url)
    .then(() => {
      runtime.failedLoads.delete(tab.id);
    })
    .catch((err: unknown) => {
      if (runtime.views.get(tab.id) !== view) {
        return;
      }
      // A navigateTab call on this tab while its initial load is still in flight
      // aborts that load (Electron rejects with ERR_ABORTED). That is a
      // superseded load, not a failure: per the last-request-wins contract it must
      // never mark failedLoads or log. The newer load owns the retry state.
      if ((err as { code?: string }).code === "ERR_ABORTED") {
        return;
      }
      runtime.failedLoads.add(tab.id);
      console.error(`tab ${tab.id} failed to load ${urlOverride ?? tab.url}:`, err);
    });

  // Keep the z-order tab views < divider view < settings view < command-bar
  // overlay: re-adding a child raises it over the view just added. Re-raise the
  // divider, then the open settings view, then the overlay. Null-guarded so the
  // first createViewFor (which may run before any of them exist) is safe.
  raiseOverlays();
}

/** Tears down and unparents the tracked view for `id`, if one exists. */
export function destroyView(id: string): void {
  // Close the find session before the bound view is destroyed, so
  // stopFindInPage runs while its webContents is still alive.
  if (runtime.find.open && runtime.find.tabId === id) {
    runtime.closeFindSession?.();
  }
  const view = runtime.views.get(id);
  if (view !== undefined) {
    runtime.win?.contentView.removeChildView(view);
    // Drop the reverse-index entry via the forward index, so the entry is removed
    // even when the webContents is already destroyed (its `id` would then be
    // inaccessible). NOT the blocked COUNT: a remap or activate-retry recreates
    // the same tab, so the count survives a view teardown and is dropped only on
    // real tab removal (close/remove/delete).
    const wcId = runtime.tabToWcId.get(id);
    if (wcId !== undefined) {
      runtime.webContentsToTab.delete(wcId);
    }
    runtime.tabToWcId.delete(id);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    runtime.views.delete(id);
    // Drop any retry marker so a stale id never lingers past its view.
    runtime.failedLoads.delete(id);
    // Drop the per-tab nav sequence so a reused id starts fresh. The history
    // per-tab state (hasRealTitle, lastHistoryKey, lastVisitId) is NOT dropped
    // here: a view teardown/recreate (idle unload, remapSpaceProfile, failed-load
    // retry) must keep those flags — they live/die with the real tab, in
    // closeTab/removeTab/deleteSpace.
    runtime.navSeq.delete(id);
  }
}

/**
 * Shows the given tab's view, hides ALL others, and re-lays-out the active one.
 * Because it iterates every tracked view across all spaces, calling it after a
 * space switch with the incoming space's active tab id also hides the outgoing
 * space's views — the whole space-switch view transition.
 */
export function setActive(id: string | null): void {
  // A find session never follows a tab change: closing it here covers activate,
  // archive, space-switch, and close-to-sibling. Re-asserting the same active tab
  // (find.tabId === id) is a no-op.
  if (runtime.find.open && runtime.find.tabId !== id) {
    runtime.closeFindSession?.();
  }
  for (const [tabId, view] of runtime.views) {
    const active = tabId === id;
    view.setVisible(active);
    if (active) {
      view.setBounds(viewBounds());
    }
  }
}

/**
 * Creates the active space's active-tab view if it has none yet (lazy restore),
 * then shows it and hides the rest. Every other restored tab materializes its
 * view on first activation.
 */
export function ensureActiveView(): void {
  const activeTabId = runtime.store.activeTabId;
  if (activeTabId !== null && !runtime.views.has(activeTabId)) {
    const tab = runtime.store.list().find((t) => t.id === activeTabId);
    if (tab !== undefined) {
      createViewFor(tab, runtime.store.activeSpaceId);
    }
  }
  setActive(activeTabId);
}

/**
 * Tears down `id`'s view while its tab stays in the store — {@link destroyView}
 * by another name so call sites read as intent (it adds no behavior). A no-op
 * when `views` has no entry.
 */
export function unloadView(id: string): void {
  destroyView(id);
}

/**
 * Unloads every tracked view owned by `spaceId` except `keepTabId` and except a
 * currently-audible one — the outgoing-space teardown of a space switch (#58).
 * Snapshots the `views` entries before iterating, since unloadView mutates it.
 */
export function unloadSpaceViews(spaceId: string, keepTabId: string | null): void {
  for (const [tabId, view] of [...runtime.views]) {
    if (runtime.store.spaceOfTab(tabId) !== spaceId || tabId === keepTabId) {
      continue;
    }
    const wc = view.webContents;
    if (!wc.isDestroyed() && wc.isCurrentlyAudible()) {
      continue;
    }
    unloadView(tabId);
  }
}

/**
 * The tab ids the ACTIVE space currently shows on screen: the active tab in
 * single mode, or BOTH panes in split mode. A view for one of these is never
 * idle-unloaded even when it is not `store.activeTabId` (the non-focused split
 * pane is visible but not the active tab).
 */
function shownTabIds(): Set<string> {
  const shown = new Set<string>();
  if (runtime.layout.mode === "split") {
    shown.add(runtime.layout.left);
    shown.add(runtime.layout.right);
  } else if (runtime.store.activeTabId !== null) {
    shown.add(runtime.store.activeTabId);
  }
  return shown;
}

/**
 * Runs the idle-unload policy over every tracked view and tears down each id the
 * pure {@link selectViewsToUnload} returns (hidden, silent, idle past the
 * threshold). `visible` is "shown in the active space's current layout" (active
 * tab OR either split pane), so a visible non-focused pane is never unloaded; a
 * view whose tab no longer belongs to any space is skipped. Broadcasts once iff
 * anything was unloaded (the unloadedTabIds slice changed).
 */
export function unloadIdleViews(now: number): void {
  const shown = shownTabIds();
  const activeSpaceId = runtime.store.activeSpaceId;
  const candidates: UnloadCandidate[] = [];
  for (const [tabId, view] of runtime.views) {
    const spaceId = runtime.store.spaceOfTab(tabId);
    if (spaceId === null) {
      continue;
    }
    const tab = runtime.store.tabsOfSpace(spaceId).find((t) => t.id === tabId);
    if (tab === undefined) {
      continue;
    }
    const wc = view.webContents;
    candidates.push({
      tabId,
      lastActiveAt: tab.lastActiveAt,
      visible: spaceId === activeSpaceId && shown.has(tabId),
      audible: !wc.isDestroyed() && wc.isCurrentlyAudible(),
    });
  }
  const toUnload = selectViewsToUnload(candidates, now, viewUnloadAfterMs());
  for (const id of toUnload) {
    unloadView(id);
  }
  if (toUnload.length > 0) {
    broadcast();
  }
}

/**
 * The idle threshold / sweep interval (ms): the core constants, overridden by
 * ZEO_VIEW_UNLOAD_AFTER_MS / ZEO_VIEW_UNLOAD_INTERVAL_MS ONLY when
 * ZEO_E2E === "1" and the env value parses as a positive integer. A packaged
 * build ignores both.
 */
function envPositiveIntWhenE2E(name: string): number | null {
  if (process.env.ZEO_E2E !== "1") {
    return null;
  }
  const raw = process.env[name];
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function viewUnloadAfterMs(): number {
  return envPositiveIntWhenE2E("ZEO_VIEW_UNLOAD_AFTER_MS") ?? VIEW_UNLOAD_AFTER_MS;
}

export function viewUnloadIntervalMs(): number {
  return envPositiveIntWhenE2E("ZEO_VIEW_UNLOAD_INTERVAL_MS") ?? VIEW_UNLOAD_INTERVAL_MS;
}
