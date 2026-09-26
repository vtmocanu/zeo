import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted fakes the electron + db mocks below close over, mirroring
// session-migration.test.ts: each test drives the injected fetch/clipboard/shell
// stubs and the db accessors directly.
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  writeText: vi.fn(),
  openExternal: vi.fn(),
  handle: vi.fn(),
  readUpdateSettings: vi.fn(),
  writeUpdateCheckEnabled: vi.fn(),
  writeUpdateDismissedVersion: vi.fn(),
  writeUpdateLastCheckedAt: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.0.0",
    isPackaged: false,
  },
  net: { fetch: h.fetch },
  clipboard: { writeText: h.writeText },
  shell: { openExternal: h.openExternal },
  ipcMain: { handle: h.handle },
}));

vi.mock("./db.js", () => ({
  readUpdateSettings: h.readUpdateSettings,
  writeUpdateCheckEnabled: h.writeUpdateCheckEnabled,
  writeUpdateDismissedVersion: h.writeUpdateDismissedVersion,
  writeUpdateLastCheckedAt: h.writeUpdateLastCheckedAt,
  // broadcast() schedules a debounced store save; a no-op stub is enough here.
  scheduleSave: () => {},
}));

import { runtime } from "./state.js";
import {
  MAX_FEED_BYTES,
  UPDATE_TIMER_TICK_MS,
  checkForUpdates,
  dismissUpdate,
  feedUrl,
  initUpdateState,
  openRelease,
  setUpdateCheckEnabled,
  startUpdateChecks,
  startupDelayMs,
} from "./update.js";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_STARTUP_DELAY_MS,
  UPDATE_FEED_URL,
} from "@zeo/core";

/** A JSON `Response`, `ok`/streaming all real (backed by the platform `Response`). */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A `Response` carrying a VALID, newer-version release body, but whose
 * declared `Content-Length` header exceeds {@link MAX_FEED_BYTES} — exercises
 * the early, no-body-read rejection path in isolation: since the body itself
 * would otherwise successfully decide a new `available`, only the declared
 * length can be what triggers rejection here.
 */
function oversizedByHeaderResponse(): Response {
  return new Response(JSON.stringify(release("v2.0.0")), {
    status: 200,
    headers: { "content-length": String(MAX_FEED_BYTES + 1) },
  });
}

/**
 * A `Response` whose ACTUAL body exceeds {@link MAX_FEED_BYTES} with no
 * (accurate) declared Content-Length — exercises the streaming byte-count
 * rejection path.
 */
function oversizedByBodyResponse(): Response {
  const body = "a".repeat(MAX_FEED_BYTES + 1);
  return new Response(body, { status: 200 });
}

