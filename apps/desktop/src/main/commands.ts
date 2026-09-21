import { clipboard, ipcMain, shell } from "electron";
import {
  IPC,
  COMMANDS,
  isCommandEnabled,
  siteKeyForUrl,
  hostMatchesAllowlist,
  DEFAULT_ZOOM_FACTOR,
  defaultSpaceName,
  clearFinishedDownloads,
  isFinished,
  promoteQuickBrowse,
  titleForUrl,
} from "@zeo/core";
import type { CommandContext, CommandDescriptor, CommandId } from "@zeo/core";
import { clearHistory, clearFinishedDownloadRows } from "./db.js";
import { runtime } from "./state.js";
import { broadcast, pushCommandBar } from "./broadcast.js";
import { layoutOverlay } from "./overlay.js";
import { openCommandBar, closeCommandBar, recomputeSuggestions } from "./command-bar.js";
import { createTab, closeTab, pinTab, unpinTab, moveTabToTop, moveTabToBottom, archiveTab } from "./tabs.js";
import { createViewFor, setActive } from "./views.js";
import { deleteSpace } from "./spaces.js";
import { setBlockingEnabled, allowSite, disallowSite } from "./blocking.js";
import { openSettings, openSettingsAt, closeSettings } from "./settings.js";
import { invalidateAllHistoryKeys, logHistoryError } from "./history.js";
import { zoomActiveTab } from "./zoom.js";
import { openFindSession, findNext, findPrevious, closeFindSession } from "./find.js";
import { teardownQuickBrowse, setAsDefaultBrowser } from "./quick-browse.js";
import { reconcileAndApply, doSplit, doUnsplit, doFocusOther, doSwap } from "./layout.js";
import { downloadsDir, logDownloadError } from "./downloads.js";

/**
 * Builds the current {@link CommandContext} from the store and the active view.
 * `spaceCount` is the number of spaces; `activeTab` is `null` when no tab is
 * active, otherwise the active tab's `pinned` flag plus its live navigation
 * history flags read from the active view's non-deprecated `navigationHistory`
 * API (both `false` when the view is missing, but `activeTab` is still non-null).
 */
export function commandContextOf(): CommandContext {
  const spaceCount = runtime.store.spaces().length;
  const hasFinishedDownload = runtime.downloads.items.some(isFinished);
  const activeTabId = runtime.store.activeTabId;
  if (activeTabId === null) {
    return {
      activeTab: null,
      spaceCount,
      settingsOpen: runtime.settingsOpen,
      quickBrowseOpen: runtime.quickBrowseWindow !== null,
      hasFinishedDownload,
      find: { open: runtime.find.open, hasQuery: runtime.find.query.trim().length > 0 },
      layoutMode: runtime.layout.mode,
      openTabCount: runtime.store.list().length,
    };
  }
  const tab = runtime.store.list().find((t) => t.id === activeTabId);
  const wc = runtime.views.get(activeTabId)?.view.webContents;
  // Derive siteHost from the LIVE view URL — the same identity zoomActiveTab/
  // applyZoom mutate — so zoom command enablement and the mutation agree on the
  // host even during an in-flight navigation (tab.url updates before loadURL
  // commits). No live http(s) view ⇒ null, matching zoomActiveTab's rejection.
  const siteHost = siteKeyForUrl(wc !== undefined && !wc.isDestroyed() ? wc.getURL() : "");
  return {
    activeTab: {
      pinned: tab?.pinned ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      siteHost,
      siteAllowlisted: siteHost !== null && hostMatchesAllowlist(siteHost, runtime.allowlist),
      zoomFactor:
        siteHost !== null ? (runtime.zoom.byHost[siteHost] ?? DEFAULT_ZOOM_FACTOR) : DEFAULT_ZOOM_FACTOR,
    },
    spaceCount,
    settingsOpen: runtime.settingsOpen,
    quickBrowseOpen: runtime.quickBrowseWindow !== null,
    hasFinishedDownload,
    find: { open: runtime.find.open, hasQuery: runtime.find.query.trim().length > 0 },
    layoutMode: runtime.layout.mode,
    openTabCount: runtime.store.list().length,
  };
}

/**
 * The one handler per {@link CommandId}, called only by {@link executeCommand}
 * (which gates enablement first, so the `!`/no-op guards here never run on a
 * disabled command). Each handler reuses the existing store/view helper for its
 * action, so command dispatch and the old menu/context-menu paths stay in step.
 */
