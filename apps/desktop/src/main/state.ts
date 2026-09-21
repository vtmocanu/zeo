import type { BrowserWindow, WebContentsView } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Blocker } from "@zeo/adblock";
import { SpaceStore, SINGLE_LAYOUT, initialBlockingState } from "@zeo/core";
import type {
  BlockingState,
  CommandBarState,
  CommandContext,
  CommandId,
  DownloadsState,
  FindState,
  QuickBrowseState,
  Settings,
  SettingsSectionId,
  WindowLayout,
  ZoomState,
} from "@zeo/core";
import type { DownloadRegistryEntry } from "./download-ops.js"; // type-only; no runtime edge

// The built main is emitted by electron-vite as ESM (out/main/index.js, the
// package is "type": "module"), so `__dirname` is not defined — derive it from
// import.meta.url. Preload and renderer are resolved as siblings of the main
// file's directory (out/preload/index.cjs, out/renderer/index.html).
export const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the cosmetic-filtering frame preload, shipped as a sibling of
 * the main bundle (out/preload/cosmetic-preload.cjs, copied by
 * scripts/copy-renderer.mjs). Passed to the blocker via `internals.preloadPath`;
 * the wrapper registers it on each attached profile session. Resolved the same
 * way as the renderer preload above.
 */
export const cosmeticPreloadPath = join(moduleDir, "../preload/cosmetic-preload.cjs");

/** Default url/title used by the renderer's URL-less new-tab button. */
export const DEFAULT_URL = "https://example.com";

/**
 * Auto-archive schedule. The *policy* (which tabs are idle) lives in core
 * (`SpaceStore.archiveIdleAll`, which sweeps every space's `TabStore`); the main
 * process only owns these scheduling constants and the timer. A tab untouched for
 * `IDLE_THRESHOLD_MS` is swept, and the sweep runs every `SWEEP_INTERVAL_MS` (plus
 * once on launch).
 */
export const IDLE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Debounce window for {@link scheduleLayoutSave}, in milliseconds. */
export const LAYOUT_SAVE_DEBOUNCE_MS = 300;

/** Number of history candidates the catalog offers `suggest` (PRD 6.1 §5). */
export const HISTORY_CANDIDATES = 20;

/** Coalescing window for {@link scheduleBlockingBroadcast}, in milliseconds. */
export const BLOCKING_BROADCAST_MS = 250;

/** Coalescing window for {@link scheduleDownloadsBroadcast}, in milliseconds. */
export const DOWNLOADS_BROADCAST_MS = 250;

/**
 * Live WebContentsView per tab id, tagged with the id of its OWNING space. The
 * active space's active tab is the single visible view; every other view (other
 * tabs in the active space, and all tabs in inactive spaces) stays alive but
 * hidden. The owning-space tag lets a space delete destroy exactly that space's
 * views.
 */
export interface TrackedView {
  view: WebContentsView;
  spaceId: string;
}

type Timer = ReturnType<typeof setTimeout> | null;

/**
 * The single mutable runtime-state singleton every main-process module reads and
 * writes. Its properties are reassigned in place (`runtime.win = ...`), so a
 * module never holds a stale copy of a reassigned binding; the collection fields
 * (Maps/Sets/arrays) are mutated in place via `.set`/`.add`/`.delete`/`.clear`/
 * `.push`. The six hook fields are late-bound cross-module callbacks each owning
 * module registers at load, breaking an otherwise-cyclic value import.
 */
