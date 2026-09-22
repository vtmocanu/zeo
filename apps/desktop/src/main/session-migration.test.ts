import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted fakes the electron + db mocks below close over, so each test drives the
// injected sessions and the two db accessors directly (the vi.mock factories are
// hoisted above the imports and may only read hoisted state).
const h = vi.hoisted(() => ({
  defaultCookiesGet: vi.fn(),
  defaultClearStorageData: vi.fn(),
  targetCookiesSet: vi.fn(),
  readMarker: vi.fn(),
  writeMarker: vi.fn(),
}));

vi.mock("electron", () => ({
  session: {
    defaultSession: {
      cookies: { get: h.defaultCookiesGet },
      clearStorageData: h.defaultClearStorageData,
    },
    // migrateDefaultSession only ever asks for persist:default.
    fromPartition: () => ({ cookies: { set: h.targetCookiesSet } }),
  },
}));

vi.mock("./db.js", () => ({
  readDefaultSessionMigratedAt: h.readMarker,
  writeDefaultSessionMigratedAt: h.writeMarker,
}));

import { migrateDefaultSession } from "./session-migration.js";

/** A minimal cookie fixture (short, non-secret-shaped fake value). */
function cookie(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "sid",
    value: "v1",
    domain: "example.com",
    path: "/",
    secure: true,
    httpOnly: false,
    ...overrides,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  // Silence (and observe) the migration's console.error diagnostics.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Sensible resolving defaults; individual tests override per case.
  h.defaultCookiesGet.mockResolvedValue([]);
  h.defaultClearStorageData.mockResolvedValue(undefined);
  h.targetCookiesSet.mockResolvedValue(undefined);
  h.readMarker.mockReturnValue(null);
  h.writeMarker.mockReturnValue(undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("migrateDefaultSession", () => {
  test("copies every cookie, clears the source storage, and writes the marker", async () => {
    h.defaultCookiesGet.mockResolvedValue([cookie({ name: "a" }), cookie({ name: "b" })]);

    await expect(migrateDefaultSession()).resolves.toBeUndefined();

    expect(h.targetCookiesSet).toHaveBeenCalledTimes(2);
    expect(h.defaultClearStorageData).toHaveBeenCalledTimes(1);
    expect(h.writeMarker).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("already-migrated marker short-circuits; a later null read migrates normally", async () => {
    // First call: read throws → logged once, and NOTHING is read/cleared/written.
    h.readMarker.mockImplementationOnce(() => {
      throw new Error("read failed");
    });

    await expect(migrateDefaultSession()).resolves.toBeUndefined();

    expect(h.defaultCookiesGet).not.toHaveBeenCalled();
    expect(h.defaultClearStorageData).not.toHaveBeenCalled();
    expect(h.writeMarker).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Second call: read now returns null (the default), so it migrates normally.
    h.defaultCookiesGet.mockResolvedValue([cookie()]);

    await expect(migrateDefaultSession()).resolves.toBeUndefined();

    expect(h.targetCookiesSet).toHaveBeenCalledTimes(1);
    expect(h.defaultClearStorageData).toHaveBeenCalledTimes(1);
    expect(h.writeMarker).toHaveBeenCalledTimes(1);
  });

  test("a cookies.set rejection leaves the source intact; a second call retries the copy", async () => {
    h.defaultCookiesGet.mockResolvedValue([cookie({ name: "a" }), cookie({ name: "b" })]);
    // One set rejects on the first pass.
    h.targetCookiesSet.mockRejectedValueOnce(new Error("set failed"));

    await expect(migrateDefaultSession()).resolves.toBeUndefined();

    // Nothing cleared, marker never written (marker stays null for the retry).
    expect(h.defaultClearStorageData).not.toHaveBeenCalled();
    expect(h.writeMarker).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Second call: marker still null, every set now resolves → copy + clear + mark.
    h.targetCookiesSet.mockClear();
    h.targetCookiesSet.mockResolvedValue(undefined);

    await expect(migrateDefaultSession()).resolves.toBeUndefined();

    expect(h.targetCookiesSet).toHaveBeenCalledTimes(2);
    expect(h.defaultClearStorageData).toHaveBeenCalledTimes(1);
    expect(h.writeMarker).toHaveBeenCalledTimes(1);
  });

  test("a cookies.get rejection leaves the marker unwritten and resolves", async () => {
    h.defaultCookiesGet.mockRejectedValue(new Error("get failed"));

    await expect(migrateDefaultSession()).resolves.toBeUndefined();

    expect(h.targetCookiesSet).not.toHaveBeenCalled();
    expect(h.defaultClearStorageData).not.toHaveBeenCalled();
    expect(h.writeMarker).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("a write-marker failure after a successful clear resolves; the next call retries the marker over an empty source", async () => {
    h.defaultCookiesGet.mockResolvedValue([cookie()]);
    // The clear succeeded, but stamping the marker throws.
    h.writeMarker.mockImplementationOnce(() => {
      throw new Error("write failed");
    });

    await expect(migrateDefaultSession()).resolves.toBeUndefined();

    expect(h.defaultClearStorageData).toHaveBeenCalledTimes(1);
    // The write threw, so the marker is still null and the failure was logged.
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Second call: marker still null, but the source is now empty — nothing to copy,
    // and the marker write is retried (and now succeeds).
    h.defaultCookiesGet.mockResolvedValue([]);
    h.targetCookiesSet.mockClear();
    h.defaultClearStorageData.mockClear();
    h.writeMarker.mockClear();

    await expect(migrateDefaultSession()).resolves.toBeUndefined();

    expect(h.targetCookiesSet).not.toHaveBeenCalled();
    expect(h.defaultClearStorageData).toHaveBeenCalledTimes(1);
    expect(h.writeMarker).toHaveBeenCalledTimes(1);
  });
});