const commandHandlers: Record<CommandId, () => void> = {
  "tab.new": () => openCommandBar("new-tab"),
  "tab.close": () => closeTab(runtime.store.activeTabId!),
  "tab.pin": () => pinTab(runtime.store.activeTabId!),
  "tab.unpin": () => unpinTab(runtime.store.activeTabId!),
  "tab.moveToTop": () => moveTabToTop(runtime.store.activeTabId!),
  "tab.moveToBottom": () => moveTabToBottom(runtime.store.activeTabId!),
  "tab.archive": () => archiveTab(runtime.store.activeTabId!),
  "tab.copy-url": () => {
    const tab = runtime.store.list().find((t) => t.id === runtime.store.activeTabId);
    if (tab !== undefined) {
      clipboard.writeText(tab.url);
    }
  },
  "tab.reload": () => runtime.views.get(runtime.store.activeTabId!)?.view.webContents.reload(),
  "tab.back": () =>
    runtime.views.get(runtime.store.activeTabId!)?.view.webContents.navigationHistory.goBack(),
  "tab.forward": () =>
    runtime.views.get(runtime.store.activeTabId!)?.view.webContents.navigationHistory.goForward(),
  "space.new": () => {
    const space = runtime.store.createSpace(defaultSpaceName(runtime.store.spaces()));
    runtime.store.setActiveSpace(space.id);
    // Switching to the new space invalidates any split of the old space's tabs, so
    // reconcile (→ single) and re-lay the new space's active view (hiding the
    // divider).
    reconcileAndApply();
    broadcast();
  },
  // From the macOS menu bar with no window, ensureWindow recreates one but this
  // first send reaches an unloaded renderer and is dropped (a second invocation
  // works); space.rename has no accelerator, so this is an obscure, benign edge.
  "space.rename": () =>
    runtime.win?.webContents.send(IPC.spaceMenuAction, {
      action: "rename",
      spaceId: runtime.store.activeSpaceId,
    }),
  "space.delete": () => deleteSpace(runtime.store.activeSpaceId),
  "bar.open-location": () => openCommandBar("navigate"),
  "bar.open-commands": () => {
    if (runtime.commandBar.open && runtime.commandBar.mode === "commands") {
      closeCommandBar();
    } else {
      openCommandBar("commands");
    }
  },
  "blocking.toggle": () => {
    setBlockingEnabled(!runtime.blocking.enabled).catch((err) => {
      console.error("[blocking] toggle failed:", err);
    });
  },
  "blocking.allowSite": () => {
    const ctx = commandContextOf();
    if (ctx.activeTab?.siteHost) {
      allowSite(ctx.activeTab.siteHost).catch((err) => {
        console.error("[blocking] allowSite failed:", err);
      });
    }
  },
  "blocking.disallowSite": () => {
    const ctx = commandContextOf();
    const host = ctx.activeTab?.siteHost;
    if (!host) {
      return;
    }
    // Remove the LONGEST allowlist entry that the active site matches, so
    // allowlisting `www.example.com` via the parent entry `example.com` and then
    // re-enabling removes the entry actually covering the host.
    let best: string | null = null;
    for (const entry of runtime.allowlist) {
      if (hostMatchesAllowlist(host, [entry]) && (best === null || entry.length > best.length)) {
        best = entry;
      }
    }
    if (best !== null) {
      disallowSite(best).catch((err) => {
        console.error("[blocking] disallowSite failed:", err);
      });
    }
  },
  "settings.open": () => {
    // A cold open selects General and bumps the nonce so the renderer re-selects
    // it; when already open, leave the section and nonce unchanged (a plain Cmd+,
    // then just focuses, preserving PRD 5.2's focus-only behavior).
    if (!runtime.settingsOpen) {
      runtime.settingsSection = "general";
      runtime.settingsSectionNonce++;
    }
    openSettings();
  },
  "settings.openGeneral": () => openSettingsAt("general"),
  "settings.openProfiles": () => openSettingsAt("profiles"),
  "settings.openHistory": () => openSettingsAt("history"),
  "settings.close": () => closeSettings(),
  "history.open": () => openCommandBar("history"),
  "history.clear": () => {
    try {
      clearHistory();
      invalidateAllHistoryKeys();
    } catch (err) {
      logHistoryError(err);
    }
    if (runtime.commandBar.open && runtime.commandBar.mode === "history") {
      recomputeSuggestions();
      layoutOverlay();
      pushCommandBar();
    }
  },
  "downloads.open": () => {
    if (runtime.commandBar.open && runtime.commandBar.mode === "downloads") {
      closeCommandBar();
    } else {
      openCommandBar("downloads");
    }
  },
  "downloads.openFolder": () => {
    void shell.openPath(downloadsDir());
  },
  "downloads.clearFinished": () => {
    runtime.downloads = clearFinishedDownloads(runtime.downloads);
    try {
      clearFinishedDownloadRows();
    } catch (err) {
      logDownloadError(err);
    }
    // broadcast() mirrors the new DownloadsState and, via refreshCommandState,
    // re-ranks an open downloads-mode bar and refreshes clearFinished enablement.
    broadcast();
  },
  "zoom.in": () => {
    zoomActiveTab("in").catch((err) => console.error("[zoom] zoom.in failed:", err));
  },
  "zoom.out": () => {
    zoomActiveTab("out").catch((err) => console.error("[zoom] zoom.out failed:", err));
  },
  "zoom.reset": () => {
    zoomActiveTab("reset").catch((err) => console.error("[zoom] zoom.reset failed:", err));
  },
  "find.open": () => openFindSession(),
  "find.next": () => findNext(),
  "find.previous": () => findPrevious(),
  "find.close": () => closeFindSession(),
  "quickBrowse.promote": () => {
    // Keep the link: a new tab loading its url in the ACTIVE space, activated. The
    // teardown returns focus to the main window on that new active tab.
    const entry = promoteQuickBrowse(runtime.quickBrowse);
    createTab(entry.url);
    teardownQuickBrowse();
  },
  "quickBrowse.promoteToSpace": () => {
    // Bring the main window forward so its command-bar overlay (which openCommandBar
    // shows + focuses) is visible while the user picks a target space; the
    // quick-browse window stays open until a space is accepted (see performSuggestion).
    if (runtime.win !== null && !runtime.win.isDestroyed()) {
      runtime.win.show();
      runtime.win!.focus();
    }
    openCommandBar("promote");
  },
  "quickBrowse.dismiss": () => teardownQuickBrowse(),
  "quickBrowse.openInTab": () => {
    // Background tab: keep the link on a new tab in the active space WITHOUT
    // activating it or moving focus, leaving the quick-browse window open. store's
    // create always makes the new tab active, so re-activate the previous active
    // tab and keep the visible view pointed at it.
    const entry = promoteQuickBrowse(runtime.quickBrowse);
    const previousActive = runtime.store.activeTabId;
    const tab = runtime.store.create({ url: entry.url, title: titleForUrl(entry.url) });
    createViewFor(tab, runtime.store.activeSpaceId);
    if (previousActive !== null && previousActive !== tab.id) {
      runtime.store.activate(previousActive);
    }
    setActive(runtime.store.activeTabId);
    broadcast();
  },
  "browser.setDefault": () => setAsDefaultBrowser(),
  "view.split": () => {
    // doSplit may reject (no active tab, already split, or < 2 open tabs);
    // executeCommand gates enablement first, but swallow-log any residual
    // rejection like the zoom handlers rather than crash the dispatch.
    doSplit().catch((err) => console.error("[split] view.split failed:", err));
  },
  "view.splitChoose": () => openCommandBar("split"),
  "view.unsplit": () => doUnsplit(),
  "view.focusOtherPane": () => doFocusOther(),
  "view.swapPanes": () => doSwap(),
};