export interface RuntimeState {
  store: SpaceStore;
  win: BrowserWindow | null;
  overlay: WebContentsView | null;
  layout: WindowLayout;
  dividerView: WebContentsView | null;
  layoutSaveTimer: Timer;
  commandBar: CommandBarState;
  commandBarRevision: number;
  find: FindState;
  historyErrorLogged: boolean;
  blocker: Blocker | null;
  blocking: BlockingState;
  zoom: ZoomState;
  refreshInFlight: Promise<boolean> | null;
  settingsView: WebContentsView | null;
  settingsOpen: boolean;
  settings: Settings;
  settingsSection: SettingsSectionId;
  settingsSectionNonce: number;
  blockingBroadcastTimer: Timer;
  quickBrowse: QuickBrowseState;
  isDefaultBrowser: boolean;
  quickBrowseWindow: BrowserWindow | null;
  quickBrowsePageView: WebContentsView | null;
  quickBrowseSession: Electron.Session | null;
  quickBrowseSessionSeq: number;
  quickBrowseLoadPending: boolean;
  quickBrowseTearingDown: boolean;
  appReady: boolean;
  downloads: DownloadsState;
  downloadsBroadcastTimer: Timer;
  downloadErrorLogged: boolean;
  views: Map<string, TrackedView>;
  failedLoads: Set<string>;
  navSeq: Map<string, number>;
  hasRealTitle: Set<string>;
  lastHistoryKey: Map<string, string>;
  lastVisitId: Map<string, number>;
  tabOrigin: Map<string, string>;
  allowlist: Set<string>;
  webContentsToTab: Map<number, string>;
  tabToWcId: Map<string, number>;
  pendingExternalLinks: string[];
  downloadItems: Map<string, DownloadRegistryEntry<Electron.DownloadItem>>;
  removedDownloadIds: Set<string>;
  reservedFilenames: Set<string>;
  downloadSessionProfiles: Set<string>;
  onStateApplied: (() => void) | null;
  executeCommand: ((id: CommandId) => void) | null;
  commandContextOf: (() => CommandContext) | null;
  closeFindSession: ((returnFocus?: boolean) => void) | null;
  rebuildMenu: (() => void) | null;
  createWindow: ((seed: boolean) => void) | null;
}

/**
 * The mutable runtime singletons every module shares, seeded with the documented
 * defaults (a literal — no disk reads at import, guarded by state.test.ts).
 */
export const runtime: RuntimeState = {
  store: new SpaceStore(),
  win: null,
  overlay: null,
  layout: SINGLE_LAYOUT,
  dividerView: null,
  layoutSaveTimer: null,
  commandBar: {
    open: false,
    mode: "navigate",
    initialText: "",
    query: "",
    suggestions: [],
    selectedIndex: -1,
    revision: 0,
    surface: "bar",
  },
  commandBarRevision: 0,
  find: {
    open: false,
    query: "",
    activeMatch: 0,
    matchCount: 0,
    tabId: null,
    activeRequestId: null,
  },
  historyErrorLogged: false,
  blocker: null,
  blocking: initialBlockingState(true, "none"),
  zoom: { byHost: {} },
  refreshInFlight: null,
  settingsView: null,
  settingsOpen: false,
  settings: { searchEngine: "duckduckgo", quickBrowseExternal: true },
  settingsSection: "general",
  settingsSectionNonce: 0,
  blockingBroadcastTimer: null,
  quickBrowse: null,
  isDefaultBrowser: false,
  quickBrowseWindow: null,
  quickBrowsePageView: null,
  quickBrowseSession: null,
  quickBrowseSessionSeq: 0,
  quickBrowseLoadPending: false,
  quickBrowseTearingDown: false,
  appReady: false,
  downloads: { items: [] },
  downloadsBroadcastTimer: null,
  downloadErrorLogged: false,
  views: new Map(),
  failedLoads: new Set(),
  navSeq: new Map(),
  hasRealTitle: new Set(),
  lastHistoryKey: new Map(),
  lastVisitId: new Map(),
  tabOrigin: new Map(),
  allowlist: new Set(),
  webContentsToTab: new Map(),
  tabToWcId: new Map(),
  pendingExternalLinks: [],
  downloadItems: new Map(),
  removedDownloadIds: new Set(),
  reservedFilenames: new Set(),
  downloadSessionProfiles: new Set(),
  onStateApplied: null,
  executeCommand: null,
  commandContextOf: null,
  closeFindSession: null,
  rebuildMenu: null,
  createWindow: null,
};
