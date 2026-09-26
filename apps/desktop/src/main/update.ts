/**
 * The in-app update check: a main-side poller against the GitHub Releases API,
 * feeding the pure decision core in `@zeo/core` (`parseLatestRelease`,
 * `updateDecision`, `installOrigin`) and the broadcast `update` slice.
 *
 * Imports ONLY `state.js`, `db.js`, and `broadcast.js` — never `commands.js` or
 * `settings.js` — so `commands.ts` can import this module without creating a
 * cycle (`commands.ts` -> `update.ts` -> {state,db,broadcast}, never back).
 */
import { app, clipboard, ipcMain, net, shell } from "electron";
import { existsSync, statSync } from "node:fs";
import {
  CASKROOM_PATHS,
  HOMEBREW_UPGRADE_COMMAND,
  IPC,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_STARTUP_DELAY_MS,
  UPDATE_FETCH_TIMEOUT_MS,
  UPDATE_FEED_URL,
  installOrigin,
  parseLatestRelease,
  updateDecision,
} from "@zeo/core";
import type { InstallOrigin, UpdateState } from "@zeo/core";
import {
  readUpdateSettings,
  writeUpdateCheckEnabled,
  writeUpdateDismissedVersion,
  writeUpdateLastCheckedAt,
} from "./db.js";
import { runtime } from "./state.js";
import { broadcast } from "./broadcast.js";

/** Reason a check was initiated, threaded through for the rate-limit rule. */
export type CheckReason = "startup" | "timer" | "manual";

/**
 * Logs an update-settings-write error once per launch and swallows it
 * thereafter, mirroring {@link logHistoryError}: a failing persistence write
 * never fails the check itself.
 */
function logUpdateWriteError(err: unknown): void {
  if (!runtime.updateWriteErrorLogged) {
    runtime.updateWriteErrorLogged = true;
    console.error("[update] database error persisting update-check state:", err);
  }
}

/**
 * Seeds `runtime.update`/`runtime.updateDismissedVersion` from disk plus a
 * Caskroom probe, at startup. `ZEO_UPDATE_ORIGIN` overrides the probe only
 * under `ZEO_E2E === "1"`, letting e2e tests exercise both install origins
 * without a real Caskroom directory. Any read failure is logged and leaves
 * the seeded defaults (enabled, direct origin) in place — never blocks
 * startup.
 */
export function initUpdateState(): void {
  try {
    const settings = readUpdateSettings();
    let origin: InstallOrigin = installOrigin(
      (path) => existsSync(path) && statSync(path).isDirectory(),
      CASKROOM_PATHS,
    );
    if (process.env.ZEO_E2E === "1") {
      const override = process.env.ZEO_UPDATE_ORIGIN;
      if (override === "homebrew" || override === "direct") {
        origin = override;
      }
    }
    runtime.update = {
      ...runtime.update,
      enabled: settings.enabled,
      origin,
      lastCheckedAt: settings.lastCheckedAt,
    };
    runtime.updateDismissedVersion = settings.dismissedVersion;
  } catch (err) {
    console.error("[update] failed to read update settings; using defaults:", err);
  }
}

/** The releases feed url: overridable only under `ZEO_E2E === "1"`. */
export function feedUrl(): string {
  if (process.env.ZEO_E2E === "1") {
    const override = process.env.ZEO_UPDATE_FEED_URL;
    if (typeof override === "string" && override !== "") {
      return override;
    }
  }
  return UPDATE_FEED_URL;
}

/**
 * The startup-check delay: overridable only under `ZEO_E2E === "1"`, and only
 * when the override parses as a finite, non-negative number (an invalid
 * override falls back to the documented constant rather than crashing the
 * timer setup).
 */