const release = (tag: string) => ({
  tag_name: tag,
  html_url: `https://example.com/releases/${tag}`,
  published_at: "2026-01-01T00:00:00Z",
  draft: false,
  prerelease: false,
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.ZEO_E2E;
  delete process.env.ZEO_UPDATE_ORIGIN;
  delete process.env.ZEO_UPDATE_FEED_URL;
  delete process.env.ZEO_UPDATE_STARTUP_DELAY_MS;
  h.readUpdateSettings.mockReturnValue({
    enabled: true,
    dismissedVersion: null,
    lastCheckedAt: null,
  });
  runtime.update = {
    enabled: true,
    origin: "direct",
    available: null,
    checking: false,
    lastCheckedAt: null,
    error: null,
  };
  runtime.updateDismissedVersion = null;
  runtime.updateCheckInFlight = null;
  runtime.updateWriteErrorLogged = false;
  runtime.settings = { ...runtime.settings, updateCheckEnabled: true };
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("initUpdateState", () => {
  test("seeds enabled/dismissedVersion/lastCheckedAt from readUpdateSettings", () => {
    h.readUpdateSettings.mockReturnValue({
      enabled: false,
      dismissedVersion: "1.2.3",
      lastCheckedAt: 999,
    });
    initUpdateState();
    expect(runtime.update.enabled).toBe(false);
    expect(runtime.update.lastCheckedAt).toBe(999);
    expect(runtime.updateDismissedVersion).toBe("1.2.3");
    // Seeded from the SAME readUpdateSettings() read (not re-read elsewhere).
    expect(runtime.settings.updateCheckEnabled).toBe(false);
    expect(h.readUpdateSettings).toHaveBeenCalledTimes(1);
  });

  test("a read failure is logged and leaves the seeded defaults in place", () => {
    h.readUpdateSettings.mockImplementation(() => {
      throw new Error("disk error");
    });
    initUpdateState();
    expect(runtime.update.enabled).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  test("ZEO_UPDATE_ORIGIN overrides the probe only under ZEO_E2E=1", () => {
    process.env.ZEO_UPDATE_ORIGIN = "homebrew";
    initUpdateState();
    expect(runtime.update.origin).toBe("direct");

    process.env.ZEO_E2E = "1";
    initUpdateState();
    expect(runtime.update.origin).toBe("homebrew");
  });
});

describe("checkForUpdates — rate limiting", () => {
  test("a non-manual check no-ops when disabled", async () => {
    runtime.update = { ...runtime.update, enabled: false };
    await checkForUpdates("startup");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test("a non-manual check no-ops within the interval since the last check", async () => {
    runtime.update = { ...runtime.update, lastCheckedAt: Date.now() };
    await checkForUpdates("timer");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test("a manual check is never rate-limited", async () => {
    runtime.update = { ...runtime.update, lastCheckedAt: Date.now(), enabled: false };
    h.fetch.mockResolvedValue(jsonResponse(200, release("v1.0.0")));
    await checkForUpdates("manual");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("checkForUpdates — coalescing", () => {
  test("a second call while checking returns the SAME promise", () => {
    let resolveFetch!: (value: unknown) => void;
    h.fetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const first = checkForUpdates("manual");
    const second = checkForUpdates("manual");
    expect(second).toBe(first);
    resolveFetch(jsonResponse(200, { ...release("v0.0.1"), prerelease: true }));
    return first;
  });
});

describe("checkForUpdates — error paths", () => {
  test("a non-2xx status sets the HTTP error and leaves available unchanged", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    h.fetch.mockResolvedValue(jsonResponse(500, {}));
    await checkForUpdates("manual");
    expect(runtime.update.error).toBe("HTTP 500");
    expect(runtime.update.available).toEqual({
      version: "9.9.9",
      url: "https://example.com/releases/v9.9.9",
    });
    expect(runtime.update.checking).toBe(false);
  });

  test("a rejected fetch sets 'network error' and leaves available/checking sane", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    h.fetch.mockRejectedValue(new Error("boom"));
    await checkForUpdates("manual");
    expect(runtime.update.error).toBe("network error");
    expect(runtime.update.available).toEqual({
      version: "9.9.9",
      url: "https://example.com/releases/v9.9.9",
    });
    expect(runtime.update.checking).toBe(false);
  });

  test("a malformed feed sets 'malformed feed' and leaves available unchanged", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    h.fetch.mockResolvedValue(jsonResponse(200, {}));
    await checkForUpdates("manual");
    expect(runtime.update.error).toBe("malformed feed");
    expect(runtime.update.available).toEqual({
      version: "9.9.9",
      url: "https://example.com/releases/v9.9.9",
    });
  });

  test("a valid feed with no eligible release clears available and error", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    h.fetch.mockResolvedValue(jsonResponse(200, { ...release("v0.0.1"), prerelease: true }));
    await checkForUpdates("manual");
    expect(runtime.update.available).toBeNull();
    expect(runtime.update.error).toBeNull();
  });

  test("a newer release sets available and stamps lastCheckedAt", async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, release("v2.0.0")));
    await checkForUpdates("manual");
    expect(runtime.update.available).toEqual({
      version: "2.0.0",
      url: "https://example.com/releases/v2.0.0",
    });
    expect(runtime.update.error).toBeNull();
    expect(runtime.update.lastCheckedAt).not.toBeNull();
    expect(h.writeUpdateLastCheckedAt).toHaveBeenCalled();
  });

  test("a write failure on lastCheckedAt is logged once and does not fail the check", async () => {
    h.writeUpdateLastCheckedAt.mockImplementation(() => {
      throw new Error("disk full");
    });
    h.fetch.mockResolvedValue(jsonResponse(200, release("v2.0.0")));
    await checkForUpdates("manual");
    expect(runtime.update.checking).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // A second failure in the same launch does not log again.
    await checkForUpdates("manual");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("an over-cap Content-Length is rejected as malformed without reading the body", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    h.fetch.mockResolvedValue(oversizedByHeaderResponse());
    await checkForUpdates("manual");
    expect(runtime.update.error).toBe("malformed feed");
    expect(runtime.update.available).toEqual({
      version: "9.9.9",
      url: "https://example.com/releases/v9.9.9",
    });
  });

  test("an over-cap body with no accurate Content-Length is rejected as malformed (streamed count)", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    h.fetch.mockResolvedValue(oversizedByBodyResponse());
    await checkForUpdates("manual");
    expect(runtime.update.error).toBe("malformed feed");
    expect(runtime.update.available).toEqual({
      version: "9.9.9",
      url: "https://example.com/releases/v9.9.9",
    });
  });

  test("a JSON parse error is a network error, not malformed", async () => {
    h.fetch.mockResolvedValue(new Response("not json", { status: 200 }));
    await checkForUpdates("manual");
    expect(runtime.update.error).toBe("network error");
  });

  test("dismissing during an in-flight check is not resurrected by a later error response", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    let resolveFetch!: (value: Response) => void;
    h.fetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const promise = checkForUpdates("manual");
    await dismissUpdate();
    expect(runtime.update.available).toBeNull();

    resolveFetch(jsonResponse(500, {}));
    await promise;
    expect(runtime.update.available).toBeNull();
  });

  test("updateDecision reads updateDismissedVersion as of completion, not at the start of the check", async () => {
    let resolveFetch!: (value: Response) => void;
    h.fetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const promise = checkForUpdates("manual");
    // Dismissed while the fetch is still in flight.
    runtime.updateDismissedVersion = "2.0.0";
    resolveFetch(jsonResponse(200, release("v2.0.0")));
    await promise;
    expect(runtime.update.available).toBeNull();
  });
});

describe("checkForUpdates — broadcast throws never leak out", () => {
  afterEach(() => {
    runtime.win = null;
  });

  test("a broadcast that throws while starting a check (step 3) is logged, does not throw synchronously, and does not leave checking stuck", async () => {
    let sendCalls = 0;
    runtime.win = {
      webContents: {
        send: () => {
          sendCalls += 1;
          if (sendCalls === 1) {
            throw new Error("boom at start");
          }
        },
      },
    } as unknown as typeof runtime.win;
    h.fetch.mockResolvedValue(jsonResponse(200, release("v2.0.0")));

    // Calling this must not itself throw synchronously.
    const promise = checkForUpdates("manual");
    await expect(promise).resolves.toBeUndefined();

    expect(runtime.update.checking).toBe(false);
    expect(runtime.updateCheckInFlight).toBeNull();
    expect(runtime.update.available).toEqual({
      version: "2.0.0",
      url: "https://example.com/releases/v2.0.0",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("broadcast failed while starting a check"),
      expect.anything(),
    );
  });

  test("a broadcast that throws while completing a check (the finally path) still clears checking/updateCheckInFlight and the promise resolves", async () => {
    let sendCalls = 0;
    runtime.win = {
      webContents: {
        send: () => {
          sendCalls += 1;
          // Let the step-3 "checking = true" broadcast succeed; only the
          // completion broadcast (inside the finally) throws.
          if (sendCalls > 1) {
            throw new Error("boom at completion");
          }
        },
      },
    } as unknown as typeof runtime.win;
    h.fetch.mockResolvedValue(jsonResponse(200, release("v2.0.0")));

    const promise = checkForUpdates("manual");
    await expect(promise).resolves.toBeUndefined();

    expect(runtime.update.checking).toBe(false);
    expect(runtime.updateCheckInFlight).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("broadcast failed while completing a check"),
      expect.anything(),
    );
  });
});

describe("dismissUpdate", () => {
  test("a no-op when nothing is available", async () => {
    await dismissUpdate();
    expect(h.writeUpdateDismissedVersion).not.toHaveBeenCalled();
  });

  test("persists the dismissed version and clears available", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    await dismissUpdate();
    expect(h.writeUpdateDismissedVersion).toHaveBeenCalledWith("9.9.9");
    expect(runtime.updateDismissedVersion).toBe("9.9.9");
    expect(runtime.update.available).toBeNull();
  });

  test("a persistence failure rejects and changes nothing", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    h.writeUpdateDismissedVersion.mockImplementation(() => {
      throw new Error("disk error");
    });
    await expect(dismissUpdate()).rejects.toThrow();
    expect(runtime.update.available).toEqual({
      version: "9.9.9",
      url: "https://example.com/releases/v9.9.9",
    });
  });
});

describe("setUpdateCheckEnabled", () => {
  test("rejects with a TypeError on a non-boolean", async () => {
    await expect(setUpdateCheckEnabled("yes" as unknown as boolean)).rejects.toThrow(TypeError);
    expect(h.writeUpdateCheckEnabled).not.toHaveBeenCalled();
  });

  test("resolves with no side effect when unchanged", async () => {
    await setUpdateCheckEnabled(true);
    expect(h.writeUpdateCheckEnabled).not.toHaveBeenCalled();
  });

  test("persists, updates settings AND runtime.update.enabled, and does not trigger a check", async () => {
    await setUpdateCheckEnabled(false);
    expect(h.writeUpdateCheckEnabled).toHaveBeenCalledWith(false);
    expect(runtime.settings.updateCheckEnabled).toBe(false);
    expect(runtime.update.enabled).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("openRelease", () => {
  test("a no-op when nothing is available", async () => {
    await openRelease();
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  test("opens an https github.com release url", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://github.com/vtmocanu/zeo/releases/v9.9.9" },
    };
    await openRelease();
    expect(h.openExternal).toHaveBeenCalledWith("https://github.com/vtmocanu/zeo/releases/v9.9.9");
  });

  test("a non-https url is a silent no-op", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "http://github.com/releases/v9.9.9" },
    };
    await openRelease();
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  test("a non-github.com https url is a silent no-op", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    await openRelease();
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  test("an unparseable url is a silent no-op", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "not a url" },
    };
    await openRelease();
    expect(h.openExternal).not.toHaveBeenCalled();
  });
});

describe("feedUrl / startupDelayMs — overrides gated on ZEO_E2E", () => {
  test("feedUrl ignores ZEO_UPDATE_FEED_URL without ZEO_E2E=1", () => {
    process.env.ZEO_UPDATE_FEED_URL = "https://example.com/other-feed";
    expect(feedUrl()).toBe(UPDATE_FEED_URL);
  });

  test("feedUrl honors the override under ZEO_E2E=1", () => {
    process.env.ZEO_E2E = "1";
    process.env.ZEO_UPDATE_FEED_URL = "https://example.com/other-feed";
    expect(feedUrl()).toBe("https://example.com/other-feed");
  });

  test("startupDelayMs ignores ZEO_UPDATE_STARTUP_DELAY_MS without ZEO_E2E=1", () => {
    process.env.ZEO_UPDATE_STARTUP_DELAY_MS = "500";
    expect(startupDelayMs()).toBe(UPDATE_CHECK_STARTUP_DELAY_MS);
  });

  test("startupDelayMs falls back to the constant on an invalid override, even under ZEO_E2E=1", () => {
    process.env.ZEO_E2E = "1";
    process.env.ZEO_UPDATE_STARTUP_DELAY_MS = "not-a-number";
    expect(startupDelayMs()).toBe(UPDATE_CHECK_STARTUP_DELAY_MS);

    process.env.ZEO_UPDATE_STARTUP_DELAY_MS = "-5";
    expect(startupDelayMs()).toBe(UPDATE_CHECK_STARTUP_DELAY_MS);
  });

  test("startupDelayMs honors a valid override under ZEO_E2E=1", () => {
    process.env.ZEO_E2E = "1";
    process.env.ZEO_UPDATE_STARTUP_DELAY_MS = "500";
    expect(startupDelayMs()).toBe(500);
  });
});

describe("startUpdateChecks — scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("schedules nothing when unpackaged without the ZEO_E2E/ZEO_UPDATE_FEED_URL override", async () => {
    vi.useFakeTimers();
    startUpdateChecks();
    await vi.advanceTimersByTimeAsync(48 * UPDATE_TIMER_TICK_MS);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test("auto checks land within about an hour of the 24h mark, at most once per 24h", async () => {
    vi.useFakeTimers();
    process.env.ZEO_E2E = "1";
    process.env.ZEO_UPDATE_FEED_URL = "https://example.com/feed";
    h.fetch.mockResolvedValue(jsonResponse(200, { ...release("v0.0.1"), prerelease: true }));

    const hour = UPDATE_TIMER_TICK_MS;
    const day = UPDATE_CHECK_INTERVAL_MS;

    startUpdateChecks();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    // Hourly ticks up to the 24h mark stay rate-limited by the ~10s-old check
    // (this is the bug: using the 24h interval itself as the timer period
    // would instead miss this whole window and drift to ~48h between checks).
    await vi.advanceTimersByTimeAsync(day - 10_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    // The next hourly tick past the 24h mark (24h+1h absolute) fires.
    await vi.advanceTimersByTimeAsync(hour);
    expect(h.fetch).toHaveBeenCalledTimes(2);

    // By 48h+2h absolute a third check has fired (at most once per 24h since).
    await vi.advanceTimersByTimeAsync(day + hour);
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
});
