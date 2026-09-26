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
import type { AvailableUpdate, InstallOrigin, UpdateState } from "@zeo/core";
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
 * Hard cap on the releases-feed response body. A compromised or misbehaving
 * feed (or a MITM on a non-pinned connection) must not be able to stream an
 * unbounded number of bytes into memory just because `checkForUpdates` awaits
 * the response. 1 MiB is generously larger than any real GitHub release
 * payload: GitHub release bodies can run up to 125k characters, and JSON
 * escaping plus multibyte encoding can inflate that well past 256 KiB.
 */
export const MAX_FEED_BYTES = 1024 * 1024;

/**
 * The recurring automatic-check timer period. Each tick calls
 * {@link checkForUpdates}, whose 24h {@link UPDATE_CHECK_INTERVAL_MS} rate
 * limit decides whether the tick fetches.
 */
export const UPDATE_TIMER_TICK_MS = 60 * 60 * 1000;

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
 * Seeds `runtime.update`, `runtime.updateDismissedVersion` and
 * `runtime.settings.updateCheckEnabled` from `readUpdateSettings()`, and the
 * install origin from a Caskroom probe. A failed read keeps the seeded
 * defaults; a failed probe falls back to "direct". `ZEO_UPDATE_ORIGIN`
 * overrides the origin only under `ZEO_E2E === "1"`.
 */
