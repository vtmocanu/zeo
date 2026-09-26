import { app, ipcMain, session } from "electron";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createBlocker, createBlockerFromFilters } from "@zeo/adblock";
import type { Blocker } from "@zeo/adblock";
import {
  IPC,
  initialBlockingState,
  applyBlockedRequest,
  applyUnattributedBlock,
  siteKeyForUrl,
  hostMatchesAllowlist,
  normalizeAllowlistHost,
  addAllowlistHost,
  removeAllowlistHost,
} from "@zeo/core";
import type { BlockingState } from "@zeo/core";
import {
  readBlockingEnabled,
  writeBlockingEnabled,
  readSearchEngine,
  readQuickBrowseExternal,
  readUpdateSettings,
  readAllowlist,
  insertAllowlistHost,
  deleteAllowlistHost,
  readSiteZoom,
} from "./db.js";
import { runtime, cosmeticPreloadPath } from "./state.js";
import { broadcast, scheduleBlockingBroadcast, fullSnapshot } from "./broadcast.js";
import { profileSessions } from "./views.js";
import { teardownQuickBrowse } from "./quick-browse.js";

/**
 * Subscribes to the blocker's blocked events: a hit in the reverse index
 * attributes the block to that tab, a miss (a torn-down view or a non-tab
 * renderer) is counted as unattributed so a wrong mapping is visible in tests.
 */
export function wireOnBlocked(b: Blocker): void {
  b.onBlocked(({ webContentsId }) => {
    const tabId = runtime.webContentsToTab.get(webContentsId);
    runtime.blocking =
      tabId !== undefined
        ? applyBlockedRequest(runtime.blocking, tabId)
        : applyUnattributedBlock(runtime.blocking);
    scheduleBlockingBroadcast();
  });
}

/**
 * Installs the per-site bypass predicate on the blocker. The predicate reads the
 * live {@link allowlist} set, so allowlist edits take effect with no further
 * wrapper call. Called wherever {@link wireOnBlocked} is, so every blocker (the
 * fixture, the cap-winner, and the deferred cap-loser) gets it.
 */
export function installBypass(b: Blocker): void {
  b.setBypass((url) => {
    const host = siteKeyForUrl(url);
    return host !== null && hostMatchesAllowlist(host, runtime.allowlist);
  });
}

/** Attaches the blocker to every profile session (idempotent per session). */
export function attachBlockerToAllSessions(b: Blocker): void {
  for (const s of profileSessions()) {
    b.attach(s);
  }
}

/**
 * Attaches the content blocker to a profile's persistent session when blocking is
 * enabled and the engine has loaded. Best-effort: Blocker.attach throws if the
 * blocker was disposed or another blocker owns the session, so a failure is logged
 * and swallowed — the caller's remaining lifecycle steps must still run.
 */
export function attachBlockerToProfileSession(profileId: string): void {
  if (runtime.blocking.enabled && runtime.blocker) {
    try {
      runtime.blocker.attach(session.fromPartition("persist:" + profileId));
    } catch (err) {
      console.error(`[blocking] failed to attach profile session ${profileId}:`, err);
    }
  }
}

/**
 * The ordered set-enabled contract (PRD 5.1 §2): (1) no-op when the value is
 * unchanged; (2) persist synchronously — a throw propagates with nothing else
 * changed; (3) attach/detach every profile session, reverting the sessions
 * already changed AND the persisted value on any throw; (4) update the in-memory
 * flag and broadcast. attach/detach are idempotent, so the revert is safe. When
 * `blocker` is null during the startup cap window the session loop is a no-op but
 * the flag still flips; the cap race's `then` then attaches per `blocking.enabled`.
 */