export function startupDelayMs(): number {
  if (process.env.ZEO_E2E === "1") {
    const override = process.env.ZEO_UPDATE_STARTUP_DELAY_MS;
    if (typeof override === "string" && override !== "") {
      const parsed = Number(override);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return UPDATE_CHECK_STARTUP_DELAY_MS;
}

/**
 * Runs (or coalesces onto) a releases-feed check, per PRD 9.6 §4:
 *
 * 1. A non-manual check no-ops (resolves immediately) when checking is
 *    disabled, or when the last check was inside {@link UPDATE_CHECK_INTERVAL_MS}.
 *    A manual check is never rate-limited.
 * 2. A check already in flight returns the SAME promise (coalesced) rather
 *    than issuing a second request.
 * 3. Sets `checking = true`, clears `error`, broadcasts.
 * 4. Fetches the feed with a timeout; a non-2xx status or a rejection
 *    (network, timeout, JSON parse) sets `error` and leaves `available`
 *    unchanged.
 * 5. On success, `parseLatestRelease` decides `available`: malformed leaves
 *    it unchanged (like a network error); none clears it; a release runs it
 *    through `updateDecision`.
 * 6. In every case `lastCheckedAt` is stamped and persisted (a write failure
 *    is logged once, not fatal), `checking = false`, broadcast. Never
 *    rejects.
 */
export function checkForUpdates(reason: CheckReason): Promise<void> {
  if (reason !== "manual") {
    if (!runtime.update.enabled) {
      return Promise.resolve();
    }
    const lastCheckedAt = runtime.update.lastCheckedAt;
    if (lastCheckedAt !== null && Date.now() - lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) {
      return Promise.resolve();
    }
  }
  if (runtime.update.checking && runtime.updateCheckInFlight !== null) {
    return runtime.updateCheckInFlight;
  }

  runtime.update = { ...runtime.update, checking: true, error: null };
  broadcast();

  const promise = (async (): Promise<void> => {
    let error: string | null = null;
    let nextAvailable = runtime.update.available;
    try {
      const res = await net.fetch(feedUrl(), {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "zeo/" + app.getVersion(),
        },
        signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        error = `HTTP ${res.status}`;
      } else {
        const json: unknown = await res.json();
        const parsed = parseLatestRelease(json);
        if (parsed.kind === "malformed") {
          error = "malformed feed";
        } else if (parsed.kind === "none") {
          nextAvailable = null;
        } else {
          nextAvailable = updateDecision(
            app.getVersion(),
            parsed.release,
            runtime.updateDismissedVersion,
          );
        }
      }
    } catch {
      error = "network error";
    }

    const now = Date.now();
    try {
      writeUpdateLastCheckedAt(now);
    } catch (err) {
      logUpdateWriteError(err);
    }
    runtime.update = {
      ...runtime.update,
      available: nextAvailable,
      checking: false,
      error,
      lastCheckedAt: now,
    };
    runtime.updateCheckInFlight = null;
    broadcast();
  })();

  runtime.updateCheckInFlight = promise;
  return promise;
}

/**
 * Dismisses the currently available update until a newer version appears. A
 * no-op when there is nothing available; a persistence failure rejects the
 * invoke and changes nothing (unlike the check's own writes, which are best-
 * effort).
 */
export async function dismissUpdate(): Promise<void> {
  const available = runtime.update.available;
  if (available === null) {
    return;
  }
  writeUpdateDismissedVersion(available.version);
  runtime.updateDismissedVersion = available.version;
  runtime.update = { ...runtime.update, available: null };
  broadcast();
}

/**
 * Sets whether main checks the releases feed automatically, the PRD 6.5
 * ordered contract mirrored from {@link setQuickBrowseExternal}: (1) reject
 * with a `TypeError` (changing nothing) when `enabled` is not a boolean; (2)
 * resolve with no side effect when it already matches the current value; (3)
 * persist synchronously — a throw rejects and stops before any in-memory
 * change; (4) update `runtime.settings.updateCheckEnabled` AND
 * `runtime.update.enabled`, then broadcast. Turning it on does NOT itself
 * trigger a check; the next timer tick or a manual check does.
 */
export async function setUpdateCheckEnabled(enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") {
    throw new TypeError("update.setUpdateCheckEnabled expects a boolean");
  }
  if (enabled === runtime.settings.updateCheckEnabled) {
    return;
  }
  writeUpdateCheckEnabled(enabled);
  runtime.settings = { ...runtime.settings, updateCheckEnabled: enabled };
  runtime.update = { ...runtime.update, enabled };
  broadcast();
}

/**
 * Opens the release page in the default browser, only when an update is
 * available and its url parses as `https:`. A parse failure or a non-https
 * url is a silent no-op — never an unvalidated `shell.openExternal` call.
 * Calls `shell.openExternal` as a property access on the imported `shell` so
 * an e2e stub installed via `app.evaluate` (replacing the property) is
 * observed here.
 */
export async function openRelease(): Promise<void> {
  const available = runtime.update.available;
  if (available === null) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(available.url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:") {
    return;
  }
  await shell.openExternal(available.url);
}

/** Copies the Homebrew upgrade command to the clipboard. */
export async function copyUpgradeCommand(): Promise<void> {
  clipboard.writeText(HOMEBREW_UPGRADE_COMMAND);
}

/**
 * Starts the automatic scheduling: gated on a packaged build, or (only under
 * `ZEO_E2E === "1"`) an explicit `ZEO_UPDATE_FEED_URL` override, so an
 * unpackaged dev build never polls the real feed on its own — `update.check`
 * still works there manually. Schedules one startup check after
 * {@link startupDelayMs} and a recurring check every
 * {@link UPDATE_CHECK_INTERVAL_MS}.
 */
export function startUpdateChecks(): void {
  const gate =
    app.isPackaged || (process.env.ZEO_E2E === "1" && Boolean(process.env.ZEO_UPDATE_FEED_URL));
  if (!gate) {
    return;
  }
  setTimeout(() => void checkForUpdates("startup"), startupDelayMs());
  setInterval(() => void checkForUpdates("timer"), UPDATE_CHECK_INTERVAL_MS);
}

// --- Update -------------------------------------------------------------------
// check() runs a manual check (never rate-limited); dismiss/openRelease/
// copyUpgradeCommand act on the current `available` slice; state() reads back
// the current UpdateState. settingsSetUpdateCheckEnabled lives here (not
// settings.ts) to keep update.ts import-acyclic with commands.ts/settings.ts.
ipcMain.handle(IPC.updateCheck, (): Promise<void> => checkForUpdates("manual"));

ipcMain.handle(IPC.updateDismiss, (): Promise<void> => dismissUpdate());

ipcMain.handle(IPC.updateOpenRelease, (): Promise<void> => openRelease());

ipcMain.handle(IPC.updateCopyCommand, (): Promise<void> => copyUpgradeCommand());

ipcMain.handle(IPC.updateState, (): UpdateState => runtime.update);

ipcMain.handle(IPC.settingsSetUpdateCheckEnabled, (_event, enabled: boolean): Promise<void> =>
  setUpdateCheckEnabled(enabled),
);