/**
 * The single checked dispatch boundary. Builds the current context, throws for
 * an unknown id or a command disabled in that context (rejecting a stale menu
 * click, a stale accepted row, or a bad/disabled `commands.run`), and only then
 * runs the handler. Every dispatch path goes through here.
 */
export function executeCommand(id: CommandId): void {
  const context = commandContextOf();
  const handler = commandHandlers[id] as (() => void) | undefined;
  if (handler === undefined || !COMMANDS.some((c) => c.id === id)) {
    throw new Error(`unknown command: ${id}`);
  }
  if (!isCommandEnabled(id, context)) {
    throw new Error(`command disabled in current context: ${id}`);
  }
  handler();
}

// Register the executeCommand + commandContextOf hooks: command-bar (buildCatalog,
// acceptCommandBar), quick-browse (key handler, promote IPC), and menu use them.
runtime.executeCommand = executeCommand;
runtime.commandContextOf = commandContextOf;

// --- Command registry ---------------------------------------------------------
// list() returns the registry verbatim; run() dispatches through the single
// checked boundary executeCommand, which throws (rejecting the invoke) on an
// unknown id or a command disabled in the current context.
ipcMain.handle(IPC.commandsList, (): CommandDescriptor[] => [...COMMANDS]);

ipcMain.handle(IPC.commandsRun, (_event, id: CommandId): void => {
  executeCommand(id);
});