export async function setBlockingEnabled(enabled: boolean): Promise<void> {
  // Reachable from the renderer over IPC.blockingSetEnabled with an untrusted
  // payload: reject a non-boolean BEFORE any persistence or state change so a
  // malformed payload can never persist/broadcast a non-boolean. The IPC handler
  // returns this promise, so the rejection surfaces to the renderer's invoke.
  if (typeof enabled !== "boolean") {
    throw new TypeError("blocking.setEnabled expects a boolean");
  }
  if (enabled === runtime.blocking.enabled) {
    return;
  }
  // PRD 5.3 §3 failure state: with no engine attached (setup failed, blocker
  // stayed null), enabling blocking cannot take effect. Reject BEFORE any change
  // so the persisted value, sessions, and in-memory state are all untouched; the
  // app never reports blocking enabled with no engine.
  if (enabled && runtime.blocker === null) {
    throw new Error("content blocking is unavailable: no filter engine is loaded");
  }
  writeBlockingEnabled(enabled);
  // Cover the transient quick-browse window's ephemeral session too while one is
  // open, alongside every profile session — the toggle must reach the untrusted
  // quick-browse page view, not just persisted-profile tabs. It rides the same
  // idempotent attach/detach loop and revert-on-error path below.
  const sessions = profileSessions();
  if (runtime.quickBrowseSession !== null) {
    sessions.push(runtime.quickBrowseSession);
  }
  const done: Electron.Session[] = [];
  try {
    for (const s of sessions) {
      if (runtime.blocker) {
        if (enabled) {
          runtime.blocker.attach(s);
        } else {
          runtime.blocker.detach(s);
        }
      }
      done.push(s);
    }
  } catch (err) {
    for (const s of done) {
      if (runtime.blocker) {
        if (enabled) {
          runtime.blocker.detach(s);
        } else {
          runtime.blocker.attach(s);
        }
      }
    }
    writeBlockingEnabled(runtime.blocking.enabled);
    throw err;
  }
  runtime.blocking = { ...runtime.blocking, enabled };
  broadcast();
}

/**
 * Adds `host` to the per-site allowlist on the main thread in the PRD's ordered
 * contract: (1) normalize — a `null` result rejects with `TypeError` and changes
 * nothing; (2) an already-present host resolves with no side effect; (3) persist
 * synchronously — a throw rejects and changes nothing; (4) update the live set
 * and the broadcast slice through the reducer; (5) broadcast. Resolves once the
 * change has landed.
 */
