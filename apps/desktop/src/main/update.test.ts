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
  checkForUpdates,
  dismissUpdate,
  initUpdateState,
  openRelease,
  setUpdateCheckEnabled,
} from "./update.js";

/** A JSON `Response`-shaped fetch result, `ok` derived from `status`. */
function jsonResponse(status: number, body: unknown): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
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
    resolveFetch(jsonResponse(200, { kind: "none" }));
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

  test("a rejected fetch sets 'network error'", async () => {
    h.fetch.mockRejectedValue(new Error("boom"));
    await checkForUpdates("manual");
    expect(runtime.update.error).toBe("network error");
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

  test("opens an https release url", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "https://example.com/releases/v9.9.9" },
    };
    await openRelease();
    expect(h.openExternal).toHaveBeenCalledWith("https://example.com/releases/v9.9.9");
  });

  test("a non-https url is a silent no-op", async () => {
    runtime.update = {
      ...runtime.update,
      available: { version: "9.9.9", url: "http://example.com/releases/v9.9.9" },
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