export function initUpdateState(): void {
  let settings: ReturnType<typeof readUpdateSettings> | null = null;
  try {
    settings = readUpdateSettings();
  } catch (err) {
    console.error("[update] failed to read update settings; using defaults:", err);
  }
  let origin: InstallOrigin;
  try {
    origin = installOrigin(
      (path) => existsSync(path) && statSync(path).isDirectory(),
      CASKROOM_PATHS,
    );
  } catch (err) {
    console.error("[update] install-origin probe failed; assuming direct:", err);
    origin = "direct";
  }
  if (process.env.ZEO_E2E === "1") {
    const override = process.env.ZEO_UPDATE_ORIGIN;
    if (override === "homebrew" || override === "direct") {
      origin = override;
    }
  }
  runtime.update = { ...runtime.update, origin };
  if (settings) {
    runtime.update = {
      ...runtime.update,
      enabled: settings.enabled,
      lastCheckedAt: settings.lastCheckedAt,
    };
    runtime.updateDismissedVersion = settings.dismissedVersion;
    runtime.settings = { ...runtime.settings, updateCheckEnabled: settings.enabled };
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
 * Reads a fetch `Response` body up to {@link MAX_FEED_BYTES}: rejects early
 * from a declared `Content-Length` exceeding the cap without reading any
 * body, and otherwise stream-counts the bytes actually read via the body
 * reader, aborting the moment the running total exceeds the cap. Returns the
 * decoded text, or `null` when the cap was exceeded — the caller reports
 * that the same as a malformed feed, never as a network error, so an
 * oversized response is distinguishable from a transient failure.
 */
async function readCappedText(res: Response): Promise<string | null> {
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body reader available — the real case is a null-body
    // response (e.g. a 204), whose `.text()` resolves to `""`; that empty
    // string then fails `JSON.parse` in the caller and is reported as
    // "network error", not "malformed feed". Still cap on the decoded length
    // for whatever body (if any) is actually present.
    const text = await res.text();
    return text.length > MAX_FEED_BYTES ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Runs (or coalesces onto) a releases-feed check, per PRD 9.6 §4:
 *
 * 1. A non-manual check no-ops (resolves immediately) when checking is
 *    disabled, or when the last check was inside {@link UPDATE_CHECK_INTERVAL_MS}.
 *    A manual check is never rate-limited.
 * 2. A check already in flight returns the SAME promise (coalesced) rather
 *    than issuing a second request.
 * 3. Sets `checking = true`, clears `error`, broadcasts — guarded by its own
 *    try/catch so a throwing broadcast here is logged and swallowed rather
 *    than propagating synchronously out of `checkForUpdates` itself (which
 *    would leave `checking` stuck at `true`, since step 6's finally would
 *    never run) or rejecting the returned promise.
 * 4. Fetches the feed with a timeout; a non-2xx status, an over-cap body
 *    (see {@link readCappedText}), or a rejection (network, timeout, JSON
 *    parse) sets `error` and leaves `available` unchanged. An over-cap body
 *    reports `"malformed feed"`; every other failure reports
 *    `"network error"`.
 * 5. On success, `parseLatestRelease` decides `available`: malformed leaves
 *    it unchanged (like a network error); none clears it; a release runs it
 *    through `updateDecision`, reading `runtime.updateDismissedVersion` as of
 *    THIS point (not snapshotted at step 3), so a dismissal that lands while
 *    the fetch is in flight is honored.
 * 6. In every case `available` is resolved from `runtime.update.available`
 *    AS OF COMPLETION on every non-success path (never a value snapshotted
 *    at step 3), so a concurrent dismissal during the in-flight fetch is
 *    never resurrected by a subsequent error/malformed response.
 *    `lastCheckedAt` is stamped and persisted (a write failure is logged
 *    once, not fatal), `checking = false`, broadcast, all inside a `finally`
 *    so a throw anywhere above (including from this closing `broadcast()`)
 *    still clears `checking`/`updateCheckInFlight`. Combined with step 3's
 *    own guard, no `broadcast()` call anywhere in this function can leave
 *    `checking`/`updateCheckInFlight` stuck or make `checkForUpdates` reject
 *    or throw synchronously. Never rejects.
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
  try {
    broadcast();
  } catch (err) {
    // A throwing broadcast here must not propagate synchronously out of
    // `checkForUpdates` (which would leave `checking` stuck at `true` forever,
    // since the async IIFE below — whose `finally` resets it — would never
    // even be constructed) and must not reject the returned promise either;
    // logged and swallowed, then execution falls through to start the fetch
    // as normal, so completion still runs the finally below and clears
    // `checking`/`updateCheckInFlight`.
    console.error("[update] broadcast failed while starting a check:", err);
  }

  const promise = (async (): Promise<void> => {
    let error: string | null = null;
    // `undefined` means "leave `available` unchanged"; distinct from a
    // decided `null`/`AvailableUpdate`, and resolved against the CURRENT
    // `runtime.update.available` only once completion is reached below —
    // never snapshotted here at the start of the check.
    let nextAvailable: AvailableUpdate | null | undefined;
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
        const text = await readCappedText(res);
        if (text === null) {
          error = "malformed feed";
        } else {
          // A JSON.parse throw here propagates to the outer catch below,
          // which reports "network error", per PRD (a parse error is not
          // distinguished from a network failure). Strip a leading UTF-8 BOM
          // first: some servers/proxies prepend one, and JSON.parse rejects
          // it outright even though the remaining text is valid JSON.
          const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
          const json: unknown = JSON.parse(withoutBom);
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
      }
    } catch {
      error = "network error";
    } finally {
      const now = Date.now();
      try {
        writeUpdateLastCheckedAt(now);
      } catch (err) {
        logUpdateWriteError(err);
      }
      // Resolved against the CURRENT `runtime.update.available` on every
      // non-success path (`nextAvailable` still `undefined`), so a dismissal
      // that landed while the fetch was in flight is never resurrected.
      const available = nextAvailable === undefined ? runtime.update.available : nextAvailable;
      try {
        runtime.update = {
          ...runtime.update,
          available,
          checking: false,
          error,
          lastCheckedAt: now,
        };
        broadcast();
      } catch (err) {
        // A throwing broadcast must not leave `checking`/`updateCheckInFlight`
        // stuck — logged, never rethrown, so `checkForUpdates` structurally
        // never rejects.
        console.error("[update] broadcast failed while completing a check:", err);
      } finally {
        runtime.updateCheckInFlight = null;
      }
    }
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
 * available and its url parses as `https:` on the `github.com` host. A parse
 * failure, a non-https url, or a non-github.com host is a silent no-op —
 * never an unvalidated `shell.openExternal` call (the feed url always comes
 * from `parseLatestRelease`, but this is defense in depth against a
 * compromised or spoofed feed response). Calls `shell.openExternal` as a
 * property access on the imported `shell` so an e2e stub installed via
 * `app.evaluate` (replacing the property) is observed here.
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
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
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
 * {@link startupDelayMs} and a recurring timer that ticks every
 * {@link UPDATE_TIMER_TICK_MS} (hourly); `checkForUpdates`'s own rate limit
 * against {@link UPDATE_CHECK_INTERVAL_MS} decides which ticks actually fetch,
 * so a check still lands at most once per 24h but within about an hour of
 * that mark, rather than the timer period itself gating a 24h-or-longer drift.
 */
export function startUpdateChecks(): void {
  const gate =
    app.isPackaged || (process.env.ZEO_E2E === "1" && Boolean(process.env.ZEO_UPDATE_FEED_URL));
  if (!gate) {
    return;
  }
  setTimeout(() => void checkForUpdates("startup"), startupDelayMs());
  setInterval(() => void checkForUpdates("timer"), UPDATE_TIMER_TICK_MS);
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