export function allowSite(host: string): Promise<void> {
  const normalized = normalizeAllowlistHost(host);
  if (normalized === null) {
    return Promise.reject(new TypeError("invalid allowlist host"));
  }
  if (runtime.allowlist.has(normalized)) {
    return Promise.resolve();
  }
  try {
    insertAllowlistHost(normalized, Date.now());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  runtime.allowlist.add(normalized);
  runtime.blocking = addAllowlistHost(runtime.blocking, normalized);
  broadcast();
  return Promise.resolve();
}

/**
 * Removes `host` from the per-site allowlist, mirroring {@link allowSite}: a
 * `null` normalization rejects with `TypeError`; an absent host resolves with no
 * side effect; otherwise the on-disk row is deleted, the live set and the
 * broadcast slice are updated through the remove reducer, and the change is
 * broadcast.
 */
export function disallowSite(host: string): Promise<void> {
  const normalized = normalizeAllowlistHost(host);
  if (normalized === null) {
    return Promise.reject(new TypeError("invalid allowlist host"));
  }
  if (!runtime.allowlist.has(normalized)) {
    return Promise.resolve();
  }
  try {
    deleteAllowlistHost(normalized);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  runtime.allowlist.delete(normalized);
  runtime.blocking = removeAllowlistHost(runtime.blocking, normalized);
  broadcast();
  return Promise.resolve();
}

/**
 * Re-fetches the filter lists. Rejects when no engine is loaded
 * (`blocker === null`); otherwise returns `blocker.refresh()`. While a refresh is
 * in flight every further call returns the SAME promise, so overlapping calls
 * coalesce onto one `blocker.refresh()`. Runs whether or not blocking is enabled (the
 * daily timer, in contrast, keeps skipping while disabled).
 */
export function refreshLists(): Promise<boolean> {
  if (runtime.blocker === null) {
    return Promise.reject(new Error("content blocking is unavailable: no filter engine is loaded"));
  }
  if (runtime.refreshInFlight !== null) {
    return runtime.refreshInFlight;
  }
  runtime.refreshInFlight = runtime.blocker.refresh().finally(() => {
    runtime.refreshInFlight = null;
  });
  return runtime.refreshInFlight;
}

/**
 * The content-blocking startup gate (PRD 5.1 §3). The ENTIRE startup is wrapped so
 * ANY failure — a bad ZEO_ADBLOCK_FILTERS path (readFileSync throws ENOENT), a
 * cache/engine load error, a session attach failure — degrades gracefully to
 * "blocking off" rather than aborting the whenReady handler before the window is
 * ever created. `blocking` is left seeded so fullSnapshot() never dereferences
 * undefined. Also seeds the settings, default-browser, and zoom slices from disk.
 */
export async function startBlocking(): Promise<void> {
  try {
    // Read the persisted enabled flag (needs the store's open db handle) and seed
    // the blocking slice before any window or tab view exists.
    const enabled = readBlockingEnabled();
    // Seed the settings slice from the persisted search-engine choice and the
    // quick-browse-external toggle; main is the sole holder threaded into
    // resolveInput/suggest.
    runtime.settings = {
      searchEngine: readSearchEngine(),
      quickBrowseExternal: readQuickBrowseExternal(),
      updateCheckEnabled: readUpdateSettings().enabled,
    };
    // Cache the OS-default-browser flag once at startup; it is re-read only after
    // browser.setDefault, never in fullSnapshot (which runs on every broadcast).
    runtime.isDefaultBrowser = app.isDefaultProtocolClient("http");
    // Load the persisted allowlist into the live set BEFORE the blocker is created,
    // so the bypass predicate (which reads the set) is correct from the first
    // request. Seed the broadcast slice from the same set, sorted for stable order.
    for (const h of readAllowlist()) {
      runtime.allowlist.add(h);
    }
    runtime.blocking = initialBlockingState(
      enabled,
      "none",
      [...runtime.allowlist].sort((a, b) => a.localeCompare(b)),
    );
    // Seed TabsState.zoom.byHost from the DB before any window/tab view exists;
    // an empty site_zoom table yields { byHost: {} }. Every later change flows
    // through applyZoom.
    runtime.zoom = { byHost: readSiteZoom() };

    const filtersFile = process.env.ZEO_ADBLOCK_FILTERS;
    if (process.env.ZEO_E2E === "1" && filtersFile !== undefined && filtersFile !== "") {
      // Test/e2e hook, checked FIRST: build the engine from a fixture list only —
      // no cache read/write, no remote fetch, no daily refresh. It also requires
      // ZEO_E2E === "1", so a packaged production build ignores the env var and
      // never takes the fixture path even if ZEO_ADBLOCK_FILTERS is set. It is a
      // test hook, so a bad path must degrade gracefully (logged in the catch) not
      // brick the app.
      const text = readFileSync(filtersFile, "utf8");
      // ZEO_ADBLOCK_RESOURCES (fixture path only): scriptlet resource text in the
      // library's resources format, applied to the parsed engine so fixture
      // scriptlets (##+js(...)) resolve. Read only here, alongside the filters.
      const resourcesFile = process.env.ZEO_ADBLOCK_RESOURCES;
      const resources =
        resourcesFile !== undefined && resourcesFile !== ""
          ? readFileSync(resourcesFile, "utf8")
          : undefined;
      runtime.blocker = createBlockerFromFilters(text, "fixture:" + basename(filtersFile), {
        preloadPath: cosmeticPreloadPath,
        resources,
      });
    } else {
      // Kick off the real engine load and race it against a 3 s cap. createBlocker's
      // promise covers only the fast local step (cache or empty engine); if the cap
      // wins the window opens with an empty engine (blocker stays null) and the
      // loaded engine swaps in when it arrives.
      const p = createBlocker({
        cacheFile: join(app.getPath("userData"), "adblock-engine.bin"),
        fetch,
        internals: { preloadPath: cosmeticPreloadPath },
      });
      const capped = await Promise.race([
        p.then((b) => ({ won: true as const, blocker: b })),
        new Promise<{ won: false }>((resolve) => setTimeout(() => resolve({ won: false }), 3000)),
      ]);
      if (capped.won) {
        runtime.blocker = capped.blocker;
      } else {
        // Cap won the race: leave blocker null (empty engine) for now and swap in
        // the loaded engine when it arrives, attaching + wiring like the cap-winner
        // path below.
        void p
          .then((b) => {
            runtime.blocker = b;
            if (runtime.blocking.enabled) {
              attachBlockerToAllSessions(b);
              // Cover the transient quick-browse window's ephemeral session too if
              // one is open when the deferred engine arrives.
              if (runtime.quickBrowseSession !== null) {
                try {
                  b.attach(runtime.quickBrowseSession);
                } catch {
                  teardownQuickBrowse();
                }
              }
            }
            wireOnBlocked(b);
            installBypass(b);
            scheduleBlockingBroadcast();
          })
          .catch(() => {});
      }
      // Refresh once a day while running. createBlocker already starts ONE
      // background refresh on startup (§1), so this interval covers only the
      // recurring "once a day" case. Because fullSnapshot derives listVersion LIVE
      // off the blocker, the startup refresh's (and each daily refresh's) new
      // version surfaces on the next push with no extra observation — so main does
      // not separately gate on cache age (an intentional simplification vs. §3's
      // "on launch when the cache is older than a day").
      setInterval(
        () => {
          // Skip the recurring refresh while blocking is disabled: a user who
          // turned content blocking off must not trigger a remote filter-list
          // download every 24h.
          if (!runtime.blocking.enabled) {
            return;
          }
          runtime.blocker
            ?.refresh()
            .then((ok) => {
              if (ok) {
                scheduleBlockingBroadcast();
              }
            })
            .catch(() => {});
        },
        24 * 60 * 60 * 1000,
      );
    }
    // After the blocker is set (fixture or cap-winner) attach it to every existing
    // profile session when enabled, and wire the blocked-event listener. In the
    // cap-lost case blocker is still null here; its p.then above does both.
    if (enabled && runtime.blocker) {
      attachBlockerToAllSessions(runtime.blocker);
    }
    if (runtime.blocker) {
      wireOnBlocked(runtime.blocker);
      installBypass(runtime.blocker!);
    }
  } catch (err) {
    console.error("[blocking] startup failed; continuing without content blocking:", err);
    // Detach any sessions attached before the failure so no session hook is
    // left pointing at a blocker we are about to drop the reference to (a
    // partial attachBlockerToAllSessions above could leave some attached).
    if (runtime.blocker) {
      // Terminal transition: dispose() detaches every session AND removes the
      // wrapper's IPC handlers, so a replacement blocker (e.g. next launch) can
      // take them. A thrown error is caught and logged once; startup continues.
      try {
        runtime.blocker.dispose();
      } catch (disposeErr) {
        console.error("[blocking] dispose during startup cleanup failed:", disposeErr);
      }
    }
    runtime.blocker = null;
    // PRD 5.3 §3 failure state: with no engine attached, report blocking disabled
    // for this launch; the persisted flag is left as-is (no writeBlockingEnabled)
    // so the next launch retries. Seeding false also keeps the slice sane when
    // readBlockingEnabled threw before it was set above, so fullSnapshot() never
    // dereferences undefined.
    runtime.blocking = initialBlockingState(
      false,
      "none",
      [...runtime.allowlist].sort((a, b) => a.localeCompare(b)),
    );
  }
}

// --- Content blocking ---------------------------------------------------------
// setEnabled runs the ordered set-enabled contract (persist → attach/detach →
// broadcast) and rejects the invoke on a persistence/session failure; state()
// reads back the live blocking slice (listVersion derived off the blocker).
ipcMain.handle(IPC.blockingSetEnabled, (_event, enabled: boolean): Promise<void> =>
  setBlockingEnabled(enabled),
);

ipcMain.handle(IPC.blockingState, (): BlockingState => fullSnapshot().blocking);

// allowSite/disallowSite run the ordered allowlist contract on the main thread
// and reject the invoke on a bad host or a persistence failure; refreshLists
// re-fetches the filter lists (coalescing overlapping calls) and rejects when no
// engine is loaded.
ipcMain.handle(IPC.blockingAllowSite, (_event, host: string): Promise<void> => allowSite(host));

ipcMain.handle(
  IPC.blockingDisallowSite,
  (_event, host: string): Promise<void> => disallowSite(host),
);

ipcMain.handle(IPC.blockingRefresh, (): Promise<boolean> => refreshLists());
